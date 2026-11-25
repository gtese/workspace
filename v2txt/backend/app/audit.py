"""安全与用户事件审计。

约定：
- 所有事件只追加，不更新、不删除（retention 到期由维护任务清理）。
- `action` 用点分层级：`auth.login`、`billing.order.create`、`recording.share.revoke`。
- `result`：ok / fail / denied，便于安全面板统计失败与越权。
- 写审计绝不能影响业务：所有异常在这里吞掉并打日志。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy.orm import Session

from .models import AuditEvent

log = logging.getLogger("audit")

# 动作白名单（便于查询面板做下拉，也避免手写错别字）
ACTIONS: dict[str, str] = {
    "auth.register": "注册",
    "auth.login": "登录",
    "auth.login.failed": "登录失败",
    "auth.logout": "登出",
    "auth.email.verified": "邮箱验证",
    "auth.password.forgot": "申请重置密码",
    "auth.password.reset": "重置密码",
    "auth.password.changed": "修改密码",
    "auth.feishu.login": "飞书登录",
    "auth.feishu.failed": "飞书登录失败",
    "org.create": "创建团队",
    "org.rename": "团队改名",
    "org.switch": "切换空间",
    "org.invite": "邀请成员",
    "org.accept": "接受邀请",
    "org.role": "调整角色",
    "org.member.remove": "移除成员",
    "billing.order.create": "提交充值单",
    "billing.order.cancel": "取消订单",
    "billing.subscribe": "订阅套餐",
    "billing.order.confirm": "确认到账",
    "billing.grant": "手工加额度",
    "recording.create": "新建录音",
    "recording.upload": "上传音频",
    "recording.delete": "删除录音",
    "recording.rerun": "重新转写",
    "recording.share.revoke": "撤销分享",
    "recording.share.restore": "恢复分享",
    "recording.email": "邮件交付",
    "admin.user.status": "停用/启用账号",
    "admin.view": "查看运营后台",
}


def client_ip(request: Any) -> str:
    if request is None:
        return ""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    client = getattr(request, "client", None)
    return (client.host if client else "")[:64]


def client_ua(request: Any) -> str:
    if request is None:
        return ""
    return request.headers.get("user-agent", "")[:300]


def record(
    db: Session,
    action: str,
    *,
    request: Any = None,
    org_id: str = "",
    user_id: str = "",
    actor: str = "",
    target: str = "",
    result: str = "ok",
    detail: dict | str | None = None,
) -> None:
    try:
        payload = ""
        if isinstance(detail, dict) and detail:
            payload = json.dumps(detail, ensure_ascii=False)[:4000]
        elif isinstance(detail, str):
            payload = detail[:4000]
        db.add(
            AuditEvent(
                action=action[:60],
                result=result if result in ("ok", "fail", "denied") else "ok",
                org_id=(org_id or "")[:32],
                user_id=(user_id or "")[:32],
                actor=(actor or "")[:200],
                ip=client_ip(request),
                ua=client_ua(request),
                target=(target or "")[:200],
                detail=payload,
            )
        )
        db.commit()
    except Exception:  # noqa: BLE001 审计失败不能影响业务
        log.exception("写入审计事件失败 action=%s", action)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
    if result != "ok":
        log.warning("审计 %s %s user=%s ip=%s %s", action, result, user_id, client_ip(request), detail)
