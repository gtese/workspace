"""单进程 DB 队列 worker：重启不丢任务，串行处理（2–4 核机器够用）。

M2 可换 Redis/RQ，接口保持不变。
"""

from __future__ import annotations

import logging
import threading

from sqlalchemy import select, update

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
        """原子认领一个 queued 任务并处理；没有任务返回 False。

        多 worker 并发时靠 ``UPDATE ... WHERE status='queued'`` 的 rowcount 保证只被认领一次。
        """
        db = SessionLocal()
        try:
            row = db.execute(
                select(Recording.id)
                .where(Recording.status == STATUS_QUEUED)
                .order_by(Recording.created_at)
                .limit(1)
            ).first()
            if row is None:
                return False
            rid = row[0]
            res = db.execute(
                update(Recording)
                .where(Recording.id == rid, Recording.status == STATUS_QUEUED)
                .values(status=STATUS_TRANSCRIBING)
            )
            db.commit()
            if res.rowcount == 0:  # 被其他 worker 抢先
                return False
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


_workers: list[Worker] = []


def start_worker() -> list[Worker]:
    global _workers
    if not get_settings().worker_enabled:
        return []
    if not _workers:
        for _ in range(max(1, get_settings().worker_count)):
            w = Worker()
            w.start()
            _workers.append(w)
    return _workers


def stop_worker() -> None:
    global _workers
    for w in _workers:
        w.stop()
    _workers = []
