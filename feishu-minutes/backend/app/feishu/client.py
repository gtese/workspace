"""飞书应用机器人：发纪要卡片。mock 模式落盘到 data/outbox/。"""

from __future__ import annotations

import json
import logging
import time

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)
BASE = "https://open.feishu.cn/open-apis"


def build_minutes_card(title: str, scene_label: str, summary: dict, detail_url: str) -> dict:
    def md(text: str) -> dict:
        return {"tag": "div", "text": {"tag": "lark_md", "content": text[:2500]}}

    elements: list[dict] = [
        md(f"**摘要**\n{summary.get('summary') or '（无）'}"),
    ]
    points = summary.get("key_points") or []
    if points:
        elements.append(md("**要点**\n" + "\n".join(f"- {p}" for p in points[:6])))
    todos = summary.get("todos") or []
    if todos:
        lines = []
        for t in todos[:6]:
            who = f"{t.get('owner')} " if t.get("owner") else ""
            due = f"（{t.get('due')}）" if t.get("due") else ""
            lines.append(f"- {who}{t.get('item')}{due}")
        elements.append(md("**待办**\n" + "\n".join(lines)))
    elements.append(
        {
            "tag": "action",
            "actions": [
                {
                    "tag": "button",
                    "text": {"tag": "plain_text", "content": "查看全文"},
                    "type": "primary",
                    "url": detail_url,
                }
            ],
        }
    )
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "blue",
            "title": {"tag": "plain_text", "content": f"纪要完成 · {title}"[:60]},
        },
        "elements": elements,
        "_scene": scene_label,
    }


class FeishuClient:
    def __init__(self) -> None:
        self.settings = get_settings()
        self._token: str = ""
        self._token_exp: float = 0

    def _tenant_token(self) -> str:
        if self._token and time.time() < self._token_exp - 60:
            return self._token
        resp = httpx.post(
            f"{BASE}/auth/v3/tenant_access_token/internal",
            json={
                "app_id": self.settings.feishu_app_id,
                "app_secret": self.settings.feishu_app_secret,
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            raise RuntimeError(f"飞书 token 失败: {data.get('msg')}")
        self._token = data["tenant_access_token"]
        self._token_exp = time.time() + int(data.get("expire", 7200))
        return self._token

    def send_card(
        self, receive_id: str, card: dict, receive_id_type: str = "open_id"
    ) -> dict:
        if self.settings.feishu_mode != "real":
            outbox = self.settings.data_dir / "outbox"
            outbox.mkdir(parents=True, exist_ok=True)
            path = outbox / f"feishu-{int(time.time() * 1000)}.json"
            path.write_text(
                json.dumps(
                    {"receive_id": receive_id, "type": receive_id_type, "card": card},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            log.info("飞书 mock 卡片已写入 %s", path)
            return {"mode": "mock", "path": str(path)}

        card = dict(card)
        card.pop("_scene", None)
        token = self._tenant_token()
        resp = httpx.post(
            f"{BASE}/im/v1/messages",
            params={"receive_id_type": receive_id_type},
            headers={"Authorization": f"Bearer {token}"},
            json={
                "receive_id": receive_id,
                "msg_type": "interactive",
                "content": json.dumps(card, ensure_ascii=False),
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            raise RuntimeError(f"飞书发消息失败: {data.get('code')} {data.get('msg')}")
        return {"mode": "real", "message_id": data.get("data", {}).get("message_id")}
