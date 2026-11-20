from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from .. import audio, storage
from ..config import get_settings
from ..db import get_db
from ..models import (
    STATUS_CREATED,
    STATUS_FAILED,
    STATUS_QUEUED,
    STATUS_RECORDING,
    Recording,
    Segment,
    SpeakerName,
)
from ..feishu import FeishuClient, build_minutes_card
from ..llm.summarize import SCENE_LABELS
from ..pipeline import process_recording
from sqlalchemy import or_

from ..schemas import (
    FinishOut,
    RecordingCreate,
    RecordingOut,
    SearchHit,
    SendIn,
    SpeakerRenameIn,
)
from ..security import share_url
from .deps import current_open_id
from .serializers import to_out

router = APIRouter(prefix="/api/v1", tags=["recordings"])

MAX_SEGMENT_BYTES = 120 * 1024 * 1024


def _owned(db: Session, recording_id: str, open_id: str) -> Recording:
    rec = db.get(Recording, recording_id)
    if rec is None or rec.owner_open_id != open_id:
        raise HTTPException(status_code=404, detail="录音不存在")
    return rec


@router.post("/recordings", response_model=RecordingOut)
def create_recording(
    body: RecordingCreate,
    open_id: str = Depends(current_open_id),
    db: Session = Depends(get_db),
) -> RecordingOut:
    rec = Recording(owner_open_id=open_id, title=body.title, scene=body.scene)
    db.add(rec)
    db.commit()
    db.refresh(rec)
    return to_out(rec)


@router.get("/recordings", response_model=list[RecordingOut])
def list_recordings(
    open_id: str = Depends(current_open_id), db: Session = Depends(get_db)
) -> list[RecordingOut]:
    rows = (
        db.query(Recording)
        .filter(Recording.owner_open_id == open_id)
        .order_by(Recording.created_at.desc())
        .limit(100)
        .all()
    )
    return [to_out(r) for r in rows]


@router.get("/search", response_model=list[SearchHit])
def search_recordings(
    q: str,
    open_id: str = Depends(current_open_id),
    db: Session = Depends(get_db),
) -> list[SearchHit]:
    q = q.strip()
    if not q:
        return []
    like = f"%{q}%"
    rows = (
        db.query(Recording)
        .filter(
            Recording.owner_open_id == open_id,
            or_(
                Recording.title.like(like),
                Recording.transcript_json.like(like),
                Recording.summary_json.like(like),
            ),
        )
        .order_by(Recording.created_at.desc())
        .limit(50)
        .all()
    )
    hits: list[SearchHit] = []
    for rec in rows:
        text = rec.transcript_json or ""
        idx = text.find(q)
        snippet = ""
        if idx >= 0:
            snippet = text[max(0, idx - 30): idx + 90].replace("\\n", " ")
        elif rec.summary_json:
            idx = rec.summary_json.find(q)
            snippet = rec.summary_json[max(0, idx - 30): idx + 90] if idx >= 0 else ""
        hits.append(
            SearchHit(
                id=rec.id,
                title=rec.title,
                status=rec.status,
                created_at=rec.created_at.isoformat(),
                snippet=snippet,
            )
        )
    return hits


@router.put("/recordings/{recording_id}/speakers", response_model=RecordingOut)
def rename_speakers(
    recording_id: str,
    body: SpeakerRenameIn,
    open_id: str = Depends(current_open_id),
    db: Session = Depends(get_db),
) -> RecordingOut:
    rec = _owned(db, recording_id, open_id)
    for speaker, name in body.mapping.items():
        speaker = speaker.strip()[:20]
        name = (name or "").strip()[:50]
        if not speaker:
            continue
        row = (
            db.query(SpeakerName)
            .filter(SpeakerName.recording_id == rec.id, SpeakerName.speaker == speaker)
            .first()
        )
        if name and row:
            row.name = name
        elif name:
            db.add(SpeakerName(recording_id=rec.id, speaker=speaker, name=name))
        elif row:
            db.delete(row)
    db.commit()
    db.refresh(rec)
    return to_out(rec, include_detail=True)


@router.get("/stats")
def stats(open_id: str = Depends(current_open_id), db: Session = Depends(get_db)) -> dict:
    rows = db.query(Recording).filter(Recording.owner_open_id == open_id).all()
    minutes = sum(r.duration_sec for r in rows) / 60
    price = get_settings().asr_price_per_hour
    return {
        "recordings": len(rows),
        "minutes": round(minutes, 1),
        "done": sum(1 for r in rows if r.status == "done"),
        "failed": sum(1 for r in rows if r.status == "failed"),
        "estimated_cost_yuan": round(minutes / 60 * price, 2),
    }


@router.get("/recordings/{recording_id}", response_model=RecordingOut)
def get_recording(
    recording_id: str,
    open_id: str = Depends(current_open_id),
    db: Session = Depends(get_db),
) -> RecordingOut:
    return to_out(_owned(db, recording_id, open_id), include_detail=True)


