import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:16]}"


def utcnow() -> datetime:
    return datetime.now(UTC)


# 状态机：created -> recording -> queued -> transcribing -> transcribed -> summarizing -> done / failed
STATUS_CREATED = "created"
STATUS_RECORDING = "recording"
STATUS_QUEUED = "queued"
STATUS_TRANSCRIBING = "transcribing"
STATUS_TRANSCRIBED = "transcribed"
STATUS_SUMMARIZING = "summarizing"
STATUS_DONE = "done"
STATUS_FAILED = "failed"


# --------------------------------------------------------------------------
# 账号与租户
# --------------------------------------------------------------------------


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("usr_"))
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), default="")
    name: Mapped[str] = mapped_column(String(100), default="")
    locale: Mapped[str] = mapped_column(String(10), default="zh")
    status: Mapped[str] = mapped_column(String(20), default="active")  # active | disabled
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    default_org_id: Mapped[str] = mapped_column(String(32), default="")
    # 飞书身份：同一租户（tenant_key）的用户自动归入同一个团队空间
    feishu_open_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    feishu_union_id: Mapped[str] = mapped_column(String(64), default="")
    feishu_tenant_key: Mapped[str] = mapped_column(String(64), default="", index=True)
    # 长期保存刷新令牌：服务重启后仍能以用户身份操作云盘（建目录/移动）
    feishu_refresh_token: Mapped[str] = mapped_column(Text, default="")
    feishu_app_slug: Mapped[str] = mapped_column(String(40), default="")
    # 运营后台角色：""（无）| viewer | support | finance | superadmin
    ops_role: Mapped[str] = mapped_column(String(20), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class Session(Base):
    """登录会话：只存 token 的 SHA-256，落库即可撤销。"""

    __tablename__ = "sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(32), index=True)
    ip: Mapped[str] = mapped_column(String(64), default="")
    ua: Mapped[str] = mapped_column(String(300), default="")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EmailToken(Base):
    """邮箱验证 / 找回密码 / 团队邀请 一次性令牌。"""

    __tablename__ = "email_tokens"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    kind: Mapped[str] = mapped_column(String(20), index=True)  # verify|reset|invite
    email: Mapped[str] = mapped_column(String(320), index=True)
    user_id: Mapped[str] = mapped_column(String(32), default="")
    payload: Mapped[str] = mapped_column(Text, default="")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Org(Base):
    """租户：个人账号也是只有一个成员的 org，升级团队即邀请成员加入。"""

    __tablename__ = "orgs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("org_"))
    name: Mapped[str] = mapped_column(String(120), default="")
    kind: Mapped[str] = mapped_column(String(20), default="personal")  # personal | team
    owner_id: Mapped[str] = mapped_column(String(32), index=True)
    status: Mapped[str] = mapped_column(String(20), default="active")
    # 飞书企业租户：一个 tenant_key 对应一个团队空间
    feishu_tenant_key: Mapped[str] = mapped_column(String(64), default="", index=True)
    # 长期保存刷新令牌：服务重启后仍能以用户身份操作云盘（建目录/移动）
    feishu_refresh_token: Mapped[str] = mapped_column(Text, default="")
    feishu_app_slug: Mapped[str] = mapped_column(String(40), default="")
    # 运营后台角色：""（无）| viewer | support | finance | superadmin
    ops_role: Mapped[str] = mapped_column(String(20), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("org_id", "user_id", name="uq_member"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("mbr_"))
    org_id: Mapped[str] = mapped_column(String(32), index=True)
    user_id: Mapped[str] = mapped_column(String(32), index=True)
    role: Mapped[str] = mapped_column(String(20), default="member")  # owner|admin|member
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OrgInvite(Base):
    __tablename__ = "org_invites"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("inv_"))
    org_id: Mapped[str] = mapped_column(String(32), index=True)
    email: Mapped[str] = mapped_column(String(320), index=True)
    role: Mapped[str] = mapped_column(String(20), default="member")
    invited_by: Mapped[str] = mapped_column(String(32), default="")
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# --------------------------------------------------------------------------
# 计费
# --------------------------------------------------------------------------


class Plan(Base):
    __tablename__ = "plans"

    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(60))
    price_usd: Mapped[float] = mapped_column(Float, default=0.0)
    minutes_included: Mapped[float] = mapped_column(Float, default=0.0)
    period_days: Mapped[int] = mapped_column(Integer, default=30)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    features: Mapped[str] = mapped_column(Text, default="")


