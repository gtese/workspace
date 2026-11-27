"""阿里云 OSS（兼容 S3 风格）预签名：浏览器直传，服务器只签名不搬流量。

用 OSS V1 签名（HMAC-SHA1），不引入 SDK。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import time
import urllib.parse

import httpx

from .config import get_settings

log = logging.getLogger(__name__)


def _host() -> str:
    s = get_settings()
    return f"{s.oss_bucket}.oss-{s.oss_region}.aliyuncs.com"


def enabled() -> bool:
    return get_settings().oss_enabled


def _sign(verb: str, key: str, expires: int, content_type: str = "") -> str:
    s = get_settings()
    resource = f"/{s.oss_bucket}/{key}"
    string_to_sign = f"{verb}\n\n{content_type}\n{expires}\n{resource}"
    digest = hmac.new(
        s.oss_secret_key.encode(), string_to_sign.encode(), hashlib.sha1
    ).digest()
    return base64.b64encode(digest).decode()


def presign(verb: str, key: str, ttl: int | None = None, content_type: str = "") -> str:
    """生成带签名的对象 URL（PUT 用于直传，GET 用于服务端读取）。"""
    s = get_settings()
    expires = int(time.time()) + (ttl or s.oss_presign_ttl)
    sig = urllib.parse.quote(_sign(verb.upper(), key, expires, content_type), safe="")
    return (
        f"https://{_host()}/{urllib.parse.quote(key)}"
        f"?OSSAccessKeyId={urllib.parse.quote(s.oss_access_key)}"
        f"&Expires={expires}&Signature={sig}"
    )


def upload(
    key: str, data: bytes, content_type: str = "application/octet-stream", ttl: int | None = None
) -> str:
    """服务端直接上传对象，返回 6 小时有效的签名 GET URL（给 ASR 之类的外部服务拉取）。

    走 OSS 而不是走 Cloudflare 隧道：ASR 厂商拉 2MB WAV 走隧道会卡到超时。
    """
    put_url = presign("PUT", key, ttl=ttl or 900, content_type=content_type)
    resp = httpx.put(put_url, content=data, headers={"Content-Type": content_type}, timeout=180)
    if resp.status_code >= 400:
        raise RuntimeError(f"上传到 OSS 失败: HTTP {resp.status_code} {resp.text[:200]}")
    return presign("GET", key, ttl=6 * 3600)


def object_key(org_id: str, recording_id: str, suffix: str) -> str:
    s = get_settings()
    return f"{s.oss_prefix}/{org_id}/{recording_id}/source{suffix}"


def fetch(key: str, timeout: int = 120) -> bytes:
    """服务端把对象取回（同城/同区，速度很快）。"""
    url = presign("GET", key, ttl=600)
    resp = httpx.get(url, timeout=timeout, follow_redirects=True)
    if resp.status_code >= 400:
        raise RuntimeError(f"从 OSS 取文件失败: HTTP {resp.status_code} {resp.text[:200]}")
    return resp.content


def delete(key: str) -> bool:
    try:
        url = presign("DELETE", key)
        return httpx.delete(url, timeout=30).status_code < 300
    except Exception:  # noqa: BLE001
        log.exception("删除 OSS 对象失败 %s", key)
        return False
