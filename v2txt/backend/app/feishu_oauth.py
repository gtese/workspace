"""飞书开放平台：应用令牌、网页授权换 token、用户与租户信息。"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from .config import get_settings

log = logging.getLogger(__name__)

BASE = "https://open.feishu.cn/open-apis"

_cache: dict[str, tuple[str, float]] = {}


class FeishuError(RuntimeError):
    pass


def _post(path: str, payload: dict, token: str = "") -> dict:
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        resp = httpx.post(f"{BASE}{path}", json=payload, headers=headers, timeout=15)
    except httpx.HTTPError as exc:
        raise FeishuError(f"请求飞书失败: {exc}") from exc
    try:
        data = resp.json()
    except ValueError as exc:
        raise FeishuError(f"飞书返回非 JSON: HTTP {resp.status_code}") from exc
    if data.get("code") not in (0, None):
        raise FeishuError(_err_text(data))
    return data


def _err_text(data: dict) -> str:
    msg = (
        data.get("msg")
        or data.get("error_description")
        or data.get("error")
        or "未知错误"
    )
    code = data.get("code")
    return f"{msg} (code={code})" if code is not None else str(msg)


def _get(path: str, token: str) -> dict:
    try:
        resp = httpx.get(f"{BASE}{path}", headers={"Authorization": f"Bearer {token}"}, timeout=15)
    except httpx.HTTPError as exc:
        raise FeishuError(f"请求飞书失败: {exc}") from exc
    try:
        data = resp.json()
    except ValueError as exc:
        raise FeishuError(f"飞书返回非 JSON: HTTP {resp.status_code}") from exc
    if data.get("code") not in (0, None):
        raise FeishuError(_err_text(data))
    return data


def tenant_access_token() -> str:
    """应用身份 token，带 100 秒安全边界缓存。"""
    settings = get_settings()
    if not (settings.feishu_app_id and settings.feishu_app_secret):
        raise FeishuError("未配置飞书 App ID/Secret")
    cached = _cache.get("tenant")
    if cached and cached[1] > time.time():
        return cached[0]
    data = _post(
        "/auth/v3/tenant_access_token/internal",
        {"app_id": settings.feishu_app_id, "app_secret": settings.feishu_app_secret},
    )
    token = data.get("tenant_access_token") or ""
    expire = int(data.get("expire") or 7200)
    _cache["tenant"] = (token, time.time() + max(60, expire - 100))
    return token


def tenant_info() -> dict[str, Any]:
    """企业信息（需要 tenant:tenant:readonly 权限，缺权限时返回空）。"""
    try:
        data = _get("/tenant/v2/tenant/query", tenant_access_token())
    except FeishuError as exc:
        log.warning("获取飞书企业信息失败（可忽略）: %s", exc)
        return {}
    return (data.get("data") or {}).get("tenant") or {}


def exchange_code(code: str, redirect_uri: str = "") -> dict[str, Any]:
    """网页授权 code 换 user_access_token（v2 接口）。"""
    settings = get_settings()
    payload: dict[str, Any] = {
        "grant_type": "authorization_code",
        "client_id": settings.feishu_app_id,
        "client_secret": settings.feishu_app_secret,
        "code": code,
    }
    if redirect_uri:
        payload["redirect_uri"] = redirect_uri
    data = _post("/authen/v2/oauth/token", payload)
    if not data.get("access_token"):
        raise FeishuError(f"换取 user_access_token 失败: {data}")
    return data


def user_info(user_access_token: str) -> dict[str, Any]:
    data = _get("/authen/v1/user_info", user_access_token)
    info = data.get("data") or {}
    if not info.get("open_id"):
        raise FeishuError("未取到 open_id")
    return info


def authorize_url(redirect_uri: str, state: str = "login") -> str:
    settings = get_settings()
    from urllib.parse import quote

    return (
        "https://open.feishu.cn/open-apis/authen/v1/authorize"
        f"?app_id={quote(settings.feishu_app_id)}"
        f"&redirect_uri={quote(redirect_uri, safe='')}"
        f"&state={quote(state)}"
    )


def refresh_user_token(refresh_token: str) -> dict[str, Any]:
    """用 refresh_token 换新的 user_access_token（离线也能拿）。"""
    s = get_settings()
    return _post(
        "/authen/v2/oauth/token",
        {
            "grant_type": "refresh_token",
            "client_id": s.feishu_app_id,
            "client_secret": s.feishu_app_secret,
            "refresh_token": refresh_token,
        },
    )


def user_token_for(db, user) -> str:  # noqa: ANN001
    """拿到一个可用的 user_access_token：内存缓存 → 刷新令牌 → 空。"""
    from .user_tokens import get as cache_get
    from .user_tokens import put as cache_put

    open_id = getattr(user, "feishu_open_id", "") or ""
    if not open_id:
        return ""
    cached = cache_get(open_id)
    if cached:
        return cached
    token = getattr(user, "feishu_refresh_token", "") or ""
    if not token:
        return ""
    try:
        data = refresh_user_token(token)
    except FeishuError as exc:
        log.warning("刷新飞书 user token 失败: %s", exc)
        return ""
    access = data.get("access_token", "")
    if data.get("refresh_token"):
        user.feishu_refresh_token = data["refresh_token"]
        db.commit()
    if access:
        cache_put(open_id, access, int(data.get("expires_in") or 3600))
    return access
