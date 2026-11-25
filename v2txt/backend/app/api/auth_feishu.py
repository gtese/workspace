"""飞书登录：同一企业（tenant_key）自动归入同一个团队空间。"""

from __future__ import annotations

import logging
import threading

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import feishu_oauth
from ..accounts import issue_login_session, normalize_email
from ..billing import grant_signup_bonus
from ..config import get_settings
from ..db import get_db
from ..models import Membership, Org, User, utcnow
from ..ratelimit import enforce
from ..user_tokens import put as put_user_token
from .auth_users import _client, user_dict
from .deps import current_user

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["feishu-auth"])


class FeishuLoginIn(BaseModel):
    code: str = Field(max_length=500)
    redirect_uri: str = Field(default="", max_length=300)


def _feishu_enabled() -> bool:
    s = get_settings()
    return s.feishu_mode == "real" and bool(s.feishu_app_id and s.feishu_app_secret)


def _placeholder_email(open_id: str) -> str:
    return f"{open_id}@feishu.local"


def _team_for_tenant(db: Session, tenant_key: str, owner: User) -> Org:
    org = db.scalars(select(Org).where(Org.feishu_tenant_key == tenant_key)).first()
    if org is not None:
        return org
    name = ""
    if tenant_key:
        info = feishu_oauth.tenant_info()
        name = (info.get("name") or info.get("display_name") or "").strip()
    org = Org(
        name=name or "飞书团队",
        kind="team",
        owner_id=owner.id,
        feishu_tenant_key=tenant_key or "",
    )
    db.add(org)
    db.flush()
    db.add(Membership(org_id=org.id, user_id=owner.id, role="owner"))
    db.commit()
    grant_signup_bonus(db, org, get_settings().signup_bonus_minutes)
    log.info("飞书团队空间已创建 org=%s tenant=%s name=%s", org.id, tenant_key, org.name)
    return org


@router.get("/auth/feishu/config")
def feishu_config() -> dict:
    s = get_settings()
    base = s.public_base_url.rstrip("/")
    return {
        "enabled": _feishu_enabled(),
        "app_id": s.feishu_app_id if _feishu_enabled() else "",
        # 授权与换 token 必须使用同一个 redirect_uri，统一由服务端下发
        "redirect_uri": f"{base}/feishu-callback",
    }


@router.get("/auth/feishu/authorize-url")
def feishu_authorize_url(redirect_uri: str = "") -> dict:
    if not _feishu_enabled():
        raise HTTPException(status_code=400, detail="飞书登录未启用")
    target = redirect_uri or f"{get_settings().public_base_url.rstrip('/')}/feishu-callback"
    return {"url": feishu_oauth.authorize_url(target), "redirect_uri": target}


@router.post("/auth/feishu")
def feishu_login(body: FeishuLoginIn, request: Request, db: Session = Depends(get_db)) -> dict:
    settings = get_settings()
    if not _feishu_enabled():
        raise HTTPException(status_code=400, detail="飞书登录未启用")
    ip, ua = _client(request)
    enforce(ip or "anon", "auth_login")

    try:
        token_data = feishu_oauth.exchange_code(body.code, body.redirect_uri)
        info = feishu_oauth.user_info(token_data["access_token"])
    except feishu_oauth.FeishuError as exc:
        raise HTTPException(status_code=401, detail=f"飞书登录失败：{exc}") from exc

    open_id = info["open_id"]
    union_id = info.get("union_id", "")
    tenant_key = info.get("tenant_key", "")
    name = (info.get("name") or info.get("en_name") or "").strip()
    email = normalize_email(info.get("enterprise_email") or info.get("email") or "")

    user = db.scalars(select(User).where(User.feishu_open_id == open_id)).first()
    if user is None and email:
        user = db.scalars(select(User).where(User.email == email)).first()
        if user is not None:
            user.feishu_open_id = open_id
            user.feishu_union_id = union_id
            user.feishu_tenant_key = tenant_key
            db.commit()
            log.info("飞书账号与既有账号合并 user=%s email=%s", user.id, email)
    if user is None:
        user = User(
            email=email or _placeholder_email(open_id),
            password_hash="",
            name=name or (email.split("@")[0] if email else "飞书用户"),
            locale="zh",
            feishu_open_id=open_id,
            feishu_union_id=union_id,
            feishu_tenant_key=tenant_key,
            email_verified_at=utcnow() if email else None,
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    if user.status != "active":
        raise HTTPException(status_code=403, detail="账号已被停用，请联系客服")

    if tenant_key:
        org = _team_for_tenant(db, tenant_key, user)
        member = db.scalars(
            select(Membership).where(Membership.org_id == org.id, Membership.user_id == user.id)
        ).first()
        if member is None:
            db.add(Membership(org_id=org.id, user_id=user.id, role="member"))
            db.commit()
        user.default_org_id = org.id
    elif user.default_org_id:
        org = db.get(Org, user.default_org_id)
    else:
        org = _team_for_tenant(db, "", user)
        user.default_org_id = org.id

    user.feishu_open_id = open_id
    user.feishu_union_id = union_id or user.feishu_union_id
    user.feishu_tenant_key = tenant_key or user.feishu_tenant_key
    if name and not user.name:
        user.name = name
    db.commit()

    put_user_token(open_id, token_data.get("access_token", ""))
    # 后台对齐云盘「AI录音」目录，失败不影响登录
    from ..feishu.folder_sync import ensure_folder_from_user

    def _prepare_drive() -> None:
        ensure_folder_from_user(open_id)

    threading.Thread(target=_prepare_drive, daemon=True).start()
    session_token, expires = issue_login_session(db, user, ip=ip, ua=ua)
    payload = user_dict(db, user)
    payload["feishu"] = {"open_id": open_id, "tenant_key": tenant_key}
    return {
        "token": session_token,
        "expires_at": expires.isoformat(),
        "user": payload,
        "org_id": payload.get("default_org_id", ""),
        "team_org_id": user.default_org_id,
        "tenant_key": tenant_key,
        "settings": {"site_name": settings.site_name},
    }


@router.get("/auth/feishu/me")
def feishu_me(user: User = Depends(current_user)) -> dict:
    return {
        "open_id": user.feishu_open_id,
        "tenant_key": user.feishu_tenant_key,
        "linked": bool(user.feishu_open_id),
    }
