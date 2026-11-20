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
