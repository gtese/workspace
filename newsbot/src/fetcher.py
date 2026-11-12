# -*- coding: utf-8 -*-
"""RSS 抓取与归一化（含低频节流：请求随机间隔 + 失败退避重试）

支持的源类型：
  - 传统新闻 RSS（sources.yaml）
  - 公众号 RSS（we-mp-rss 输出，mp_sources.yaml，src.kind == "mp"）
"""
import calendar
import random
import re
import time

import feedparser
import requests
import yaml

ACCEPT = ("text/html,application/xhtml+xml,application/xml;q=0.9,"
          "application/rss+xml;q=0.9,*/*;q=0.8")
MAX_ENTRIES = 80


def load_sources(path):
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return data.get("sources", [])


def strip_html(s, limit=400):
    if not s:
        return ""
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", '"')
    s = re.sub(r"&[a-zA-Z#0-9]+;", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:limit]


def entry_ts(entry):
    """返回 epoch 秒（UTC），取不到返回 None"""
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        val = entry.get(key)
        if val:
            try:
                return calendar.timegm(val)
            except Exception:
                pass
    return None


def _sleep_before_request(runtime):
    """每个请求前随机等待，压低单轮抓取密度，降低被源站拦截的概率"""
    dmin = float(runtime.get("fetch_delay_min", 0) or 0)
    dmax = float(runtime.get("fetch_delay_max", 0) or 0)
    if dmax > 0:
        time.sleep(random.uniform(dmin, max(dmin, dmax)))


def _http_get(url, headers, runtime):
    """带退避重试的 GET；返回 (resp, err)"""
    retries = int(runtime.get("fetch_retry", 1) or 0)
    timeout = runtime.get("request_timeout", 20)
    last = None
    for attempt in range(retries + 1):
        try:
            return requests.get(url, headers=headers, timeout=timeout,
                                allow_redirects=True), None
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt < retries:
                time.sleep(random.uniform(3.0, 6.0))
    return None, last


def fetch_source(src, runtime):
    """抓取单个源，返回 (源名, 条目列表, 状态字符串)"""
    name = src.get("name", "?")
    url = src.get("url", "")
    hint = src.get("hint", "")
    kind = src.get("kind", "rss")
    items = []

    _sleep_before_request(runtime)

    headers = {
        "User-Agent": runtime.get("user_agent", "Mozilla/5.0"),
        "Accept": ACCEPT,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    try:
        resp, err = _http_get(url, headers, runtime)
        if resp is None:
            return name, [], "ERR %s: %s" % (type(err).__name__, str(err)[:80])
        if resp.status_code != 200:
            return name, [], "http=%s" % resp.status_code

        feed = feedparser.parse(resp.content)
        if not feed.entries:
            ctype = resp.headers.get("Content-Type", "")[:30]
            return name, [], "no-entries(ctype=%s)" % ctype

        for entry in feed.entries[:MAX_ENTRIES]:
            title = strip_html(entry.get("title", ""), 200)
            link = (entry.get("link") or "").strip()
            if not title or not link:
                continue
            summary = strip_html(entry.get("summary") or entry.get("description") or "", 400)
            items.append({
                "title": title,
                "link": link,
                "summary": summary,
                "source": name,
                "kind": kind,
                "hint": hint,
                "allow": src.get("allow") or [],
                "ts": entry_ts(entry),
            })
        return name, items, "ok entries=%d" % len(items)
    except Exception as exc:  # noqa: BLE001
        return name, [], "ERR %s: %s" % (type(exc).__name__, str(exc)[:80])
