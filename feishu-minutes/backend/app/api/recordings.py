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
)
from ..pipeline import process_recording
from ..schemas import FinishOut, RecordingCreate, RecordingOut
from ..security import signed_url
from .deps import current_open_id

router = APIRouter(prefix="/api/v1", tags=["recordings"])

MAX_SEGMENT_BYTES = 80 * 1024 * 1024


def _owned(db: Session, recording_id: str, open_id: str) -> Recording:
    rec = db.get(Recording, recording_id)
    if rec is None or rec.owner_open_id != open_id:
        raise HTTPException(status_code=404, detail="录音不存在")
    return rec


def _to_out(rec: Recording, include_detail: bool = False) -> RecordingOut:
    data = RecordingOut(
        id=rec.id,
        title=rec.title,
        scene=rec.scene,
        status=rec.status,
        duration_sec=rec.duration_sec,
        created_at=rec.created_at.isoformat(),
        segment_count=len(rec.segments),
        error=rec.error,
    )
    if include_detail:
        import json

        audio_file = storage.merged_path(rec.id)
        data.transcript = (
            json.loads(rec.transcript_json).get("segments") if rec.transcript_json else None
        )
        data.summary = json.loads(rec.summary_json) if rec.summary_json else None
        if audio_file.exists():
            data.audio_url = signed_url(storage.rel_media_path(audio_file))
    return data


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
    return _to_out(rec)


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
    return [_to_out(r) for r in rows]


@router.get("/recordings/{recording_id}", response_model=RecordingOut)
def get_recording(
    recording_id: str,
    open_id: str = Depends(current_open_id),
    db: Session = Depends(get_db),
) -> RecordingOut:
    return _to_out(_owned(db, recording_id, open_id), include_detail=True)


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

    path, digest = storage.save_segment(rec.id, idx, data)
    try:
        info = audio.inspect(path)
    except audio.WavError as exc:
        path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    existing = next((s for s in rec.segments if s.idx == idx), None)
    if existing:
        existing.path = str(path)
        existing.size = len(data)
        existing.sha256 = digest
        existing.duration_sec = info["duration"]
    else:
        db.add(
            Segment(
                recording_id=rec.id,
                idx=idx,
                path=str(path),
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
    return _to_out(rec)


@router.post("/recordings/{recording_id}/finish", response_model=FinishOut)
def finish_recording(
    recording_id: str,
    open_id: str = Depends(current_open_id),
    db: Session = Depends(get_db),
) -> FinishOut:
    rec = _owned(db, recording_id, open_id)
    if not rec.segments:
        raise HTTPException(status_code=400, detail="还没有上传任何分段")
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
    rec.status = STATUS_QUEUED
    rec.error = ""
    db.commit()
    # worker 会在 2 秒内取走；sync 模式直接跑
    if get_settings().sync_pipeline:
        process_recording(rec.id)
    return FinishOut(id=rec.id, status=rec.status, segment_count=len(rec.segments))
