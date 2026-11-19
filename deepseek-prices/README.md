# DeepSeek 官方价目表快照

数据来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>（页面「复制 Markdown」对应的 `/zh-cn/quick_start/pricing.md`）。

## 文件

| 文件 | 说明 |
| --- | --- |
| `deepseek_prices_2026-11-19.csv` | 交付文件。价目表长表：模型 Token 价格 + Search/Fetch + 文件解析/OCR + 语音，共 17 行 |
| `deepseek_models_2026-11-19.csv` | 模型细节宽表（版本、上下文、输出长度、功能支持、并发限制），每模型一行 |
| `raw_pricing_2026-11-19.md` | 页面原始 Markdown（抓取时间点存档，便于复核） |
| `fetch_deepseek_prices.py` | 抓取 + 解析脚本，关键字段带断言，页面改版会直接报错 |

## 抓取时间

2026-11-19（Asia/Shanghai）。

## 价格 CSV 列

`分类, 模型/项目, 计费项, 时段, 价格(元), 折扣价(元), 计费单位, 备注`

- `计费单位` 为 `百万 tokens` 的行是模型 Token 价格，配合 `时段` 看：`空闲时段` / `高峰时段`。
- 其余行（Search/Fetch、文件解析/OCR、语音）没有时段，`计费单位` 分别是每 1,000 次成功请求、每 1,000 页、每 10,000 字符 / 每小时音频。
- 语音两项有 `限时折扣价（5 折）`，放在 `折扣价(元)` 列。

## 当前价目（2026-11-19）

**模型 Token 价格（元 / 百万 tokens）**

| 计费项 | deepseek-flash 空闲 | deepseek-flash 高峰 | deepseek-v4-pro 空闲 | deepseek-v4-pro 高峰 |
| --- | --- | --- | --- | --- |
| 输入（缓存命中） | 0.02 | 0.04 | 0.15 | 0.30 |
| 输入（缓存未命中） | 1 | 2 | 4.5 | 9.0 |
| 输出 | 4 | 8 | 13.5 | 27.0 |

- 空闲时段价为高峰时段价的一半；高峰时段 = 北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00，其余时段（含周末、法定节假日全天）为空闲时段。
- 模型版本：`deepseek-flash` → DeepSeek-V4.1-Flash-1017；`deepseek-v4-pro` → DeepSeek-V4-Pro-0813。
- 旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，按 Flash 价格计费。

**其它**

| 项目 | 计费单位 | 价格 |
| --- | --- | --- |
| Search API（文字） | 每 1,000 次成功请求 | 5 元 |
| Fetch API | 每 1,000 次成功请求 | 5 元 |
| 文件解析、OCR API | 每 1,000 页 | 1.5 元 |
| 语音合成（TTS） | 每 10,000 字符 | 3 元（限时 1.5 元） |
| 语音识别（ASR） | 每小时音频 | 0.78 元（限时 0.39 元） |

补充：自北京时间 2026-11-18 12:00 起，模型调用触发的服务端搜索/网页抓取，工具调用本身不再单独计费，结果拼进上下文按 Token 计费（Search/Fetch API 直接按次调用仍按上表计费）。

## 刷新

```bash
python3 fetch_deepseek_prices.py --date 2026-11-19
```

注意：价格随时可能调整，本快照只代表抓取时刻；以官网页面为准。
