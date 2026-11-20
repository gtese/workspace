"""后台维护：过期音频清理、孤儿文件回收、数据库+音频备份。"""

from __future__ import annotations

import logging
import shutil
import sqlite3
import subprocess
import tarfile
import threading
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from . import storage
from .config import get_settings
from .db import SessionLocal
from .models import Recording

log = logging.getLogger(__name__)
_stop = threading.Event()


def cleanup_expired(days: int | None = None) -> int:
    """删除超过保留期的音频文件与分段记录，返回处理的录音数。"""
    days = days or get_settings().retention_days
    cutoff = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=days)
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


def cleanup_orphan_files(older_than_days: int = 1) -> int:
    """删除 data/recordings 下没有数据库记录、且超过 N 天的目录（异常中断残留）。"""
    db = SessionLocal()
    try:
        ids = {rid for (rid,) in db.query(Recording.id).all()}
    finally:
        db.close()

    root = get_settings().data_dir / "recordings"
    if not root.exists():
        return 0
    cutoff = time.time() - older_than_days * 86400
    count = 0
    for d in root.iterdir():
        if not d.is_dir() or d.name in ids:
            continue
        if d.stat().st_mtime > cutoff:
            continue
        shutil.rmtree(d, ignore_errors=True)
        count += 1
    if count:
        log.info("回收孤儿录音目录 %d 个", count)
    return count


def backup(out_dir: Path | None = None, keep: int = 7) -> Path:
    """打包数据库 + 音频到 tar.gz，保留最近 keep 份。"""
    s = get_settings()
    out_dir = out_dir or (s.data_dir.parent / "backups")
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    tmp = out_dir / f".tmp-{ts}"
    tmp.mkdir()

    try:
        if s.is_sqlite:
            db_file = Path(s.db_url.removeprefix("sqlite:///"))
            if db_file.exists():
                src = sqlite3.connect(str(db_file))
                dst = sqlite3.connect(str(tmp / "app.db"))
                with dst:
                    src.backup(dst)
                src.close()
                dst.close()
        else:
            subprocess.run(
                ["pg_dump", "-Fc", "-f", str(tmp / "fm.dump"), s.database_url],
                check=True,
            )
        recordings = s.data_dir / "recordings"
        if recordings.exists():
            shutil.copytree(recordings, tmp / "recordings")
        archive = out_dir / f"fm-backup-{ts}.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(tmp, arcname=".")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    archives = sorted(out_dir.glob("fm-backup-*.tar.gz"), key=lambda p: p.stat().st_mtime)
    for old in archives[:-keep] if keep > 0 else []:
        old.unlink(missing_ok=True)
    log.info("备份完成: %s (%.1f MB)", archive, archive.stat().st_size / 1048576)
    return archive
