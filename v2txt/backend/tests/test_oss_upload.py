"""浏览器直传 OSS：预签名、落位入库、路径校验。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api import uploads_oss  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import Recording, Segment  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from .conftest import headers_for  # noqa: E402
from .test_audio import make_wav  # noqa: E402


def _enable(monkeypatch) -> None:
    base = get_settings()
    settings = base.model_copy(
        update={
            "oss_bucket": "v2txtbyai",
            "oss_region": "cn-hangzhou",
            "oss_access_key": "AKTEST",
            "oss_secret_key": "SKTEST",
            "oss_upload_enabled": True,
            "sync_pipeline": False,
        }
    )
    monkeypatch.setattr(uploads_oss, "get_settings", lambda: settings)
    monkeypatch.setattr(uploads_oss, "get_settings", lambda: settings)
    monkeypatch.setattr("app.config.get_settings", lambda: settings)
    monkeypatch.setattr("app.oss.get_settings", lambda: settings)


def test_presign_returns_signed_put_url(client: TestClient, monkeypatch) -> None:
    _enable(monkeypatch)
    r = client.post(
        "/api/v1/uploads/presign",
        json={"filename": "会议.mp3", "content_type": "audio/mpeg"},
        headers=headers_for("u_test"),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["recording_id"].startswith("rec_")
    assert body["key"].endswith(".mp3")
    assert "OSSAccessKeyId=AKTEST" in body["put_url"] and "Signature=" in body["put_url"]
    assert body["headers"]["Content-Type"] == "audio/mpeg"


def test_complete_ingests_object(client: TestClient, monkeypatch, tmp_path: Path) -> None:
    _enable(monkeypatch)
    r = client.post(
        "/api/v1/uploads/presign",
        json={"filename": "a.wav", "content_type": "audio/wav"},
        headers=headers_for("u_test"),
    ).json()
    rec_id = r["recording_id"]
    wav_bytes = make_wav(tmp_path / "x.wav", 1.0).read_bytes()

    monkeypatch.setattr(uploads_oss.oss, "fetch", lambda key, timeout=120: wav_bytes)
    monkeypatch.setattr(uploads_oss.oss, "delete", lambda key: True)
    done = client.post(
        f"/api/v1/uploads/{rec_id}/complete",
        json={"key": r["key"], "title": "直传测试"},
        headers=headers_for("u_test"),
    )
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "queued"

    db = SessionLocal()
    try:
        segs = db.query(Segment).filter(Segment.recording_id == rec_id).all()
        assert len(segs) == 1 and segs[0].duration_sec > 0
        # 清掉队列里的任务，避免影响其它用例（worker 测试会断言空队列）
        rec = db.get(Recording, rec_id)
        db.delete(rec)
        db.commit()
    finally:
        db.close()


def test_complete_rejects_foreign_key(client: TestClient, monkeypatch) -> None:
    _enable(monkeypatch)
    r = client.post(
        "/api/v1/uploads/presign",
        json={"filename": "a.wav"},
        headers=headers_for("u_test"),
    ).json()
    bad = client.post(
        f"/api/v1/uploads/{r['recording_id']}/complete",
        json={"key": "v2txt/other-org/rec_x/source.wav"},
        headers=headers_for("u_test"),
    )
    assert bad.status_code == 403


def test_oss_disabled_returns_400(client: TestClient) -> None:
    assert client.get("/api/v1/uploads/oss").json()["enabled"] is False
    r = client.post("/api/v1/uploads/presign", json={"filename": "a.wav"}, headers=headers_for("u_test"))
    assert r.status_code == 400
