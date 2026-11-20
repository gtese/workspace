"""纪要生成：DeepSeek（OpenAI 兼容）或 mock。输出固定 JSON 结构。"""

from __future__ import annotations

import json
import logging

import httpx

from ..config import get_settings

log = logging.getLogger(__name__)

SCENE_LABELS = {"meeting": "内部会议", "client": "客户沟通", "memo": "语音速记"}

SYSTEM_PROMPT = (
    "你是严谨的中文会议纪要助手。根据转写文本生成结构化纪要，"
    "只输出一个 JSON 对象，不要输出任何解释或 Markdown 代码块。"
    "JSON 字段：summary(字符串，100-200字)、key_points(字符串数组，3-8条)、"
    "decisions(字符串数组，0-5条)、todos(对象数组，每项 owner/item/due，due 可为空字符串)、"
    "risks(字符串数组，0-4条)。不要编造转写中没有的信息，人名保持原文。"
)


def _user_prompt(title: str, scene: str, transcript: str) -> str:
    label = SCENE_LABELS.get(scene, "会议")
    return (
        f"会议标题：{title}\n场景类型：{label}\n\n"
        f"转写文本（含时间戳与说话人）：\n{transcript[:60000]}\n\n"
        "请生成纪要 JSON。"
    )


def _normalize(data: dict) -> dict:
    def as_list(v) -> list:
        return v if isinstance(v, list) else []

    todos = []
    for item in as_list(data.get("todos")):
        if isinstance(item, dict):
            todos.append(
                {
                    "owner": str(item.get("owner", "") or ""),
                    "item": str(item.get("item", "") or ""),
                    "due": str(item.get("due", "") or ""),
                }
            )
        elif isinstance(item, str) and item.strip():
            todos.append({"owner": "", "item": item.strip(), "due": ""})
    return {
        "summary": str(data.get("summary", "") or "").strip(),
        "key_points": [str(x).strip() for x in as_list(data.get("key_points")) if str(x).strip()],
        "decisions": [str(x).strip() for x in as_list(data.get("decisions")) if str(x).strip()],
        "todos": todos,
        "risks": [str(x).strip() for x in as_list(data.get("risks")) if str(x).strip()],
    }


def _mock(title: str, transcript: str) -> dict:
    lines = [ln for ln in transcript.splitlines() if ln.strip()]
    head = lines[0].split("：", 1)[-1] if lines else ""
    return {
        "summary": f"（mock 纪要）{title}：{head} 会议共 {len(lines)} 条发言，讨论了进展、风险与待办。",
        "key_points": [ln.split("：", 1)[-1] for ln in lines[1:4]] or ["（mock）无更多要点"],
        "decisions": ["（mock）按原计划推进，下周同步进展"],
        "todos": [{"owner": "待定", "item": "（mock）确认排期与预算", "due": "本周五"}],
        "risks": ["（mock）交付时间存在风险"],
    }


def _deepseek(title: str, scene: str, transcript: str) -> dict:
    settings = get_settings()
    if not settings.deepseek_api_key:
        raise RuntimeError("缺少 DeepSeek API Key（~/.mm/deepseek 或 FM_DEEPSEEK_API_KEY）")
    payload = {
        "model": settings.llm_model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _user_prompt(title, scene, transcript)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
        "max_tokens": 2000,
    }
    resp = httpx.post(
        f"{settings.deepseek_base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {settings.deepseek_api_key}"},
        json=payload,
        timeout=120,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    return _normalize(json.loads(content))


def summarize(transcript: str, title: str, scene: str) -> dict:
    settings = get_settings()
    if settings.llm_provider == "deepseek" and settings.deepseek_api_key:
        return _deepseek(title, scene, transcript)
    log.info("LLM 使用 mock 模式")
    return _mock(title, transcript)
