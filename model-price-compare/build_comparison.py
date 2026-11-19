#!/usr/bin/env python3
"""三家模型价格对比：阿里云百炼（用户提供的折扣明细 xlsx） / AstraFlow(UCloud ModelVerse) / DeepSeek 官方。

输入：
  source_discount_table.xlsx          阿里云百炼 固定价格商品列表（元/千tokens）
  ../astraflow-prices/*.csv           AstraFlow 价格快照（元/百万 Token）
  ../deepseek-prices/*.csv            DeepSeek 官方价目表（元/百万 tokens）

输出：
  three_way_price_comparison.xlsx     4 个 sheet：统一对比 / 折扣率 / 明细 / 说明
  three_way_price_comparison.csv      统一对比的 CSV 版

统一口径：全部换算为「元 / 百万 tokens」，只比同一计费项、同一时段。
"""
import csv
import glob
import re
from collections import OrderedDict

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

BASE = '.'

# ---------- 1. 阿里云百炼（xlsx，元/千tokens） ----------

# 官网公开价（2026-11-19 取自 help.aliyun.com 百炼定价页），用于算折扣率
BAILIAN_LIST = OrderedDict([
    # 模型: {计费项: (忙时价, 闲时价)}  —— 输入/输出为公开价；缓存价格官网未在表中给出数字，留空
    ('deepseek-v4.1-flash', {'输入': (2.0, 1.0), '输出': (8.0, 4.0)}),
    ('deepseek-v4-pro-0813', {'输入': (9.0, 4.5), '输出': (27.0, 13.5)}),
    ('glm-5.3', {'输入': (8.0, 8.0), '输出': (28.0, 28.0)}),
    ('glm-5.2', {'输入': (8.0, 8.0), '输出': (28.0, 28.0)}),
    ('kimi-k3', {'输入': (20.0, 20.0), '输出': (100.0, 100.0)}),
    ('qwen3.8-max', {'输入': (12.0, 12.0), '输出': (36.0, 36.0)}),
])

ITEM_MAP = [
    (r'缓存未命中', '输入'),
    (r'隐式缓存命中', '缓存读取'),
    (r'显式缓存命中', '缓存读取'),
    (r'显式缓存创建', '缓存创建'),
    (r'^输出', '输出'),
]
PERIOD_MAP = {'忙时': '高峰', '闲时': '空闲'}


def norm_item(raw):
    for pat, name in ITEM_MAP:
        if re.search(pat, raw):
            return name
    raise ValueError(f'未知计费项: {raw}')


def parse_bailian():
    wb = load_workbook(f'{BASE}/source_discount_table.xlsx', data_only=True)
    ws = wb['固定价格商品列表']
    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not r or not r[5]:
            continue
        cond = r[6] or ''
        m = re.search(r'文本生成模型规格：([^(（]+)', cond)
        model = m.group(1).strip() if m else ''
        tok = re.search(r'Token类型：([^\n]+)', cond)
        tok_desc = tok.group(1) if tok else ''
        # 去掉尾部的接口字段名与比较符，如「(input_token_cache)(等于)」
        tok_desc = re.sub(r'\((?:input|output)[^)]*\)', '', tok_desc)
        tok_desc = tok_desc.replace('(等于)', '').strip()
        price = re.search(r'使用量价\s*([\d.]+)\s*元/千tokens', r[5])
        assert price, r[5]
        per_m = round(float(price.group(1)) * 1000, 6)  # 元/千 -> 元/百万
        period = '默认'
        for k, v in PERIOD_MAP.items():
            if k in tok_desc:
                period = v
        item = norm_item(tok_desc)
        rows.append({'厂商': '阿里云百炼(折扣表)', '模型': model, '计费项': item,
                     '时段': period, '单价': per_m, '原始计费项': tok_desc,
                     '原始价': r[5], '计费单位': '元/百万 tokens'})
    return rows


# ---------- 2. AstraFlow ----------

AF_ITEM = {'输入': '输入', '缓存': '缓存读取', '缓存读取': '缓存读取',
           '缓存写入': '缓存创建', '文本输出': '输出', '输出': '输出'}


