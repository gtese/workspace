"""健康快照与看门狗告警。"""

from __future__ import annotations

import logging
import shutil
import threading
from datetime import UTC, datetime, timedelta

from .config import get_settings
from .db import SessionLocal
from .feishu.client import FeishuClient
from .models import Recording

log = logging.getLogger(__name__)
_stop = threading.Event()

ACTIVE = ("queued", "transcribing", "summarizing")


def snapshot() -> dict:
    settings = get_settings()
    db = SessionLocal()
    try:
        rows = db.query(Recording.status).all()
        counts: dict[str, int] = {}
        for (status,) in rows:
            counts[status] = counts.get(status, 0) + 1
        cutoff = datetime.now(UTC).replace(tzinfo=None) - timedelta(hours=24)
        failed_24h = (
            db.query(Recording)
            .filter(Recording.status == "failed", Recording.updated_at >= cutoff)
            .count()
        )
        oldest = (
            db.query(Recording.created_at)
            .filter(Recording.status == "queued")
            .order_by(Recording.created_at)
            .first()
        )
        oldest_minutes = None
        if oldest:
            created = oldest[0]
            if created.tzinfo is None:
                created = created.replace(tzinfo=UTC)
            oldest_minutes = round((datetime.now(UTC) - created).total_seconds() / 60, 1)
        db_ok = True
    except Exception as exc:  # noqa: BLE001
        log.exception("健康快照失败")
        return {"db_ok": False, "error": str(exc)[:200]}
    finally:
        db.close()

    disk = shutil.disk_usage(settings.data_dir) if settings.data_dir.exists() else None
    return {
        "db_ok": db_ok,
        "recordings": counts,
        "active": sum(counts.get(s, 0) for s in ACTIVE),
        "failed_24h": failed_24h,
        "oldest_queued_minutes": oldest_minutes,
        "disk_free_gb": round(disk.free / 1024**3, 1) if disk else None,
        "worker_count": settings.worker_count,
        "time": datetime.now(UTC).isoformat(),
    }


def _alert(message: str) -> None:
    settings = get_settings()
    log.warning("监控告警: %s", message)
    ids = [x.strip() for x in settings.alert_open_ids.split(",") if x.strip()]
    if not ids:
        return
    for open_id in ids:
        try:
            FeishuClient().send_text(open_id, f"[Trace Voice 告警] {message}")
        except Exception:  # noqa: BLE001
            log.exception("告警发送失败")


def check_once() -> list[str]:
    s = snapshot()
    problems: list[str] = []
    if not s.get("db_ok", True):
        problems.append("数据库不可用")
    if s.get("active", 0) > 20:
        problems.append(f"处理队列积压 {s['active']} 个任务")
    if (s.get("oldest_queued_minutes") or 0) > 30:
        problems.append(f"最早排队任务已等待 {s['oldest_queued_minutes']} 分钟")
    if s.get("failed_24h", 0) > 3:
        problems.append(f"24 小时内失败 {s['failed_24h']} 条")
    if s.get("disk_free_gb") is not None and s["disk_free_gb"] < 10:
        problems.append(f"磁盘剩余 {s['disk_free_gb']} GB")
    if problems:
        _alert("；".join(problems))
    return problems


def _loop(interval: int) -> None:
    while not _stop.wait(interval):
        try:
            check_once()
        except Exception:  # noqa: BLE001
            log.exception("看门狗执行失败")


def start_watchdog() -> None:
    s = get_settings()
    if not s.monitoring_enabled:
        return
    threading.Thread(target=_loop, args=(s.watchdog_seconds,), name="fm-watchdog", daemon=True).start()


def stop_watchdog() -> None:
    _stop.set()
