"""浏览器直传 OSS：后端只签发 URL 和落位后的入库，不经手大文件流量。"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import audio, audit, oss, storage
from ..config import get_settings
from ..db import get_db
from ..models import STATUS_QUEUED, Org, Recording, Segment, User
from ..ratelimit import enforce
from .deps import current_org, current_user

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["uploads-oss"])

ALLOWED_EXT = {
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".amr",
    ".mp4", ".mov", ".mkv", ".webm",
}


class PresignIn(BaseModel):
    filename: str = Field(max_length=255)
    content_type: str = Field(default="", max_length=120)


class CompleteIn(BaseModel):
    key: str = Field(max_length=500)
    title: str = Field(default="", max_length=200)


@router.get("/uploads/oss")
def oss_status() -> dict:
    s = get_settings()
    return {
        "enabled": oss.enabled() and s.oss_upload_enabled,
        "bucket": s.oss_bucket if oss.enabled() else "",
        "region": s.oss_region if oss.enabled() else "",
        "max_mb": s.upload_max_mb,
        "max_minutes": s.upload_max_minutes,
    }


@router.post("/uploads/presign")
def presign_upload(
    body: PresignIn,
    request: Request,
    user: User = Depends(current_user),
    org: Org = Depends(current_org),
    db: Session = Depends(get_db),
) -> dict:
    from ..billing import can_start_task

    if not (oss.enabled() and get_settings().oss_upload_enabled):
        raise HTTPException(status_code=400, detail="对象存储直传未启用")
    enforce(user.id, "upload")
    if not can_start_task(db, org.id):
        raise HTTPException(status_code=402, detail="额度不足，请先充值")

    suffix = Path(body.filename or "upload").suffix.lower()
    if suffix not in ALLOWED_EXT:
        raise HTTPException(status_code=400, detail=f"不支持的文件类型 {suffix or '(无)'}")

    rec = Recording(
        org_id=org.id,
        owner_user_id=user.id,
        owner_open_id=user.feishu_open_id or "",
        title=(Path(body.filename or "上传音频").stem)[:200],
        source="upload",
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)

    key = oss.object_key(org.id, rec.id, suffix)
    put_url = oss.presign("PUT", key, content_type=body.content_type)
    audit.record(db, "recording.upload", request=request, org_id=org.id, user_id=user.id,
                 actor=user.email, target=rec.id,
                 detail={"mode": "oss_presign", "filename": body.filename, "key": key})
    return {
        "recording_id": rec.id,
        "key": key,
        "put_url": put_url,
        "method": "PUT",
        "headers": {"Content-Type": body.content_type} if body.content_type else {},
        "expires_in": get_settings().oss_presign_ttl,
    }


@router.post("/uploads/{recording_id}/complete")
async def complete_upload(
    recording_id: str,
    body: CompleteIn,
    request: Request,
    user: User = Depends(current_user),
    org: Org = Depends(current_org),
    db: Session = Depends(get_db),
) -> dict:
    """浏览器直传完成后调用：服务端从 OSS 拉回、解码、入队。"""
    settings = get_settings()
    rec = db.get(Recording, recording_id)
    if rec is None or rec.org_id != org.id:
        raise HTTPException(status_code=404, detail="录音不存在")
    if not body.key.startswith(f"{settings.oss_prefix}/{org.id}/"):
        raise HTTPException(status_code=403, detail="对象路径不匹配")

    try:
        data = oss.fetch(body.key)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"取回文件失败：{exc}") from exc
    if not data:
        raise HTTPException(status_code=400, detail="空文件")
    if len(data) > settings.upload_max_mb * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"文件超过 {settings.upload_max_mb}MB")

    suffix = Path(body.key).suffix.lower() or ".bin"
    raw = storage.recording_dir(rec.id) / f"source{suffix}"
    raw.write_bytes(data)
    wav_path = storage.segment_path(rec.id, 0)
    try:
        if suffix == ".wav":
            wav_path.write_bytes(data)
            info = audio.inspect(wav_path)
        else:
            info = audio.convert_to_wav(raw, wav_path)
    except audio.WavError as exc:
        raw.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"音频解析失败：{exc}") from exc
    finally:
        raw.unlink(missing_ok=True)

    minutes = info["duration"] / 60.0
    if minutes > settings.upload_max_minutes:
        raise HTTPException(status_code=413, detail=f"音频超过 {settings.upload_max_minutes:g} 分钟上限")

    db.add(
        Segment(
            recording_id=rec.id,
            idx=0,
            path=str(wav_path),
            size=wav_path.stat().st_size,
            sha256=hashlib.sha256(data).hexdigest(),
            duration_sec=info["duration"],
        )
    )
    rec.duration_sec = int(round(info["duration"]))
    rec.status = STATUS_QUEUED
    if body.title.strip():
        rec.title = body.title.strip()[:200]
    db.commit()
    db.refresh(rec)

    if settings.sync_pipeline:
        from ..pipeline import process_recording

        process_recording(rec.id)
        db.refresh(rec)
    oss.delete(body.key)  # 音频已落地本地，OSS 副本即可删掉，省存储
    return {"recording_id": rec.id, "status": rec.status, "minutes": round(minutes, 2)}