def parse_astraflow():
    path = sorted(glob.glob(f'{BASE}/../astraflow-prices/astraflow_model_prices_2026-11-19.csv'))[-1]
    rows = []
    with open(path, encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            desc = (r['说明'] or '').strip()
            item = AF_ITEM.get(desc)
            if not item:
                continue
            cond = r['档位条件'] or ''
            if '峰时' in cond or 'peak' in cond:
                period = '高峰'
            elif '谷时' in cond or 'normal' in cond:
                period = '空闲'
            else:
                period = '默认'
            rows.append({'厂商': 'AstraFlow', '模型': r['模型ID'], '计费项': item,
                         '时段': period, '单价': round(float(r['标价(元)']), 6),
                         '原始计费项': desc,
                         '原始价': f"{r['标价(元)']} 元/{r['单位']}", '计费单位': '元/百万 tokens'})
    return rows


# ---------- 3. DeepSeek 官方 ----------

DS_MODEL = {'deepseek-flash': 'deepseek-v4.1-flash', 'deepseek-v4-pro': 'deepseek-v4-pro-0813'}
DS_ITEM = {'输入（缓存命中）': '缓存读取', '输入（缓存未命中）': '输入', '输出': '输出'}


def parse_deepseek():
    path = f'{BASE}/../deepseek-prices/deepseek_prices_2026-11-19.csv'
    rows = []
    with open(path, encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            if r['分类'] != '模型 Token':
                continue
            item = DS_ITEM.get(r['计费项'])
            if not item:
                continue
            period = '高峰' if r['时段'] == '高峰时段' else '空闲'
            rows.append({'厂商': 'DeepSeek 官方', '模型': DS_MODEL[r['模型/项目']], '计费项': item,
                         '时段': period, '单价': round(float(r['价格(元)']), 6),
                         '原始计费项': r['计费项'],
                         '原始价': f"{r['价格(元)']} 元/百万 tokens", '计费单位': '元/百万 tokens'})
    return rows


# ---------- 4. 组装 ----------

MODELS = ['deepseek-v4.1-flash', 'deepseek-v4-pro-0813', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'qwen3.8-max']
ITEMS = ['输入', '缓存读取', '输出']
PERIODS = ['高峰', '空闲', '默认']

detail = parse_bailian() + parse_astraflow() + parse_deepseek()
# 百炼表里 deepseek-v4.1-flash-1017 与 deepseek-v4.1-flash 价格相同，统一到后者
for r in detail:
    if r['模型'] == 'deepseek-v4.1-flash-1017':
        r['模型'] = 'deepseek-v4.1-flash'
detail = [r for r in detail if r['模型'] in MODELS]

assert len(detail) > 40, len(detail)

idx = {}
for r in detail:
    idx[(r['厂商'], r['模型'], r['计费项'], r['时段'])] = r['单价']

compare = []
for model in MODELS:
    bailian_list = BAILIAN_LIST.get(model, {})
    for item in ITEMS:
        periods = ['高峰', '空闲'] if model.startswith('deepseek') else ['默认']
        for period in periods:
            bl = idx.get(('阿里云百炼(折扣表)', model, item, period))
            af = idx.get(('AstraFlow', model, item, period))
            ds = idx.get(('DeepSeek 官方', model, item, period))
            listed = bailian_list.get(item)
            list_price = None
            if listed:
                list_price = listed[0] if period == '高峰' else listed[1]
            vals = {k: v for k, v in [('百炼折扣表', bl), ('AstraFlow', af), ('DeepSeek官方', ds)] if v is not None}
            cheapest = min(vals, key=vals.get) if vals else ''
            compare.append({
                '模型': model, '计费项': item, '时段': period,
                '百炼(你的折扣表)': bl, 'AstraFlow': af, 'DeepSeek官方': ds,
                '最低价来源': cheapest,
                '最低价': min(vals.values()) if vals else '',
                '百炼官网公开价': list_price,
                '折扣表/公开价': round(bl / list_price, 4) if (bl is not None and list_price) else '',
            })

# ---------- 4b. 时段加权（把峰谷窗口差异算进单价） ----------
# 官方/AstraFlow：工作日 高峰 6h(09-12,14-18)、闲时 18h；周末全天闲时。
# 阿里云百炼：每天 忙时 14h(08-22)、闲时 10h(22-08)，周末节假日照算。
OFFICIAL_WINDOW = (6, 18, 'off')   # (忙时h, 闲时h, 周末全天=闲时)
BAILIAN_WINDOW = (14, 10)


def weighted(peak_price, off_price, weekend):
    if peak_price is None or off_price is None:
        return None, None, None
    if weekend == 'off':
        weekday = (OFFICIAL_WINDOW[0] * peak_price + OFFICIAL_WINDOW[1] * off_price) / 24
        wkend = off_price
    else:  # 'same' → 每天同样的 14h/10h 结构
        weekday = (BAILIAN_WINDOW[0] * peak_price + BAILIAN_WINDOW[1] * off_price) / 24
        wkend = (BAILIAN_WINDOW[0] * peak_price + BAILIAN_WINDOW[1] * off_price) / 24
    week = (5 * weekday + 2 * wkend) / 7
    return round(weekday, 4), round(wkend, 4), round(week, 4)


weighted_rows = []
for model in ['deepseek-v4.1-flash', 'deepseek-v4-pro-0813']:
    for item in ['输入', '缓存读取', '输出']:
        pairs = {
            '百炼（你的折扣表）': (idx.get(('阿里云百炼(折扣表)', model, item, '高峰')), idx.get(('阿里云百炼(折扣表)', model, item, '空闲')), 'same'),
            '百炼官网公开价': (BAILIAN_LIST.get(model, {}).get(item, (None, None))[0], BAILIAN_LIST.get(model, {}).get(item, (None, None))[1], 'same'),
            'AstraFlow': (idx.get(('AstraFlow', model, item, '高峰')), idx.get(('AstraFlow', model, item, '空闲')), 'off'),
            'DeepSeek 官方': (idx.get(('DeepSeek 官方', model, item, '高峰')), idx.get(('DeepSeek 官方', model, item, '空闲')), 'off'),
        }
        for scheme, (peak_p, off_p, wk) in pairs.items():
            wd, we, w = weighted(peak_p, off_p, wk)
            if wd is None:
                continue
            weighted_rows.append({'模型': model, '计费项': item, '方案': scheme,
                                  '高峰/忙时价': peak_p, '空闲/闲时价': off_p,
                                  '工作日均价': wd, '周末均价': we, '周加权均价': w})

# ---------- 5. 输出 ----------

HDR_FILL = PatternFill('solid', fgColor='1E3A5F')
HDR_FONT = Font(color='FFFFFF', bold=True, size=11)
THIN = Side(style='thin', color='BFC9D4')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
CHEAP_FILL = PatternFill('solid', fgColor='D6F5D6')
MONEY = '#,##0.0000'


def write_sheet(ws, header, rows, widths, money_cols=(), pct_cols=(), highlight_col=None):
    ws.append(header)
    for c in range(1, len(header) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill, cell.font, cell.border = HDR_FILL, HDR_FONT, BORDER
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
    for r in rows:
        ws.append([r.get(h) for h in header])
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, max_col=len(header)):
        for cell in row:
            cell.border = BORDER
            if cell.column in money_cols:
                cell.number_format = MONEY
            elif cell.column in pct_cols:
                cell.number_format = '0.0%'
    if highlight_col:
        for row in ws.iter_rows(min_row=2, max_row=ws.max_row):
            cheap = row[header.index('最低价来源')].value if '最低价来源' in header else None
            if cheap and row[highlight_col - 1].value == cheap:
                for cell in row:
                    cell.fill = CHEAP_FILL
    ws.freeze_panes = 'A2'
    ws.auto_filter.ref = ws.dimensions


wb = Workbook()

ws1 = wb.active
ws1.title = '统一对比'
h1 = ['模型', '计费项', '时段', '百炼(你的折扣表)', 'AstraFlow', 'DeepSeek官方', '最低价来源', '最低价', '百炼官网公开价', '折扣表/公开价']
write_sheet(ws1, h1, compare, [24, 10, 8, 17, 13, 14, 14, 10, 15, 13],
            money_cols=(4, 5, 6, 8, 9), pct_cols=(10,), highlight_col=8)

ws2 = wb.create_sheet('折扣率')
h2 = ['模型', '计费项', '时段', '百炼折扣表价', '百炼官网公开价', '折扣率(折扣表/公开价)', 'AstraFlow', '说明']
rows2 = []
for c in compare:
    if c['折扣表/公开价'] == '':
        continue
    rows2.append({
        '模型': c['模型'], '计费项': c['计费项'], '时段': c['时段'],
        '百炼折扣表价': c['百炼(你的折扣表)'], '百炼官网公开价': c['百炼官网公开价'],
        '折扣率(折扣表/公开价)': c['折扣表/公开价'], 'AstraFlow': c['AstraFlow'],
        '说明': 'AstraFlow 价与百炼官网公开价一致' if c['AstraFlow'] == c['百炼官网公开价'] else '',
    })
write_sheet(ws2, h2, rows2, [24, 10, 8, 14, 15, 20, 13, 34],
            money_cols=(4, 5, 7), pct_cols=(6,))

ws3 = wb.create_sheet('明细')
h3 = ['厂商', '模型', '计费项', '时段', '单价', '原始计费项', '原始价', '计费单位']
write_sheet(ws3, h3, detail, [22, 26, 10, 8, 12, 30, 34, 18], money_cols=(5,))

ws4 = wb.create_sheet('时段加权')
h4 = ['模型', '计费项', '方案', '高峰/忙时价', '空闲/闲时价', '工作日均价', '周末均价', '周加权均价']
write_sheet(ws4, h4, weighted_rows, [22, 10, 20, 13, 13, 12, 12, 13],
            money_cols=(4, 5, 6, 7, 8))

ws5 = wb.create_sheet('说明')
notes = [
    ['项目', '说明'],
    ['数据来源', '百炼：discount_table_detail_1362889_20261119.xlsx（固定价格商品列表，元/千tokens）；AstraFlow：astraflow.ucloud.cn/modelverse/prices 快照（2026-11-19）；DeepSeek：api-docs.deepseek.com 官网价目表（2026-11-19）'],
    ['统一口径', '全部换算成「元 / 百万 tokens」。百炼表为元/千tokens，×1000 得元/百万 tokens。缓存项与输入项分开比较。'],
    ['模型映射', '百炼 deepseek-v4-pro-0813 = AstraFlow deepseek-v4-pro-0813 = DeepSeek 官方 deepseek-v4-pro；百炼 deepseek-v4.1-flash / deepseek-v4.1-flash-1017 = AstraFlow 同名 = DeepSeek 官方 deepseek-flash（DeepSeek-V4.1-Flash-1017）。'],
    ['时段口径（关键）', '百炼：忙时=北京时间 08:00-22:00，闲时=22:00-次日08:00（每天固定，周末节假日不例外）。DeepSeek 官方 / AstraFlow：高峰=工作日（不含法定节假日）09:00-12:00、14:00-18:00，其余时段含周末与节假日全天为闲时/谷时。两边「高峰」窗口并不等价。'],
    ['折扣表性质', '折扣商品的“折扣比例”为空，价格全部落在「固定价格商品」里，且低于百炼官网公开价，属于该账号（1362889）的协议/活动价，不是官网标价。'],
    ['缓存差异', '百炼折扣表的缓存读取价 = 输入价的 10%~25%（deepseek/kimi 10%、qwen 显式读 7.1%、glm 25%）；DeepSeek 官方缓存命中价 = 输入价的 2%~3.3%；AstraFlow 与 DeepSeek 官方一致。'],
    ['qwen3.8-max 缓存', '百炼表里 qwen3.8-max 有两种缓存命中口径：显式缓存命中 0.85 元/百万 tokens、隐式缓存命中 1.275 元/百万 tokens（对照表取隐式口径）；另有显式缓存创建 12.75 元/百万 tokens，AstraFlow 缓存写入 15 元/百万 tokens。'],
    ['时段加权算法', '按一天 24h 把峰谷时长折算成均价：官方/AstraFlow 忙时 6h、闲时 18h（工作日），周末全天闲时；百炼每天忙时 14h(08-22)、闲时 10h(22-08)，周末照算。周加权 = (5×工作日 + 2×周末)/7。'],
    ['未包含项', 'Batch 半价、免费额度、代金券、地域差异（如美国/新加坡加价）均未计入，按华北2(北京)/全球默认价比较。'],
]
for r in notes:
    ws5.append(r)
for c in range(1, 3):
    cell = ws5.cell(row=1, column=c)
    cell.fill, cell.font = HDR_FILL, HDR_FONT
ws5.column_dimensions['A'].width = 18
ws5.column_dimensions['B'].width = 120
for row in ws5.iter_rows(min_row=2, max_row=ws5.max_row):
    for cell in row:
        cell.alignment = Alignment(vertical='top', wrap_text=True)

wb.save(f'{BASE}/three_way_price_comparison.xlsx')

with open(f'{BASE}/three_way_price_comparison.csv', 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.DictWriter(f, fieldnames=h1)
    w.writeheader()
    w.writerows(compare)

print(f'明细 {len(detail)} 行；统一对比 {len(compare)} 行；折扣率 {len(rows2)} 行')
for r in compare:
    print(f"{r['模型']:22s} {r['计费项']:6s} {r['时段']:4s} 百炼={r['百炼(你的折扣表)']} AstraFlow={r['AstraFlow']} DeepSeek={r['DeepSeek官方']} 最低={r['最低价来源']}")
