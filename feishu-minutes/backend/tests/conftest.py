import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="fm-test-")
os.environ["FM_DATA_DIR"] = _TMP
os.environ["FM_DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
os.environ["FM_ASR_PROVIDER"] = "mock"
os.environ["FM_LLM_PROVIDER"] = "mock"
os.environ["FM_FEISHU_MODE"] = "mock"
os.environ["FM_SYNC_PIPELINE"] = "true"
os.environ["FM_WORKER_ENABLED"] = "false"
os.environ["FM_SECRET_KEY"] = "test-secret"

import pytest  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _init_db():
    """单独运行某个测试文件时也建表（不依赖 TestClient 的 lifespan）。"""
    from app.db import init_db

    init_db()
    yield
