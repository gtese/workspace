"""把纪要同步成飞书云文档，并转交给员工本人。

流程：创建 docx → 追加内容块 → 加员工为可编辑成员 → 转移拥有者 → 取文档 URL。
全部使用 tenant_access_token，已验证可用（2026-11-20）。
"""

from __future__ import annotations

import logging

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)
BASE = "https://open.feishu.cn/open-apis"


def _text(s: str) -> dict:
    return {"text_run": {"content": s}}


def _heading(s: str, level: int = 1) -> dict:
    key = "heading1" if level == 1 else "heading2"
    return {"block_type": 3 + (0 if level == 1 else 1), key: {"elements": [_text(s)], "style": {}}}


def _para(s: str) -> dict:
    return {"block_type": 2, "text": {"elements": [_text(s)], "style": {}}}


def _bullet(s: str) -> dict:
    return {"block_type": 12, "bullet": {"elements": [_text(s)], "style": {}}}


class FeishuDocClient:
    def __init__(self) -> None:
        s = get_settings()
        self.app_id = s.feishu_app_id
        self.app_secret = s.feishu_app_secret

    def _token(self) -> str:
        r = httpx.post(
            f"{BASE}/auth/v3/tenant_access_token/internal",
            json={"app_id": self.app_id, "app_secret": self.app_secret},
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        if data.get("code") != 0:
            raise RuntimeError(f"tenant token 失败: {data.get('msg')}")
        return data["tenant_access_token"]

    def create_user_folder(self, open_id: str, name: str = "AI录音") -> str:
        """在员工云盘创建「AI录音」文件夹（转交拥有者，应用保留可编辑）。"""
        token = self._token()
        h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        r = httpx.post(
            f"{BASE}/drive/v1/files/create_folder",
            headers=h,
            json={"name": name, "folder_token": ""},
            timeout=20,
        )
        r.raise_for_status()
        data = r.json()
        if data.get("code") != 0:
            raise RuntimeError(f"创建文件夹失败: {data.get('msg')}")
        folder = data["data"]["token"]
        httpx.post(
            f"{BASE}/drive/v1/permissions/{folder}/members?type=folder",
            headers=h,
            json={"member_type": "openid", "member_id": open_id, "perm": "full_access"},
            timeout=20,
        )
        httpx.post(
            f"{BASE}/drive/v1/permissions/{folder}/members/transfer_owner?type=folder",
            headers=h,
            json={
                "member_type": "openid",
                "member_id": open_id,
                "old_owner_perm": "full_access",
                "remove_old_owner": False,
                "stay_put": True,
            },
            timeout=20,
        )
        return folder

    def create_minutes_doc(
        self,
        title: str,
        summary: dict,
        share_url: str,
        open_id: str,
        folder_token: str = "",
    ) -> dict:
        token = self._token()
        h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

        r = httpx.post(f"{BASE}/docx/v1/documents", headers=h, json={"title": title}, timeout=20)
        r.raise_for_status()
        data = r.json()
        if data.get("code") != 0:
            raise RuntimeError(f"创建文档失败: {data.get('msg')}")
        doc = data["data"]["document"]["document_id"]

        blocks: list[dict] = []
        if summary.get("summary"):
            blocks += [_heading("摘要"), _para(summary["summary"])]
        if summary.get("key_points"):
            blocks.append(_heading("要点"))
            blocks += [_bullet(x) for x in summary["key_points"]]
        if summary.get("decisions"):
            blocks.append(_heading("结论 / 决策"))
            blocks += [_bullet(x) for x in summary["decisions"]]
        if summary.get("todos"):
            blocks.append(_heading("待办"))
            for t in summary["todos"]:
                who = f"{t.get('owner')} " if t.get("owner") else ""
                due = f"（{t.get('due')}）" if t.get("due") else ""
                blocks.append(_bullet(f"{who}{t.get('item')}{due}"))
        if summary.get("risks"):
            blocks.append(_heading("风险"))
            blocks += [_bullet(x) for x in summary["risks"]]
        blocks += [_heading("在线查看"), _para(share_url)]

        r = httpx.post(
            f"{BASE}/docx/v1/documents/{doc}/blocks/{doc}/children",
            headers=h,
            json={"children": blocks, "index": 0},
            timeout=30,
        )
        r.raise_for_status()
        if r.json().get("code") != 0:
            raise RuntimeError(f"写入文档失败: {r.json().get('msg')}")

        # 先移动到员工云盘的「AI录音」目录（此时文档仍归应用，移动权限足够）
        if folder_token:
            m = httpx.post(
                f"{BASE}/drive/v1/files/{doc}/move",
                headers=h,
                json={"type": "docx", "folder_token": folder_token},
                timeout=20,
            )
            if m.json().get("code") != 0:
                log.warning("移动到 AI录音 目录失败: %s", m.text[:200])

        # 交给员工本人（失败不影响文档可用，只是仍在应用空间）
        try:
            httpx.post(
                f"{BASE}/drive/v1/permissions/{doc}/members?type=docx",
                headers=h,
                json={"member_type": "openid", "member_id": open_id, "perm": "full_access"},
                timeout=20,
            )
            httpx.post(
                f"{BASE}/drive/v1/permissions/{doc}/members/transfer_owner?type=docx",
                headers=h,
                json={
                    "member_type": "openid",
                    "member_id": open_id,
                    "old_owner_perm": "full_access",
                    "remove_old_owner": False,
                    "stay_put": True,
                },
                timeout=20,
            )
        except Exception:  # noqa: BLE001
            log.exception("文档转交失败（保留在应用空间）")

        url = f"https://feishu.cn/docx/{doc}"
        try:
            meta = httpx.post(
                f"{BASE}/drive/v1/metas/batch_query",
                headers=h,
                json={"request_docs": [{"doc_token": doc, "doc_type": "docx"}], "with_url": True},
                timeout=20,
            ).json()
            url = meta["data"]["metas"][0].get("url") or url
        except Exception:  # noqa: BLE001
            log.warning("取文档 URL 失败，使用默认链接")

        return {"document_id": doc, "url": url}
