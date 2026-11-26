"""审计事件：写入、查询、越权保护、保留期清理。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import AuditEvent  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import select  # noqa: E402

from .conftest import headers_for  # noqa: E402


def _events(action: str) -> list[AuditEvent]:
    db = SessionLocal()
    try:
        return list(db.scalars(select(AuditEvent).where(AuditEvent.action == action)).all())
    finally:
        db.close()


def test_login_success_and_failure_are_audited(client: TestClient) -> None:
    from app import ratelimit

    ratelimit.reset()
    client.post(
        "/api/v1/auth/register",
        json={"email": "audit1@example.com", "password": "Goodpass123", "name": "审计"},
    )
    ratelimit.reset()
    assert client.post(
        "/api/v1/auth/login", json={"email": "audit1@example.com", "password": "Goodpass123"}
    ).status_code == 200
    assert _events("auth.login")

    ratelimit.reset()
    client.post("/api/v1/auth/login", json={"email": "audit1@example.com", "password": "wrong-pass"})
    rows = _events("auth.login.failed")
    assert rows and rows[-1].result == "fail"
    assert rows[-1].actor == "audit1@example.com"


def test_register_and_recording_events(client: TestClient) -> None:
    from app import ratelimit

    ratelimit.reset()
    data = client.post(
        "/api/v1/auth/register",
        json={"email": "audit2@example.com", "password": "Goodpass123"},
    ).json()
    headers = {
        "Authorization": "Bearer " + data["token"],
        "X-Org-Id": data["user"]["default_org_id"],
    }
    assert _events("auth.register")

    rec = client.post("/api/v1/recordings", json={"title": "审计录音", "scene": "meeting"}, headers=headers)
    assert rec.status_code == 200
    rows = _events("recording.create")
    assert any(r.target == rec.json()["id"] for r in rows)


def test_admin_can_query_events_and_others_cannot(client: TestClient, monkeypatch) -> None:
    settings = get_settings()
    admin_user = settings.model_copy(update={"admin_emails": "u_test@example.com"})
    from app.api import deps

    monkeypatch.setattr(deps, "get_settings", lambda: admin_user)

    r = client.get("/api/v1/admin/events?limit=5", headers=headers_for("u_test"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert "items" in body and body["actions"]
    assert client.get("/api/v1/admin/events/summary", headers=headers_for("u_test")).status_code == 200

    other = client.get("/api/v1/admin/events", headers=headers_for("other"))
    assert other.status_code == 403


def test_audit_filtering_by_result(client: TestClient, monkeypatch) -> None:
    settings = get_settings().model_copy(update={"admin_emails": "u_test@example.com"})
    from app.api import deps

    monkeypatch.setattr(deps, "get_settings", lambda: settings)
    r = client.get("/api/v1/admin/events?result=fail&limit=50", headers=headers_for("u_test"))
    assert r.status_code == 200
    assert all(x["result"] == "fail" for x in r.json()["items"])


def test_retention_cleanup() -> None:
    from datetime import UTC, datetime, timedelta

    from app.maintenance import cleanup_audit_events

    db = SessionLocal()
    try:
        old = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=400)
        db.add(AuditEvent(action="auth.login", created_at=old, actor="old@example.com"))
        db.commit()
    finally:
        db.close()
    assert cleanup_audit_events(days=180) >= 1


def test_audit_failure_does_not_break_request(client: TestClient, monkeypatch) -> None:
    """审计写库失败不能影响主流程。"""
    from app import audit

    def boom(*a, **kw):  # noqa: ANN002, ANN003
        raise RuntimeError("db down")

    monkeypatch.setattr(audit.log, "exception", lambda *a, **kw: None)
    monkeypatch.setattr(AuditEvent, "action", property(boom))
    from app import ratelimit

    ratelimit.reset()
    r = client.post(
        "/api/v1/auth/login", json={"email": "nobody@example.com", "password": "whatever123"}
    )
    assert r.status_code == 401  # 业务结果不受影响


def test_admin_can_reset_password(client: TestClient, monkeypatch) -> None:
    from app import ratelimit
    from app.api import deps
    from app.config import get_settings

    settings = get_settings().model_copy(update={"admin_emails": "u_test@example.com"})
    monkeypatch.setattr(deps, "get_settings", lambda: settings)
    ratelimit.reset()
    reg = client.post(
        "/api/v1/auth/register",
        json={"email": "resetpw@example.com", "password": "Goodpass123"},
    ).json()
    uid = reg["user"]["id"]
    r = client.post(
        f"/api/v1/admin/users/{uid}/password",
        json={"password": "Newpass123"},
        headers=headers_for("u_test"),
    )
    assert r.status_code == 200, r.text
    ratelimit.reset()
    assert client.post(
        "/api/v1/auth/login", json={"email": "resetpw@example.com", "password": "Newpass123"}
    ).status_code == 200
