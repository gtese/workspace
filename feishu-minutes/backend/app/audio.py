"""WAV 工具：校验、时长、多段合并（POC 不依赖 ffmpeg）。"""

from __future__ import annotations

import wave
from pathlib import Path


class WavError(ValueError):
    pass


def is_wav(path: Path) -> bool:
    try:
        with path.open("rb") as fh:
            return fh.read(4) == b"RIFF" and fh.read(4) and fh.read(4) == b"WAVE"
    except OSError:
        return False


def inspect(path: Path) -> dict:
    try:
        with wave.open(str(path), "rb") as w:
            return {
                "sample_rate": w.getframerate(),
                "channels": w.getnchannels(),
                "sampwidth": w.getsampwidth(),
                "frames": w.getnframes(),
                "duration": w.getnframes() / float(w.getframerate() or 1),
            }
    except (wave.Error, EOFError) as exc:
        raise WavError(f"不是合法的 WAV: {path.name} ({exc})") from exc


def merge(paths: list[Path], out: Path) -> dict:
    """合并参数一致的 WAV；返回合并结果元信息。"""
    if not paths:
        raise WavError("没有可合并的音频段")
    infos = [inspect(p) for p in paths]
    first = infos[0]
    for p, info in zip(paths[1:], infos[1:]):
        for key in ("sample_rate", "channels", "sampwidth"):
            if info[key] != first[key]:
                raise WavError(f"{p.name} 参数不一致：{key} {info[key]} != {first[key]}")

    out.parent.mkdir(parents=True, exist_ok=True)
    total_frames = 0
    with wave.open(str(out), "wb") as w_out:
        w_out.setnchannels(first["channels"])
        w_out.setsampwidth(first["sampwidth"])
        w_out.setframerate(first["sample_rate"])
        for p in paths:
            with wave.open(str(p), "rb") as w_in:
                frames = w_in.readframes(w_in.getnframes())
                w_out.writeframes(frames)
                total_frames += w_in.getnframes()

    duration = total_frames / float(first["sample_rate"] or 1)
    return {**first, "frames": total_frames, "duration": duration, "segments": len(paths)}
