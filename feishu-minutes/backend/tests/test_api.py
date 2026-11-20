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