@router.post("/recordings/{recording_id}/segments", response_model=RecordingOut)
async def upload_segment(
    recording_id: str,
    idx: int,
    file: UploadFile = File(...),
    open_id: str = Depends(current_open_id),
    db: Session = Depends(get_db),
) -> RecordingOut:
    rec = _owned(db, recording_id, open_id)
    if rec.status not in (STATUS_CREATED, STATUS_RECORDING, STATUS_FAILED):
        raise HTTPException(status_code=409, detail=f"当前状态不允许上传分段: {rec.status}")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="空文件")
    if len(data) > MAX_SEGMENT_BYTES:
        raise HTTPException(status_code=413, detail="分段超过 80MB")

    raw, digest = storage.save_segment_raw(rec.id, idx, data)
    wav_path = storage.segment_path(rec.id, idx)
    try:
        if audio.is_wav(raw):
            raw.replace(wav_path)
            info = audio.inspect(wav_path)
        else:
            info = audio.convert_to_wav(raw, wav_path)
            raw.unlink(missing_ok=True)
    except audio.WavError as exc:
        raw.unlink(missing_ok=True)
        wav_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    existing = next((s for s in rec.segments if s.idx == idx), None)
    if existing:
        existing.path = str(wav_path)
        existing.size = len(data)
        existing.sha256 = digest
        existing.duration_sec = info["duration"]
    else:
        db.add(
            Segment(
                recording_id=rec.id,
                idx=idx,
                path=str(wav_path),
                size=len(data),
                sha256=digest,
                duration_sec=info["duration"],
            )
        )
    if rec.status == STATUS_FAILED:
        rec.error = ""
    rec.status = STATUS_RECORDING
    db.commit()
    db.refresh(rec)
    return to_out(rec)


@router.get("/recordings/{recording_id}/share")
def get_share_link(
    recording_id: str,
    open_id: str = Depends(current_open_id),
    db: Session = Depends(get_db),
) -> dict:
    rec = _owned(db, recording_id, open_id)
    return {"url": share_url(rec.id)}


@router.post("/recordings/{recording_id}/send")
def send_to_chat(
    recording_id: str,
    body: SendIn,
    open_id: str = Depends(current_open_id),
    db: Session = Depends(get_db),
) -> dict:
    """把纪要卡片转发到指定会话/个人（默认发给自己）。"""
    import json as _json
    from datetime import datetime, timezone

    from ..models import DeliveryLog

    rec = _owned(db, recording_id, open_id)
    if rec.status != "done":
        raise HTTPException(status_code=409, detail="纪要还没生成完成")
    summary = _json.loads(rec.summary_json) if rec.summary_json else {}
    card = build_minutes_card(
        rec.title, SCENE_LABELS.get(rec.scene, "会议"), summary, share_url(rec.id)
    )
    target = body.receive_id or rec.owner_open_id
    try:
        result = FeishuClient().send_card(target, card, receive_id_type=body.receive_id_type)
        status, detail = "sent", _json.dumps(result, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001
        status, detail = "failed", str(exc)[:500]
    db.add(
        DeliveryLog(
            recording_id=rec.id, channel="feishu", target=target,
            status=status, detail=detail,
        )
    )
    db.commit()
    return {"status": status, "target": target, "detail": detail}


@router.post("/recordings/{recording_id}/finish", response_model=FinishOut)
def finish_recording(
    recording_id: str,
    open_id: str = Depends(current_open_id),
    db: Session = Depends(get_db),
) -> FinishOut:
    rec = _owned(db, recording_id, open_id)
    if not rec.segments:
        raise HTTPException(status_code=400, detail="还没有上传任何分段")
    if rec.status == "done":
        return FinishOut(id=rec.id, status=rec.status, segment_count=len(rec.segments))
    if rec.status in ("queued", "transcribing", "summarizing"):
        raise HTTPException(status_code=409, detail=f"正在处理中：{rec.status}")
    rec.status = STATUS_QUEUED
    db.commit()
    if get_settings().sync_pipeline:  # 测试/调试：同步跑完
        process_recording(rec.id)
        db.refresh(rec)
    return FinishOut(id=rec.id, status=rec.status, segment_count=len(rec.segments))


@router.post("/recordings/{recording_id}/rerun", response_model=FinishOut)
def rerun_recording(
    recording_id: str,
    open_id: str = Depends(current_open_id),
    db: Session = Depends(get_db),
) -> FinishOut:
    rec = _owned(db, recording_id, open_id)
    if not rec.segments:
        raise HTTPException(status_code=400, detail="没有音频分段")
    if rec.status in ("queued", "transcribing", "summarizing"):
        raise HTTPException(status_code=409, detail=f"正在处理中：{rec.status}")
    rec.status = STATUS_QUEUED
    rec.error = ""
    db.commit()
    # worker 会在 2 秒内取走；sync 模式直接跑
    if get_settings().sync_pipeline:
        process_recording(rec.id)
    return FinishOut(id=rec.id, status=rec.status, segment_count=len(rec.segments))
