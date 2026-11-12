# -*- coding: utf-8 -*-
"""四类新闻分类：领域锚点 + 关键词加权打分

规则：
  1. anchors：类目门槛，正文命中至少一个锚点才有资格进入该类（anchors 为空则不限）
  2. keywords：标题命中 x3，标题+摘要命中 x1；关键词越长越具体，权重越高
     （>=10 字符 3 分，>=6 字符 2 分，其余 1 分）
  3. 来源倾向 hint 命中：+2 分
  4. 取最高分分类；最高分低于 min_score 视为"未分类"丢弃
"""
import re

_EN_RE = re.compile(r"[a-zA-Z]")


def keyword_weight(kw):
    n = len(kw)
    if n >= 10:
        return 3
    if n >= 6:
        return 2
    return 1


def _hit(text, kw):
    """中文用子串匹配；英文用词边界匹配，避免 'agent' 命中 'reagent'、'order' 命中 'second-order'"""
    if _EN_RE.search(kw):
        pat = r"(?<![a-z0-9])" + re.escape(kw) + r"(?![a-z0-9])"
        return re.search(pat, text) is not None
    return kw in text


def is_excluded(title, patterns):
    """全局排除：命中任一正则即丢弃"""
    if not patterns:
        return False
    for pat in patterns:
        if re.search(pat, title, re.IGNORECASE):
            return True
    return False


def score_item(item, categories, min_score=3):
    """返回 (best_category_id 或 None, best_score, detail)

    detail = {cat_id: (score, [命中的关键词])}
    """
    title = item["title"].lower()
    body = (item["title"] + " " + item.get("summary", "")).lower()
    hint = item.get("hint", "")
    allow = item.get("allow") or []

    detail = {}
    for cat in categories:
        # 源级类目白名单：不在白名单内的类目不给分
        if allow and cat["id"] not in allow:
            detail[cat["id"]] = (0, [])
            continue
        anchors = cat.get("anchors") or []
        if anchors and not any(_hit(body, a.lower()) for a in anchors):
            detail[cat["id"]] = (0, [])
            continue

        score, hits = 0, []
        for kw in cat.get("keywords", []):
            k = kw.lower()
            if _hit(title, k):
                score += keyword_weight(kw) * 3
                hits.append(kw + "(标题)")
            elif _hit(body, k):
                score += keyword_weight(kw)
                hits.append(kw)
        if hint and hint == cat["id"]:
            score += 2
        detail[cat["id"]] = (score, hits)

    best_id, best_score = None, 0
    for cid, (s, _) in detail.items():
        if s > best_score:
            best_id, best_score = cid, s
    if best_score < min_score:
        return None, best_score, detail
    return best_id, best_score, detail


def classify(item, categories, min_score=3):
    """兼容旧调用：返回 (category_id 或 None, 得分, detail)"""
    return score_item(item, categories, min_score)
