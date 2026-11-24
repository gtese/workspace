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
        from app import audio as audio_mod
        from app.storage import merged_m4a_path, merged_path

        if audio_mod.ffmpeg_path():
            assert merged_m4a_path(rid).exists(), "转写后应压缩为 m4a"
            assert not merged_path(rid).exists(), "wav 应已删除"
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
        rec = db.get(Recording, rid)
        assert rec.status == STATUS_QUEUED
        db.delete(rec)  # 清理，避免污染后续用例的队列
        db.commit()
    finally:
        db.close()


def test_pipeline_distributes_email(tmp_path: Path) -> None:
    from app.models import DeliveryLog, Employee
    from app.storage import data_dir

    db = SessionLocal()
    try:
        emp = db.get(Employee, "u_mail") or Employee(open_id="u_mail", name="张三", email="zs@example.com")
        db.add(emp)
        rec = Recording(owner_open_id="u_mail", title="邮件测试", scene="client", status="queued")
        db.add(rec)
        db.commit()
        db.refresh(rec)
        p = make_wav(tmp_path / "m.wav", 1.0)
        db.add(Segment(recording_id=rec.id, idx=0, path=str(p), size=p.stat().st_size))
        db.commit()
        rid = rec.id
    finally:
        db.close()

    outbox = data_dir() / "outbox"
    before = {x.name for x in outbox.glob("email-*.json")} if outbox.exists() else set()

    assert Worker().process_one() is True

    db = SessionLocal()
    try:
        logs = db.query(DeliveryLog).filter(DeliveryLog.recording_id == rid).all()
        email_logs = [x for x in logs if x.channel == "email"]
        assert email_logs and email_logs[0].status == "sent"
        assert email_logs[0].target == "zs@example.com"
    finally:
        db.close()

    after = {x.name for x in outbox.glob("email-*.json")}
    assert after - before


def test_monitoring_snapshot() -> None:
    from app.monitoring import snapshot

    s = snapshot()
    assert s["db_ok"] is True
    assert "recordings" in s
    assert "disk_free_gb" in s
