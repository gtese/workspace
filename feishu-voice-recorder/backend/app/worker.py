"""单进程 DB 队列 worker：重启不丢任务，串行处理（2–4 核机器够用）。

M2 可换 Redis/RQ，接口保持不变。
"""

from __future__ import annotations

import logging
import threading

from .config import get_settings
from .db import SessionLocal
from .models import STATUS_QUEUED, STATUS_TRANSCRIBING, Recording
from .pipeline import process_recording

log = logging.getLogger(__name__)


class Worker:
    def __init__(self, poll_seconds: float = 2.0) -> None:
        self.poll_seconds = poll_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="fm-worker", daemon=True)
        self._thread.start()
        log.info("worker 已启动")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def process_one(self) -> bool:
        """认领一个 queued 任务并处理；没有任务返回 False。"""
        db = SessionLocal()
        try:
            rec = (
                db.query(Recording)
                .filter(Recording.status == STATUS_QUEUED)
                .order_by(Recording.created_at)
                .first()
            )
            if rec is None:
                return False
            rec.status = STATUS_TRANSCRIBING  # 先认领，避免被重复取走
            db.commit()
            rid = rec.id
        finally:
            db.close()
        process_recording(rid)
        return True

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                if self.process_one():
                    continue
            except Exception:  # noqa: BLE001
                log.exception("worker 处理异常")
            self._stop.wait(self.poll_seconds)


_worker: Worker | None = None


def start_worker() -> Worker | None:
    global _worker
    if not get_settings().worker_enabled:
        return None
    if _worker is None:
        _worker = Worker()
        _worker.start()
    return _worker


def stop_worker() -> None:
    global _worker
    if _worker:
        _worker.stop()
        _worker = None
