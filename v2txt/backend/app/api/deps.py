"""FastAPI 依赖：登录用户、当前租户、权限。"""

from __future__ import annotations

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..accounts import resolve_login_session
from ..config import get_settings
from ..db import get_db
from ..models import Membership, Org, User


def _bearer(authorization: str | None) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip()
    return ""


def current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    user = resolve_login_session(db, _bearer(authorization))
    if user is None:
        raise HTTPException(status_code=401, detail="请先登录")
    return user


def optional_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User | None:
    return resolve_login_session(db, _bearer(authorization))


def membership_of(db: Session, user_id: str, org_id: str) -> Membership | None:
    return db.scalars(
        select(Membership).where(Membership.user_id == user_id, Membership.org_id == org_id)
    ).first()


def resolve_org(db: Session, user: User, org_id: str = "") -> Org:
    target = org_id or user.default_org_id
    if not target:
        row = db.scalars(
            select(Membership).where(Membership.user_id == user.id).order_by(Membership.created_at)
        ).first()
        target = row.org_id if row else ""
    if not target:
        raise HTTPException(status_code=400, detail="账号还没有可用空间")
    if membership_of(db, user.id, target) is None:
        raise HTTPException(status_code=403, detail="无权访问该团队空间")
    org = db.get(Org, target)
    if org is None or org.status != "active":
        raise HTTPException(status_code=404, detail="团队空间不存在")
    return org


def current_org(
    x_org_id: str | None = Header(default=None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Org:
    return resolve_org(db, user, x_org_id or "")


def require_org_admin(
    org: Org = Depends(current_org),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Org:
    member = membership_of(db, user.id, org.id)
    if member is None or member.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return org


def ops_role_of(user: User) -> str:
    """运营角色：平台管理员邮箱优先 superadmin，其次 users.ops_role。"""
    emails = {e.strip().lower() for e in get_settings().admin_emails.split(",") if e.strip()}
    if (user.email or "").lower() in emails:
        return "superadmin"
    role = getattr(user, "ops_role", "") or ""
    return role if role in ("viewer", "support", "finance", "superadmin") else ""


def require_ops(*roles: str):
    """用法：Depends(require_ops("support", "superadmin"))。"""

    def _dep(user: User = Depends(current_user)) -> User:
        role = ops_role_of(user)
        if not role or (roles and role not in roles):
            raise HTTPException(status_code=403, detail="需要运营权限")
        return user

    return _dep


def is_platform_admin(user: User) -> bool:
    emails = {e.strip().lower() for e in get_settings().admin_emails.split(",") if e.strip()}
    return bool(emails) and user.email.lower() in emails


def require_platform_admin(user: User = Depends(current_user)) -> User:
    if not is_platform_admin(user):
        raise HTTPException(status_code=403, detail="需要运营权限")
    return user
