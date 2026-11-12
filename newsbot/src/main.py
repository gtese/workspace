#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""新闻抓取 -> 四类分类 -> 飞书分群推送（双栏：传统 RSS / 公众号）   主入口

用法:
  /opt/newsbot/venv/bin/python /opt/newsbot/src/main.py             # 按配置执行
  /opt/newsbot/venv/bin/python /opt/newsbot/src/main.py --dry-run   # 只演练不发送
  /opt/newsbot/venv/bin/python /opt/newsbot/src/main.py --source 量子位
  /opt/newsbot/venv/bin/python /opt/newsbot/src/main.py --explain 8 # 打分类明细
"""
import argparse
import hashlib
import json
import logging
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import yaml

BASE = "/opt/newsbot"
sys.path.insert(0, os.path.join(BASE, "src"))

from fetcher import fetch_source, load_sources                       # noqa: E402
from classifier import is_excluded, score_item                       # noqa: E402
from pusher import build_card, card_to_text, send_card, send_text    # noqa: E402

CONFIG = os.path.join(BASE, "config", "config.yaml")
SOURCES = os.path.join(BASE, "config", "sources.yaml")
MP_SOURCES = os.path.join(BASE, "config", "mp_sources.yaml")
STATE = os.path.join(BASE, "state", "seen.json")
LOG = os.path.join(BASE, "logs", "newsbot.log")

SCHEDULE_FILE = os.path.join(BASE, "state", "schedule.json")
CAT_INTERVAL_DAYS = {"c1": 1, "c2": 1, "c3": 2, "c4": 2}


def _load_schedule():
    if not os.path.exists(SCHEDULE_FILE):
        return {}
    try:
        with open(SCHEDULE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _should_push_today(cid, today):
    """按类别间隔判断今天是否需要推送。"""
    interval = CAT_INTERVAL_DAYS.get(cid, 1)
    if interval <= 1:
        return True
    last = _load_schedule().get(cid, "")
    if not last:
        return True
    try:
        last_d = datetime.strptime(last, "%Y-%m-%d").date()
    except Exception:
        return True
    return (today - last_d).days >= interval


def _mark_pushed(cid, today):
    """记录该类别本次成功推送日期。"""
    data = _load_schedule()
    data[cid] = today.strftime("%Y-%m-%d")
    try:
        os.makedirs(os.path.dirname(SCHEDULE_FILE), exist_ok=True)
        with open(SCHEDULE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log.warning("schedule write failed: %s", e)

log = logging.getLogger("newsbot")


def setup_logger():
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s",
                            datefmt="%Y-%m-%d %H:%M:%S")
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    fh = logging.FileHandler(LOG, encoding="utf-8")
    fh.setFormatter(fmt)
    log.handlers = [sh, fh]


def item_key(title):
    norm = re.sub(r"\s+", "", title).lower()
    return hashlib.md5(norm.encode("utf-8")).hexdigest()


def load_state():
    if os.path.exists(STATE):
        try:
            with open(STATE, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"seen": {}}


def save_state(state, keep_days=14):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=keep_days)).isoformat()
    state["seen"] = {k: v for k, v in state["seen"].items() if v >= cutoff}
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)


def load_mp_sources(path):
    """读取公众号 RSS 源清单（we-mp-rss 输出，独立于传统 sources.yaml）"""
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not data.get("enabled", True):
        return []
    base = (data.get("base") or "").rstrip("/")
    out = []
    for item in data.get("feeds") or []:
        fid = item.get("id") or ""
        url = item.get("url") or ("{}/feed/{}.xml".format(base, fid) if fid else "")
        if not url:
            continue
        out.append({
            "name": item.get("name") or fid,
            "url": url,
            "hint": item.get("hint", ""),
            "allow": item.get("allow") or [],
            "kind": "mp",
            "enabled": item.get("enabled", True),
        })
    return [s for s in out if s.get("enabled", True)]


def pick_rows(rows, cap, total):
    """rows 已按时间倒序；先按单源配额截断，再取总量上限"""
    picked, used = [], {}
    for score, it in rows:
        src = it["source"]
        if used.get(src, 0) >= cap:
            continue
        used[src] = used.get(src, 0) + 1
        picked.append((score, it))
        if len(picked) >= total:
            break
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只演练，不真正推送")
    ap.add_argument("--source", default="", help="只跑名字包含该串的源")
    ap.add_argument("--show", type=int, default=0, help="打印前 N 条分类结果")
    ap.add_argument("--explain", type=int, default=0, help="打印前 N 条分类得分明细")
    args = ap.parse_args()

    setup_logger()
    with open(CONFIG, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    rt = cfg["runtime"]
    cats = cfg["categories"]
    fs = cfg["feishu"]
    dry = args.dry_run or fs.get("dry_run", True)
    excludes = rt.get("exclude_patterns") or []

    sources = [s for s in load_sources(SOURCES) if s.get("enabled", True)]
    sources += [s for s in load_mp_sources(MP_SOURCES) if s.get("enabled", True)]
    if args.source:
        sources = [s for s in sources if args.source in s["name"]]

    log.info("========== run start | sources=%d (rss=%d, mp=%d) | dry_run=%s ==========",
             len(sources),
             len([s for s in sources if s.get("kind") != "mp"]),
             len([s for s in sources if s.get("kind") == "mp"]), dry)

    # 1) 抓取
    fetched = []
    with ThreadPoolExecutor(max_workers=rt.get("max_workers", 2)) as ex:
        for name, items, status in ex.map(lambda s: fetch_source(s, rt), sources):
            log.info("fetch %-22s %s", name, status)
            fetched.extend(items)

    # 2) 去重 + 时效过滤 + 全局排除
    now = datetime.now(timezone.utc)
    max_age = timedelta(hours=rt.get("max_age_hours", 72))
    state = load_state()
    fresh, excluded = [], 0
    run_seen = set()
    for it in fetched:
        key = item_key(it["title"])
        if key in state["seen"] or key in run_seen:
            continue
        run_seen.add(key)
        if it["ts"]:
            age = now - datetime.fromtimestamp(it["ts"], tz=timezone.utc)
            if age > max_age:
                continue
        if is_excluded(it["title"], excludes):
            excluded += 1
            continue
        it["key"] = key
        fresh.append(it)
    log.info("fetched=%d (rss=%d, mp=%d) | excluded=%d | new=%d",
             len(fetched),
             len([x for x in fetched if x.get("kind") != "mp"]),
             len([x for x in fetched if x.get("kind") == "mp"]),
             excluded, len(fresh))

    # 3) 四类分类
    buckets = {c["id"]: [] for c in cats}
    dropped = 0
    mp_fallback = 0
    for it in fresh:
        cid, score, detail = score_item(it, cats, rt.get("min_score", 3))
        it["_cat"], it["_score"], it["_detail"] = cid, score, detail
        if cid:
            buckets[cid].append((score, it))
        elif it.get("kind") == "mp":
            # 公众号兜底：5 个号均为 AI 方向，分类不上的（科普/奖项/产品类）统一归研发群
            it["_cat"] = "c1"
            buckets["c1"].append((score, it))
            mp_fallback += 1
        else:
            dropped += 1
    log.info("classified: %s | dropped=%d | mp_fallback=%d",
             {k: len(v) for k, v in buckets.items()}, dropped, mp_fallback)

    # 3.5) 调试输出
    if args.show:
        for it in fresh[:args.show]:
            print("  [%s|%s|%s] %s" % (it["_cat"] or "--", it.get("kind", "rss"),
                                       it["_score"], it["title"][:70]))
    if args.explain:
        for it in fresh[:args.explain]:
            print("---")
            print("标题: %s" % it["title"][:90])
            print("来源: %s | kind=%s | hint=%s | 判定=%s(%s)" % (
                it["source"], it.get("kind", "rss"), it["hint"],
                it["_cat"] or "未分类", it["_score"]))
            for cid, (s, kws) in sorted(it["_detail"].items(), key=lambda x: -x[1][0]):
                if s > 0:
                    print("    %s score=%-4s %s" % (cid, s, "，".join(kws[:8])))

    # 4) 分群推送（每群卡片分两栏：传统 RSS / 公众号）
    cat_by_id = {c["id"]: c for c in cats}
    sent_total = 0
    for cid, rows in buckets.items():
        _today = (now + timedelta(hours=8)).date()
        if not _should_push_today(cid, _today):
            log.info("[SKIP] %s -> %s 每 %d 天推送一次，今日不推",
                     cid, cat_by_id[cid]["group"], CAT_INTERVAL_DAYS.get(cid, 1))
            continue
        if not rows:
            continue

        rows.sort(key=lambda x: (x[1]["ts"] or 0), reverse=True)
        rss_rows = [x for x in rows if x[1].get("kind") != "mp"]
        mp_rows = [x for x in rows if x[1].get("kind") == "mp"]
        rss_pick = pick_rows(rss_rows, rt.get("max_per_source_per_run", 3),
                             rt.get("max_per_group_per_run", 15))
        mp_pick = pick_rows(mp_rows, rt.get("mp_max_per_source_per_run", 3),
                            rt.get("mp_max_per_group_per_run", 12))
        if not rss_pick and not mp_pick:
            continue

        cat = cat_by_id[cid]
        grp = fs["groups"].get(cat["group"], {})
        payload_rss = [{k: it[k] for k in ("title", "link", "source", "ts", "summary")}
                       for _, it in rss_pick]
        payload_mp = [{k: it[k] for k in ("title", "link", "source", "ts", "summary")}
                      for _, it in mp_pick]

        if dry or not grp.get("webhook"):
            reason = "dry-run" if dry else "webhook 未配置"
            log.info("[SKIP] %s -> %s (%s) | RSS %d 条 | 公众号 %d 条",
                     cat["name"], grp.get("name", cat["group"]), reason,
                     len(payload_rss), len(payload_mp))
            for _, it in rss_pick:
                log.info("    [RSS] %s | %s", it["title"][:80], it["link"])
            for _, it in mp_pick:
                log.info("    [MP ] %s | %s", it["title"][:80], it["link"])
            continue

        code, body = send_card(grp["webhook"], grp.get("secret", ""),
                               build_card(cat, payload_rss, payload_mp))
        if code == 200 and '"code":0' in body.replace(" ", ""):
            log.info("[SEND] %s -> %s | RSS %d 条 | 公众号 %d 条",
                     cat["name"], grp.get("name"), len(payload_rss), len(payload_mp))
        else:
            log.warning("[SEND-FAIL] %s code=%s body=%s，改用文本重试",
                        cat["name"], code, body)
            code2, body2 = send_text(grp["webhook"], grp.get("secret", ""),
                                     card_to_text(cat, payload_rss, payload_mp))
            log.warning("[SEND-TEXT] code=%s body=%s", code2, body2)
        sent_total += len(payload_rss) + len(payload_mp)
        _mark_pushed(cid, _today)
        time.sleep(fs.get("rate_limit_seconds", 1.2))

    # 5) 落地状态（dry-run 不写，避免污染下一轮去重）
    if dry:
        log.info("[DRY] 不写入 seen.json / schedule.json")
    else:
        stamp = now.isoformat()
        for it in fresh:
            state["seen"][it["key"]] = stamp
        save_state(state)

    log.info("========== run done | pushed=%d ==========", sent_total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
