import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import SessionLocal  # noqa: E402
from app.maintenance import cleanup_expired  # noqa: E402
from app.models import Recording, Segment  # noqa: E402
from app.storage import recording_dir  # noqa: E402


def test_cleanup_removes_audio_keeps_minutes(tmp_path: Path) -> None:
    db = SessionLocal()
    try:
        rec = Recording(owner_open_id="u_cleanup", title="老录音", scene="meeting")
        rec.transcript_json = '{"segments": []}'
        rec.summary_json = '{"summary": "保留的纪要"}'
        rec.created_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=120)
        db.add(rec)
        db.commit()
        db.refresh(rec)
        d = recording_dir(rec.id)
        audio = d / "seg_000.wav"
        audio.write_bytes(b"RIFF....WAVE")
        db.add(Segment(recording_id=rec.id, idx=0, path=str(audio), size=12))
        db.commit()
        rid = rec.id
    finally:
        db.close()

    assert cleanup_expired(90) >= 1
    assert not d.exists()

    db = SessionLocal()
    try:
        rec = db.get(Recording, rid)
        assert rec is not None
        assert rec.summary_json and "保留的纪要" in rec.summary_json
        assert len(rec.segments) == 0
    finally:
        db.close()


def test_cleanup_keeps_recent() -> None:
    db = SessionLocal()
    try:
        rec = Recording(owner_open_id="u_recent", title="新录音", scene="memo")
        db.add(rec)
        db.commit()
        rid = rec.id
    finally:
        db.close()

    cleanup_expired(90)

    db = SessionLocal()
    try:
        assert db.get(Recording, rid) is not None
    finally:
        db.close()
