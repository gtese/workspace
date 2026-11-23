import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
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


class Recording(Base):
    __tablename__ = "recordings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("rec_"))
    owner_open_id: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(200), default="未命名会议")
    scene: Mapped[str] = mapped_column(String(20), default="meeting")
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
    channel: Mapped[str] = mapped_column(String(20))  # feishu | website | email
    target: Mapped[str] = mapped_column(String(200), default="")
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|sent|failed
    detail: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    recording: Mapped[Recording] = relationship(back_populates="deliveries")


class DriveFolder(Base):
    """每个员工在飞书云盘的「AI录音」文件夹 token。"""

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
    """每条录音对应的飞书云文档（同步成功后写入）。"""

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


class Employee(Base):
    __tablename__ = "employees"

    open_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(100), default="")
    email: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )
