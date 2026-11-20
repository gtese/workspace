"""阿里云百炼 / MaaS 语音转写适配器（qwen3-asr-flash，OpenAI 兼容）。

- 每个录音分段（默认 2 分钟）单独转写，按段偏移拼成带时间轴的结果
- 接口形态：POST {base}/chat/completions，content 里放 input_audio.data = 公网音频 URL
- 该模型暂不返回逐句时间戳与说话人，因此按段给时间、说话人统一为「发言人1」
- 状态：已用真实中文语音验证（104 秒音频，转写正确）
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

from ..config import get_settings
from .base import ASRProvider, AudioChunk, Segment, Transcript

log = logging.getLogger(__name__)


class AliyunASR(ASRProvider):
    name = "aliyun"

    def __init__(self) -> None:
        s = get_settings()
        self.base = s.aliyun_base_url.rstrip("/")
        self.key = s.aliyun_api_key
        self.model = s.asr_model
        self.concurrency = max(1, s.asr_chunk_concurrency)

    def _one(self, chunk: AudioChunk, index: int) -> Segment | None:
        payload = {
            "model": self.model,
            "max_tokens": 4096,
            "temperature": 0,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {"data": chunk.public_url},
                        }
                    ],
                }
            ],
        }
        last_err: Exception | None = None
        for attempt in range(3):
            try:
                resp = httpx.post(
                    f"{self.base}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                    timeout=300,
                )
                resp.raise_for_status()
                data = resp.json()
                text = (
                    (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
                ).strip()
                if not text:
                    return None
                return Segment(
                    start=round(chunk.offset, 2),
                    end=round(chunk.offset + chunk.duration, 2),
                    speaker="发言人1",
                    text=text,
                )
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                log.warning("ASR 分段 %d 失败（第 %d 次）：%s", index, attempt + 1, exc)
        raise RuntimeError(f"分段 {index} 转写失败: {last_err}")

    def transcribe(
        self,
        audio_path: Path,
        duration: float,
        public_url: str | None = None,
        chunks: list[AudioChunk] | None = None,
    ) -> Transcript:
        if not (self.key and self.base):
            raise RuntimeError("缺少阿里云 MaaS 凭据（~/.mm/aliyun）")
        if not chunks:
            raise RuntimeError("阿里云 ASR 需要分段音频（chunks）")
        if not all(c.public_url for c in chunks):
            raise RuntimeError("阿里云 ASR 需要公网可访问的分段 URL（检查 FM_PUBLIC_BASE_URL）")

        results: list[Segment | None] = [None] * len(chunks)
        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            futures = {pool.submit(self._one, c, i): i for i, c in enumerate(chunks)}
            for fut in futures:
                i = futures[fut]
                results[i] = fut.result()

        segments = [s for s in results if s is not None]
        log.info("阿里云 ASR 完成：%d/%d 段有内容", len(segments), len(chunks))
        return Transcript(
            segments=segments,
            provider=self.name,
            raw={"model": self.model, "chunks": len(chunks)},
        )
