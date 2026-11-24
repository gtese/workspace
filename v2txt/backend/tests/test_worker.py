import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import SessionLocal  # noqa: E402
from app.models import STATUS_DONE, STATUS_QUEUED, Recording, Segment  # noqa: E402
from app.worker import Worker  # noqa: E402

from tests.test_audio import make_wav  # noqa: E402


def _owner_id(db) -> str:
    from app.models import User

    user = db.query(User).filter(User.email == "u_test@example.com").first()
    return user.id if user else ""


def _make_queued(db, tmp_path: Path) -> str:
    owner = _owner_id(db)
    rec = Recording(owner_user_id=owner, title="worker 测试", scene="meeting", status=STATUS_QUEUED)
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
    from app.accounts import hash_password
    from app.models import DeliveryLog, Membership, Org, User

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == "mailtest@example.com").first()
        if user is None:
            user = User(email="mailtest@example.com", password_hash=hash_password("Testpass123"), name="张三")
            db.add(user)
            db.flush()
            org = Org(name="mail test", kind="personal", owner_id=user.id)
            db.add(org)
            db.flush()
            db.add(Membership(org_id=org.id, user_id=user.id, role="owner"))
            user.default_org_id = org.id
            db.commit()
        rec = Recording(owner_user_id=user.id, org_id=user.default_org_id,
                        title="邮件测试", scene="client", status="queued")
        db.add(rec)
        db.commit()
        db.refresh(rec)
        p = make_wav(tmp_path / "m.wav", 1.0)
        db.add(Segment(recording_id=rec.id, idx=0, path=str(p), size=p.stat().st_size))
        db.commit()
        rid = rec.id
    finally:
        db.close()

    assert Worker().process_one() is True

    db = SessionLocal()
    try:
        logs = db.query(DeliveryLog).filter(DeliveryLog.recording_id == rid).all()
        email_logs = [x for x in logs if x.channel == "email"]
        assert email_logs and email_logs[0].status == "sent"
        assert email_logs[0].target == "mailtest@example.com"
    finally:
        db.close()


def test_monitoring_snapshot() -> None:
    from app.monitoring import snapshot

    s = snapshot()
    assert s["db_ok"] is True
    assert "recordings" in s
    assert "disk_free_gb" in s
