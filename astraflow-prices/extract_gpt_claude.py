#!/usr/bin/env python3
"""从 AstraFlow 价格快照里抽取 GPT（OpenAI）与 Claude（Anthropic）模型价格。

输入：astraflow_model_prices_2026-11-19.csv（由 build_csv.py 生成）
输出：astraflow_gpt_claude_prices_2026-11-19.csv（一行 = 一个模型的一个计费项档位）

档位（tier/上下文/时长）从 PricingSku 里解析：
  ..._standard_context≤272K / _priority_ / _fast_ / _input≤100k / _5m cache write_ / _1h cache write_
"""
import csv
import re

SRC = 'astraflow_model_prices_2026-11-19.csv'
OUT = 'astraflow_gpt_claude_prices_2026-11-19.csv'

VENDOR_TAG = {'openai': 'OpenAI', 'gpt': 'OpenAI', 'claude': 'Anthropic', 'o3': 'OpenAI'}


def vendor_of(model):
    m = model.lower()
    if m.startswith('openai/') or m.startswith('gpt') or m.startswith('o3'):
        return 'OpenAI'
    if m.startswith('claude'):
        return 'Anthropic'
    return ''


def parse_sku(sku):
    s = sku
    service = 'standard'
    if 'priority' in s:
        service = 'priority'
    elif 'fast' in s:
        service = 'fast'
    elif 'batch' in s.lower():
        service = 'batch'
    ctx = ''
    m = re.search(r'context(\s*[≤>]\s*\d+K)', s, re.I)
    if m:
        ctx = m.group(1).replace(' ', '')
    m = re.search(r'input(\s*[≤>]\s*\d+[kK])', s, re.I)
    if m:
        ctx = 'input' + m.group(1).replace(' ', '')
    cache_ttl = ''
    m = re.search(r'(\d+[mh]) cache write', s, re.I)
    if m:
        cache_ttl = m.group(1)
    return service, ctx, cache_ttl


rows_out = []
with open(SRC, encoding='utf-8-sig') as f:
    for r in csv.DictReader(f):
        vendor = vendor_of(r['模型ID'])
        if not vendor:
            continue
        service, ctx, ttl = parse_sku(r['计费单元'])
        note = ''
        if ttl:
            note = f'缓存写入 {ttl}'
        rows_out.append({
            '厂商': vendor,
            '模型': r['模型ID'],
            '计费项': r['说明'],
            '服务档位': service,
            '上下文档位': ctx,
            '缓存时长': ttl,
            '单价(元/百万Token)': r['标价(元)'],
            '单位': r['单位'],
            '计费单元(PricingSku)': r['计费单元'],
            '备注': note,
        })

order = {'输入': 0, '文本输出': 1, '缓存读取': 2, '缓存写入 (5m)': 3, '缓存写入 (1h)': 4}
rows_out.sort(key=lambda x: (x['厂商'], x['模型'], order.get(x['计费项'], 9), x['服务档位'], x['上下文档位']))

cols = ['厂商', '模型', '计费项', '服务档位', '上下文档位', '缓存时长',
        '单价(元/百万Token)', '单位', '计费单元(PricingSku)', '备注']
with open(OUT, 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.DictWriter(f, fieldnames=cols)
    w.writeheader()
    w.writerows(rows_out)

models = sorted({r['模型'] for r in rows_out})
gpt = [m for m in models if vendor_of(m) == 'OpenAI']
claude = [m for m in models if vendor_of(m) == 'Anthropic']
print(f'{OUT}: {len(rows_out)} 行 / {len(models)} 个模型（OpenAI {len(gpt)}，Anthropic {len(claude)}）')