class Subscription(Base):
    __tablename__ = "subscriptions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("sub_"))
    org_id: Mapped[str] = mapped_column(String(32), index=True)
    plan_code: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(20), default="active")  # active|canceled|past_due
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Wallet(Base):
    __tablename__ = "wallets"

    org_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    minutes: Mapped[float] = mapped_column(Float, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class LedgerEntry(Base):
    """额度台账：任何余额变化都必须落一条，审计和对账都靠它。"""

    __tablename__ = "ledger"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("led_"))
    org_id: Mapped[str] = mapped_column(String(32), index=True)
    kind: Mapped[str] = mapped_column(String(20))  # topup|grant|consume|refund|adjust
    minutes: Mapped[float] = mapped_column(Float, default=0.0)
    balance_after: Mapped[float] = mapped_column(Float, default=0.0)
    recording_id: Mapped[str] = mapped_column(String(32), default="")
    order_id: Mapped[str] = mapped_column(String(32), default="")
    note: Mapped[str] = mapped_column(String(300), default="")
    operator_id: Mapped[str] = mapped_column(String(32), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Order(Base):
    """对公转账 / 人工开通的充值单。"""

    __tablename__ = "orders"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("ord_"))
    org_id: Mapped[str] = mapped_column(String(32), index=True)
    user_id: Mapped[str] = mapped_column(String(32), default="")
    kind: Mapped[str] = mapped_column(String(20), default="topup")  # topup|subscription
    plan_code: Mapped[str] = mapped_column(String(32), default="")
    minutes: Mapped[float] = mapped_column(Float, default=0.0)
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    currency: Mapped[str] = mapped_column(String(8), default="CNY")
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|confirmed|canceled
    payer_name: Mapped[str] = mapped_column(String(120), default="")
    note: Mapped[str] = mapped_column(String(500), default="")
    confirmed_by: Mapped[str] = mapped_column(String(32), default="")
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class UsageRecord(Base):
    """单次任务的成本核算：用于毛利报表。"""

    __tablename__ = "usage_records"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("usg_"))
    recording_id: Mapped[str] = mapped_column(String(32), index=True)
    org_id: Mapped[str] = mapped_column(String(32), index=True)
    audio_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    asr_cost_cny: Mapped[float] = mapped_column(Float, default=0.0)
    llm_cost_cny: Mapped[float] = mapped_column(Float, default=0.0)
    billed_minutes: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# --------------------------------------------------------------------------
# 录音与产物
# --------------------------------------------------------------------------


