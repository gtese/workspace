"""上传入口：整文件音视频上传 → 转码 → 入队转写。"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy.orm import Session

from .. import audio, audit, storage
from ..config import get_settings
from ..db import get_db
from ..models import STATUS_QUEUED, Org, Recording, Segment, User
from ..ratelimit import enforce
from .deps import current_org, current_user
from .serializers import to_out

router = APIRouter(prefix="/api/v1", tags=["uploads"])

ALLOWED_EXT = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".amr": "audio/amr",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
}


@router.get("/uploads/limits")
def limits() -> dict:
    s = get_settings()
    return {
        "max_mb": s.upload_max_mb,
        "max_minutes": s.upload_max_minutes,
        "extensions": sorted(ALLOWED_EXT),
    }


@router.post("/uploads")
async def upload_media(
    request: Request,
    file: UploadFile = File(...),
    title: str = Form(default=""),
    user: User = Depends(current_user),
    org: Org = Depends(current_org),
    db: Session = Depends(get_db),
) -> dict:
    from ..billing import can_start_task

    enforce(user.id, "upload")
    if not can_start_task(db, org.id):
        raise HTTPException(status_code=402, detail="额度不足，请先充值")

    settings = get_settings()
    suffix = Path(file.filename or "upload").suffix.lower()
    if suffix not in ALLOWED_EXT:
        raise HTTPException(status_code=400, detail=f"不支持的文件类型 {suffix or '(无)'}")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="空文件")
    if len(data) > settings.upload_max_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"文件超过 {settings.upload_max_mb}MB")

    rec = Recording(
        org_id=org.id,
        owner_user_id=user.id,
        owner_open_id=user.feishu_open_id or "",
        title=(title.strip() or Path(file.filename or "上传音频").stem)[:200],
        source="upload",
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)

    raw = storage.recording_dir(rec.id) / f"source{suffix}"
    raw.write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    wav_path = storage.segment_path(rec.id, 0)
    try:
        if suffix == ".wav":
            shutil.copyfile(raw, wav_path)
            info = audio.inspect(wav_path)
        else:
            info = audio.convert_to_wav(raw, wav_path)
    except audio.WavError as exc:
        shutil.rmtree(storage.recording_dir(rec.id), ignore_errors=True)
        db.delete(rec)
        db.commit()
        raise HTTPException(status_code=400, detail=f"音频解析失败：{exc}") from exc
    finally:
        raw.unlink(missing_ok=True)

    minutes = info["duration"] / 60.0
    if minutes > settings.upload_max_minutes:
        shutil.rmtree(storage.recording_dir(rec.id), ignore_errors=True)
        db.delete(rec)
        db.commit()
        raise HTTPException(
            status_code=413, detail=f"音频超过 {settings.upload_max_minutes:g} 分钟上限"
        )

    db.add(
        Segment(
            recording_id=rec.id,
            idx=0,
            path=str(wav_path),
            size=wav_path.stat().st_size,
            sha256=digest,
            duration_sec=info["duration"],
        )
    )
    rec.duration_sec = int(round(info["duration"]))
    rec.status = STATUS_QUEUED
    db.commit()
    db.refresh(rec)

    audit.record(db, "recording.upload", request=request, org_id=org.id, user_id=user.id,
                 actor=user.email, target=rec.id,
                 detail={"filename": file.filename, "bytes": len(data), "minutes": round(minutes, 2)})
    if settings.sync_pipeline:  # 测试模式同步跑
        from ..pipeline import process_recording

        process_recording(rec.id)
        db.refresh(rec)
    return {"recording": to_out(rec).model_dump(), "minutes": round(minutes, 2)}
