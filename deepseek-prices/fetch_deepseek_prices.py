#!/usr/bin/env python3
"""抓取 DeepSeek 官方价目表（https://api-docs.deepseek.com/zh-cn/quick_start/pricing/）并生成 CSV。

数据源用该页的 Markdown 版本（页面右上角「复制 Markdown」对应的 /pricing.md），
比解析 HTML 稳定。脚本对关键字段做了断言，页面改版时会报错而不是静默产出错数据。

用法: python3 fetch_deepseek_prices.py [--url URL] [--out-prefix PREFIX]
"""
import argparse
import csv
import re
import urllib.request

DEFAULT_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md'
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8')


def strip_md(cell):
    """把单元格里的 markdown 链接/加粗等还原成纯文本。"""
    cell = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', cell)
    cell = cell.replace('**', '').replace('`', '').replace('<', '').replace('>', '')
    return cell.strip()


def parse_row_cells(line):
    return [strip_md(c) for c in line.strip().strip('|').split('|')]


def table_lines(md, heading):
    """取某个二级标题下、第一张表格的数据行（跳过表头与分隔线）。"""
    start = md.index(heading)
    rest = md[start:]
    end = re.search(r'\n## ', rest[1:])
    body = rest if not end else rest[:end.start() + 1]
    lines = [l for l in body.splitlines() if l.strip().startswith('|')]
    rows = [parse_row_cells(l) for l in lines]
    # 去掉 |---|---| 分隔行；表头行保留（模型细节表的表头就是模型名）
    return [r for r in rows if not all(set(c) <= set('-: ') for c in r)]


def clean_name(text):
    """去掉脚注上标，如 deepseek-flash(1) -> deepseek-flash。"""
    return re.sub(r'\(\d+\)$', '', text).strip()


def tok(text):
    """'0.02元' -> '0.02'; '1元' -> '1'"""
    m = re.match(r'^([\d.]+)\s*元$', text)
    assert m, f'价格格式无法解析: {text!r}'
    return m.group(1).rstrip('0').rstrip('.') if '.' in m.group(1) else m.group(1)


def parse_md(md):
    rows = []

    # 1) 模型 Token 价格表（模型细节）
    detail = table_lines(md, '## 模型细节')
    models = [clean_name(m) for m in detail[0][3:5]]
    assert models == ['deepseek-flash', 'deepseek-v4-pro'], models
    price_rows = [r for r in detail if len(r) == 5 and r[0].startswith('价格')]
    assert len(price_rows) == 6, len(price_rows)
    for r in price_rows:
        item, period = r[1], r[2]
        item = item.replace('百万tokens', '').replace('/', '').replace('（', '（').strip()
        item = re.sub(r'\s+', '', item)
        for name, price in zip(models, r[3:5]):
            rows.append({
                '分类': '模型 Token',
                '模型/项目': name,
                '计费项': item,
                '时段': period,
                '价格(元)': tok(price),
                '折扣价(元)': '',
                '计费单位': '百万 tokens',
                '备注': '',
            })

    # 2) Search 与 Fetch API
    for r in table_lines(md, '## Search 与 Fetch API 价格')[1:]:
        item, unit, price = r[0], r[1], r[2]
        rows.append({'分类': 'Search/Fetch API', '模型/项目': item, '计费项': item, '时段': '',
                     '价格(元)': tok(price), '折扣价(元)': '', '计费单位': unit, '备注': ''})

    # 3) 文件解析与 OCR
    for r in table_lines(md, '## 文件解析与 OCR 价格')[1:]:
        item, unit, price = r[0], r[1], r[2]
        rows.append({'分类': '文件解析与OCR', '模型/项目': item, '计费项': item, '时段': '',
                     '价格(元)': tok(price), '折扣价(元)': '', '计费单位': unit, '备注': ''})

    # 4) 语音
    for r in table_lines(md, '## 语音价格')[1:]:
        item, unit, list_price, discount = r[0], r[1], r[2], r[3]
        rows.append({'分类': '语音', '模型/项目': item, '计费项': item, '时段': '',
                     '价格(元)': tok(list_price), '折扣价(元)': tok(discount),
                     '计费单位': unit, '备注': '限时折扣 5 折'})

    notes = {
        'deepseek-flash': '模型名用 deepseek-flash；旧名 deepseek-v4-flash、deepseek-v4-flash-vision-exp 仍可调用，按 Flash 价格计费',
    }
    for row in rows:
        if row['模型/项目'] in notes and not row['备注']:
            row['备注'] = notes[row['模型/项目']]
    return rows


def parse_models(md):
    """模型细节表 -> 宽表（每模型一行）。"""
    detail = table_lines(md, '## 模型细节')
    models = [clean_name(m) for m in detail[0][3:5]]
    out = []
    for r in detail:
        if len(r) != 5:
            continue
        label = r[0]
        if label == '模型' or label.startswith('价格'):
            continue  # 表头 / 价格行：价格单独输出到 *_prices_*.csv
        key = r[1] if r[1] != label else label
        key = clean_name(key.strip())
        out.append({'字段': key, **{m: r[3 + i] for i, m in enumerate(models)}})
    rows = []
    for m_i, name in enumerate(models):
        rec = {'模型': name}
        for item in out:
            rec[item['字段']] = item[name]
        rows.append(rec)
    return rows, models


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', default=DEFAULT_URL)
    ap.add_argument('--out-prefix', default='deepseek_prices')
    ap.add_argument('--date', default='2026-11-19')
    args = ap.parse_args()

    md = fetch(args.url)
    with open(f'raw_pricing_{args.date}.md', 'w', encoding='utf-8') as f:
        f.write(md)

    rows = parse_md(md)
    cols = ['分类', '模型/项目', '计费项', '时段', '价格(元)', '折扣价(元)', '计费单位', '备注']
    price_csv = f'{args.out_prefix}_{args.date}.csv'
    with open(price_csv, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)

    model_rows, models = parse_models(md)
    cols2 = ['模型'] + [k for k in model_rows[0] if k != '模型']
    model_csv = f'deepseek_models_{args.date}.csv'
    with open(model_csv, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=cols2, extrasaction='ignore')
        w.writeheader()
        w.writerows(model_rows)

    print(f'{price_csv}: {len(rows)} 行 / {len({r["模型/项目"] for r in rows})} 个项目')
    print(f'{model_csv}: {len(model_rows)} 行 ({", ".join(models)})')


if __name__ == '__main__':
    main()
