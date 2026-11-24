import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402

from tests.test_audio import make_wav  # noqa: E402

from .conftest import headers_for

HEADERS = headers_for("u_spk")


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _done(client: TestClient, tmp_path: Path, title: str = "说话人测试") -> str:
    rid = client.post("/api/v1/recordings", json={"title": title, "scene": "meeting"}, headers=HEADERS).json()["id"]
    wav = make_wav(tmp_path / "a.wav", 2.0)
    with wav.open("rb") as fh:
        client.post(f"/api/v1/recordings/{rid}/segments?idx=0", files={"file": ("a.wav", fh, "audio/wav")}, headers=HEADERS)
    client.post(f"/api/v1/recordings/{rid}/finish", headers=HEADERS)
    return rid


def test_speaker_rename_applies_to_transcript(client: TestClient, tmp_path: Path) -> None:
    rid = _done(client, tmp_path)
    body = client.get(f"/api/v1/recordings/{rid}", headers=HEADERS).json()
    original = body["transcript"][0]["speaker"]
    assert original.startswith("发言人")

    r = client.put(f"/api/v1/recordings/{rid}/speakers", json={"mapping": {original: "张三"}}, headers=HEADERS)
    assert r.status_code == 200, r.text
    assert r.json()["transcript"][0]["speaker"] == "张三"

    # 重新转写后映射仍生效
    client.post(f"/api/v1/recordings/{rid}/rerun", headers=HEADERS)
    body = client.get(f"/api/v1/recordings/{rid}", headers=HEADERS).json()
    assert body["transcript"][0]["speaker"] == "张三"


def test_speaker_rename_removed(client: TestClient, tmp_path: Path) -> None:
    rid = _done(client, tmp_path)
    body = client.get(f"/api/v1/recordings/{rid}", headers=HEADERS).json()
    original = body["transcript"][0]["speaker"]
    client.put(f"/api/v1/recordings/{rid}/speakers", json={"mapping": {original: "李四"}}, headers=HEADERS)
    client.put(f"/api/v1/recordings/{rid}/speakers", json={"mapping": {original: ""}}, headers=HEADERS)
    body = client.get(f"/api/v1/recordings/{rid}", headers=HEADERS).json()
    assert body["transcript"][0]["speaker"] == original


def test_search(client: TestClient, tmp_path: Path) -> None:
    rid = _done(client, tmp_path, "搜索测试")
    r = client.get("/api/v1/search", params={"q": "进展"}, headers=HEADERS)
    assert r.status_code == 200
    hits = r.json()
    assert any(h["id"] == rid for h in hits)
    assert all(h["snippet"] for h in hits)

    r = client.get("/api/v1/search", params={"q": "绝不可能出现的词xyz"}, headers=HEADERS)
    assert r.json() == []

    r = client.get("/api/v1/search", params={"q": ""}, headers=HEADERS)
    assert r.json() == []


def test_search_owner_isolation(client: TestClient, tmp_path: Path) -> None:
    _done(client, tmp_path, "别人的会议")
    r = client.get("/api/v1/search", params={"q": "进展"}, headers=headers_for("stranger"))
    assert r.json() == []
