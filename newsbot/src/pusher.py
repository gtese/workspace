# -*- coding: utf-8 -*-
"""飞书自定义机器人推送（支持签名校验）—— 双栏卡片（左：传统 RSS / 右：公众号）+ emoji 行头"""
import base64
import hashlib
import hmac
import time

import requests

CARD_COLOR = {"c1": "blue", "c2": "turquoise", "c3": "orange", "c4": "purple"}

# 卡片标题 emoji（按分类）
CAT_EMOJI = {"c1": "\U0001F916", "c2": "\U0001F6E0\uFE0F",
             "c3": "\U0001F4E6", "c4": "\U0001F4B0"}

# 栏目 emoji
COL_RSS = "\U0001F4E1"   # 📡 传统 RSS
COL_MP = "\U0001F4F1"    # 📱 公众号

# 条目行头 emoji：按标题主题匹配，靠前的规则优先
TOPIC_EMOJI = (
    (("融资", "轮融资", "估值", "并购", "收购", "ipo", "funding", "raises", "raised",
      "valuation", "acquisition", "unicorn", "领投", "募资"), "\U0001F4B0"),
    (("大模型", "基础模型", "语言模型", "多模态", "推理模型", "开源模型", "llm",
      "transformer", "gpt", "gemini", "claude", "moe", "上下文"), "\U0001F9E0"),
    (("芯片", "半导体", "制程", "晶圆", "光刻", "封装", "芯粒", "gpu", "npu", "tpu",
      "asic", "hbm", "silicon", "wafer", "chiplet", "算子", "制程"), "\U0001F52C"),
    (("算力", "数据中心", "服务器", "集群", "超节点", "datacenter", "cluster"), "\U0001F5A5\uFE0F"),
    (("智能体", "agent", "agentic", "mcp", "rag", "copilot", "代码生成"), "\U0001F916"),
    (("eda", "设计自动化", "验证", "rtl", "pdk", "布局布线", "逻辑综合", "signoff"), "\U0001F6E0\uFE0F"),
    (("订单", "客户", "供货", "产能", "交期", "量产", "供应链", "涨价", "缺货",
      "出货", "采购", "招标", "中标", "shipment", "capacity", "capex"), "\U0001F4E6"),
)
DEFAULT_EMOJI = "\U0001F4F0"


def pick_emoji(title):
    """按标题主题挑一个相关 emoji 作行头"""
    t = (title or "").lower()
    for kws, emo in TOPIC_EMOJI:
        for kw in kws:
            if kw in t:
                return emo
    return DEFAULT_EMOJI


def _sign(secret, timestamp):
    """飞书自定义机器人签名：key = 'timestamp\\nsecret'，data 为空，HMAC-SHA256 后 base64"""
    string_to_sign = "{}\n{}".format(timestamp, secret)
    digest = hmac.new(string_to_sign.encode("utf-8"),
                      digestmod=hashlib.sha256).digest()
    return base64.b64encode(digest).decode("utf-8")


def _payload(msg_type, content, secret):
    payload = {"msg_type": msg_type}
    payload.update(content)
    if secret:
        ts = str(int(time.time()))
        payload["timestamp"] = ts
        payload["sign"] = _sign(secret, ts)
    return payload


def _entry_lines(rows):
    """列表条目：每条一行「序号 + emoji + 标题(原文链接)」，下一行灰色显示来源与时间"""
    lines = []
    for idx, it in enumerate(rows, 1):
        emo = pick_emoji(it.get("title", ""))
        when = time.strftime("%m-%d %H:%M", time.localtime(it["ts"])) if it.get("ts") else ""
        meta = " · ".join([x for x in (it.get("source"), when) if x])
        md = "{n}. {e} **[{t}]({l})**".format(n=idx, e=emo, t=it["title"], l=it["link"])
        if meta:
            md += "\n<font color='grey'>{}</font>".format(meta)
        lines.append(md)
    return lines


def _column(title, rows, empty_hint="暂无更新"):
    """飞书卡片单栏：标题 + 条目列表"""
    if rows:
        content = "\n\n".join(_entry_lines(rows))
    else:
        content = "<font color='grey'>{}</font>".format(empty_hint)
    return {
        "tag": "column",
        "width": "weighted",
        "weight": 1,
        "vertical_align": "top",
        "elements": [
            {"tag": "div", "text": {"tag": "lark_md", "content": title}},
            {"tag": "div", "text": {"tag": "lark_md", "content": content}},
        ],
    }


def build_card(cat, rss_rows, mp_rows=None):
    """双栏卡片：左栏传统 RSS，右栏公众号；条目均带原文链接

    rss_rows / mp_rows: [{title, link, source, ts, summary}]
    """
    cid = cat["id"]
    mp_rows = mp_rows or []
    total = len(rss_rows) + len(mp_rows)

    left = _column("{} 传统 RSS · {} 条".format(COL_RSS, len(rss_rows)), rss_rows,
                   empty_hint="暂无 RSS 新闻")
    right = _column("{} 公众号 · {} 条".format(COL_MP, len(mp_rows)), mp_rows,
                    empty_hint="暂无公众号文章")

    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": CARD_COLOR.get(cid, "blue"),
            "title": {
                "tag": "plain_text",
                "content": "{} {} · {} 条".format(
                    CAT_EMOJI.get(cid, DEFAULT_EMOJI), cat["name"], total),
            },
        },
        "elements": [
            {"tag": "hr"},
            {"tag": "column_set", "flex_mode": "none", "horizontal_spacing": "default",
             "columns": [left, right]},
        ],
    }


def send_card(webhook, secret, card, timeout=20):
    resp = requests.post(webhook, json=_payload("interactive", {"card": card}, secret),
                         timeout=timeout)
    return resp.status_code, (resp.text or "")[:300]


def send_text(webhook, secret, text, timeout=20):
    resp = requests.post(webhook, json=_payload("text", {"content": {"text": text}}, secret),
                         timeout=timeout)
    return resp.status_code, (resp.text or "")[:300]


def card_to_text(cat, rss_rows, mp_rows=None):
    """文本兜底：两栏分段输出"""
    mp_rows = mp_rows or []
    lines = ["{} {} 共 {} 条".format(
        CAT_EMOJI.get(cat["id"], DEFAULT_EMOJI), cat["name"],
        len(rss_rows) + len(mp_rows))]

    for title, rows in (("{} 传统 RSS".format(COL_RSS), rss_rows),
                        ("{} 公众号".format(COL_MP), mp_rows)):
        lines.append("")
        lines.append("---- {} · {} 条 ----".format(title, len(rows)))
        if not rows:
            lines.append("暂无更新")
            continue
        for idx, it in enumerate(rows, 1):
            when = time.strftime("%m-%d %H:%M", time.localtime(it["ts"])) if it.get("ts") else ""
            lines.append("{}. {} {} ({}{}) {}".format(
                idx, pick_emoji(it.get("title", "")), it["title"], it.get("source", ""),
                " " + when if when else "", it["link"]))
    return "\n".join(lines)
