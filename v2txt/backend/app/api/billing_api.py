"""计费 API：套餐、额度、流水、对公充值单。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..billing import TOPUP_PACKS, list_plans, org_summary
from ..config import get_settings
from ..db import get_db
from ..models import LedgerEntry, Order, Org, Plan, User
from ..ratelimit import enforce
from .deps import current_org, current_user, is_platform_admin, membership_of

router = APIRouter(prefix="/api/v1/billing", tags=["billing"])


class TopupIn(BaseModel):
    minutes: float = Field(gt=0, le=100000)
    amount: float = Field(gt=0, le=1000000)
    currency: str = "CNY"
    payer_name: str = Field(default="", max_length=120)
    note: str = Field(default="", max_length=500)


class SubscribeIn(BaseModel):
    plan_code: str = Field(max_length=32)


@router.get("/summary")
def summary(org: Org = Depends(current_org), db: Session = Depends(get_db)) -> dict:
    data = org_summary(db, org.id)
    settings = get_settings()
    data["low_balance_warn"] = settings.low_balance_warn_minutes
    return data


@router.get("/plans")
def plans(db: Session = Depends(get_db)) -> dict:
    items = []
    for plan in list_plans(db):
        items.append(
            {
                "code": plan.code,
                "name": plan.name,
                "price_usd": plan.price_usd,
                "minutes_included": plan.minutes_included,
                "period_days": plan.period_days,
                "features": [f for f in plan.features.split("|") if f],
            }
        )
    return {"items": items, "packs": TOPUP_PACKS, "currency": get_settings().billing_currency}


@router.get("/ledger")
def ledger(
    limit: int = 50,
    org: Org = Depends(current_org),
    db: Session = Depends(get_db),
) -> dict:
    rows = db.scalars(
        select(LedgerEntry)
        .where(LedgerEntry.org_id == org.id)
        .order_by(LedgerEntry.created_at.desc())
        .limit(min(max(limit, 1), 200))
    ).all()
    return {
        "items": [
            {
                "id": r.id,
                "kind": r.kind,
                "minutes": r.minutes,
                "balance_after": r.balance_after,
                "note": r.note,
                "recording_id": r.recording_id,
                "order_id": r.order_id,
                "created_at": r.created_at.isoformat(),
            }
            for r in rows
        ]
    }


@router.get("/orders")
def orders(org: Org = Depends(current_org), db: Session = Depends(get_db)) -> dict:
    rows = db.scalars(
        select(Order).where(Order.org_id == org.id).order_by(Order.created_at.desc()).limit(100)
    ).all()
    return {"items": [_order_dict(r) for r in rows]}


def _order_dict(order: Order) -> dict:
    return {
        "id": order.id,
        "kind": order.kind,
        "plan_code": order.plan_code,
        "minutes": order.minutes,
        "amount": order.amount,
        "currency": order.currency,
        "status": order.status,
        "payer_name": order.payer_name,
        "note": order.note,
        "created_at": order.created_at.isoformat(),
        "confirmed_at": order.confirmed_at.isoformat() if order.confirmed_at else None,
    }


@router.post("/orders")
def create_topup(
    body: TopupIn,
    user: User = Depends(current_user),
    org: Org = Depends(current_org),
    db: Session = Depends(get_db),
) -> dict:
    enforce(user.id, "order")
    member = membership_of(db, user.id, org.id)
    if member is None or member.role == "member":
        raise HTTPException(status_code=403, detail="只有管理员可以提交充值单")
    order = Order(
        org_id=org.id,
        user_id=user.id,
        kind="topup",
        minutes=round(body.minutes, 2),
        amount=round(body.amount, 2),
        currency=body.currency if body.currency in ("CNY", "USD") else "CNY",
        payer_name=body.payer_name[:120],
        note=body.note[:500],
    )
    db.add(order)
    db.commit()
    audit.record(db, "billing.order.create", org_id=org.id, user_id=user.id, actor=user.email,
                 target=order.id, detail={"minutes": order.minutes, "amount": order.amount,
                                          "currency": order.currency})
    return _order_dict(order)


@router.post("/subscribe")
def subscribe(
    body: SubscribeIn,
    user: User = Depends(current_user),
    org: Org = Depends(current_org),
    db: Session = Depends(get_db),
) -> dict:
    enforce(user.id, "order")
    plan = db.get(Plan, body.plan_code)
    if plan is None or not plan.active:
        raise HTTPException(status_code=404, detail="套餐不存在")
    if plan.code == "free":
        raise HTTPException(status_code=400, detail="免费套餐无需下单")
    member = membership_of(db, user.id, org.id)
    if member is None or member.role == "member":
        raise HTTPException(status_code=403, detail="只有管理员可以开通套餐")
    money = plan.price_usd * 7.2 if get_settings().billing_currency == "CNY" else plan.price_usd
    order = Order(
        org_id=org.id,
        user_id=user.id,
        kind="subscription",
        plan_code=plan.code,
        minutes=plan.minutes_included,
        amount=round(money, 2),
        currency=get_settings().billing_currency,
        note=f"订阅 {plan.name}（{plan.minutes_included:g} 分钟/期）",
    )
    db.add(order)
    db.commit()
    audit.record(db, "billing.order.create", org_id=org.id, user_id=user.id, actor=user.email,
                 target=order.id, detail={"minutes": order.minutes, "amount": order.amount,
                                          "currency": order.currency})
    return _order_dict(order)


@router.post("/orders/{order_id}/cancel")
def cancel_order(
    order_id: str,
    user: User = Depends(current_user),
    org: Org = Depends(current_org),
    db: Session = Depends(get_db),
) -> dict:
    order = db.get(Order, order_id)
    if order is None or order.org_id != org.id:
        raise HTTPException(status_code=404, detail="订单不存在")
    if order.status != "pending":
        raise HTTPException(status_code=400, detail="只有待确认的订单可以取消")
    if order.user_id != user.id and not is_platform_admin(user):
        member = membership_of(db, user.id, org.id)
        if member is None or member.role == "member":
            raise HTTPException(status_code=403, detail="只有管理员可以取消订单")
    order.status = "canceled"
    db.commit()
    audit.record(db, "billing.order.cancel", org_id=org.id, user_id=user.id, actor=user.email,
                 target=order.id)
    return _order_dict(order)


@router.get("/payment-info")
def payment_info() -> dict:
    """对公转账收款信息（可在环境变量里覆盖，不要写死在代码里）。"""
    s = get_settings()
    return {
        "bank": getattr(s, "pay_bank_name", "") or "请联系客服获取对公账户",
        "account_name": getattr(s, "pay_account_name", ""),
        "account_no": getattr(s, "pay_account_no", ""),
        "swift": getattr(s, "pay_swift", ""),
        "note": "转账备注请填写订单号；到账后 1 个工作日内开通",
    }
