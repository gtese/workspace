"""飞书网页应用登录：Code → user_access_token → 用户信息。

文档：
- 免登流程：https://open.feishu.cn/document/uYjL24iN/uMTMuMTMuMTM/development-guide/step-3
- 获取 user_access_token：https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/access_token/create
- 获取用户信息：https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/authen/user_info
"""

from __future__ import annotations

import logging
import time

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)
BASE = "https://open.feishu.cn/open-apis"


class FeishuAuthError(RuntimeError):
    pass


class FeishuAuth:
    def __init__(self) -> None:
        s = get_settings()
        self.app_id = s.feishu_app_id
        self.app_secret = s.feishu_app_secret
        self._app_token = ""
        self._exp = 0.0

    def app_access_token(self) -> str:
        if self._app_token and time.time() < self._exp - 60:
            return self._app_token
        resp = httpx.post(
            f"{BASE}/auth/v3/app_access_token/internal",
            json={"app_id": self.app_id, "app_secret": self.app_secret},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            raise FeishuAuthError(f"app_access_token 失败: {data.get('code')} {data.get('msg')}")
        self._app_token = data["app_access_token"]
        self._exp = time.time() + int(data.get("expire", 7200))
        return self._app_token

    def user_access_token(self, code: str) -> dict:
        resp = httpx.post(
            f"{BASE}/authen/v1/access_token",
            headers={"Authorization": f"Bearer {self.app_access_token()}"},
            json={"grant_type": "authorization_code", "code": code},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            raise FeishuAuthError(f"user_access_token 失败: {data.get('code')} {data.get('msg')}")
        return data.get("data") or {}

    def user_info(self, user_access_token: str) -> dict:
        resp = httpx.get(
            f"{BASE}/authen/v1/user_info",
            headers={"Authorization": f"Bearer {user_access_token}"},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            raise FeishuAuthError(f"user_info 失败: {data.get('code')} {data.get('msg')}")
        return data.get("data") or {}

    def login_with_code(self, code: str) -> dict:
        token_data = self.user_access_token(code)
        user_token = token_data.get("access_token", "")
        if not user_token:
            raise FeishuAuthError("user_access_token 为空")
        info = self.user_info(user_token)
        open_id = info.get("open_id") or token_data.get("open_id")
        if not open_id:
            raise FeishuAuthError("未获取到 open_id")
        return {
            "open_id": open_id,
            "name": info.get("name", ""),
            "email": info.get("email", ""),
            "user_access_token": user_token,
        }
