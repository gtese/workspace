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
from .asr.base import AudioChunk
from .config import get_settings
from .db import SessionLocal
from .email_send import EmailSender, build_minutes_email
from .feishu import FeishuClient, build_minutes_card
from .feishu.docs import FeishuDocClient
from .llm.summarize import SCENE_LABELS, summarize
from .models import (
    STATUS_DONE,
    STATUS_FAILED,
    STATUS_QUEUED,
    STATUS_SUMMARIZING,
    STATUS_TRANSCRIBED,
    STATUS_TRANSCRIBING,
    DeliveryLog,
    Document,
    DriveFolder,
    Employee,
    Recording,
    SpeakerName,
)
from .security import hmac_sha256_hex, share_url, signed_url

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
    t_merge = time.time()
    info = audio.merge([Path(s.path) for s in segments], merged)
    log.info("合并 %s: %.1f 秒音频 / %d 段，耗时 %.2fs", rec.id, info["duration"], len(segments), time.time() - t_merge)
    rec.duration_sec = int(round(info["duration"]))
    db.commit()

    # 腾讯需要公网 URL；mock 忽略
    public_url = signed_url(storage.rel_media_path(merged), ttl=6 * 3600)
    chunks: list[AudioChunk] = []
    offset = 0.0
    for seg in segments:
        seg_path = Path(seg.path)
        try:
            seg_url = signed_url(storage.rel_media_path(seg_path), ttl=6 * 3600)
        except ValueError:  # 不在 data 目录（例如测试里的临时文件）
            seg_url = ""
        chunks.append(
            AudioChunk(
                path=seg_path,
                public_url=seg_url,
                offset=offset,
                duration=float(seg.duration_sec or 0.0),
            )
        )
        offset += float(seg.duration_sec or 0.0)

    t_asr = time.time()
    transcript = get_asr_provider().transcribe(
        merged, info["duration"], public_url, chunks=chunks
    )
    log.info("转写 %s: %d 段文本，耗时 %.2fs", rec.id, len(transcript.segments), time.time() - t_asr)
    rec.transcript_json = json.dumps(transcript.to_dict(), ensure_ascii=False)
    rec.status = STATUS_TRANSCRIBED
    db.commit()

    rec.status = STATUS_SUMMARIZING
    db.commit()
    llm_text = transcript.plain_text()
    names = {
        x.speaker: x.name
        for x in db.query(SpeakerName).filter(SpeakerName.recording_id == rec.id).all()
    }
    if names:  # 说话人已改名，喂给 LLM 的文本用真实姓名
        llm_text = "\n".join(
            f"{names.get(s.speaker, s.speaker)}：{s.text}" for s in transcript.segments
        )
    summary = summarize(llm_text, rec.title, rec.scene)
    rec.summary_json = json.dumps(summary, ensure_ascii=False)
    db.commit()

    _distribute(db, rec, summary, settings)
    rec.status = STATUS_DONE
    db.commit()


def _distribute(db: Session, rec: Recording, summary: dict, settings) -> None:  # noqa: ANN001
    detail_url = share_url(rec.id)

    # 1) 同步为飞书云文档（失败不阻塞卡片）
    doc_url = ""
    doc_hint = ""
    if settings.feishu_mode == "real" and settings.feishu_doc_enabled:
        try:
            client = FeishuDocClient()
            folder_token = ""
            try:
                row = db.get(DriveFolder, rec.owner_open_id)
                if row and row.folder_token:
                    folder_token = row.folder_token
                else:
                    folder_token = client.create_user_folder(rec.owner_open_id)
                    db.add(DriveFolder(open_id=rec.owner_open_id, folder_token=folder_token))
                    db.commit()
            except Exception:  # noqa: BLE001
                log.exception("创建 AI录音 目录失败，文档将放在云盘根目录")
                folder_token = ""
            info = client.create_minutes_doc(
                rec.title, summary, detail_url, rec.owner_open_id, folder_token
            )
            if folder_token:
                doc_hint = "📁 已保存到飞书云盘「AI录音」目录"
            doc_url = info["url"]
            db.add(Document(recording_id=rec.id, doc_id=info["document_id"], url=doc_url))
            db.commit()
            log.info("已同步飞书文档: %s", doc_url)
        except Exception as exc:  # noqa: BLE001
            log.exception("同步飞书文档失败")
            db.add(
                DeliveryLog(
                    recording_id=rec.id, channel="feishu_doc", target=rec.owner_open_id,
                    status="failed", detail=str(exc)[:500],
                )
            )
            db.commit()

    # 2) 飞书卡片
    card = build_minutes_card(
        rec.title, SCENE_LABELS.get(rec.scene, "会议"), summary, detail_url, doc_url, doc_hint
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

    # 3) 公司网站回调
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

    # 4) 邮件（发给录音本人；未配置 SMTP 时 mock 落盘）
    emp = db.get(Employee, rec.owner_open_id)
    if emp is not None and emp.email:
        subject, html = build_minutes_email(rec.title, summary, detail_url)
        try:
            result = EmailSender().send(emp.email, subject, html)
            db.add(
                DeliveryLog(
                    recording_id=rec.id, channel="email", target=emp.email,
                    status="sent", detail=json.dumps(result, ensure_ascii=False),
                )
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("邮件发送失败")
            db.add(
                DeliveryLog(
                    recording_id=rec.id, channel="email", target=emp.email,
                    status="failed", detail=str(exc)[:500],
                )
            )
        db.commit()
