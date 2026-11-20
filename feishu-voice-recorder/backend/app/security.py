"""媒体 URL 签名：/media/<path>?exp=<unix>&sig=<hmac>，默认 1 小时有效。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
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


# ---- 分享链接：/s/<rid>?exp=<unix>&sig=<hmac>，默认 30 天 ----

def share_signature(rid: str, exp: int) -> str:
    secret = get_settings().secret_key.encode()
    msg = f"share:{rid}:{exp}".encode()
    return hmac.new(secret, msg, hashlib.sha256).hexdigest()[:32]


def share_url(rid: str, ttl: int | None = None) -> str:
    settings = get_settings()
    ttl = ttl or settings.share_ttl_days * 86400
    exp = int(time.time()) + ttl
    sig = share_signature(rid, exp)
    return f"{settings.public_base_url.rstrip('/')}/s/{rid}?exp={exp}&sig={sig}"


def verify_share(rid: str, exp: str | int, sig: str) -> bool:
    try:
        exp_i = int(exp)
    except (TypeError, ValueError):
        return False
    if exp_i < int(time.time()):
        return False
    return hmac.compare_digest(share_signature(rid, exp_i), sig)


def hmac_sha256_hex(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


# ---- 会话 token（网页应用免登后签发，不存服务器状态） ----

SESSION_PREFIX = "fm_"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def issue_session(open_id: str, ttl: int = 7 * 24 * 3600) -> str:
    payload = {"oid": open_id, "exp": int(time.time()) + ttl}
    raw = json.dumps(payload, separators=(",", ":")).encode()
    body = _b64(raw)
    sig = hmac.new(
        get_settings().secret_key.encode(), body.encode(), hashlib.sha256
    ).hexdigest()[:32]
    return f"{SESSION_PREFIX}{body}.{sig}"


def verify_session(token: str) -> str | None:
    if not token.startswith(SESSION_PREFIX):
        return None
    body, _, sig = token[len(SESSION_PREFIX):].partition(".")
    if not body or not sig:
        return None
    expected = hmac.new(
        get_settings().secret_key.encode(), body.encode(), hashlib.sha256
    ).hexdigest()[:32]
    if not hmac.compare_digest(expected, sig):
        return None
    try:
        payload = json.loads(_unb64(body))
    except ValueError:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return str(payload.get("oid") or "") or None
