import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402
from app.storage import data_dir  # noqa: E402

from tests.test_audio import make_wav  # noqa: E402

HEADERS = {"X-Employee-Open-Id": "u_test"}


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _upload(client: TestClient, rid: str, idx: int, path: Path):
    with path.open("rb") as fh:
        return client.post(
            f"/api/v1/recordings/{rid}/segments?idx={idx}",
            files={"file": (path.name, fh, "audio/wav")},
            headers=HEADERS,
        )


def test_full_flow(client: TestClient, tmp_path: Path) -> None:
    r = client.post("/api/v1/recordings", json={"title": "POC 会议", "scene": "meeting"}, headers=HEADERS)
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    assert r.json()["status"] == "created"

    seg1 = make_wav(tmp_path / "s0.wav", 2.0)
    seg2 = make_wav(tmp_path / "s1.wav", 2.0)
    assert _upload(client, rid, 0, seg1).status_code == 200
    r = _upload(client, rid, 1, seg2)
    assert r.status_code == 200, r.text
    assert r.json()["segment_count"] == 2

    r = client.post(f"/api/v1/recordings/{rid}/finish", headers=HEADERS)
    assert r.status_code == 200, r.text

    r = client.get(f"/api/v1/recordings/{rid}", headers=HEADERS)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "done", body
    assert body["duration_sec"] >= 3
    assert body["summary"] and body["summary"]["summary"]
    assert len(body["transcript"]) >= 1
    assert body["audio_url"]

    # 签名 URL 可播放；篡改签名被拒
    url = body["audio_url"].replace("http://127.0.0.1:8000", "")
    assert client.get(url).status_code == 200
    assert client.get(url[:-4] + "0000").status_code == 403


def test_upload_rejects_non_wav(client: TestClient) -> None:
    r = client.post("/api/v1/recordings", json={"title": "t", "scene": "memo"}, headers=HEADERS)
    rid = r.json()["id"]
    r = client.post(
        f"/api/v1/recordings/{rid}/segments?idx=0",
        files={"file": ("x.wav", io.BytesIO(b"not-a-wav"), "audio/wav")},
        headers=HEADERS,
    )
    assert r.status_code == 400
    assert not list((data_dir() / "recordings" / rid).glob("*.wav"))


def test_owner_isolation(client: TestClient) -> None:
    r = client.post("/api/v1/recordings", json={"title": "私密", "scene": "client"}, headers=HEADERS)
    rid = r.json()["id"]
    r = client.get(f"/api/v1/recordings/{rid}", headers={"X-Employee-Open-Id": "other"})
    assert r.status_code == 404


def test_finish_requires_segments(client: TestClient) -> None:
    r = client.post("/api/v1/recordings", json={"title": "空", "scene": "meeting"}, headers=HEADERS)
    rid = r.json()["id"]
    r = client.post(f"/api/v1/recordings/{rid}/finish", headers=HEADERS)
    assert r.status_code == 400


def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["asr_provider"] == "mock"


def test_next_segment_index(client: TestClient, tmp_path: Path) -> None:
    r = client.post("/api/v1/recordings", json={"title": "续录", "scene": "meeting"}, headers=HEADERS)
    rid = r.json()["id"]
    _upload(client, rid, 0, make_wav(tmp_path / "a.wav", 1.0))
    r = _upload(client, rid, 1, make_wav(tmp_path / "b.wav", 1.0))
    assert r.json()["next_segment_index"] == 2


def test_finish_idempotent_and_busy_guard(client: TestClient, tmp_path: Path) -> None:
    rid = client.post("/api/v1/recordings", json={"title": "幂等", "scene": "meeting"}, headers=HEADERS).json()["id"]
    _upload(client, rid, 0, make_wav(tmp_path / "i.wav", 1.0))

    r = client.post(f"/api/v1/recordings/{rid}/finish", headers=HEADERS)
    assert r.status_code == 200
    assert r.json()["status"] == "done"

    # 已完成后再 finish：不再排队，直接返回
    r = client.post(f"/api/v1/recordings/{rid}/finish", headers=HEADERS)
    assert r.status_code == 200
    assert r.json()["status"] == "done"


