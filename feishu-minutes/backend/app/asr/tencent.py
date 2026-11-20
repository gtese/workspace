"""腾讯云「录音文件识别」适配器（异步任务式，适配 ≥1 小时音频）。

- 文档：https://cloud.tencent.com/document/product/1093/37823 (CreateRecTask)
- 会议引擎：16k_zh_en_meeting，SpeakerDiarization=1 打开说话人分离
- 注意：SourceType=0 走 URL，音频必须能被腾讯侧公网访问 → 用我们签名后的
  media URL（public_base_url 必须是公网可达域名）。
- 状态：未经真实账号联调，字段与签名逻辑按官方文档实现，联调后回填。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx

from ..config import get_settings
from .base import ASRProvider, Segment, Transcript

HOST = "asr.tencentcloudapi.com"
SERVICE = "asr"
VERSION = "2019-06-14"


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def _sha256_hex(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def build_request(
    action: str, params: dict, secret_id: str, secret_key: str, region: str
) -> tuple[dict[str, str], bytes]:
    """返回 (请求头, 请求体)；签名基于字节级 body，避免 JSON 序列化差异。"""
    body = json.dumps(
        {"Action": action, **params}, separators=(",", ":"), ensure_ascii=False
    ).encode()
    ts = int(time.time())
    date = datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%d")
    canonical_request = "\n".join(
        [
            "POST",
            "/",
            "",
            f"content-type:application/json; charset=utf-8\nhost:{HOST}\n",
            "content-type;host",
            _sha256_hex(body),
        ]
    )
    string_to_sign = "\n".join(
        [
            "TC3-HMAC-SHA256",
            str(ts),
            f"{date}/{SERVICE}/tc3_request",
            _sha256_hex(canonical_request),
        ]
    )
    k_date = _hmac(("TC3" + secret_key).encode(), date)
    k_service = _hmac(k_date, SERVICE)
    k_signing = _hmac(k_service, "tc3_request")
    signature = hmac.new(k_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()
    authorization = (
        f"TC3-HMAC-SHA256 Credential={secret_id}/{date}/{SERVICE}/tc3_request, "
        f"SignedHeaders=content-type;host, Signature={signature}"
    )
    headers = {
        "Authorization": authorization,
        "Content-Type": "application/json; charset=utf-8",
        "X-TC-Action": action,
        "X-TC-Version": VERSION,
        "X-TC-Timestamp": str(ts),
        "X-TC-Region": region,
    }
    return headers, body


class TencentASR(ASRProvider):
    name = "tencent"

    def __init__(self) -> None:
        s = get_settings()
        self.secret_id = s.tencent_secret_id
        self.secret_key = s.tencent_secret_key
        self.region = s.tencent_region
        self.engine = s.tencent_engine_model

    def _call(self, action: str, params: dict) -> dict:
        headers, body = build_request(
            action, params, self.secret_id, self.secret_key, self.region
        )
        resp = httpx.post(f"https://{HOST}", headers=headers, content=body, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if "Error" in data.get("Response", {}):
            err = data["Response"]["Error"]
            raise RuntimeError(f"腾讯 ASR 失败 {err.get('Code')}: {err.get('Message')}")
        return data["Response"]

    def transcribe(
        self, audio_path: Path, duration: float, public_url: str | None = None
    ) -> Transcript:
        if not public_url:
            raise RuntimeError("腾讯 ASR 需要公网可访问的音频 URL（public_url）")
        if not (self.secret_id and self.secret_key):
            raise RuntimeError("缺少腾讯云 ASR 凭据（~/.mm/tencent-asr）")

        created = self._call(
            "CreateRecTask",
            {
                "EngineModelType": self.engine,
                "ChannelNum": 1,
                "ResTextFormat": 0,
                "SourceType": 0,
                "Url": public_url,
                "SpeakerDiarization": 1,
                "SpeakerNumber": 0,
                "ProjectId": 0,
            },
        )
        task_id = created["Data"]["TaskId"]

        deadline = time.time() + 3600
        result_json: str | None = None
        while time.time() < deadline:
            status = self._call("DescribeTaskStatus", {"TaskId": task_id})
            data = status["Data"]
            code = int(data.get("Status", -1))
            if code == 2:
                result_json = data.get("Result", "")
                break
            if code == 3:
                raise RuntimeError(f"腾讯 ASR 任务失败: {data.get('ErrorMsg', '')}")
            time.sleep(5)
        if result_json is None:
            raise RuntimeError("腾讯 ASR 任务超时")

        parsed = json.loads(result_json) if result_json else {}
        segs: list[Segment] = []
        for item in parsed.get("ResultDetail", []) or []:
            text = (item.get("FinalSentence") or "").strip()
            if not text:
                continue
            segs.append(
                Segment(
                    start=item.get("StartMs", 0) / 1000.0,
                    end=item.get("EndMs", 0) / 1000.0,
                    speaker=f"发言人{int(item.get('SpeakerId', 1))}" if item.get("SpeakerId") else "发言人1",
                    text=text,
                )
            )
        if not segs:  # 兼容只返回整段文本的情况
            whole = (parsed.get("Result") or "").strip()
            if whole:
                segs = [Segment(start=0.0, end=duration, speaker="发言人1", text=whole)]
        return Transcript(segments=segs, provider=self.name, raw={"task_id": task_id})
