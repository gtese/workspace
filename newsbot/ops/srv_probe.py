#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""服务器侧源可达性复核：新增候选 + 此前待定/失败源重试"""
import concurrent.futures as cf
import requests, feedparser

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
HDR = {"User-Agent": UA,
       "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
       "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}

CANDS = [
 # ---- A. 本轮拟新增（本地已验证，服务器复核） ----
 ("A|爱范儿", "https://www.ifanr.com/feed"),
 ("A|少数派", "https://sspai.com/feed"),
 ("A|雷科技", "https://www.leikeji.com/rss"),
 ("A|ChinaZ", "https://www.chinaz.com/rss/rss1.xml"),
 ("A|arXiv cs.CL", "https://rss.arxiv.org/rss/cs.CL"),
 ("A|DeepMind Blog", "https://deepmind.google/blog/rss.xml"),
 ("A|MIT News AI", "https://news.mit.edu/rss/topic/artificial-intelligence2"),
 ("A|NVIDIA Blogs", "https://blogs.nvidia.com/feed/"),
 ("A|IEEE Spectrum Semi", "https://spectrum.ieee.org/feeds/topic/semiconductors.rss"),
 ("A|博客园", "https://www.cnblogs.com/rss/"),
 ("A|开源中国", "https://www.oschina.net/news/rss"),
 ("A|稀土掘金", "https://juejin.cn/rss"),
 ("A|ACM SIGDA", "https://www.sigda.org/rss"),
 ("A|TC Enterprise", "https://techcrunch.com/category/enterprise/feed/"),
 ("A|华尔街见闻", "https://dedicated.wallstreetcn.com/rss.xml"),
 ("A|TC Fundraising", "https://techcrunch.com/category/fundraising/feed/"),
 # ---- B. 此前待定 / 失败，服务器侧重试 ----
 ("B|The Next Platform", "https://www.nextplatform.com/feed/"),
 ("B|澎湃新闻", "https://www.thepaper.cn/rss_newsDetail_25950.xml"),
 ("B|品玩", "https://www.pingwest.com/feed"),
 ("B|C114", "https://www.c114.com.cn/rss/rss.xml"),
 ("B|半导体行业观察", "https://www.semiinsights.com/feed"),
 ("B|芯智讯", "https://www.icsmart.cn/feed"),
 ("B|IT桔子", "https://www.itjuzi.com/rss"),
 ("B|集微网", "https://www.laoyaoba.com/rss"),
 ("B|机器之心", "https://www.jiqizhixin.com/rss"),
 ("B|36氪快讯", "https://36kr.com/feed-newsflash"),
 ("B|Anthropic", "https://www.anthropic.com/news/rss.xml"),
 ("B|Meta AI", "https://ai.meta.com/blog/rss/"),
 ("B|Reuters Tech", "https://www.reuters.com/arc/outboundfeeds/technology/?outputType=xml"),
 ("B|Bloomberg Tech", "https://feeds.bloomberg.com/technology/news.rss"),
 ("B|Synopsys", "https://news.synopsys.com/rss"),
 ("B|Cadence", "https://www.cadence.com/rss/newsroom.xml"),
 ("B|PitchBook", "https://pitchbook.com/news/rss"),
 ("B|ICLAD", "https://iclad.ai/feed"),
]

def probe(item):
    name, url = item
    out = {"name": name, "url": url, "ok": False, "entries": 0, "status": "", "err": ""}
    try:
        r = requests.get(url, headers=HDR, timeout=20, allow_redirects=True)
        out["status"] = r.status_code
        if r.status_code == 200:
            f = feedparser.parse(r.content)
            n = len(f.entries)
            out["entries"] = n
            out["ok"] = n > 0
            if n > 0:
                out["latest"] = (f.entries[0].get("title") or "")[:55]
        else:
            out["err"] = "HTTP %s" % r.status_code
    except Exception as e:
        out["err"] = type(e).__name__
    return out

with cf.ThreadPoolExecutor(max_workers=8) as ex:
    res = list(ex.map(probe, CANDS))

print("=== SERVERSIDE PROBE ===")
for r in res:
    flag = "OK " if r["ok"] else "NG "
    print("%s%-22s %-4s e=%-4d %s %s" % (flag, r["name"], r["status"], r["entries"],
                                         r.get("latest", ""), r["err"]))
print("=== SUMMARY ok=%d/%d ===" % (sum(1 for r in res if r["ok"]), len(res)))
for tag in ("A", "B"):
    sub = [r for r in res if r["name"].startswith(tag + "|")]
    print("%s: ok=%d/%d" % (tag, sum(1 for r in sub if r["ok"]), len(sub)))
