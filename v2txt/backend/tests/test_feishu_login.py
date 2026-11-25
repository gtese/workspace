"""飞书登录：同一 tenant_key 自动成为一个团队空间。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from app.api import auth_feishu as fs_mod  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import Membership, Org, User  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def _enable(monkeypatch, *, user: dict, tenant: str = "测试企业") -> None:
    settings = get_settings().model_copy(
        update={"feishu_mode": "real", "feishu_app_id": "cli_test", "feishu_app_secret": "sec"}
    )
    monkeypatch.setattr(fs_mod, "get_settings", lambda: settings)
    monkeypatch.setattr(fs_mod.feishu_oauth, "exchange_code", lambda code, redirect_uri="": {"access_token": "u-token"})
    monkeypatch.setattr(fs_mod.feishu_oauth, "user_info", lambda token: user)
    monkeypatch.setattr(fs_mod.feishu_oauth, "tenant_info", lambda: {"name": tenant, "display_name": tenant})


def _login(client: TestClient) -> dict:
    from app import ratelimit

    ratelimit.reset()
    r = client.post("/api/v1/auth/feishu", json={"code": "any"})
    assert r.status_code == 200, r.text
    return r.json()


def test_first_login_creates_team(client: TestClient, monkeypatch) -> None:
    _enable(
        monkeypatch,
        user={
            "open_id": "ou_test_a",
            "union_id": "on_a",
            "tenant_key": "tk_demo",
            "name": "张三",
            "email": "zhangsan@demo.com",
        },
    )
    data = _login(client)
    assert data["token"].startswith("vt_")
    assert data["tenant_key"] == "tk_demo"
    assert data["team_org_id"]

    db = SessionLocal()
    try:
        org = db.get(Org, data["team_org_id"])
        assert org.kind == "team"
        assert org.feishu_tenant_key == "tk_demo"
        user = db.get(User, data["user"]["id"])
        assert user.feishu_open_id == "ou_test_a"
        member = db.query(Membership).filter(Membership.org_id == org.id, Membership.user_id == user.id).one()
        assert member.role == "owner"
    finally:
        db.close()


def test_same_tenant_joins_same_team(client: TestClient, monkeypatch) -> None:
    _enable(
        monkeypatch,
        user={"open_id": "ou_test_b", "tenant_key": "tk_demo2", "name": "李四", "email": "lisi@demo.com"},
    )
    first = _login(client)

    _enable(
        monkeypatch,
        user={"open_id": "ou_test_c", "tenant_key": "tk_demo2", "name": "王五", "email": "wangwu@demo.com"},
    )
    second = _login(client)

    assert first["team_org_id"] == second["team_org_id"]
    db = SessionLocal()
    try:
        org = db.get(Org, second["team_org_id"])
        members = db.query(Membership).filter(Membership.org_id == org.id).all()
        roles = {m.user_id: m.role for m in members}
        assert roles[first["user"]["id"]] == "owner"
        assert roles[second["user"]["id"]] == "member"
    finally:
        db.close()


def test_different_tenant_separate_team(client: TestClient, monkeypatch) -> None:
    _enable(
        monkeypatch,
        user={"open_id": "ou_other_1", "tenant_key": "tk_other", "name": "赵六", "email": "zhaoliu@other.com"},
        tenant="另一家公司",
    )
    data = _login(client)
    db = SessionLocal()
    try:
        org = db.get(Org, data["team_org_id"])
        assert org.feishu_tenant_key == "tk_other"
        assert org.name == "另一家公司"
    finally:
        db.close()


def test_link_existing_email_account(client: TestClient, monkeypatch) -> None:
    # 先用邮箱注册一个账号
    from app import ratelimit

    ratelimit.reset()
    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "link@example.com", "password": "Goodpass123", "name": "老用户"},
    )
    assert reg.status_code == 200
    user_id = reg.json()["user"]["id"]

    _enable(
        monkeypatch,
        user={"open_id": "ou_link", "tenant_key": "tk_link", "name": "老用户", "email": "link@example.com"},
    )
    data = _login(client)
    assert data["user"]["id"] == user_id
    db = SessionLocal()
    try:
        assert db.get(User, user_id).feishu_open_id == "ou_link"
    finally:
        db.close()

    # 合并后原有密码登录仍然可用（双通道）
    r = client.post("/api/v1/auth/login", json={"email": "link@example.com", "password": "Goodpass123"})
    assert r.status_code == 200


def test_feishu_disabled_returns_400(client: TestClient) -> None:
    r = client.post("/api/v1/auth/feishu", json={"code": "x"})
    assert r.status_code in (400, 401)
    cfg = client.get("/api/v1/auth/feishu/config").json()
    assert cfg["enabled"] is False


def test_feishu_user_gets_team_quota_once(client: TestClient, monkeypatch) -> None:
    _enable(
        monkeypatch,
        user={"open_id": "ou_quota_1", "tenant_key": "tk_quota", "name": "A", "email": "a@quota.com"},
    )
    data = _login(client)
    org_id = data["team_org_id"]
    balance_1 = client.get(
        "/api/v1/billing/summary", headers={"Authorization": "Bearer " + data["token"], "X-Org-Id": org_id}
    ).json()["minutes"]
    assert balance_1 >= 60

    _enable(
        monkeypatch,
        user={"open_id": "ou_quota_2", "tenant_key": "tk_quota", "name": "B", "email": "b@quota.com"},
    )
    data2 = _login(client)
    balance_2 = client.get(
        "/api/v1/billing/summary", headers={"Authorization": "Bearer " + data2["token"], "X-Org-Id": org_id}
    ).json()["minutes"]
    assert balance_2 == balance_1  # 第二个成员不再赠送


@pytest.mark.parametrize("path", ["/login", "/feishu-callback"])
def test_feishu_pages_served(client: TestClient, path: str) -> None:
    r = client.get(path)
    assert r.status_code == 200
    assert "飞书登录" in r.text
