"""全局配置。凭据优先级：环境变量 > ~/.mm 密钥文件 > 默认值。"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(REPO_ROOT / ".env"), env_prefix="FM_", extra="ignore"
    )

    app_name: str = "v2txt"
    site_name: str = "V2TXT"
    app_env: str = "dev"  # dev | prod
    log_level: str = "INFO"
    data_dir: Path = REPO_ROOT / "data"
    database_url: str = ""
    secret_key: str = "dev-only-change-me"
    public_base_url: str = "http://127.0.0.1:8000"
    media_url_ttl_seconds: int = 3600
    share_ttl_days: int = 30
    sync_pipeline: bool = False
    worker_enabled: bool = True
    worker_count: int = 2
    monitoring_enabled: bool = True
    watchdog_seconds: int = 300
    ops_token: str = ""
    alert_open_ids: str = ""
    retention_days: int = 30
    retention_check_seconds: int = 6 * 3600

    # ASR
    asr_provider: str = "mock"  # mock | tencent
    tencent_secret_id: str = ""
    tencent_secret_key: str = ""
    tencent_region: str = "ap-guangzhou"
    tencent_engine_model: str = "16k_zh_en_meeting"
    asr_price_per_hour: float = 0.8

    # 阿里云百炼 / MaaS（OpenAI 兼容）
    aliyun_api_key: str = ""
    aliyun_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    asr_model: str = "qwen3-asr-flash"
    asr_filetrans_model: str = "qwen-audio-3.1-asr-flash-filetrans"
    asr_diarization: bool = True
    asr_chunk_concurrency: int = 3

    # LLM
    llm_provider: str = "mock"  # mock | deepseek | aliyun
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    llm_model: str = "deepseek-chat"

    # 飞书
    feishu_mode: str = "mock"  # mock | real
    feishu_doc_enabled: bool = False  # 纪要同步为飞书云文档（需要云空间权限）
    feishu_card_enabled: bool = False  # 生成后推送卡片（需要 im 权限）
    feishu_app_id: str = ""
    feishu_app_secret: str = ""

    # 网站回调
    website_callback_url: str = ""
    website_callback_secret: str = ""

    # 邮件
    email_mode: str = "mock"  # mock | real
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_use_ssl: bool = True
    smtp_use_starttls: bool = False
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_sender: str = ""
    smtp_sender_name: str = "V2TXT"
    email_minutes_auto: bool = True  # 纪要生成后自动邮件给录音所属账号

    # 账号与会话
    session_ttl_days: int = 30
    verify_token_minutes: int = 60 * 24
    reset_token_minutes: int = 60
    signup_bonus_minutes: float = 60.0
    admin_emails: str = ""  # 逗号分隔，拥有运营后台权限
    allow_self_register: bool = True

    # 计费
    billing_currency: str = "USD"
    price_per_minute_usd: float = 0.02
    min_billed_minutes: float = 0.5
    billing_round_minutes: float = 0.1
    low_balance_warn_minutes: float = 10.0

    # 收款信息（对公转账；留空则前端提示联系客服）
    pay_bank_name: str = ""
    pay_account_name: str = ""
    pay_account_no: str = ""
    pay_swift: str = ""

    # 上传
    upload_max_mb: int = 500
    upload_max_minutes: float = 300.0

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
