"""过期音频清理：音频保留 90 天，纪要（转写 + 摘要）永久保留。"""

from __future__ import annotations

import logging
import shutil
import threading
from datetime import datetime, timedelta, timezone

from . import storage
from .config import get_settings
from .db import SessionLocal
from .models import Recording

log = logging.getLogger(__name__)
_stop = threading.Event()


def cleanup_expired(days: int | None = None) -> int:
    """删除超过保留期的音频文件与分段记录，返回处理的录音数。"""
    days = days or get_settings().retention_days
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)
    db = SessionLocal()
    count = 0
    try:
        rows = db.query(Recording).filter(Recording.created_at < cutoff).all()
        for rec in rows:
            shutil.rmtree(storage.recording_dir(rec.id), ignore_errors=True)
            rec.segments.clear()  # cascade 删除分段记录，纪要正文保留
            count += 1
        db.commit()
        if count:
            log.info("清理 %d 条过期音频（>%d 天）", count, days)
        return count
    finally:
        db.close()


def _loop(interval_seconds: int) -> None:
    while not _stop.wait(interval_seconds):
        try:
            cleanup_expired()
        except Exception:  # noqa: BLE001
            log.exception("音频清理失败")


def start_maintenance() -> None:
    interval = get_settings().retention_check_seconds
    threading.Thread(target=_loop, args=(interval,), name="fm-maintenance", daemon=True).start()


def stop_maintenance() -> None:
    _stop.set()
