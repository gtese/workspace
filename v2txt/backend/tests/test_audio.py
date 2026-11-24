import math
import struct
import wave
from pathlib import Path

import pytest
from app import audio


def make_wav(path: Path, seconds: float = 2.0, rate: int = 16000, freq: float = 440.0) -> Path:
    n = int(seconds * rate)
    frames = b"".join(
        struct.pack("<h", int(12000 * math.sin(2 * math.pi * freq * i / rate))) for i in range(n)
    )
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames)
    return path


def test_inspect(tmp_path: Path) -> None:
    p = make_wav(tmp_path / "a.wav", 1.5)
    info = audio.inspect(p)
    assert info["sample_rate"] == 16000
    assert info["channels"] == 1
    assert abs(info["duration"] - 1.5) < 0.05


def test_merge(tmp_path: Path) -> None:
    a = make_wav(tmp_path / "a.wav", 1.0, freq=440)
    b = make_wav(tmp_path / "b.wav", 2.0, freq=880)
    out = tmp_path / "merged.wav"
    info = audio.merge([a, b], out)
    assert info["segments"] == 2
    assert abs(info["duration"] - 3.0) < 0.05
    assert audio.inspect(out)["frames"] == info["frames"]


def test_merge_rejects_mismatch(tmp_path: Path) -> None:
    a = make_wav(tmp_path / "a.wav", 1.0, rate=16000)
    b = make_wav(tmp_path / "b.wav", 1.0, rate=8000)
    with pytest.raises(audio.WavError):
        audio.merge([a, b], tmp_path / "merged.wav")


def test_merge_empty(tmp_path: Path) -> None:
    with pytest.raises(audio.WavError):
        audio.merge([], tmp_path / "merged.wav")
