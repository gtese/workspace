"""阿里云百炼「录音文件识别」异步转写（带说话人分离）。

- 模型：qwen-audio-3.1-asr-flash-filetrans（≤12 小时/2GB，单声道）
- 提交合并后的整段音频 URL → 轮询任务 → 下载 JSON
- 结果含句级时间戳与 speaker_id → 转成 发言人1/2/...
- 已用双人中文语音实测：speaker 0/1 正确区分
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

import httpx

from ..config import get_settings
from .base import ASRProvider, AudioChunk, Segment, Transcript

log = logging.getLogger(__name__)


class NoSpeechError(RuntimeError):
    """音频里没有识别到语音（通常是静音、麦克风被占用或录音过短）。"""


def _api_base(base: str) -> str:
    base = base.rstrip("/")
    if base.endswith("/compatible-mode/v1"):
        return base[: -len("/compatible-mode/v1")] + "/api/v1"
    return base


class AliyunFiletransASR(ASRProvider):
    name = "aliyun_filetrans"

    def __init__(self) -> None:
        s = get_settings()
        self.base = _api_base(s.aliyun_base_url)
        self.key = s.aliyun_api_key
        self.model = s.asr_filetrans_model
        self.diarization = s.asr_diarization
        self.poll_seconds = 5
        self.timeout_seconds = 1800

    def transcribe(
        self,
        audio_path: Path,
        duration: float,
        public_url: str | None = None,
        chunks: list[AudioChunk] | None = None,
    ) -> Transcript:
        if not (self.key and self.base):
            raise RuntimeError("缺少阿里云 MaaS 凭据（~/.mm/aliyun）")
        if not public_url:
            raise RuntimeError("录音文件识别需要公网音频 URL")
        headers = {"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}

        body = {
            "model": self.model,
            "input": {"file_urls": [public_url]},
            "parameters": {"diarization_enabled": self.diarization},
        }
        r = httpx.post(
            f"{self.base}/services/audio/asr/transcription",
            headers={**headers, "X-DashScope-Async": "enable"},
            json=body,
            timeout=60,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"提交转写任务失败: HTTP {r.status_code} {r.text[:300]}")
        task_id = r.json()["output"]["task_id"]
        log.info("转写任务已提交: %s", task_id)

        deadline = time.time() + self.timeout_seconds
        transcription_url = ""
        while time.time() < deadline:
            time.sleep(self.poll_seconds)
            t = httpx.get(f"{self.base}/tasks/{task_id}", headers=headers, timeout=30).json()
            out = t.get("output", {})
            status = out.get("task_status")
            if status == "SUCCEEDED":
                results = out.get("results") or []
                if not results or results[0].get("subtask_status") != "SUCCEEDED":
                    raise RuntimeError(f"转写子任务失败: {out}")
                transcription_url = results[0]["transcription_url"]
                break
            if status in ("FAILED", "CANCELED"):
                code = str(out.get("code") or "")
                if code in ("ASR_RESPONSE_HAVE_NO_WORDS", "ASR_NO_WORDS"):
                    raise NoSpeechError(
                        "没有识别到语音内容：请确认麦克风有声音、说话时长足够后重新录制"
                    )
                raise RuntimeError(f"转写任务失败: {out}")
        if not transcription_url:
            raise RuntimeError("转写任务超时")

        data = httpx.get(transcription_url, timeout=60).json()
        segments: list[Segment] = []
        for channel in data.get("transcripts", []):
            for sent in channel.get("sentences", []):
                text = (sent.get("text") or "").strip()
                if not text:
                    continue
                sid = sent.get("speaker_id")
                speaker = f"发言人{int(sid) + 1}" if sid is not None else "发言人1"
                segments.append(
                    Segment(
                        start=round(sent.get("begin_time", 0) / 1000.0, 2),
                        end=round(sent.get("end_time", 0) / 1000.0, 2),
                        speaker=speaker,
                        text=text,
                    )
                )
        segments.sort(key=lambda s: s.start)
        speakers = sorted({s.speaker for s in segments})
        log.info("文件转写完成: %d 句, 说话人 %s", len(segments), speakers)
        return Transcript(
            segments=segments,
            provider=self.name,
            raw={"task_id": task_id, "speakers": len(speakers), "model": self.model},
        )
