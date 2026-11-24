"""运营后台 API：用户、订单确认、手工调额度、用量毛利。"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import mailer
from ..billing import credit, org_summary
from ..config import get_settings
from ..db import get_db
from ..models import (
    Membership,
    Order,
    Org,
    Plan,
    Recording,
    Subscription,
    UsageRecord,
    User,
    utcnow,
)
from .deps import require_platform_admin

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


class StatusIn(BaseModel):
    status: str
    reason: str = ""


class GrantIn(BaseModel):
    minutes: float = Field(gt=0, le=100000)
    note: str = Field(default="运营调整", max_length=200)


class ConfirmIn(BaseModel):
    minutes: float | None = None
    note: str = ""


@router.get("/overview")
def overview(
    admin: User = Depends(require_platform_admin), db: Session = Depends(get_db)
) -> dict:
    since = utcnow() - timedelta(days=30)
    users = db.scalar(select(func.count()).select_from(User)) or 0
    orgs = db.scalar(select(func.count()).select_from(Org)) or 0
    recs = db.scalar(select(func.count()).select_from(Recording)) or 0
    recs30 = (
        db.scalar(
            select(func.count()).select_from(Recording).where(Recording.created_at >= since)
        )
        or 0
    )
    pending = (
        db.scalar(select(func.count()).select_from(Order).where(Order.status == "pending")) or 0
    )
    usage = db.scalars(select(UsageRecord).where(UsageRecord.created_at >= since)).all()
    minutes = sum(u.billed_minutes for u in usage)
    cost = sum(u.asr_cost_cny + u.llm_cost_cny for u in usage)
    revenue = 0.0
    for order in db.scalars(select(Order).where(Order.status == "confirmed")).all():
        revenue += order.amount if order.currency == "USD" else order.amount / 7.2
    return {
        "users": users,
        "orgs": orgs,
        "recordings": recs,
        "recordings_30d": recs30,
        "pending_orders": pending,
        "billed_minutes_30d": round(minutes, 1),
        "cost_cny_30d": round(cost, 2),
        "revenue_usd": round(revenue, 2),
        "gross_margin_usd": round(revenue - cost / 7.2, 2),
        "admin": admin.email,
    }


@router.get("/users")
def list_users(
    q: str = "",
    limit: int = 50,
    admin: User = Depends(require_platform_admin),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(User).order_by(User.created_at.desc()).limit(min(max(limit, 1), 200))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(User.email.like(like) | User.name.like(like))
    rows = db.scalars(stmt).all()
    items = []
    for user in rows:
        org_sum = org_summary(db, user.default_org_id) if user.default_org_id else {"minutes": 0}
        items.append(
            {
                "id": user.id,
                "email": user.email,
                "name": user.name,
                "status": user.status,
                "email_verified": user.email_verified_at is not None,
                "created_at": user.created_at.isoformat(),
                "org_id": user.default_org_id,
                "minutes": org_sum.get("minutes", 0),
            }
        )
    return {"items": items}


@router.post("/users/{user_id}/status")
def set_user_status(
    user_id: str,
    body: StatusIn,
    admin: User = Depends(require_platform_admin),
    db: Session = Depends(get_db),
) -> dict:
    if body.status not in ("active", "disabled"):
        raise HTTPException(status_code=400, detail="状态只能是 active 或 disabled")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    user.status = body.status
    db.commit()
    return {"ok": True, "status": user.status}


@router.get("/orders")
def list_orders(
    status: str = "",
    admin: User = Depends(require_platform_admin),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(Order).order_by(Order.created_at.desc()).limit(200)
    if status in ("pending", "confirmed", "canceled"):
        stmt = stmt.where(Order.status == status)
    rows = db.scalars(stmt).all()
    items = []
    for order in rows:
        org = db.get(Org, order.org_id)
        user = db.get(User, order.user_id) if order.user_id else None
        items.append(
            {
                "id": order.id,
                "org_id": order.org_id,
                "org_name": org.name if org else "",
                "user_email": user.email if user else "",
                "kind": order.kind,
                "plan_code": order.plan_code,
                "minutes": order.minutes,
                "amount": order.amount,
                "currency": order.currency,
                "status": order.status,
                "payer_name": order.payer_name,
                "note": order.note,
                "created_at": order.created_at.isoformat(),
            }
        )
    return {"items": items}


@router.post("/orders/{order_id}/confirm")
def confirm_order(
    order_id: str,
    body: ConfirmIn,
    admin: User = Depends(require_platform_admin),
    db: Session = Depends(get_db),
) -> dict:
    order = db.get(Order, order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="订单不存在")
    if order.status != "pending":
        raise HTTPException(status_code=400, detail="该订单已处理")
    minutes = body.minutes if body.minutes is not None else order.minutes
    if minutes <= 0:
        raise HTTPException(status_code=400, detail="到账分钟数必须大于 0")

    if order.kind == "subscription" and order.plan_code:
        plan = db.get(Plan, order.plan_code)
        if plan is not None:
            current = db.scalars(
                select(Subscription).where(
                    Subscription.org_id == order.org_id, Subscription.status == "active"
                )
            ).all()
            for old in current:
                old.status = "canceled"
            start = utcnow()
            db.add(
                Subscription(
                    org_id=order.org_id,
                    plan_code=plan.code,
                    status="active",
                    period_start=start,
                    period_end=start + timedelta(days=plan.period_days),
                )
            )
            db.commit()

    credit(
        db,
        order.org_id,
        minutes,
        kind="topup",
        note=f"订单 {order.id} 确认到账" + (f"（{body.note}）" if body.note else ""),
        order_id=order.id,
        operator_id=admin.id,
    )
    order.status = "confirmed"
    order.confirmed_by = admin.id
    order.confirmed_at = utcnow()
    db.commit()

    owner = db.get(User, order.user_id) if order.user_id else None
    if owner is not None:
        mailer.send_order_email(owner.email, order.id, minutes, order.amount, order.currency)
    return {"ok": True, "order_id": order.id, "minutes": minutes}


@router.post("/orgs/{org_id}/grant")
def grant_minutes(
    org_id: str,
    body: GrantIn,
    admin: User = Depends(require_platform_admin),
    db: Session = Depends(get_db),
) -> dict:
    org = db.get(Org, org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="团队不存在")
    credit(db, org.id, body.minutes, kind="adjust", note=body.note, operator_id=admin.id)
    return {"ok": True, "minutes": org_summary(db, org.id)["minutes"]}


@router.get("/usage")
def usage_report(
    days: int = 30,
    admin: User = Depends(require_platform_admin),
    db: Session = Depends(get_db),
) -> dict:
    since = utcnow() - timedelta(days=min(max(days, 1), 365))
    rows = db.scalars(select(UsageRecord).where(UsageRecord.created_at >= since)).all()
    per_org: dict[str, dict] = {}
    for row in rows:
        bucket = per_org.setdefault(
            row.org_id, {"minutes": 0.0, "cost_cny": 0.0, "tasks": 0}
        )
        bucket["minutes"] += row.billed_minutes
        bucket["cost_cny"] += row.asr_cost_cny + row.llm_cost_cny
        bucket["tasks"] += 1
    items = []
    for org_id, bucket in per_org.items():
        org = db.get(Org, org_id)
        settings = get_settings()
        revenue = bucket["minutes"] * settings.price_per_minute_usd
        items.append(
            {
                "org_id": org_id,
                "org_name": org.name if org else "",
                "tasks": bucket["tasks"],
                "minutes": round(bucket["minutes"], 1),
                "cost_cny": round(bucket["cost_cny"], 2),
                "revenue_usd": round(revenue, 2),
                "margin_usd": round(revenue - bucket["cost_cny"] / 7.2, 2),
            }
        )
    items.sort(key=lambda x: x["minutes"], reverse=True)
    return {"days": days, "items": items}


@router.get("/orgs/{org_id}/members")
def org_members(
    org_id: str,
    admin: User = Depends(require_platform_admin),
    db: Session = Depends(get_db),
) -> dict:
    rows = db.scalars(select(Membership).where(Membership.org_id == org_id)).all()
    return {
        "items": [
            {
                "user_id": row.user_id,
                "role": row.role,
                "email": (db.get(User, row.user_id).email if db.get(User, row.user_id) else ""),
            }
            for row in rows
        ]
    }
