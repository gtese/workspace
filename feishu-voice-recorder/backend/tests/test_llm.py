import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.llm import summarize as mod  # noqa: E402
from app.llm.summarize import _normalize, _user_prompt  # noqa: E402


def test_scene_hints() -> None:
    assert "客户诉求" in _user_prompt("t", "client", "")
    assert "待办" in _user_prompt("t", "memo", "")
    assert "决策" in _user_prompt("t", "meeting", "")


def test_normalize_missing_fields() -> None:
    out = _normalize({})
    assert out["summary"] == ""
    assert out["key_points"] == []
    assert out["todos"] == []


def test_normalize_todos_from_strings() -> None:
    out = _normalize({"summary": "s", "todos": ["跟进预算"]})
    assert out["todos"] == [{"owner": "", "item": "跟进预算", "due": ""}]


def test_deepseek_payload(monkeypatch) -> None:
    settings = mod.get_settings().model_copy(
        update={
            "llm_provider": "deepseek",
            "deepseek_api_key": "test-key",
            "deepseek_base_url": "https://api.example.com",
        }
    )
    monkeypatch.setattr(mod, "get_settings", lambda: settings)

    captured: dict = {}

    class Resp:
        def raise_for_status(self) -> None:
            pass

        def json(self) -> dict:
            return {"choices": [{"message": {"content": json.dumps({"summary": "ok", "key_points": ["p"]})}}]}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured.update(url=url, headers=headers, payload=json)
        return Resp()

    monkeypatch.setattr(mod.httpx, "post", fake_post)
    out = mod.summarize("转写文本", "周会", "client")

    assert captured["url"] == "https://api.example.com/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer test-key"
    assert captured["payload"]["response_format"] == {"type": "json_object"}
    assert "客户" in captured["payload"]["messages"][1]["content"]
    assert out["summary"] == "ok"
