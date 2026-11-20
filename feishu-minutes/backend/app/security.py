"""媒体 URL 签名：/media/<path>?exp=<unix>&sig=<hmac>，默认 1 小时有效。"""

from __future__ import annotations

import hashlib
import hmac
import time

from .config import get_settings


def _sign(path: str, exp: int) -> str:
    secret = get_settings().secret_key.encode()
    msg = f"{path}:{exp}".encode()
    return hmac.new(secret, msg, hashlib.sha256).hexdigest()[:32]


def signed_url(path: str, ttl: int | None = None) -> str:
    settings = get_settings()
    exp = int(time.time()) + (ttl or settings.media_url_ttl_seconds)
    sig = _sign(path, exp)
    return f"{settings.public_base_url.rstrip('/')}{path}?exp={exp}&sig={sig}"


def verify(path: str, exp: str | int, sig: str) -> bool:
    try:
        exp_i = int(exp)
    except (TypeError, ValueError):
        return False
    if exp_i < int(time.time()):
        return False
    return hmac.compare_digest(_sign(path, exp_i), sig)


def hmac_sha256_hex(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
