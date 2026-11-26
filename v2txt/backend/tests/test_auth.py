"""v2 账号体系测试：注册、登录、会话、找回密码、验证邮箱。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.accounts import issue_email_token  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import User  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from .conftest import headers_for  # noqa: E402


def _register(client: TestClient, email: str, password: str = "Goodpass123") -> dict:
    r = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "name": "测试", "locale": "zh"},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_register_creates_org_and_bonus(client: TestClient) -> None:
    data = _register(client, "auth1@example.com")
    assert data["token"].startswith("vt_")
    assert data["user"]["email"] == "auth1@example.com"
    assert data["user"]["default_org_id"]
    assert data["user"]["orgs"][0]["role"] == "owner"

    me = client.get("/api/v1/me", headers={"Authorization": "Bearer " + data["token"]})
    assert me.status_code == 200
    assert me.json()["balance"] >= 60


def test_register_rejects_duplicate_and_weak_password(client: TestClient) -> None:
    from app import ratelimit

    _register(client, "auth2@example.com")
    ratelimit.reset()
    dup = client.post("/api/v1/auth/register", json={"email": "auth2@example.com", "password": "Goodpass123"})
    assert dup.status_code == 409
    ratelimit.reset()
    weak = client.post("/api/v1/auth/register", json={"email": "auth3@example.com", "password": "12345678"})
    assert weak.status_code == 400
    ratelimit.reset()
    bad = client.post("/api/v1/auth/register", json={"email": "not-an-email", "password": "Goodpass123"})
    assert bad.status_code == 400


def test_login_and_logout(client: TestClient) -> None:
    _register(client, "auth4@example.com", "Goodpass123")
    ok = client.post("/api/v1/auth/login", json={"email": "auth4@example.com", "password": "Goodpass123"})
    assert ok.status_code == 200
    token = ok.json()["token"]
    assert client.get("/api/v1/recordings", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert client.post("/api/v1/auth/logout", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    assert client.get("/api/v1/recordings", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_login_wrong_password_is_401(client: TestClient) -> None:
    _register(client, "auth5@example.com", "Goodpass123")
    r = client.post("/api/v1/auth/login", json={"email": "auth5@example.com", "password": "Wrongpass123"})
    assert r.status_code == 401


def test_requests_without_token_are_401(client: TestClient) -> None:
    assert client.get("/api/v1/recordings").status_code == 401
    assert client.get("/api/v1/me").status_code == 401
    # 伪造的 open_id 头不再有任何作用
    assert client.get("/api/v1/recordings", headers={"X-Employee-Open-Id": "demo"}).status_code == 401


def test_verify_email_token(client: TestClient) -> None:
    data = _register(client, "auth6@example.com")
    # 邮箱不再强制验证：注册即视为已确认，接口保留只为兼容旧链接
    assert data["user"]["email_verified"] is True
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == "auth6@example.com").first()
        token = issue_email_token(db, "verify", user.email, user_id=user.id)
    finally:
        db.close()
    r = client.post("/api/v1/auth/verify-email", json={"token": token})
    assert r.status_code == 200
    me = client.get("/api/v1/me", headers={"Authorization": "Bearer " + data["token"]})
    assert me.json()["email_verified"] is True
    again = client.post("/api/v1/auth/verify-email", json={"token": token})
    assert again.status_code == 400


def test_reset_password_flow(client: TestClient) -> None:
    _register(client, "auth7@example.com", "Goodpass123")
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == "auth7@example.com").first()
        token = issue_email_token(db, "reset", user.email, user_id=user.id)
    finally:
        db.close()
    r = client.post("/api/v1/auth/reset-password", json={"token": token, "password": "Newpass123"})
    assert r.status_code == 200
    assert client.post(
        "/api/v1/auth/login", json={"email": "auth7@example.com", "password": "Newpass123"}
    ).status_code == 200
    assert client.post(
        "/api/v1/auth/login", json={"email": "auth7@example.com", "password": "Goodpass123"}
    ).status_code == 401


def test_forgot_password_does_not_leak(client: TestClient) -> None:
    r = client.post("/api/v1/auth/forgot-password", json={"email": "nobody@example.com"})
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_change_password_revokes_sessions(client: TestClient) -> None:
    data = _register(client, "auth8@example.com", "Goodpass123")
    headers = {"Authorization": "Bearer " + data["token"]}
    r = client.post(
        "/api/v1/me/password", json={"old_password": "Goodpass123", "new_password": "Newpass123"}, headers=headers
    )
    assert r.status_code == 200
    assert client.get("/api/v1/me", headers=headers).status_code == 401


def test_rate_limit_login(client: TestClient) -> None:
    codes = [
        client.post("/api/v1/auth/login", json={"email": "x@example.com", "password": "bad"}).status_code
        for _ in range(8)
    ]
    assert 429 in codes


def test_org_headers_resolve_membership(client: TestClient) -> None:
    headers = headers_for("demo")
    assert client.get("/api/v1/orgs", headers=headers).status_code == 200
    other = client.get("/api/v1/recordings", headers={**headers, "X-Org-Id": "org_not_mine"})
    assert other.status_code == 403
