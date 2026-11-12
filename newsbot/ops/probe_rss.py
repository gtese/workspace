# -*- coding: utf-8 -*-
import concurrent.futures, requests, feedparser

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/rss+xml,application/xml,text/xml,*/*"}

SOURCES = [
 ("C1 机器之心","https://www.jiqizhixin.com/rss"),
 ("C1 量子位","https://www.qbitai.com/feed"),
 ("C1 智东西","https://www.zhidx.com/rss"),
 ("C1 雷峰网","https://www.leiphone.com/feed"),
 ("C1 极客公园","https://www.geekpark.net/rss"),
 ("C1 IT之家","https://www.ithome.com/rss/"),
 ("C1 集微网","https://www.laoyaoba.com/rss"),
 ("C1 arXiv-cs.AI","https://rss.arxiv.org/rss/cs.AI"),
 ("C1 arXiv-cs.LG","https://rss.arxiv.org/rss/cs.LG"),
 ("C1 arXiv-cs.AR","https://rss.arxiv.org/rss/cs.AR"),
 ("C1 HackerNews","https://hnrss.org/frontpage"),
 ("C1 SemiEngineering","https://semiengineering.com/feed/"),
 ("C1 EE Times","https://www.eetimes.com/feed/"),
 ("C1 TomsHardware","https://www.tomshardware.com/feeds/all"),
 ("C2 IC技术圈","https://iccircle.com/feed"),
 ("C2 InfoQ","https://www.infoq.cn/feed"),
 ("C2 SynopsysCN","https://cn.news.synopsys.com/rss"),
 ("C2 arXiv-cs.SE","https://rss.arxiv.org/rss/cs.SE"),
 ("C2 arXiv-cs.PL","https://rss.arxiv.org/rss/cs.PL"),
 ("C2 VentureBeatAI","https://venturebeat.com/category/ai/feed/"),
 ("C2 TechCrunchAI","https://techcrunch.com/category/artificial-intelligence/feed/"),
 ("C3 钛媒体","https://www.tmtpost.com/rss.xml"),
 ("C3 Digitimes","https://www.digitimes.com/rss/daily.xml"),
 ("C3 AnandTech","https://www.anandtech.com/rss/"),
 ("C3 NVIDIA","https://nvidianews.nvidia.com/rss"),
 ("C3 AMD","https://www.amd.com/en/newsroom/rss.xml"),
 ("C3 Intel","https://newsroom.intel.com/feed/"),
 ("C4 36氪","https://36kr.com/feed"),
 ("C4 36氪快讯","https://36kr.com/feed-newsflash"),
 ("C4 36氪文章","https://36kr.com/feed-article"),
 ("C4 虎嗅","https://rss.huxiu.com/"),
 ("C4 CrunchbaseNews","https://news.crunchbase.com/feed/"),
 ("C4 TechCrunch","https://techcrunch.com/feed/"),
 ("C4 创业邦","https://www.cyzone.cn/feed"),
 ("C3 电子发烧友","https://www.elecfans.com/rss.xml"),
 ("C2 电子工程专辑","https://www.eet-china.com/rss.html"),
 ("FS 飞书API","https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-0000-0000-000000000000"),
]

def probe(item):
    name, url = item
    try:
        r = requests.get(url, headers=UA, timeout=15, allow_redirects=True)
        n = -1
        ct = r.headers.get("Content-Type", "")
        try:
            n = len(feedparser.parse(r.content).entries)
        except Exception:
            pass
        return (name, url, str(r.status_code), n, ct[:35])
    except Exception as e:
        return (name, url, "ERR:" + type(e).__name__, -1, "")

with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
    for name, url, code, n, ct in ex.map(probe, SOURCES):
        print("%-18s %-62s %-16s entries=%-5s %s" % (name, url[:62], code, n, ct))
