"""团队空间：创建、改名、成员、邀请、切换。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit, mailer
from ..accounts import consume_email_token, issue_email_token, normalize_email, valid_email
from ..billing import balance
from ..config import get_settings
from ..db import get_db
from ..models import Membership, Org, OrgInvite, User, utcnow
from ..ratelimit import enforce
from .deps import (
    current_user,
    membership_of,
    require_org_admin,
    resolve_org,
)

router = APIRouter(prefix="/api/v1", tags=["orgs"])


class OrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class InviteIn(BaseModel):
    email: str = Field(max_length=320)
    role: str = "member"


class RoleIn(BaseModel):
    role: str


class AcceptIn(BaseModel):
    token: str = Field(max_length=200)


class SwitchIn(BaseModel):
    org_id: str


def _org_dict(db: Session, org: Org) -> dict:
    members = db.scalars(select(Membership).where(Membership.org_id == org.id)).all()
    return {
        "id": org.id,
        "name": org.name,
        "kind": org.kind,
        "owner_id": org.owner_id,
        "member_count": len(members),
        "minutes": balance(db, org.id),
        "created_at": org.created_at.isoformat(),
    }


@router.get("/orgs")
def list_orgs(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    orgs = db.scalars(
        select(Org).join(Membership, Membership.org_id == Org.id).where(Membership.user_id == user.id)
    ).all()
    return {"items": [_org_dict(db, o) for o in orgs], "current": user.default_org_id}


@router.post("/orgs")
def create_org(
    body: OrgIn, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    enforce(user.id, "create")
    org = Org(name=body.name.strip()[:120], kind="team", owner_id=user.id)
    db.add(org)
    db.flush()
    db.add(Membership(org_id=org.id, user_id=user.id, role="owner"))
    db.commit()
    audit.record(db, "org.create", org_id=org.id, user_id=user.id, actor=user.email, target=org.name)
    return _org_dict(db, org)


@router.patch("/orgs/{org_id}")
def rename_org(
    org_id: str, body: OrgIn, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    org = resolve_org(db, user, org_id)
    member = membership_of(db, user.id, org.id)
    if member is None or member.role != "owner":
        raise HTTPException(status_code=403, detail="只有空间所有者可以改名")
    old = org.name
    org.name = body.name.strip()[:120]
    db.commit()
    audit.record(db, "org.rename", org_id=org.id, user_id=user.id, actor=user.email,
                 detail={"from": old, "to": org.name})
    return _org_dict(db, org)


@router.get("/orgs/{org_id}/members")
def list_members(
    org_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    org = resolve_org(db, user, org_id)
    rows = db.scalars(select(Membership).where(Membership.org_id == org.id)).all()
    items = []
    for row in rows:
        member_user = db.get(User, row.user_id)
        items.append(
            {
                "user_id": row.user_id,
                "email": member_user.email if member_user else "",
                "name": member_user.name if member_user else "",
                "role": row.role,
                "joined_at": row.created_at.isoformat(),
            }
        )
    pending = db.scalars(
        select(OrgInvite).where(OrgInvite.org_id == org.id, OrgInvite.accepted_at.is_(None))
    ).all()
    return {
        "items": items,
        "invites": [
            {"id": i.id, "email": i.email, "role": i.role, "created_at": i.created_at.isoformat()}
            for i in pending
        ],
    }


@router.post("/orgs/{org_id}/invites")
def invite_member(
    org_id: str, body: InviteIn, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    org = require_org_admin(resolve_org(db, user, org_id), user, db)
    enforce(user.id, "send")
    email = normalize_email(body.email)
    if not valid_email(email):
        raise HTTPException(status_code=400, detail="邮箱格式不正确")
    if body.role not in ("admin", "member"):
        raise HTTPException(status_code=400, detail="角色不合法")
    existing = db.scalars(select(User).where(User.email == email)).first()
    if existing is not None and membership_of(db, existing.id, org.id) is not None:
        raise HTTPException(status_code=409, detail="该用户已在团队中")
    invite = OrgInvite(org_id=org.id, email=email, role=body.role, invited_by=user.id)
    db.add(invite)
    db.commit()
    raw = issue_email_token(db, "invite", email, payload=f"{org.id}|{body.role}", ttl_minutes=60 * 72)
    link = f"{get_settings().public_base_url.rstrip('/')}/join?token={raw}"
    mailer.send_invite_email(email, org.name, link)
    audit.record(db, "org.invite", org_id=org.id, user_id=user.id, actor=user.email,
                 target=email, detail={"role": body.role})
    return {"ok": True, "invite_id": invite.id, "link": link if get_settings().app_env != "prod" else None}


@router.post("/orgs/accept-invite")
def accept_invite(
    body: AcceptIn, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    row = consume_email_token(db, "invite", body.token)
    if row is None:
        raise HTTPException(status_code=400, detail="邀请链接无效或已过期")
    payload = (row.payload or "").split("|")
    org_id = payload[0] if payload else ""
    role = payload[1] if len(payload) > 1 and payload[1] in ("admin", "member") else "member"
    org = db.get(Org, org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="团队不存在")
    if membership_of(db, user.id, org.id) is None:
        db.add(Membership(org_id=org.id, user_id=user.id, role=role))
    invites = db.scalars(
        select(OrgInvite).where(
            OrgInvite.org_id == org.id, OrgInvite.email == user.email, OrgInvite.accepted_at.is_(None)
        )
    ).all()
    for item in invites:
        item.accepted_at = utcnow()
    db.commit()
    audit.record(db, "org.accept", org_id=org.id, user_id=user.id, actor=user.email)
    return {"ok": True, "org": _org_dict(db, org)}


@router.patch("/orgs/{org_id}/members/{user_id}")
def set_role(
    org_id: str,
    user_id: str,
    body: RoleIn,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    org = resolve_org(db, user, org_id)
    actor = membership_of(db, user.id, org.id)
    if actor is None or actor.role != "owner":
        raise HTTPException(status_code=403, detail="只有空间所有者可以调整角色")
    if body.role not in ("admin", "member"):
        raise HTTPException(status_code=400, detail="角色不合法")
    target = membership_of(db, user_id, org.id)
    if target is None:
        raise HTTPException(status_code=404, detail="成员不存在")
    if target.role == "owner":
        raise HTTPException(status_code=400, detail="不能修改所有者角色")
    target.role = body.role
    db.commit()
    audit.record(db, "org.role", org_id=org.id, user_id=user.id, actor=user.email,
                 target=user_id, detail={"role": body.role})
    return {"ok": True}


@router.delete("/orgs/{org_id}/members/{user_id}")
def remove_member(
    org_id: str,
    user_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    org = resolve_org(db, user, org_id)
    actor = membership_of(db, user.id, org.id)
    if actor is None or actor.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="需要管理员权限")
    target = membership_of(db, user_id, org.id)
    if target is None:
        raise HTTPException(status_code=404, detail="成员不存在")
    if target.role == "owner":
        raise HTTPException(status_code=400, detail="不能移除空间所有者")
    if target.user_id == user.id and actor.role != "owner":
        raise HTTPException(status_code=400, detail="请让所有者移除你")
    db.delete(target)
    db.commit()
    audit.record(db, "org.member.remove", org_id=org.id, user_id=user.id, actor=user.email, target=user_id)
    return {"ok": True}


@router.post("/me/switch-org")
def switch_org(
    body: SwitchIn, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    org = resolve_org(db, user, body.org_id)
    user.default_org_id = org.id
    db.commit()
    audit.record(db, "org.switch", org_id=org.id, user_id=user.id, actor=user.email)
    return {"ok": True, "org_id": org.id}
