import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402
from app.security import share_signature, share_url, verify_share  # noqa: E402

from tests.test_audio import make_wav  # noqa: E402

from .conftest import headers_for

HEADERS = headers_for("u_share")


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _done_recording(client: TestClient, tmp_path: Path) -> str:
    rid = client.post("/api/v1/recordings", json={"title": "分享测试", "scene": "meeting"}, headers=HEADERS).json()["id"]
    wav = make_wav(tmp_path / "a.wav", 1.0)
    with wav.open("rb") as fh:
        client.post(
            f"/api/v1/recordings/{rid}/segments?idx=0",
            files={"file": ("a.wav", fh, "audio/wav")},
            headers=HEADERS,
        )
    client.post(f"/api/v1/recordings/{rid}/finish", headers=HEADERS)
    return rid


def test_share_url_roundtrip() -> None:
    url = share_url("rec_abc")
    q = parse_qs(urlparse(url).query)
    assert url.startswith("http") and "/s/rec_abc" in url
    assert verify_share("rec_abc", q["exp"][0], q["sig"][0]) is True


def test_share_tampered_and_expired() -> None:
    exp = 1
    assert verify_share("rec_abc", exp, "bad") is False
    assert verify_share("rec_abc", exp, share_signature("rec_abc", exp)) is False  # 已过期


def test_shared_endpoint_and_page(client: TestClient, tmp_path: Path) -> None:
    rid = _done_recording(client, tmp_path)
    url = share_url(rid)
    q = parse_qs(urlparse(url).query)
    r = client.get(f"/api/v1/shared/{rid}?exp={q['exp'][0]}&sig={q['sig'][0]}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "分享测试"
    assert body["summary"] and body["summary"]["summary"]
    assert body["audio_url"]

    # 页面本身可打开（数据由前端带签名参数拉取）
    assert client.get(f"/s/{rid}").status_code == 200

    # 篡改签名 / 过期
    assert client.get(f"/api/v1/shared/{rid}?exp={q['exp'][0]}&sig=deadbeef").status_code == 403
    assert client.get(f"/api/v1/shared/{rid}?exp=1&sig=deadbeef").status_code == 403
    assert client.get("/api/v1/shared/rec_not_exist?exp=9999999999&sig=" + share_signature("rec_not_exist", 9999999999)).status_code == 404


def test_send_without_feishu_channel(client: TestClient, tmp_path: Path) -> None:
    rid = _done_recording(client, tmp_path)
    r = client.post(f"/api/v1/recordings/{rid}/send", json={}, headers=HEADERS)
    assert r.status_code == 400
    assert "飞书" in r.json()["detail"]


def test_email_delivery_mock(client: TestClient, tmp_path: Path) -> None:
    rid = _done_recording(client, tmp_path)
    r = client.post(f"/api/v1/recordings/{rid}/email", headers=HEADERS)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "sent"
    assert body["email"] == "u_share@example.com"


def test_send_requires_done(client: TestClient) -> None:
    rid = client.post("/api/v1/recordings", json={"title": "未完成", "scene": "memo"}, headers=HEADERS).json()["id"]
    r = client.post(f"/api/v1/recordings/{rid}/email", headers=HEADERS)
    assert r.status_code == 409


def test_get_share_link_owner_only(client: TestClient, tmp_path: Path) -> None:
    rid = _done_recording(client, tmp_path)
    r = client.get(f"/api/v1/recordings/{rid}/share", headers=HEADERS)
    assert r.status_code == 200
    url = r.json()["url"]
    assert f"/s/{rid}" in url and "sig=" in url

    r = client.get(f"/api/v1/recordings/{rid}/share", headers=headers_for("other"))
    assert r.status_code == 404


def test_share_revoke_and_audit(client: TestClient, tmp_path: Path) -> None:
    from app.db import SessionLocal
    from app.models import ShareAccess

    rid = _done_recording(client, tmp_path)
    q = parse_qs(urlparse(share_url(rid)).query)
    url = f"/api/v1/shared/{rid}?exp={q['exp'][0]}&sig={q['sig'][0]}"
    assert client.get(url).status_code == 200

    r = client.post(f"/api/v1/recordings/{rid}/share/revoke", headers=HEADERS)
    assert r.status_code == 200
    assert r.json()["revoked"] is True
    assert client.get(url).status_code == 403

    r = client.delete(f"/api/v1/recordings/{rid}/share/revoke", headers=HEADERS)
    assert r.status_code == 200
    assert r.json()["revoked"] is False
    assert client.get(url).status_code == 200

    db = SessionLocal()
    try:
        assert db.query(ShareAccess).filter(ShareAccess.recording_id == rid).count() >= 2
    finally:
        db.close()


def test_share_get_reports_revoked(client: TestClient, tmp_path: Path) -> None:
    rid = _done_recording(client, tmp_path)
    body = client.get(f"/api/v1/recordings/{rid}/share", headers=HEADERS).json()
    assert body["revoked"] is False
    client.post(f"/api/v1/recordings/{rid}/share/revoke", headers=HEADERS)
    body = client.get(f"/api/v1/recordings/{rid}/share", headers=HEADERS).json()
    assert body["revoked"] is True