def test_rerun_busy_guard(client: TestClient, tmp_path: Path) -> None:
    from app.db import SessionLocal
    from app.models import Recording

    rid = client.post("/api/v1/recordings", json={"title": "忙", "scene": "meeting"}, headers=HEADERS).json()["id"]
    _upload(client, rid, 0, make_wav(tmp_path / "b.wav", 1.0))
    db = SessionLocal()
    try:
        rec = db.get(Recording, rid)
        rec.status = "transcribing"
        db.commit()
    finally:
        db.close()
    r = client.post(f"/api/v1/recordings/{rid}/rerun", headers=HEADERS)
    assert r.status_code == 409
    r = client.post(f"/api/v1/recordings/{rid}/finish", headers=HEADERS)
    assert r.status_code == 409

    # 清理：避免下次启动 lifespan 把它重新排队，污染其它测试
    db = SessionLocal()
    try:
        db.delete(db.get(Recording, rid))
        db.commit()
    finally:
        db.close()


def test_created_at_has_timezone(client: TestClient) -> None:
    from datetime import datetime

    r = client.post("/api/v1/recordings", json={"title": "时区", "scene": "meeting"}, headers=HEADERS)
    rid = r.json()["id"]
    body = client.get(f"/api/v1/recordings/{rid}", headers=HEADERS).json()
    dt = datetime.fromisoformat(body["created_at"])
    assert dt.tzinfo is not None, "created_at 必须带时区，否则前端显示会差 8 小时"
    assert dt.utcoffset().total_seconds() == 0


def test_openapi_schema(client: TestClient) -> None:
    r = client.get("/openapi.json")
    assert r.status_code == 200
    paths = r.json()["paths"]
    for p in ["/api/v1/recordings", "/api/v1/recordings/{recording_id}", "/api/v1/auth/feishu-login", "/api/v1/shared/{recording_id}", "/api/v1/search", "/api/v1/stats"]:
        assert p in paths, p


def test_delete_recording(client: TestClient, tmp_path: Path) -> None:
    rid = client.post("/api/v1/recordings", json={"title": "待删除", "scene": "memo"}, headers=HEADERS).json()["id"]
    _upload(client, rid, 0, make_wav(tmp_path / "d.wav", 1.0))
    client.post(f"/api/v1/recordings/{rid}/finish", headers=HEADERS)

    from app.storage import data_dir

    rec_dir = data_dir() / "recordings" / rid
    assert rec_dir.exists()
    r = client.delete(f"/api/v1/recordings/{rid}", headers=HEADERS)
    assert r.status_code == 204, r.text
    assert client.get(f"/api/v1/recordings/{rid}", headers=HEADERS).status_code == 404
    assert not rec_dir.exists()


def test_delete_other_users_recording_forbidden(client: TestClient) -> None:
    rid = client.post("/api/v1/recordings", json={"title": "别人的", "scene": "memo"}, headers=HEADERS).json()["id"]
    r = client.delete(f"/api/v1/recordings/{rid}", headers={"X-Employee-Open-Id": "other"})
    assert r.status_code == 404


def test_detail_exposes_feishu_delivery(client: TestClient, tmp_path: Path) -> None:
    rid = client.post("/api/v1/recordings", json={"title": "投递状态", "scene": "meeting"}, headers=HEADERS).json()["id"]
    _upload(client, rid, 0, make_wav(tmp_path / "f.wav", 1.0))
    client.post(f"/api/v1/recordings/{rid}/finish", headers=HEADERS)
    body = client.get(f"/api/v1/recordings/{rid}", headers=HEADERS).json()
    assert body["feishu_status"] == "sent"


def test_rate_limit_create(client: TestClient) -> None:
    headers = {"X-Employee-Open-Id": "u_rate_limit"}
    codes = [
        client.post("/api/v1/recordings", json={"title": f"限流{i}", "scene": "memo"}, headers=headers).status_code
        for i in range(8)
    ]
    assert codes.count(200) <= 6
    assert 429 in codes


def test_ops_health_requires_token(client: TestClient, monkeypatch) -> None:
    from app import main as main_mod
    from app.config import get_settings

    settings = get_settings().model_copy(update={"ops_token": "ops-secret"})
    monkeypatch.setattr(main_mod, "get_settings", lambda: settings)
    assert client.get("/api/v1/ops/health").status_code == 404
    r = client.get("/api/v1/ops/health", headers={"X-Ops-Token": "ops-secret"})
    assert r.status_code == 200
    body = r.json()
    assert body["db_ok"] is True
    assert "recordings" in body
