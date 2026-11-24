import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.asr import aliyun as aliyun_mod  # noqa: E402
from app.asr.aliyun import AliyunASR  # noqa: E402
from app.asr.base import AudioChunk  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.llm import summarize as llm_mod  # noqa: E402


class _Resp:
    status_code = 200
    text = ""

    def __init__(self, content: str) -> None:
        self._content = content

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return {"choices": [{"message": {"content": self._content}}]}


def _settings(**kw):
    return get_settings().model_copy(update=kw)


def test_aliyun_asr_chunks(monkeypatch, tmp_path: Path) -> None:
    settings = _settings(
        aliyun_api_key="k", aliyun_base_url="https://x/v1", asr_model="qwen3-asr-flash"
    )
    monkeypatch.setattr(aliyun_mod, "get_settings", lambda: settings)

    calls: list[dict] = []

    def fake_post(url, headers=None, json=None, timeout=None):
        calls.append(json)
        audio_url = json["messages"][0]["content"][0]["input_audio"]["data"]
        return _Resp(f"文字:{audio_url}")

    monkeypatch.setattr(aliyun_mod.httpx, "post", fake_post)

    chunks = [
        AudioChunk(path=tmp_path / f"{i}.wav", public_url=f"https://u/{i}.wav", offset=120.0 * i, duration=120.0)
        for i in range(3)
    ]
    t = AliyunASR().transcribe(tmp_path / "merged.wav", 360.0, "https://u/merged.wav", chunks=chunks)

    assert [s.start for s in t.segments] == [0.0, 120.0, 240.0]
    # 并发完成顺序不固定，按偏移校验内容
    by_start = {s.start: s.text for s in t.segments}
    assert by_start[0.0] == "文字:https://u/0.wav"
    assert by_start[120.0] == "文字:https://u/1.wav"
    assert by_start[240.0] == "文字:https://u/2.wav"
    assert all(s.speaker == "发言人1" for s in t.segments)
    assert calls[0]["model"] == "qwen3-asr-flash"
    assert calls[0]["messages"][0]["content"][0]["input_audio"]["data"] == "https://u/0.wav"


def test_aliyun_asr_skips_empty(monkeypatch, tmp_path: Path) -> None:
    settings = _settings(aliyun_api_key="k", aliyun_base_url="https://x/v1")
    monkeypatch.setattr(aliyun_mod, "get_settings", lambda: settings)

    seq = iter(["有内容", ""])

    def fake_post(url, headers=None, json=None, timeout=None):
        return _Resp(next(seq, ""))

    monkeypatch.setattr(aliyun_mod.httpx, "post", fake_post)
    chunks = [
        AudioChunk(path=tmp_path / "a.wav", public_url="https://u/a.wav", offset=0, duration=60),
        AudioChunk(path=tmp_path / "b.wav", public_url="https://u/b.wav", offset=60, duration=60),
    ]
    t = AliyunASR().transcribe(tmp_path / "m.wav", 120.0, None, chunks=chunks)
    assert len(t.segments) == 1
    assert t.segments[0].text == "有内容"


def test_aliyun_asr_requires_chunks(monkeypatch, tmp_path: Path) -> None:
    settings = _settings(aliyun_api_key="k", aliyun_base_url="https://x/v1")
    monkeypatch.setattr(aliyun_mod, "get_settings", lambda: settings)
    with pytest.raises(RuntimeError):
        AliyunASR().transcribe(tmp_path / "m.wav", 10.0, None)


def test_aliyun_llm(monkeypatch) -> None:
    settings = _settings(
        llm_provider="aliyun",
        aliyun_api_key="k",
        aliyun_base_url="https://x/v1",
        llm_model="qwen3.8-flash",
    )
    monkeypatch.setattr(llm_mod, "get_settings", lambda: settings)
    captured: dict = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured.update(url=url, headers=headers, payload=json)
        return _Resp('{"summary": "ok", "key_points": ["p"], "todos": [{"owner": "张三", "item": "发方案"}]}')

    monkeypatch.setattr(llm_mod.httpx, "post", fake_post)
    out = llm_mod.summarize("转写内容", "周会", "meeting")

    assert captured["url"] == "https://x/v1/chat/completions"
    assert captured["payload"]["model"] == "qwen3.8-flash"
    assert captured["payload"]["response_format"] == {"type": "json_object"}
    assert out["summary"] == "ok"
    assert out["todos"][0]["owner"] == "张三"
