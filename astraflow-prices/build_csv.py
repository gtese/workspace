#!/usr/bin/env python3
"""把 fetch_prices.mjs 抓到的 JSON 展平成 CSV（一行 = 一个模型的一个计费项单价）。"""
import csv
import json
import sys

src_path = sys.argv[1] if len(sys.argv) > 1 else 'raw_prices_2026-11-19.json'
out_path = sys.argv[2] if len(sys.argv) > 2 else 'astraflow_model_prices.csv'

src = json.load(open(src_path, encoding='utf-8'))
rows = []
for m in src['Models']:
    base = {
        '模型ID': m.get('ModelName') or '',
        '模型ID(Id字段)': m.get('ModelId') or '',
        '厂商': m.get('Manufacturer') or '',
    }
    tiers = m.get('Tiers') or []
    if not tiers:
        rows.append({**base, '计费单元': '', '说明': '', '标价(元)': '', '单位': '',
                     '档位条件': '', '计费项': '', '币种': '', 'PricingSkuId': '',
                     '说明(英文)': '', '单位(英文)': ''})
        continue
    for t in tiers:
        for r in (t.get('Rates') or []):
            rows.append({
                **base,
                '计费单元': r.get('PricingSku') or '',
                '说明': r.get('ChargeItemDescription') or '',
                '标价(元)': r.get('Price') if r.get('Price') is not None else '',
                '单位': r.get('Unit') or '',
                '档位条件': t.get('Condition') or '',
                '计费项': r.get('ChargeItem') or '',
                '币种': r.get('Currency') or '',
                'PricingSkuId': r.get('PricingSkuId') or '',
                '说明(英文)': r.get('ChargeItemDescriptionEn') or '',
                '单位(英文)': r.get('UnitEn') or '',
            })

cols = ['模型ID', '模型ID(Id字段)', '厂商', '计费单元', '说明', '标价(元)', '单位',
        '档位条件', '计费项', '币种', 'PricingSkuId', '说明(英文)', '单位(英文)']
with open(out_path, 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.DictWriter(f, fieldnames=cols)
    w.writeheader()
    w.writerows(rows)

print(f'models: {len(src["Models"])}, rows: {len(rows)} -> {out_path}')
