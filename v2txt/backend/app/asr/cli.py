"""ASR 命令行工具：直接对本地音频跑转写，用于选型 A/B 与排障。

用法（在 backend 目录）：
  ../.venv/bin/python -m app.asr.cli /path/to/meeting.m4a
  ../.venv/bin/python -m app.asr.cli a.m4a --provider tencent --json out.json
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

from .. import audio
from . import get_asr_provider
from .base import Transcript


def run(
    audio_path: Path,
    provider_name: str | None = None,
    out_json: Path | None = None,
) -> Transcript:
    if not audio_path.exists():
        raise SystemExit(f"文件不存在: {audio_path}")

    workdir = Path(tempfile.mkdtemp(prefix="fm-asr-"))
    if audio.is_wav(audio_path):
        wav = audio_path
    else:
        wav = workdir / "input.wav"
        audio.convert_to_wav(audio_path, wav)

    info = audio.inspect(wav)
    provider = get_asr_provider()
    if provider_name:
        from .mock import MockASR
        from .tencent import TencentASR

        provider = {"mock": MockASR, "tencent": TencentASR}.get(provider_name, MockASR)()

    started = time.time()
    transcript = provider.transcribe(wav, info["duration"], public_url=None)
    elapsed = time.time() - started

    data = transcript.to_dict()
    data["meta"] = {
        "file": str(audio_path),
        "duration_sec": round(info["duration"], 1),
        "provider": transcript.provider,
        "elapsed_sec": round(elapsed, 1),
        "segments": len(transcript.segments),
        "chars": len(transcript.plain_text(with_time=False)),
        "price_per_hour": 0.8,
        "estimated_cost_yuan": round(info["duration"] / 3600 * 0.8, 4),
    }
    print(transcript.plain_text())
    print(json.dumps(data["meta"], ensure_ascii=False, indent=2), file=sys.stderr)
    if out_json:
        out_json.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"已写入 {out_json}", file=sys.stderr)
    return transcript


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="对本地音频跑 ASR（mock/tencent）")
    ap.add_argument("audio", type=Path)
    ap.add_argument("--provider", choices=["mock", "tencent"], default=None)
    ap.add_argument("--json", dest="out_json", type=Path, default=None)
    args = ap.parse_args(argv)
    run(args.audio, args.provider, args.out_json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
