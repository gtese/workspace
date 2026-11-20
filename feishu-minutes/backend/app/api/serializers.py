"""把 Recording 序列化为 API 输出（含签名音频 URL）。"""

import json
from datetime import UTC

from .. import storage
from ..models import Recording
from ..schemas import RecordingOut
from ..security import signed_url


def speaker_map(rec: Recording) -> dict[str, str]:
    return {s.speaker: s.name for s in (rec.speaker_names or [])}


def iso_utc(value) -> str:
    """SQLite 里存的是 naive UTC，补上时区，前端才能正确本地化。"""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


def to_out(rec: Recording, include_detail: bool = False) -> RecordingOut:
    data = RecordingOut(
        id=rec.id,
        title=rec.title,
        scene=rec.scene,
        status=rec.status,
        duration_sec=rec.duration_sec,
        created_at=iso_utc(rec.created_at),
        segment_count=len(rec.segments),
        next_segment_index=max((s.idx for s in rec.segments), default=-1) + 1,
        error=rec.error,
    )
    if include_detail:
        data.transcript = (
            json.loads(rec.transcript_json).get("segments") if rec.transcript_json else None
        )
        if data.transcript:
            names = speaker_map(rec)
            data.transcript = [
                {**seg, "speaker": names.get(seg.get("speaker", ""), seg.get("speaker", ""))}
                for seg in data.transcript
            ]
        data.summary = json.loads(rec.summary_json) if rec.summary_json else None
        audio_file = storage.merged_path(rec.id)
        if audio_file.exists():
            data.audio_url = signed_url(storage.rel_media_path(audio_file))
    return data
