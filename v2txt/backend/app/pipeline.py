"""处理流水线：合并音频 → 转写 → 纪要 → 分发。"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import httpx
from sqlalchemy.orm import Session

from . import audio, mailer, storage
from .asr import get_asr_provider
from .asr.base import AudioChunk
from .config import get_settings
from .db import SessionLocal
from .email_send import build_minutes_email
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
    Recording,
    SpeakerName,
    User,
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


def _compact_audio(rec: Recording, seg_files: list[Path], wav: Path) -> bool:
    """转写完成后：WAV 转 AAC/m4a，删除分段文件，只留压缩后的合并文件。"""
    m4a = storage.merged_m4a_path(rec.id)
    try:
        audio.convert_to_m4a(wav, m4a)
    except Exception:  # noqa: BLE001
        log.exception("音频压缩失败，保留 WAV")
        return False
    wav_mb = wav.stat().st_size / 1048576
    wav.unlink(missing_ok=True)
    for path in seg_files:
        path.unlink(missing_ok=True)
    log.info("音频压缩完成 %s: %.1fMB -> %.1fMB", rec.id, wav_mb, m4a.stat().st_size / 1048576)
    return True


def _run(db: Session, rec: Recording, settings) -> None:  # noqa: ANN001
    segments = sorted(rec.segments, key=lambda s: s.idx)
    rec.status = STATUS_TRANSCRIBING
    rec.error = ""
    db.commit()

    merged_wav = storage.merged_path(rec.id)
    merged_m4a = storage.merged_m4a_path(rec.id)
    seg_files = [Path(seg.path) for seg in segments]
    has_all_segments = bool(seg_files) and all(p.exists() for p in seg_files)

    if has_all_segments:
        t_merge = time.time()
        info = audio.merge(seg_files, merged_wav)
        log.info(
            "合并 %s: %.1f 秒音频 / %d 段，耗时 %.2fs",
            rec.id, info["duration"], len(segments), time.time() - t_merge,
        )
        rec.duration_sec = int(round(info["duration"]))
        source = merged_wav
        db.commit()
    elif merged_wav.exists():
        source = merged_wav
        if not rec.duration_sec:
            rec.duration_sec = int(round(audio.inspect(merged_wav)["duration"]))
            db.commit()
        log.info("复用已有合并音频 %s", rec.id)
    elif merged_m4a.exists():
        if not rec.duration_sec:
            raise RuntimeError("音频已压缩且缺少时长，无法重新处理")
        source = merged_m4a
        log.info("复用已压缩音频 %s", rec.id)
    else:
        raise RuntimeError("音频文件已清理，无法重新处理")

    # 腾讯/阿里 filetrans 需要公网 URL
    public_url = signed_url(storage.rel_media_path(source), ttl=6 * 3600)
    chunks: list[AudioChunk] = []
    offset = 0.0
    for seg in segments:
        seg_path = Path(seg.path)
        if not seg_path.exists():
            offset += float(seg.duration_sec or 0.0)
            continue
        try:
            seg_url = signed_url(storage.rel_media_path(seg_path), ttl=6 * 3600)
        except ValueError:
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
        source, float(rec.duration_sec or 0.0), public_url, chunks=chunks
    )
    log.info("转写 %s: %d 段文本，耗时 %.2fs", rec.id, len(transcript.segments), time.time() - t_asr)
    rec.transcript_json = json.dumps(transcript.to_dict(), ensure_ascii=False)
    rec.status = STATUS_TRANSCRIBED
    db.commit()

    if source == merged_wav and merged_wav.exists():
        _compact_audio(rec, seg_files, merged_wav)

    rec.status = STATUS_SUMMARIZING
    db.commit()
    llm_text = transcript.plain_text()
    names = {
        x.speaker: x.name
        for x in db.query(SpeakerName).filter(SpeakerName.recording_id == rec.id).all()
    }
    if names:
        llm_text = "\n".join(
            f"{names.get(s.speaker, s.speaker)}：{s.text}" for s in transcript.segments
        )
    summary = summarize(llm_text, rec.title, rec.scene)
    rec.summary_json = json.dumps(summary, ensure_ascii=False)
    db.commit()

    _distribute(db, rec, summary, settings)
    rec.status = STATUS_DONE
    db.commit()

    # 结算：扣额度 + 记录成本
    try:
        from .billing import charge_task

        seconds = float(rec.duration_sec or 0.0)
        asr_cost = seconds / 3600.0 * float(settings.asr_price_per_hour)
        chars = len(llm_text or "")
        llm_cost = (chars / 1000.0) * 0.002 + 0.001
        charge_task(
            db, rec.org_id, rec.id, seconds, asr_cost_cny=asr_cost, llm_cost_cny=llm_cost
        )
        log.info("结算 %s: %.1fs 音频, 成本 %.4f 元", rec.id, seconds, asr_cost + llm_cost)
    except Exception:  # noqa: BLE001
        log.exception("结算失败 %s", rec.id)


def _distribute(db: Session, rec: Recording, summary: dict, settings) -> None:  # noqa: ANN001
    detail_url = share_url(rec.id)
    # 飞书通道：open_id 可能只存在 User 上（v2 账号体系）
    open_id = rec.owner_open_id
    if not open_id and rec.owner_user_id:
        owner = db.get(User, rec.owner_user_id)
        open_id = (owner.feishu_open_id or "") if owner is not None else ""

    # 1) 同步为飞书云文档（失败不阻塞卡片）
    doc_url = ""
    doc_hint = ""
    if settings.feishu_mode == "real" and settings.feishu_doc_enabled and open_id:
        try:
            client = FeishuDocClient()
            folder_token = ""
            try:
                from .feishu.folder_sync import ensure_folder_from_user, sync_folder_from_user

                synced = sync_folder_from_user(open_id)
                if synced:
                    folder_token = synced
                row = db.get(DriveFolder, open_id)
                if row and row.folder_token:
                    folder_token = row.folder_token
                created = ensure_folder_from_user(open_id)
                if created:
                    folder_token = created
                elif not folder_token:
                    folder_token = client.create_user_folder(open_id)
                    db.add(DriveFolder(open_id=open_id, folder_token=folder_token))
                    db.commit()
            except Exception:  # noqa: BLE001
                log.exception("创建 AI录音 目录失败，文档将放在云盘根目录")
                folder_token = ""
            info = client.create_minutes_doc(
                rec.title, summary, detail_url, open_id, folder_token
            )
            doc_url = info["url"]
            if info.get("folder_ok"):
                doc_hint = "📁 已保存到飞书云盘「AI录音」目录"
            else:
                doc_hint = "📁 已保存到你的飞书云盘"
            db.add(Document(recording_id=rec.id, doc_id=info["document_id"], url=doc_url))
            db.commit()
            log.info("已同步飞书文档: %s", doc_url)
        except Exception as exc:  # noqa: BLE001
            log.exception("同步飞书文档失败")
            db.add(
                DeliveryLog(
                    recording_id=rec.id, channel="feishu_doc", target=open_id,
                    status="failed", detail=str(exc)[:500],
                )
            )
            db.commit()

    # 2) 飞书卡片（仅飞书通道用户）
    card = build_minutes_card(
        rec.title, SCENE_LABELS.get(rec.scene, "会议"), summary, detail_url, doc_url, doc_hint
    )
    if open_id and settings.feishu_mode == "real" and settings.feishu_card_enabled:
        try:
            result = FeishuClient().send_card(open_id, card)
            db.add(
                DeliveryLog(
                    recording_id=rec.id,
                    channel="feishu",
                    target=open_id,
                    status="sent",
                    detail=json.dumps(result, ensure_ascii=False),
                )
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("飞书推送失败")
            db.add(
                DeliveryLog(
                    recording_id=rec.id, channel="feishu", target=open_id,
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

    # 4) 邮件（发给录音所属账号；未配置 SMTP 时 mock 落日志）
    owner = db.get(User, rec.owner_user_id) if rec.owner_user_id else None
    if owner is not None and owner.email and settings.email_minutes_auto:
        subject, html = build_minutes_email(rec.title, summary, detail_url)
        ok = mailer.send_mail(owner.email, subject, html, html)
        db.add(
            DeliveryLog(
                recording_id=rec.id,
                channel="email",
                target=owner.email,
                status="sent" if ok else "failed",
                detail="" if ok else "SMTP 发送失败",
            )
        )
        db.commit()
