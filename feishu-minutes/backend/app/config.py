"""全局配置。凭据优先级：环境变量 > ~/.mm 密钥文件 > 默认值。"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(REPO_ROOT / ".env"), env_prefix="FM_", extra="ignore"
    )

    app_name: str = "feishu-minutes"
    data_dir: Path = REPO_ROOT / "data"
    database_url: str = ""
    secret_key: str = "dev-only-change-me"
    public_base_url: str = "http://127.0.0.1:8000"
    media_url_ttl_seconds: int = 3600
    sync_pipeline: bool = False
    worker_enabled: bool = True
    retention_days: int = 90
    retention_check_seconds: int = 6 * 3600

    # ASR
    asr_provider: str = "mock"  # mock | tencent
    tencent_secret_id: str = ""
    tencent_secret_key: str = ""
    tencent_region: str = "ap-guangzhou"
    tencent_engine_model: str = "16k_zh_en_meeting"
    asr_price_per_hour: float = 0.8

    # LLM
    llm_provider: str = "mock"  # mock | deepseek
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    llm_model: str = "deepseek-chat"

    # 飞书
    feishu_mode: str = "mock"  # mock | real
    feishu_app_id: str = ""
    feishu_app_secret: str = ""

    # 网站回调
    website_callback_url: str = ""
    website_callback_secret: str = ""

    # 邮件
    email_mode: str = "mock"  # mock | real
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_sender: str = ""

    @property
    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{self.data_dir / 'app.db'}"

    @property
    def is_sqlite(self) -> bool:
        return self.db_url.startswith("sqlite")


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    try:  # 凭据文件缺失或异常不影响启动
        from .secrets import apply_mm_secrets

        settings = apply_mm_secrets(settings)
    except Exception:  # noqa: BLE001
        pass
    return settings
