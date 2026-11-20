import hashlib
import hmac
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import pipeline  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import DeliveryLog, Recording, Segment  # noqa: E402
from app.worker import Worker  # noqa: E402

from tests.test_audio import make_wav  # noqa: E402


def _drain() -> None:
    worker = Worker()
    while worker.process_one():
        pass


def _queued_recording(db, owner: str, tmp_path: Path) -> str:
    rec = Recording(owner_open_id=owner, title="分发测试", scene="meeting", status="queued")
    db.add(rec)
    db.commit()
    db.refresh(rec)
    p = make_wav(tmp_path / f"{rec.id}.wav", 1.0)
    db.add(Segment(recording_id=rec.id, idx=0, path=str(p), size=p.stat().st_size))
    db.commit()
    return rec.id


def test_website_callback_signed(monkeypatch, tmp_path: Path) -> None:
    settings = get_settings().model_copy(
        update={
            "website_callback_url": "https://example.com/hook",
            "website_callback_secret": "test-secret",
        }
    )
    monkeypatch.setattr(pipeline, "get_settings", lambda: settings)

    captured: dict = {}

    class Resp:
        status_code = 200

    def fake_post(url, content=None, headers=None, timeout=None):
        captured.update(url=url, body=content, headers=headers)
        return Resp()

    monkeypatch.setattr(pipeline.httpx, "post", fake_post)

    _drain()
    db = SessionLocal()
    try:
        rid = _queued_recording(db, "u_web", tmp_path)
    finally:
        db.close()

    assert Worker().process_one() is True
    assert captured["url"] == "https://example.com/hook"
    expected = hmac.new(
        b"test-secret", captured["body"], hashlib.sha256
    ).hexdigest()
    assert captured["headers"]["X-FM-Signature"] == expected

    payload = json.loads(captured["body"])
    assert payload["event"] == "minutes.ready"
    assert payload["recording"]["id"] == rid
    assert payload["summary"]["summary"]
    assert "/s/" in payload["detail_url"] and "sig=" in payload["detail_url"]

    db = SessionLocal()
    try:
        logs = db.query(DeliveryLog).filter(DeliveryLog.recording_id == rid).all()
        channels = {x.channel: x for x in logs}
        assert channels["website"].status == "sent"
        assert channels["feishu"].status == "sent"
        assert channels["feishu"].detail.startswith('{"mode": "mock"')
    finally:
        db.close()


def test_website_callback_failure_recorded(monkeypatch, tmp_path: Path) -> None:
    settings = get_settings().model_copy(
        update={
            "website_callback_url": "https://example.com/hook",
            "website_callback_secret": "test-secret",
        }
    )
    monkeypatch.setattr(pipeline, "get_settings", lambda: settings)
    monkeypatch.setattr(pipeline.time, "sleep", lambda *_: None)

    class Resp:
        status_code = 500

    monkeypatch.setattr(pipeline.httpx, "post", lambda *a, **k: Resp())

    _drain()
    db = SessionLocal()
    try:
        rid = _queued_recording(db, "u_web2", tmp_path)
    finally:
        db.close()

    assert Worker().process_one() is True

    db = SessionLocal()
    try:
        logs = db.query(DeliveryLog).filter(DeliveryLog.recording_id == rid).all()
        web = [x for x in logs if x.channel == "website"][0]
        assert web.status == "failed"
        assert "500" in web.detail
    finally:
        db.close()
