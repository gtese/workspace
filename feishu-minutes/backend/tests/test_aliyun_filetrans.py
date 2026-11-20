import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.asr import aliyun_filetrans as mod  # noqa: E402
from app.asr.aliyun_filetrans import AliyunFiletransASR  # noqa: E402
from app.config import get_settings  # noqa: E402

TRANSCRIPT = {
    "transcripts": [
        {
            "sentences": [
                {"begin_time": 100, "end_time": 3000, "text": "第一句", "speaker_id": 0},
                {"begin_time": 3000, "end_time": 6000, "text": "第二句", "speaker_id": 1},
                {"begin_time": 6000, "end_time": 8000, "text": "", "speaker_id": 1},
            ]
        }
    ]
}


class _Resp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
        self.text = str(payload)[:200]

    def json(self):
        return self._payload


def test_filetrans_parses_speakers(monkeypatch, tmp_path: Path) -> None:
    settings = get_settings().model_copy(
        update={"aliyun_api_key": "k", "aliyun_base_url": "https://x/compatible-mode/v1"}
    )
    monkeypatch.setattr(mod, "get_settings", lambda: settings)
    monkeypatch.setattr(mod.time, "sleep", lambda *_: None)

    def fake_post(url, headers=None, json=None, timeout=None):
        assert url == "https://x/api/v1/services/audio/asr/transcription"
        assert json["parameters"]["diarization_enabled"] is True
        assert json["input"]["file_urls"] == ["https://voice/x.wav"]
        return _Resp({"output": {"task_id": "t1", "task_status": "PENDING"}})

    def fake_get(url, headers=None, timeout=None):
        if "tasks/t1" in url:
            return _Resp(
                {
                    "output": {
                        "task_status": "SUCCEEDED",
                        "results": [{"subtask_status": "SUCCEEDED", "transcription_url": "https://r/t.json"}],
                    }
                }
            )
        return _Resp(TRANSCRIPT)

    monkeypatch.setattr(mod.httpx, "post", fake_post)
    monkeypatch.setattr(mod.httpx, "get", fake_get)

    t = AliyunFiletransASR().transcribe(tmp_path / "x.wav", 8.0, "https://voice/x.wav")
    assert len(t.segments) == 2
    assert [s.speaker for s in t.segments] == ["发言人1", "发言人2"]
    assert [s.start for s in t.segments] == [0.1, 3.0]
    assert t.segments[0].text == "第一句"


def test_filetrans_requires_url(monkeypatch, tmp_path: Path) -> None:
    settings = get_settings().model_copy(update={"aliyun_api_key": "k", "aliyun_base_url": "https://x"})
    monkeypatch.setattr(mod, "get_settings", lambda: settings)
    try:
        AliyunFiletransASR().transcribe(tmp_path / "x.wav", 1.0, None)
    except RuntimeError as exc:
        assert "公网音频" in str(exc)
    else:
        raise AssertionError("应当抛出缺少 URL 的错误")
