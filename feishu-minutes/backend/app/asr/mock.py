"""Mock ASR：无需任何凭据即可跑通全链路（POC / CI 用）。"""

from __future__ import annotations

import random
from pathlib import Path

from .base import ASRProvider, Segment, Transcript

_SENTENCES = [
    "我们先把上周的进展过一遍，主要是三个方向。",
    "第一个是客户侧的反馈，整体比预期要好一些。",
    "不过交付时间上还有个风险，需要再确认一下。",
    "这个我记一下，会后我去跟供应商对一下排期。",
    "第二个问题，预算这块财务那边还没批下来。",
    "如果这周批不下来，我们就先按原计划走。",
    "对了，上次提的那个需求，产品那边已经排期了。",
    "好，那最后确认一下，下周三之前把方案发出来。",
]


class MockASR(ASRProvider):
    name = "mock"

    def transcribe(
        self, audio_path: Path, duration: float, public_url: str | None = None
    ) -> Transcript:
        rng = random.Random(audio_path.name)
        segs: list[Segment] = []
        step = 18.0
        t = 0.0
        i = 0
        while t < max(duration, step):
            text = _SENTENCES[i % len(_SENTENCES)]
            segs.append(
                Segment(
                    start=round(t, 2),
                    end=round(min(t + step, duration) if duration else t + step, 2),
                    speaker=f"发言人{(i % 3) + 1}",
                    text=text,
                )
            )
            t += step + rng.uniform(0, 4)
            i += 1
        return Transcript(segments=segs, provider=self.name)
