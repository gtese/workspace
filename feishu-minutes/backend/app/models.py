import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:16]}"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# 状态机：created -> transcribed -> summarized -> done / failed
STATUS_CREATED = "created"
STATUS_UPLOADED = "uploaded"
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
