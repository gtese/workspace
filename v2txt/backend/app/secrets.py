"""从 ~/.mm 读取凭据，补进 Settings（环境变量优先，绝不回显内容）。"""

from __future__ import annotations

import logging
from pathlib import Path

from .config import Settings

log = logging.getLogger(__name__)

MM_DIR = Path.home() / ".mm"

# 文件名 -> {环境变量式键: Settings 字段}
SECRET_FILES: dict[str, dict[str, str]] = {
    "feishu-minutes": {
        "FEISHU_APP_ID": "feishu_app_id",
        "FEISHU_APP_SECRET": "feishu_app_secret",
    },
    "feishu-v2txt": {
        "FEISHU_APP_ID": "feishu_app_id",
        "FEISHU_APP_SECRET": "feishu_app_secret",
    },
    "tencent-asr": {
        "TENCENT_SECRET_ID": "tencent_secret_id",
        "TENCENT_SECRET_KEY": "tencent_secret_key",
    },
    "deepseek": {"DEEPSEEK_API_KEY": "deepseek_api_key"},
    "v2txt-aliyun": {
        "ALIYUN_AK": "oss_access_key",
        "ALIYUN_SK": "oss_secret_key",
    },
    "aliyun": {
        "ALIYUN_API_KEY": "aliyun_api_key",
        "ALIYUN_BASE_URL": "aliyun_base_url",
    },
    "website-callback": {
        "WEBSITE_CALLBACK_URL": "website_callback_url",
        "WEBSITE_CALLBACK_SECRET": "website_callback_secret",
    },
    "smtp": {
        "SMTP_HOST": "smtp_host",
        "SMTP_PORT": "smtp_port",
        "SMTP_USER": "smtp_user",
        "SMTP_PASSWORD": "smtp_password",
        "SMTP_SENDER": "smtp_sender",
    },
}


def _parse_kv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def apply_mm_secrets(settings: Settings) -> Settings:
    """把 ~/.mm 中存在的凭据填入未设置的字段；返回新 Settings。"""
    updates: dict[str, object] = {}
    for fname, mapping in SECRET_FILES.items():
        path = MM_DIR / fname
        if not path.exists():
            continue
        try:
            kv = _parse_kv(path)
        except OSError as exc:  # pragma: no cover - 环境相关
            log.warning("读取 %s 失败: %s", path, exc)
            continue
        for env_key, field in mapping.items():
            if env_key in kv and not getattr(settings, field, ""):
                value: object = kv[env_key]
                if field == "smtp_port":
                    try:
                        value = int(str(value))
                    except ValueError:
                        continue
                updates[field] = value
    if not updates:
        return settings
    merged = settings.model_copy(update=updates)
    log.info("已从 ~/.mm 载入凭据字段: %s", ", ".join(sorted(updates)))
    return merged
