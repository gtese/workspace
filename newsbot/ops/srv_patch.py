#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""服务器侧：把服务器复核通过的 14 个新源合并进 sources.yaml（含备份+校验）"""
import io, shutil, time, sys
import yaml

P = "/opt/newsbot/config/sources.yaml"
bak = P + ".bak." + time.strftime("%Y%m%d_%H%M%S")
shutil.copy2(P, bak)
print("备份 ->", bak)

NEW_C1 = [
    ('爱范儿',    'https://www.ifanr.com/feed',                'c1', ['c1', 'c2']),
    ('少数派',    'https://sspai.com/feed',                    'c1', ['c1', 'c2']),
    ('雷科技',    'https://www.leikeji.com/rss',               'c1', ['c1', 'c3']),
    ('arXiv cs.CL', 'https://rss.arxiv.org/rss/cs.CL',         'c1', ['c1']),
    ('DeepMind Blog', 'https://deepmind.google/blog/rss.xml',  'c1', ['c1', 'c2']),
    ('MIT News AI', 'https://news.mit.edu/rss/topic/artificial-intelligence2', 'c1', ['c1', 'c2']),
    ('NVIDIA Blogs', 'https://blogs.nvidia.com/feed/',         'c1', ['c1', 'c3']),
    ('IEEE Spectrum Semi', 'https://spectrum.ieee.org/feeds/topic/semiconductors.rss', 'c1', ['c1', 'c3']),
]
NEW_C2 = [
    ('博客园',    'https://www.cnblogs.com/rss/',              'c2', ['c1', 'c2']),
    ('开源中国',  'https://www.oschina.net/news/rss',          'c2', ['c1', 'c2']),
    ('ACM SIGDA', 'https://www.sigda.org/rss',                 'c2', ['c2']),
]
NEW_C3 = [
    ('TC Enterprise', 'https://techcrunch.com/category/enterprise/feed/', 'c3', ['c1', 'c3']),
]
NEW_C4 = [
    ('华尔街见闻', 'https://dedicated.wallstreetcn.com/rss.xml', 'c4', ['c1', 'c4']),
    ('TC Fundraising', 'https://techcrunch.com/category/fundraising/feed/', 'c4', ['c1', 'c2', 'c4']),
]

def line(n, u, h, a):
    pad = " " * max(1, 20 - len(n))
    return '  - {name: "%s",%s url: "%s",%s hint: "%s", allow: [%s], enabled: true}\n' % (
        n, pad, u, " " * max(1, 4), h, ", ".join('"%s"' % x for x in a))

text = io.open(P, encoding="utf-8").read()
orig = text

text = text.replace('  - {name: "CNBC Tech",',
                    "".join(line(*x) for x in NEW_C1) + '  - {name: "CNBC Tech",')
text = text.replace('  - {name: "Azure Blog",',
                    "".join(line(*x) for x in NEW_C2) + '  - {name: "Azure Blog",')
text = text.replace('  - {name: "Datacenter Knowledge",',
                    "".join(line(*x) for x in NEW_C3) + '  - {name: "Datacenter Knowledge",')
text = text.replace('  - {name: "Sifted",',
                    "".join(line(*x) for x in NEW_C4) + '  - {name: "Sifted",')

if text == orig:
    print("ERROR: 锚点未命中，未做任何修改"); sys.exit(1)

text = text.replace("#   2026-09-28 第二轮：中文源不变，新增 37 个实测可用英文源",
                    "#   2026-09-28 第二轮：中文源不变，新增 37 个实测可用英文源\n"
                    "#   2026-09-28 第三轮：服务器复核通过，新增 14 源（中文 4 / 英文 10）")

io.open(P, "w", encoding="utf-8").write(text)

# 校验
d = yaml.safe_load(io.open(P, encoding="utf-8"))
s = d["sources"]
en = [x for x in s if x.get("enabled")]
names = [x["name"] for x in s]
adds = [x[0] for x in NEW_C1 + NEW_C2 + NEW_C3 + NEW_C4]
print("校验: 源总数=%d 启用=%d" % (len(s), len(en)))
print("新增命中: %d/%d" % (sum(1 for a in adds if a in names), len(adds)))
print("重名: %s" % ([n for n in set(names) if names.count(n) > 1] or "无"))
cn = ["爱范儿", "少数派", "雷科技", "博客园", "开源中国", "华尔街见闻"]
print("新增中文源: %s" % [a for a in adds if a in cn])