class Recording(Base):
    __tablename__ = "recordings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("rec_"))
    org_id: Mapped[str] = mapped_column(String(32), index=True, default="")
    owner_user_id: Mapped[str] = mapped_column(String(32), index=True, default="")
    owner_open_id: Mapped[str] = mapped_column(String(64), index=True, default="")
    title: Mapped[str] = mapped_column(String(200), default="未命名会议")
    scene: Mapped[str] = mapped_column(String(20), default="meeting")
    source: Mapped[str] = mapped_column(String(20), default="web")  # web|upload|robot
    status: Mapped[str] = mapped_column(String(20), default=STATUS_CREATED, index=True)
    duration_sec: Mapped[int] = mapped_column(Integer, default=0)
    transcript_json: Mapped[str] = mapped_column(Text, default="")
    summary_json: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

    segments: Mapped[list["Segment"]] = relationship(
        back_populates="recording", cascade="all, delete-orphan", order_by="Segment.idx"
    )
    deliveries: Mapped[list["DeliveryLog"]] = relationship(
        back_populates="recording", cascade="all, delete-orphan"
    )
    speaker_names: Mapped[list["SpeakerName"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin"
    )
    documents: Mapped[list["Document"]] = relationship(
        cascade="all, delete-orphan", lazy="selectin"
    )


class Segment(Base):
    __tablename__ = "segments"
    __table_args__ = (UniqueConstraint("recording_id", "idx", name="uq_segment_idx"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("seg_"))
    recording_id: Mapped[str] = mapped_column(
        ForeignKey("recordings.id", ondelete="CASCADE"), index=True
    )
    idx: Mapped[int] = mapped_column(Integer)
    path: Mapped[str] = mapped_column(String(500))
    size: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="")
    duration_sec: Mapped[float] = mapped_column(default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    recording: Mapped[Recording] = relationship(back_populates="segments")


class DeliveryLog(Base):
    __tablename__ = "deliveries"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("dlv_"))
    recording_id: Mapped[str] = mapped_column(
        ForeignKey("recordings.id", ondelete="CASCADE"), index=True
    )
    channel: Mapped[str] = mapped_column(String(20))  # web | email | feishu | slack
    target: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|sent|failed
    detail: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    recording: Mapped[Recording] = relationship(back_populates="deliveries")


class DriveFolder(Base):
    """每个飞书用户在云盘的「AI录音」文件夹 token。"""

    __tablename__ = "drive_folders"

    open_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    folder_token: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ShareRevocation(Base):
    """分享链接撤销记录：存在即表示该录音的分享链接已失效。"""

    __tablename__ = "share_revocations"

    recording_id: Mapped[str] = mapped_column(
        ForeignKey("recordings.id", ondelete="CASCADE"), primary_key=True
    )
    revoked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ShareAccess(Base):
    """分享链接访问审计。"""

    __tablename__ = "share_accesses"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("sa_"))
    recording_id: Mapped[str] = mapped_column(
        ForeignKey("recordings.id", ondelete="CASCADE"), index=True
    )
    ip: Mapped[str] = mapped_column(String(64), default="")
    ua: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Document(Base):
    """每条录音对应的外部文档（飞书云文档等，同步成功后写入）。"""

    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("doc_"))
    recording_id: Mapped[str] = mapped_column(
        ForeignKey("recordings.id", ondelete="CASCADE"), index=True
    )
    doc_id: Mapped[str] = mapped_column(String(64), default="")
    url: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SpeakerName(Base):
    """说话人改名映射：原始标签（发言人1）→ 真实姓名。"""

    __tablename__ = "speaker_names"
    __table_args__ = (UniqueConstraint("recording_id", "speaker", name="uq_speaker"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("spk_"))
    recording_id: Mapped[str] = mapped_column(
        ForeignKey("recordings.id", ondelete="CASCADE"), index=True
    )
    speaker: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(50))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FeishuApp(Base):
    """每个企业客户一套飞书自建应用凭据；用 slug 区分登录入口。"""

    __tablename__ = "feishu_apps"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("fap_"))
    slug: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    app_id: Mapped[str] = mapped_column(String(64), default="")
    app_secret: Mapped[str] = mapped_column(String(200), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditEvent(Base):
    """安全与用户事件审计：登录、权限、计费、分享、运营操作等。

    只追加不改写；retention 由维护任务按天清理。
    """

    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("evt_"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, index=True
    )
    action: Mapped[str] = mapped_column(String(60), index=True)
    result: Mapped[str] = mapped_column(String(16), default="ok")  # ok|fail|denied
    org_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    user_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    actor: Mapped[str] = mapped_column(String(200), default="")
    ip: Mapped[str] = mapped_column(String(64), default="")
    ua: Mapped[str] = mapped_column(String(300), default="")
    target: Mapped[str] = mapped_column(String(200), default="")
    detail: Mapped[str] = mapped_column(Text, default="")


class Employee(Base):
    """飞书通道的员工映射（保留给旧通道，网页/邮件账号不依赖它）。"""

    __tablename__ = "employees"

    open_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(100), default="")
    email: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )
