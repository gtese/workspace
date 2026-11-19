# AstraFlow（UCloud ModelVerse）模型价格快照

数据来源：<https://astraflow.ucloud.cn/modelverse/prices>（模型广场 → 模型 ID / 计费单元 / 说明 / 标价(元) / 单位）。

## 文件

| 文件 | 说明 |
| --- | --- |
| `astraflow_model_prices_2026-11-19.csv` | 交付文件。一行 = 一个模型的一个计费项单价（289 个模型，1786 行） |
| `raw_prices_2026-11-19.json` | 接口原始返回（`GetUFSquareModelPrices`），保留档位/币种/英文文案等完整字段 |
| `fetch_prices.mjs` | 抓取脚本：在已登录页面的上下文里调用接口，分页拉全量 |
| `build_csv.py` | 把原始 JSON 展平成 CSV |

## 抓取时间

2026-11-19 16:05（Asia/Shanghai），共 289 个模型 / 32 个厂商。

## CSV 列

`模型ID, 模型ID(Id字段), 厂商, 计费单元, 说明, 标价(元), 单位, 档位条件, 计费项, 币种, PricingSkuId, 说明(英文), 单位(英文)`

- 页面上的 5 列对应 `模型ID / 计费单元 / 说明 / 标价(元) / 单位`，其余为原始接口的补充字段。
- `档位条件`：同一个计费单元的阶梯/规格条件（如视频分辨率、输入长度区间），页面上的多行即来自档位展开。
- 价格单位：`标价(元)` 为人民币列表价，配合 `单位` 使用（`百万 Token`、`秒`、`次`、`张`、`分`、`字符`、`页`、`小时`、`百万像素`）。
- 56 行价格为 0（26 个模型，多为 Embedding/Reranker 或限免/随资源计费模型），原样保留，未做剔除。
- 文件为 UTF-8 with BOM，Excel 直接双击不乱码。

## 为什么需要登录

价格页数据来自 `https://api.ucloud.cn/?Action=GetUFSquareModelPrices`：

- 匿名请求返回 `RetCode 170 / Missing signature`；有会话但缺 CSRF 头时返回 `RetCode 296 / Missing csrf token`；
- 公开接口 `ListUFSquareModelGuest` 只给模型元信息，`Pricing` 全为 0、`Prices/Tiers` 为 null。

所以只能用**已登录的浏览器会话**发起请求：CSRF 头取自控制台下发的 `U_CSRF_TOKEN` cookie。

## 刷新步骤

1. 用一个独立的 Chrome profile 打开价格页并登录（窗口会显示在你屏幕上）：

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --no-sandbox --disable-gpu --remote-debugging-port=9333 \
     --user-data-dir=/tmp/mvlogin \
     https://astraflow.ucloud.cn/modelverse/prices
   ```

   （macOS 沙箱环境下必须加 `--no-sandbox`，否则 GPU/沙箱初始化直接崩溃。）

2. 抓 JSON（`ProjectId` 换成自己的组织 ID，可在价格页任一 `api.ucloud.cn` 请求体里看到）：

   ```bash
   node fetch_prices.mjs --port 9333 --project org-xxxx --out raw_prices.json
   ```

3. 生成 CSV：

   ```bash
   python3 build_csv.py raw_prices.json astraflow_model_prices.csv
   ```

## 注意

- 价格随时会变，本快照仅代表抓取时刻的列表价；实际账单还会受活动价、代金券、批量推理半价等因素影响。
- 登录态 cookie 不落盘、不进仓库；脚本只从运行中的浏览器读 `document.cookie` 里的 CSRF token。
