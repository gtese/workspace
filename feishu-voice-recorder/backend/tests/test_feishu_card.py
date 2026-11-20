import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.feishu.client import build_minutes_card  # noqa: E402


def test_card_structure_and_size() -> None:
    summary = {
        "summary": "这是一段摘" * 400,  # 超长，验证截断
        "key_points": [f"要点{i}" for i in range(20)],
        "todos": [{"owner": "张三", "item": f"待办{i}", "due": "周五"} for i in range(20)],
    }
    card = build_minutes_card("周会", "内部会议", summary, "https://example.com/d/rec_1")
    raw = json.dumps(card, ensure_ascii=False)
    assert len(raw.encode()) < 30000, "飞书卡片上限 30KB"
    assert card["header"]["title"]["content"].startswith("纪要完成")
    action = [e for e in card["elements"] if e["tag"] == "action"][0]
    assert action["actions"][0]["url"] == "https://example.com/d/rec_1"
    # 要点/待办各自最多 6 条
    md_blocks = [e for e in card["elements"] if e["tag"] == "div"]
    assert all(len(b["text"]["content"]) <= 2500 for b in md_blocks)


def test_card_title_truncated() -> None:
    card = build_minutes_card("很长的标题" * 30, "会议", {}, "https://x")
    assert len(card["header"]["title"]["content"]) <= 60
