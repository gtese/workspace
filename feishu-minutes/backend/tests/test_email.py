import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.email_send import EmailSender, build_minutes_email  # noqa: E402
from app.storage import data_dir  # noqa: E402


def test_build_minutes_email() -> None:
    subject, html = build_minutes_email(
        "周会",
        {
            "summary": "本周进展顺利",
            "key_points": ["交付按期"],
            "decisions": ["按原计划推进"],
            "todos": [{"owner": "张三", "item": "发方案", "due": "周五"}],
        },
        "https://example.com/d/rec_1",
    )
    assert "周会" in subject
    assert "本周进展顺利" in html
    assert "张三" in html
    assert "https://example.com/d/rec_1" in html


def test_mock_send_writes_outbox() -> None:
    outbox = data_dir() / "outbox"
    before = {p.name for p in outbox.glob("email-*.json")} if outbox.exists() else set()
    result = EmailSender().send("someone@example.com", "主题", "<p>hi</p>")
    assert result["mode"] == "mock"
    path = Path(result["path"])
    assert path.exists()
    assert path.name not in before
    text = path.read_text(encoding="utf-8")
    assert "someone@example.com" in text
