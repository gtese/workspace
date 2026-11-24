"""计费服务：钱包余额、额度台账、扣费与套餐。"""

from __future__ import annotations

import math

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .models import LedgerEntry, Org, Plan, Subscription, UsageRecord, Wallet, utcnow

DEFAULT_PLANS = [
    {
        "code": "free",
        "name": "Free",
        "price_usd": 0.0,
        "minutes_included": 60.0,
        "period_days": 30,
        "sort": 10,
        "features": "60 分钟/月|网页录音|文件上传|中英纪要",
    },
    {
        "code": "pro",
        "name": "Pro",
        "price_usd": 9.9,
        "minutes_included": 600.0,
        "period_days": 30,
        "sort": 20,
        "features": "600 分钟/月|超额按 $0.02/分钟|团队 3 人|飞书/Word 导出",
    },
    {
        "code": "team",
        "name": "Team",
        "price_usd": 29.0,
        "minutes_included": 2000.0,
        "period_days": 30,
        "sort": 30,
        "features": "2000 分钟/月|超额按 $0.02/分钟|成员不限|共享额度池|优先支持",
    },
]

TOPUP_PACKS = [
    {"minutes": 60.0, "amount": 1.2},
    {"minutes": 300.0, "amount": 6.0},
    {"minutes": 1000.0, "amount": 20.0},
]


def seed_plans(db: Session) -> None:
    for item in DEFAULT_PLANS:
        plan = db.get(Plan, item["code"])
        if plan is None:
            db.add(Plan(**item))
    db.commit()


def list_plans(db: Session) -> list[Plan]:
    return list(db.scalars(select(Plan).where(Plan.active.is_(True)).order_by(Plan.sort)).all())


def get_wallet(db: Session, org_id: str) -> Wallet:
    wallet = db.get(Wallet, org_id)
    if wallet is None:
        wallet = Wallet(org_id=org_id, minutes=0.0)
        db.add(wallet)
        db.commit()
    return wallet


def balance(db: Session, org_id: str) -> float:
    return round(get_wallet(db, org_id).minutes, 3)


def _apply(db: Session, org_id: str, delta: float, **kwargs) -> LedgerEntry:
    wallet = get_wallet(db, org_id)
    wallet.minutes = round(wallet.minutes + delta, 3)
    wallet.updated_at = utcnow()
    entry = LedgerEntry(
        org_id=org_id,
        minutes=round(delta, 3),
        balance_after=wallet.minutes,
        **kwargs,
    )
    db.add(entry)
    db.commit()
    return entry


def credit(
    db: Session,
    org_id: str,
    minutes: float,
    kind: str = "topup",
    note: str = "",
    order_id: str = "",
    operator_id: str = "",
) -> LedgerEntry:
    return _apply(
        db, org_id, abs(minutes), kind=kind, note=note, order_id=order_id, operator_id=operator_id
    )


def debit(
    db: Session,
    org_id: str,
    minutes: float,
    note: str = "",
    recording_id: str = "",
) -> LedgerEntry:
    return _apply(
        db, org_id, -abs(minutes), kind="consume", note=note, recording_id=recording_id
    )


def billable_minutes(audio_seconds: float) -> float:
    settings = get_settings()
    raw = max(0.0, audio_seconds) / 60.0
    step = max(0.1, settings.billing_round_minutes)
    rounded = math.ceil(raw / step - 1e-9) * step
    return round(max(settings.min_billed_minutes, rounded), 3)


def charge_task(
    db: Session,
    org_id: str,
    recording_id: str,
    audio_seconds: float,
    asr_cost_cny: float = 0.0,
    llm_cost_cny: float = 0.0,
) -> UsageRecord:
    """任务完成时结算：扣额度 + 记成本。"""
    minutes = billable_minutes(audio_seconds)
    if org_id:
        debit(db, org_id, minutes, note="转写计费", recording_id=recording_id)
    usage = UsageRecord(
        recording_id=recording_id,
        org_id=org_id,
        audio_seconds=round(audio_seconds, 1),
        asr_cost_cny=round(asr_cost_cny, 4),
        llm_cost_cny=round(llm_cost_cny, 4),
        billed_minutes=minutes,
    )
    db.add(usage)
    db.commit()
    return usage


def can_start_task(db: Session, org_id: str) -> bool:
    return balance(db, org_id) > 0


def org_summary(db: Session, org_id: str) -> dict:
    settings = get_settings()
    wallet = get_wallet(db, org_id)
    sub = db.scalars(
        select(Subscription)
        .where(Subscription.org_id == org_id, Subscription.status == "active")
        .order_by(Subscription.created_at.desc())
    ).first()
    plan = db.get(Plan, sub.plan_code) if sub else None
    return {
        "org_id": org_id,
        "minutes": round(wallet.minutes, 2),
        "low_balance": wallet.minutes < settings.low_balance_warn_minutes,
        "price_per_minute": settings.price_per_minute_usd,
        "currency": settings.billing_currency,
        "plan": None
        if plan is None
        else {
            "code": plan.code,
            "name": plan.name,
            "minutes_included": plan.minutes_included,
            "price_usd": plan.price_usd,
        },
        "period_end": sub.period_end.isoformat() if sub else None,
    }


def grant_signup_bonus(db: Session, org: Org, minutes: float) -> None:
    if minutes <= 0:
        return
    credit(db, org.id, minutes, kind="grant", note="注册赠送")
