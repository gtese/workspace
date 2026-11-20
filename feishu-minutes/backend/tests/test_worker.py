import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import SessionLocal  # noqa: E402
from app.models import STATUS_DONE, STATUS_QUEUED, Recording, Segment  # noqa: E402
from app.worker import Worker  # noqa: E402
from tests.test_audio import make_wav  # noqa: E402


def _make_queued(db, tmp_path: Path) -> str:
    rec = Recording(owner_open_id="u_worker", title="worker 测试", scene="meeting", status=STATUS_QUEUED)
    db.add(rec)
    db.commit()
    db.refresh(rec)
    p = make_wav(tmp_path / f"{rec.id}.wav", 1.0)
    db.add(Segment(recording_id=rec.id, idx=0, path=str(p), size=p.stat().st_size))
    db.commit()
    return rec.id


def test_process_one_completes(tmp_path: Path) -> None:
    db = SessionLocal()
    try:
        rid = _make_queued(db, tmp_path)
    finally:
        db.close()

    worker = Worker()
    assert worker.process_one() is True

    db = SessionLocal()
    try:
        rec = db.get(Recording, rid)
        assert rec.status == STATUS_DONE
        assert rec.summary_json
        assert rec.duration_sec >= 1
    finally:
        db.close()


def test_process_one_empty_queue() -> None:
    worker = Worker()
    assert worker.process_one() is False


def test_requeue_interrupted() -> None:
    from app.models import STATUS_QUEUED, STATUS_TRANSCRIBING
    from app.pipeline import requeue_interrupted

    db = SessionLocal()
    try:
        rec = Recording(owner_open_id="u_req", title="中断", scene="meeting", status=STATUS_TRANSCRIBING)
        db.add(rec)
        db.commit()
        rid = rec.id
    finally:
        db.close()

    assert requeue_interrupted() >= 1

    db = SessionLocal()
    try:
        assert db.get(Recording, rid).status == STATUS_QUEUED
    finally:
        db.close()
