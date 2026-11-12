# -*- coding: utf-8 -*-
import concurrent.futures, requests, feedparser

H = {
 "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
 "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml;q=0.9,*/*;q=0.8",
 "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

SOURCES = [
 ("机器之心-A","https://www.jiqizhixin.com/rss"),
 ("机器之心-B","https://www.jiqizhixin.com/rss.xml"),
 ("机器之心-C","https://www.jiqizhixin.com/feed"),
 ("集微网-A","https://www.laoyaoba.com/rss"),
 ("集微网-B","https://www.laoyaoba.com/rss.xml"),
 ("集微网-C","https://www.laoyaoba.com/feed"),
 ("36氪-A","https://36kr.com/feed"),
 ("36氪-B","https://36kr.com/feed-article"),
 ("36氪-C","https://36kr.com/feed-newsflash"),
 ("NVIDIA-A","https://nvidianews.nvidia.com/rss.xml"),
 ("NVIDIA-B","https://nvidianews.nvidia.com/rss/all"),
 ("NVIDIA-C","https://nvidianews.nvidia.com/news?format=rss"),
 ("AMD-A","https://www.amd.com/en/newsroom.rss"),
 ("AMD-B","https://ir.amd.com/rss/news-releases.xml"),
 ("Intel-A","https://newsroom.intel.com/rss"),
 ("Intel-B","https://newsroom.intel.com/feed/"),
 ("VentureBeat","https://venturebeat.com/category/ai/feed/"),
 ("Crunchbase","https://news.crunchbase.com/feed/"),
 ("RSSHub-36kr","https://rsshub.app/36kr/newsflash"),
 ("RSSHub-jqzx","https://rsshub.app/jiqizhixin/latest"),
 ("电子发烧友","https://www.elecfans.com/rss/"),
 ("半导体行业观察","https://www.semiinsights.com/feed"),
]

def probe(item):
    name, url = item
    try:
        r = requests.get(url, headers=H, timeout=15, allow_redirects=True)
        n = -1
        try:
            n = len(feedparser.parse(r.content).entries)
        except Exception:
            pass
        return (name, url, str(r.status_code), n, r.headers.get("Content-Type","")[:32])
    except Exception as e:
        return (name, url, "ERR:" + type(e).__name__, -1, "")

with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
    for name, url, code, n, ct in ex.map(probe, SOURCES):
        print("%-14s %-58s %-16s entries=%-5s %s" % (name, url[:58], code, n, ct))
