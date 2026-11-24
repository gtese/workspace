import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="fm-test-")
os.environ["FM_DATA_DIR"] = _TMP
os.environ["FM_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
os.environ["FM_ASR_PROVIDER"] = "mock"
os.environ["FM_LLM_PROVIDER"] = "mock"
os.environ["FM_FEISHU_MODE"] = "mock"
os.environ["FM_EMAIL_MODE"] = "mock"
os.environ["FM_SYNC_PIPELINE"] = "true"
os.environ["FM_WORKER_ENABLED"] = "false"
os.environ["FM_SECRET_KEY"] = "test-secret"
os.environ["FM_SIGNUP_BONUS_MINUTES"] = "100000"

import pytest  # noqa: E402

_HEADERS_CACHE: dict[str, dict] = {}


def _bootstrap() -> None:
    """建表 + 预留一批测试账号会话，供各测试模块在 import 期就拿 headers。"""
    from app.accounts import hash_password, issue_login_session
    from app.billing import credit, get_wallet
    from app.db import SessionLocal, init_db
    from app.models import Membership, Org, User

    init_db()
    db = SessionLocal()
    try:
        for key in ("u_test", "other", "u_share", "u_spk", "u_formats", "u_rate_limit", "demo", "stranger"):
            email = f"{key}@example.com"
            user = db.query(User).filter(User.email == email).first()
            if user is None:
                user = User(
                    email=email,
                    password_hash=hash_password("Testpass123"),
                    name=key,
                    default_org_id="",
                )
                db.add(user)
                db.flush()
                org = Org(name=f"{key} workspace", kind="personal", owner_id=user.id)
                db.add(org)
                db.flush()
                db.add(Membership(org_id=org.id, user_id=user.id, role="owner"))
                user.default_org_id = org.id
                db.commit()
                get_wallet(db, org.id)
                credit(db, org.id, 100000, kind="grant", note="test seed")
            token, _ = issue_login_session(db, user)
            _HEADERS_CACHE[key] = {"Authorization": f"Bearer {token}", "X-Org-Id": user.default_org_id}
    finally:
        db.close()


def headers_for(key: str = "u_test") -> dict:
    if not _HEADERS_CACHE:
        _bootstrap()
    return dict(_HEADERS_CACHE[key])


_bootstrap()


@pytest.fixture(scope="session", autouse=True)
def _init_db():
    from app.db import init_db

    init_db()
    yield


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    from app import ratelimit

    ratelimit.reset()
    yield


@pytest.fixture()
def client():
    from app.main import app
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c
