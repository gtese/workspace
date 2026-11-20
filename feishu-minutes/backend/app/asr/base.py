from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass
class Segment:
    start: float
    end: float
    speaker: str
    text: str


@dataclass
class Transcript:
    segments: list[Segment]
    language: str = "zh"
    provider: str = ""
    raw: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "language": self.language,
            "provider": self.provider,
            "segments": [
                {"start": s.start, "end": s.end, "speaker": s.speaker, "text": s.text}
                for s in self.segments
            ],
        }

    def plain_text(self, with_time: bool = True) -> str:
        lines = []
        for s in self.segments:
            mm, ss = divmod(int(s.start), 60)
            prefix = f"[{mm:02d}:{ss:02d}] " if with_time else ""
            lines.append(f"{prefix}{s.speaker}：{s.text}")
        return "\n".join(lines)


class ASRProvider(Protocol):
    name: str

    def transcribe(
        self, audio_path: Path, duration: float, public_url: str | None = None
    ) -> Transcript: ...
