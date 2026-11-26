"""运营后台（/ops）：基于 SQLAdmin，带角色分级。

角色：
  superadmin  全部读写 + 业务动作
  finance     订单/台账/钱包/套餐 读写，其余只读
  support     用户/组织/成员/录音 读写，其余只读
  viewer      全部只读
管理员邮箱（FM_ADMIN_EMAILS）自动视为 superadmin。
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from sqladmin import Admin, ModelView
from sqladmin.authentication import AuthenticationBackend
from sqlalchemy import select
from starlette.requests import Request
from starlette.middleware.sessions import SessionMiddleware

from .accounts import verify_password
from .config import get_settings
from .db import SessionLocal, engine
from .models import (
    AuditEvent,
    DriveFolder,
    FeishuApp,
    LedgerEntry,
    Membership,
    Order,
    Org,
    Plan,
    Recording,
    Segment,
    Session as LoginSession,
    Subscription,
    UsageRecord,
    User,
    Wallet,
)

log = logging.getLogger(__name__)

ROLES = ("viewer", "support", "finance", "superadmin")
ROLE_LABELS = {
    "viewer": "只读",
    "support": "客服（用户/团队）",
    "finance": "财务（订单/额度）",
    "superadmin": "超级管理员",
}

# 每个模型允许"写"的角色
WRITE_RULES: dict[str, tuple[str, ...]] = {
    "users": ("support", "superadmin"),
    "orgs": ("support", "superadmin"),
    "memberships": ("support", "superadmin"),
    "recordings": ("support", "superadmin"),
    "segments": ("superadmin",),
    "orders": ("finance", "superadmin"),
    "ledger_entries": ("finance", "superadmin"),
    "wallets": ("finance", "superadmin"),
    "plans": ("finance", "superadmin"),
    "subscriptions": ("finance", "superadmin"),
    "feishu_apps": ("superadmin",),
    "audit_events": (),          # 只读，永远不许改
    "usage_records": (),         # 只读
    "drive_folders": ("superadmin",),
    "sessions": ("superadmin",),
}


def _platform_admins() -> set[str]:
    raw = get_settings().admin_emails
    return {x.strip().lower() for x in raw.split(",") if x.strip()}


def role_of(user: User) -> str:
    if user is None:
        return ""
    email = (user.email or "").lower()
    if email in _platform_admins():
        return "superadmin"
    return user.ops_role if user.ops_role in ROLES else ""


class OpsAuth(AuthenticationBackend):
    async def login(self, request: Request) -> bool:
        form = await request.form()
        email = (form.get("username") or "").strip().lower()
        password = form.get("password") or ""
        db = SessionLocal()
        try:
            user = db.scalars(select(User).where(User.email == email)).first()
            if user is None or not user.password_hash:
                return False
            if not verify_password(password, user.password_hash):
                return False
            if user.status != "active":
                return False
            role = role_of(user)
            if not role:
                return False
            request.session.update({"ops_uid": user.id, "ops_role": role})
            log.info("运营后台登录 %s role=%s", email, role)
            return True
        finally:
            db.close()

    async def logout(self, request: Request) -> bool:
        request.session.clear()
        return True

    async def authenticate(self, request: Request) -> bool:
        uid = request.session.get("ops_uid")
        if not uid:
            return False
        db = SessionLocal()
        try:
            user = db.get(User, uid)
            if user is None or user.status != "active":
                return False
            role = role_of(user)
            if not role:
                return False
            request.session["ops_role"] = role
            return True
        finally:
            db.close()


class BaseView(ModelView):
    """按角色控制写权限；列表默认按创建时间倒序。"""

    can_export = True
    page_size = 50
    page_size_options = [25, 50, 100, 200]

    def _role(self, request: Request) -> str:
        return request.session.get("ops_role", "")

    def _can_write(self, request: Request) -> bool:
        role = self._role(request)
        allowed = WRITE_RULES.get(getattr(self.model, "__tablename__", ""), ())
        return role in allowed

    async def is_accessible(self, request: Request) -> bool:  # noqa: D401
        return bool(self._role(request))

    def can_create(self, request: Request) -> bool:  # noqa: ANN001
        return self._can_write(request)

    def can_edit(self, request: Request) -> bool:  # noqa: ANN001
        return self._can_write(request)

    def can_delete(self, request: Request) -> bool:  # noqa: ANN001
        return self._can_write(request)

    def can_delete_all(self, request: Request) -> bool:  # noqa: ANN001
        return self._role(request) == "superadmin"


class UserView(BaseView):
    model = User
    name = "用户"
    name_plural = "用户"
    column_list = [User.email, User.name, User.ops_role, User.status, User.created_at]
    column_searchable_list = [User.email, User.name]
    column_sortable_list = [User.created_at]
    column_exclude_list = [User.password_hash, User.feishu_refresh_token]
    form_excluded_columns = [User.password_hash, User.feishu_refresh_token, User.created_at, User.updated_at]


class OrgAdmin(BaseView):
    model = Org
    name = "团队"
    name_plural = "团队"
    column_searchable_list = [Org.name]
    column_exclude_list = []


class MembershipAdmin(BaseView):
    model = Membership
    name = "成员"
    name_plural = "成员"


class RecordingAdmin(BaseView):
    model = Recording
    name = "录音"
    name_plural = "录音"
    column_searchable_list = [Recording.title]
    column_exclude_list = [Recording.transcript_json, Recording.summary_json]
    form_excluded_columns = [Recording.transcript_json, Recording.summary_json, Recording.created_at, Recording.updated_at]


class SegmentAdmin(BaseView):
    model = Segment
    name = "音频分段"
    name_plural = "音频分段"


class OrderAdmin(BaseView):
    model = Order
    name = "订单"
    name_plural = "订单"
    column_searchable_list = [Order.id, Order.payer_name]


class LedgerAdmin(BaseView):
    model = LedgerEntry
    name = "额度台账"
    name_plural = "额度台账"


class WalletAdmin(BaseView):
    model = Wallet
    name = "钱包"
    name_plural = "钱包"


class PlanAdmin(BaseView):
    model = Plan
    name = "套餐"
    name_plural = "套餐"


class SubscriptionAdmin(BaseView):
    model = Subscription
    name = "订阅"
    name_plural = "订阅"


class UsageAdmin(BaseView):
    model = UsageRecord
    name = "用量成本"
    name_plural = "用量成本"


class AuditAdmin(BaseView):
    model = AuditEvent
    name = "审计事件"
    name_plural = "审计事件"
    column_searchable_list = [AuditEvent.action, AuditEvent.actor, AuditEvent.ip]
    column_sortable_list = [AuditEvent.created_at]


class FeishuAppAdmin(BaseView):
    model = FeishuApp
    name = "企业应用"
    name_plural = "企业应用"
    column_exclude_list = [FeishuApp.app_secret]


class SessionAdmin(BaseView):
    model = LoginSession
    name = "会话"
    name_plural = "会话"


class DriveFolderAdmin(BaseView):
    model = DriveFolder
    name = "云盘目录"
    name_plural = "云盘目录"


VIEWS = [
    UserView, OrgAdmin, MembershipAdmin, RecordingAdmin, SegmentAdmin,
    OrderAdmin, LedgerAdmin, WalletAdmin, PlanAdmin, SubscriptionAdmin,
    UsageAdmin, AuditAdmin, FeishuAppAdmin, SessionAdmin, DriveFolderAdmin,
]


def mount_ops(app: FastAPI) -> None:
    settings = get_settings()
    app.add_middleware(SessionMiddleware, secret_key=settings.secret_key, same_site="lax",
                       https_only=settings.app_env == "prod")
    admin = Admin(
        app=app,
        engine=engine,
        title="V2TXT 运营后台",
        base_url="/ops",
        authentication_backend=OpsAuth(secret_key=settings.secret_key),
    )
    for view in VIEWS:
        admin.add_view(view)


def bootstrap_roles() -> None:
    """把 FM_ADMIN_EMAILS 里的邮箱设为 superadmin（幂等）。"""
    emails = _platform_admins()
    if not emails:
        return
    db = SessionLocal()
    try:
        changed = 0
        for user in db.scalars(select(User).where(User.email.in_(emails))).all():
            if user.ops_role != "superadmin":
                user.ops_role = "superadmin"
                changed += 1
        if changed:
            db.commit()
            log.info("已同步 %d 个平台管理员为 superadmin", changed)
    finally:
        db.close()
