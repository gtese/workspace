"""端环境诊断：把客户端上报的 UA / 运行环境落盘，用于判断"在飞书内还是在浏览器打开"。

飞书官方规则（2024 文档）：
- 桌面端主页**默认在飞书客户端内打开**；
- 只有当主页 URL 拼接了 `lk_jump_to_browser=true` 时才会跳系统浏览器；
- 「网页应用 - 打开方式配置」只影响 window.open / <a target="_blank"> 之后的**新页面**，不影响主页本身。

因此"点应用就跳浏览器"必然是配置侧（主页 URL 带参数 / 工作台里放的是网页快捷方式 /
客户端链接打开方式），本接口用于拿到客户端实证。
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from fastapi import APIRouter, Request

from ..config import get_settings

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/diag", tags=["diag"])

# UA 里出现这些关键字即认为在飞书客户端内（PC 端 Lark/x.y、移动端 Feishu/x.y 等）
FEISHU_UA_HINTS = ("Lark/", "Feishu/", "feishu", "lark")


def _is_feishu_ua(ua: str) -> bool:
    low = ua.lower()
    return any(hint.lower() in low for hint in FEISHU_UA_HINTS)


@router.post("/report")
async def report(request: Request) -> dict[str, Any]:
    """记录一次诊断上报，返回解析结论。无需登录。"""
    try:
        payload = await request.json()
        if not isinstance(payload, dict):
            payload = {"raw": payload}
    except Exception:  # noqa: BLE001  # 上报体不合法时不影响主流程
        payload = {}

    ua = str(payload.get("ua") or request.headers.get("user-agent") or "")
    in_feishu = _is_feishu_ua(ua)

    entry: dict[str, Any] = {
        "ts": int(time.time()),
        "iso": time.strftime("%Y-%m-%d %H:%M:%S"),
        "ip": (request.client.host if request.client else ""),
        "cf_ip": request.headers.get("cf-connecting-ip", ""),
        "ua": ua,
        "referer": request.headers.get("referer", ""),
        "path": str(payload.get("path") or ""),
        "href": str(payload.get("href") or ""),
        "in_feishu_ua": in_feishu,
        "has_tt": bool(payload.get("has_tt")),
        "has_h5sdk": bool(payload.get("has_h5sdk")),
        "verdict": str(payload.get("verdict") or ""),
        "extra": payload.get("extra") or {},
    }

    log.info(
        "diag report: in_feishu=%s has_tt=%s path=%s ua=%s",
        in_feishu,
        entry["has_tt"],
        entry["path"],
        ua[:160],
    )

    try:
        path = get_settings().data_dir / "diag.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:  # noqa: BLE001  # 落盘失败不影响返回
        log.warning("diag 上报落盘失败", exc_info=True)

    return {"ok": True, "in_feishu": in_feishu, "server_ua": ua[:160]}


@router.get("/reports")
def reports(limit: int = 20) -> dict[str, Any]:
    """最近若干条上报（供运维自查，不含敏感信息）。"""
    path = get_settings().data_dir / "diag.jsonl"
    if not path.exists():
        return {"items": []}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()[-max(1, min(limit, 200)) :]
    except OSError:
        return {"items": []}
    items = []
    for line in lines:
        try:
            items.append(json.loads(line))
        except ValueError:
            continue
    return {"items": items}
