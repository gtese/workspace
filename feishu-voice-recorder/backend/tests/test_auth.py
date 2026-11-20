import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402
from app.security import issue_session, verify_session  # noqa: E402


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def test_session_roundtrip() -> None:
    token = issue_session("ou_abc")
    assert token.startswith("fm_")
    assert verify_session(token) == "ou_abc"


def test_session_tampered() -> None:
    token = issue_session("ou_abc")
    body, _, sig = token[3:].partition(".")
    tampered = "fm_" + body + "." + ("0" * len(sig))
    assert verify_session(tampered) is None


def test_session_expired() -> None:
    token = issue_session("ou_abc", ttl=-5)
    assert verify_session(token) is None


def test_session_garbage() -> None:
    assert verify_session("") is None
    assert verify_session("fm_") is None
    assert verify_session("not-a-token") is None


def test_mock_login_and_me(client: TestClient) -> None:
    r = client.get("/api/v1/feishu/app-id")
    assert r.status_code == 200
    assert r.json() == {"app_id": "", "mode": "mock"}

    r = client.post("/api/v1/auth/feishu-login", json={"code": "any-code"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mock"] is True
    token = body["token"]

    r = client.get("/api/v1/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["open_id"] == "demo"


def test_bearer_takes_precedence_over_header(client: TestClient) -> None:
    token = issue_session("ou_real")
    r = client.post(
        "/api/v1/recordings",
        json={"title": "t", "scene": "meeting"},
        headers={"Authorization": f"Bearer {token}", "X-Employee-Open-Id": "spoof"},
    )
    assert r.status_code == 200
    rid = r.json()["id"]
    r = client.get(f"/api/v1/recordings/{rid}", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200


def test_bad_bearer_falls_back_to_default(client: TestClient) -> None:
    r = client.get("/api/v1/me", headers={"Authorization": "Bearer fm_bad.token"})
    assert r.status_code == 200
    assert r.json()["open_id"] == "demo"


def test_expired_bearer_rejected(client: TestClient) -> None:
    token = issue_session("ou_x", ttl=-1)
    r = client.get("/api/v1/me", headers={"Authorization": f"Bearer {token}"})
    # 过期 token 不作为身份，回落到默认 demo
    assert r.json()["open_id"] == "demo"


def test_real_mode_requires_feishu_login(client: TestClient, monkeypatch) -> None:
    from app.api import deps
    from app.config import get_settings
    from app.security import issue_session

    real = get_settings().model_copy(update={"feishu_mode": "real"})
    monkeypatch.setattr(deps, "get_settings", lambda: real)

    assert client.get("/api/v1/recordings").status_code == 401
    assert client.get("/api/v1/recordings", headers={"X-Employee-Open-Id": "demo"}).status_code == 401
    assert client.get("/api/v1/me").status_code == 401

    token = issue_session("ou_real_user")
    r = client.get("/api/v1/recordings", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    r = client.get("/api/v1/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["open_id"] == "ou_real_user"


def test_real_mode_health_stays_public(client: TestClient, monkeypatch) -> None:
    from app.api import deps
    from app.config import get_settings

    real = get_settings().model_copy(update={"feishu_mode": "real"})
    monkeypatch.setattr(deps, "get_settings", lambda: real)
    assert client.get("/health").status_code == 200
