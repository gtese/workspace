"""处理流水线：合并音频 → 转写 → 纪要 → 分发。"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import httpx
from sqlalchemy.orm import Session

from . import audio, storage
from .asr import get_asr_provider
from .config import get_settings
from .db import SessionLocal
from .feishu import FeishuClient, build_minutes_card
from .llm.summarize import SCENE_LABELS, summarize
from .models import (
    STATUS_DONE,
    STATUS_FAILED,
    STATUS_QUEUED,
    STATUS_SUMMARIZING,
    STATUS_TRANSCRIBED,
    STATUS_TRANSCRIBING,
    DeliveryLog,
    Recording,
)
from .security import hmac_sha256_hex, signed_url

log = logging.getLogger(__name__)


def requeue_interrupted() -> int:
    """服务重启后，把卡在转写/纪要中的任务重新排队（单 worker 假定，安全）。"""
    db: Session = SessionLocal()
    try:
        rows = (
            db.query(Recording)
            .filter(Recording.status.in_([STATUS_TRANSCRIBING, STATUS_SUMMARIZING]))
            .all()
        )
        for rec in rows:
            rec.status = STATUS_QUEUED
            rec.error = "服务重启，已重新排队"
        db.commit()
        return len(rows)
    finally:
        db.close()


def process_recording(recording_id: str) -> None:
    settings = get_settings()
    db: Session = SessionLocal()
    try:
        rec = db.get(Recording, recording_id)
        if rec is None:
            return
        _run(db, rec, settings)
    except Exception as exc:  # noqa: BLE001 - 流水线需要兜底
        log.exception("处理失败 %s", recording_id)
        rec = db.get(Recording, recording_id)
        if rec is not None:
            rec.status = STATUS_FAILED
            rec.error = str(exc)[:2000]
            db.commit()
    finally:
        db.close()


def _run(db: Session, rec: Recording, settings) -> None:  # noqa: ANN001
    segments = sorted(rec.segments, key=lambda s: s.idx)
    if not segments:
        raise RuntimeError("没有音频分段")

    rec.status = STATUS_TRANSCRIBING
    rec.error = ""
    db.commit()

    merged = storage.merged_path(rec.id)
    info = audio.merge([Path(s.path) for s in segments], merged)
    rec.duration_sec = int(round(info["duration"]))
    db.commit()

    # 腾讯需要公网 URL；mock 忽略
    public_url = signed_url(storage.rel_media_path(merged), ttl=6 * 3600)
    transcript = get_asr_provider().transcribe(merged, info["duration"], public_url)
    rec.transcript_json = json.dumps(transcript.to_dict(), ensure_ascii=False)
    rec.status = STATUS_TRANSCRIBED
    db.commit()

    rec.status = STATUS_SUMMARIZING
    db.commit()
    summary = summarize(transcript.plain_text(), rec.title, rec.scene)
    rec.summary_json = json.dumps(summary, ensure_ascii=False)
    db.commit()

    _distribute(db, rec, summary, settings)
    rec.status = STATUS_DONE
    db.commit()


def _distribute(db: Session, rec: Recording, summary: dict, settings) -> None:  # noqa: ANN001
    detail_url = f"{settings.public_base_url.rstrip('/')}/d/{rec.id}"

    # 1) 飞书卡片
    card = build_minutes_card(
        rec.title, SCENE_LABELS.get(rec.scene, "会议"), summary, detail_url
    )
    try:
        result = FeishuClient().send_card(rec.owner_open_id, card)
        db.add(
            DeliveryLog(
                recording_id=rec.id,
                channel="feishu",
                target=rec.owner_open_id,
                status="sent",
                detail=json.dumps(result, ensure_ascii=False),
            )
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("飞书推送失败")
        db.add(
            DeliveryLog(
                recording_id=rec.id, channel="feishu", target=rec.owner_open_id,
                status="failed", detail=str(exc)[:500],
            )
        )
    db.commit()

    # 2) 公司网站回调
    if settings.website_callback_url and settings.website_callback_secret:
        payload = json.dumps(
            {
                "event": "minutes.ready",
                "recording": {
                    "id": rec.id,
                    "title": rec.title,
                    "scene": rec.scene,
                    "duration_sec": rec.duration_sec,
                    "owner_open_id": rec.owner_open_id,
                    "created_at": rec.created_at.isoformat(),
                },
                "summary": summary,
                "detail_url": detail_url,
            },
            ensure_ascii=False,
        ).encode()
        sig = hmac_sha256_hex(settings.website_callback_secret, payload)
        status, detail = "failed", ""
        for attempt in range(3):
            try:
                resp = httpx.post(
                    settings.website_callback_url,
                    content=payload,
                    headers={"Content-Type": "application/json", "X-FM-Signature": sig},
                    timeout=10,
                )
                if resp.status_code < 300:
                    status, detail = "sent", f"HTTP {resp.status_code}"
                    break
                detail = f"HTTP {resp.status_code}"
            except httpx.HTTPError as exc:
                detail = str(exc)[:300]
            time.sleep(1 + attempt)
        db.add(
            DeliveryLog(
                recording_id=rec.id, channel="website",
                target=settings.website_callback_url, status=status, detail=detail,
            )
        )
        db.commit()
