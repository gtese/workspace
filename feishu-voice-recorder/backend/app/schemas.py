from typing import Any, Literal

from pydantic import BaseModel, Field

Scene = Literal["meeting", "client", "memo"]


class RecordingCreate(BaseModel):
    title: str = Field(default="未命名会议", max_length=200)
    scene: Scene = "meeting"


class RecordingOut(BaseModel):
    id: str
    title: str
    scene: str
    status: str
    duration_sec: int
    created_at: str
    segment_count: int = 0
    next_segment_index: int = 0
    error: str = ""
    # 详情接口才带出
    transcript: list[dict[str, Any]] | None = None
    summary: dict[str, Any] | None = None
    audio_url: str | None = None
    doc_url: str | None = None
    feishu_status: str | None = None


class SegmentOut(BaseModel):
    idx: int
    size: int
    duration_sec: float


class FinishOut(BaseModel):
    id: str
    status: str
    segment_count: int


class HealthOut(BaseModel):
    status: str = "ok"
    asr_provider: str
    llm_provider: str
    feishu_mode: str


class SpeakerRenameIn(BaseModel):
    mapping: dict[str, str] = Field(default_factory=dict)


class SearchHit(BaseModel):
    id: str
    title: str
    status: str
    created_at: str
    snippet: str = ""


class SendIn(BaseModel):
    receive_id: str = ""
    receive_id_type: str = "open_id"


class FeishuLoginIn(BaseModel):
    code: str = Field(min_length=1)


class FeishuLoginOut(BaseModel):
    open_id: str
    name: str = ""
    token: str
    mock: bool = False
