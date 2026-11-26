"""邮箱账号体系：注册、登录、验证、找回密码、个人资料。"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit, mailer
from ..accounts import (
    consume_email_token,
    hash_password,
    issue_email_token,
    issue_login_session,
    normalize_email,
    password_problem,
    revoke_all_sessions,
    revoke_login_session,
    valid_email,
    verify_password,
)
from ..billing import balance, grant_signup_bonus, org_summary
from ..config import get_settings
from ..db import get_db
from ..models import Membership, Org, User, utcnow
from ..ratelimit import enforce
from .deps import current_user, is_platform_admin

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["auth"])


class RegisterIn(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(default="", max_length=100)
    locale: str = "zh"


class LoginIn(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(max_length=128)


class TokenIn(BaseModel):
    token: str = Field(max_length=200)


class ResetIn(BaseModel):
    token: str = Field(max_length=200)
    password: str = Field(min_length=8, max_length=128)


class EmailOnlyIn(BaseModel):
    email: str = Field(max_length=320)


class ProfileIn(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    locale: str | None = None


class PasswordIn(BaseModel):
    old_password: str = Field(max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


def _base_url() -> str:
    return get_settings().public_base_url.rstrip("/")


def _client(request: Request) -> tuple[str, str]:
    ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
        request.client.host if request.client else ""
    )
    return ip, request.headers.get("user-agent", "")[:300]


def user_dict(db: Session, user: User) -> dict:
    orgs = db.scalars(
        select(Org).join(Membership, Membership.org_id == Org.id).where(Membership.user_id == user.id)
    ).all()
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "locale": user.locale,
        "email_verified": user.email_verified_at is not None,
        "status": user.status,
        "is_admin": is_platform_admin(user),
        "ops_role": (is_platform_admin(user) and "superadmin") or getattr(user, "ops_role", ""),
        "created_at": user.created_at.isoformat(),
        "default_org_id": user.default_org_id,
        "orgs": [
            {
                "id": org.id,
                "name": org.name,
                "kind": org.kind,
                "role": next(
                    (
                        m.role
                        for m in db.scalars(
                            select(Membership).where(
                                Membership.org_id == org.id, Membership.user_id == user.id
                            )
                        )
                    ),
                    "member",
                ),
            }
            for org in orgs
        ],
    }


def _auth_payload(db: Session, user: User, token: str, expires) -> dict:
    return {
        "token": token,
        "expires_at": expires.isoformat(),
        "user": user_dict(db, user),
    }


@router.post("/auth/register")
def register(body: RegisterIn, request: Request, db: Session = Depends(get_db)) -> dict:
    settings = get_settings()
    ip, ua = _client(request)
    enforce(ip or "anon", "auth_register")
    if not settings.allow_self_register:
        raise HTTPException(status_code=403, detail="当前未开放自助注册")
    email = normalize_email(body.email)
    if not valid_email(email):
        raise HTTPException(status_code=400, detail="邮箱格式不正确")
    problem = password_problem(body.password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    existing = db.scalars(select(User).where(User.email == email)).first()
    if existing is not None:
        raise HTTPException(status_code=409, detail="该邮箱已注册，请直接登录或找回密码")

    user = User(
        email=email,
        password_hash=hash_password(body.password),
        name=(body.name or email.split("@")[0])[:100],
        locale="en" if body.locale == "en" else "zh",
    )
    db.add(user)
    db.flush()
    org = Org(name=f"{user.name} 的空间" if user.locale == "zh" else f"{user.name}'s workspace",
              kind="personal", owner_id=user.id)
    db.add(org)
    db.flush()
    db.add(Membership(org_id=org.id, user_id=user.id, role="owner"))
    user.default_org_id = org.id
    db.commit()
    grant_signup_bonus(db, org, settings.signup_bonus_minutes)

    # 邮箱只作为联系方式，不做验证、不发提醒邮件
    user.email_verified_at = utcnow()
    db.commit()

    session_token, expires = issue_login_session(db, user, ip=ip, ua=ua)
    audit.record(db, "auth.register", request=request, org_id=org.id, user_id=user.id,
                 actor=user.email, target=user.email, detail={"locale": user.locale})
    log.info("新用户注册 user=%s org=%s", user.id, org.id)
    return _auth_payload(db, user, session_token, expires)


@router.post("/auth/login")
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)) -> dict:
    ip, ua = _client(request)
    enforce(ip or "anon", "auth_login")
    email = normalize_email(body.email)
    user = db.scalars(select(User).where(User.email == email)).first()
    if user is not None and not user.password_hash:
        audit.record(db, "auth.login.failed", request=request, user_id=user.id, actor=email,
                     result="fail", detail={"reason": "feishu_only"})
        raise HTTPException(status_code=400, detail="该账号使用飞书登录，请点「飞书登录」")
    if user is None or not verify_password(body.password, user.password_hash):
        audit.record(db, "auth.login.failed", request=request,
                     user_id=(user.id if user else ""), actor=email, result="fail",
                     detail={"reason": "bad_credentials"})
        raise HTTPException(status_code=401, detail="邮箱或密码不正确")
    if user.status != "active":
        audit.record(db, "auth.login.failed", request=request, user_id=user.id, actor=email,
                     result="denied", detail={"reason": "disabled"})
        raise HTTPException(status_code=403, detail="账号已被停用，请联系客服")
    token, expires = issue_login_session(db, user, ip=ip, ua=ua)
    audit.record(db, "auth.login", request=request, org_id=user.default_org_id, user_id=user.id,
                 actor=user.email, detail={"method": "password"})
    return _auth_payload(db, user, token, expires)


@router.post("/auth/logout")
def logout(
    request: Request,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> dict:
    if authorization and authorization.lower().startswith("bearer "):
        revoke_login_session(db, authorization.split(" ", 1)[1].strip())
        audit.record(db, "auth.logout", request=request)
    return {"ok": True}


@router.post("/auth/verify-email")
def verify_email(body: TokenIn, db: Session = Depends(get_db)) -> dict:
    row = consume_email_token(db, "verify", body.token)
    if row is None:
        raise HTTPException(status_code=400, detail="验证链接无效或已过期")
    user = db.get(User, row.user_id) if row.user_id else None
    if user is None:
        user = db.scalars(select(User).where(User.email == row.email)).first()
    if user is None:
        raise HTTPException(status_code=404, detail="账号不存在")
    if user.email_verified_at is None:
        user.email_verified_at = utcnow()
        db.commit()
    audit.record(db, "auth.email.verified", user_id=user.id, actor=user.email, target=user.email)
    return {"ok": True, "email": user.email}


@router.post("/auth/resend-verify")
def resend_verify(
    user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    if user.email_verified_at is not None:
        return {"ok": True, "already_verified": True}
    enforce(user.id, "auth_email")
    raw = issue_email_token(db, "verify", user.email, user_id=user.id)
    mailer.send_verify_email(user.email, f"{_base_url()}/verify?token={raw}")
    return {"ok": True}


@router.post("/auth/forgot-password")
def forgot_password(body: EmailOnlyIn, request: Request, db: Session = Depends(get_db)) -> dict:
    ip, _ = _client(request)
    enforce(ip or "anon", "auth_email")
    email = normalize_email(body.email)
    user = db.scalars(select(User).where(User.email == email)).first()
    if user is not None and user.status == "active":
        raw = issue_email_token(db, "reset", email, user_id=user.id)
        mailer.send_reset_email(email, f"{_base_url()}/reset?token={raw}")
        audit.record(db, "auth.password.forgot", request=request, user_id=user.id, actor=email)
    return {"ok": True, "message": "如果该邮箱已注册，重置邮件会在几分钟内送达"}


@router.post("/auth/reset-password")
def reset_password(body: ResetIn, db: Session = Depends(get_db)) -> dict:
    problem = password_problem(body.password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    row = consume_email_token(db, "reset", body.token)
    if row is None:
        raise HTTPException(status_code=400, detail="重置链接无效或已过期")
    user = db.get(User, row.user_id) if row.user_id else None
    if user is None:
        user = db.scalars(select(User).where(User.email == row.email)).first()
    if user is None:
        raise HTTPException(status_code=404, detail="账号不存在")
    user.password_hash = hash_password(body.password)
    db.commit()
    revoke_all_sessions(db, user.id)
    audit.record(db, "auth.password.reset", user_id=user.id, actor=user.email, result="ok")
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    payload = user_dict(db, user)
    orgs = []
    for item in payload["orgs"]:
        summary = org_summary(db, item["id"])
        item["minutes"] = summary["minutes"]
        item["plan"] = (summary["plan"] or {}).get("name", "Free")
        orgs.append(item)
    payload["orgs"] = orgs
    payload["current_org_id"] = user.default_org_id
    payload["balance"] = balance(db, user.default_org_id) if user.default_org_id else 0
    return payload


@router.patch("/me")
def update_me(
    body: ProfileIn, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    if body.name is not None and body.name.strip():
        user.name = body.name.strip()[:100]
    if body.locale in ("zh", "en"):
        user.locale = body.locale
    db.commit()
    return user_dict(db, user)


@router.post("/me/password")
def change_password(
    body: PasswordIn, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    if not verify_password(body.old_password, user.password_hash):
        raise HTTPException(status_code=400, detail="原密码不正确")
    problem = password_problem(body.new_password)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    user.password_hash = hash_password(body.new_password)
    db.commit()
    revoke_all_sessions(db, user.id)
    audit.record(db, "auth.password.changed", user_id=user.id, actor=user.email)
    return {"ok": True, "message": "密码已更新，请重新登录"}
