"""厂商接口连通性冒烟：用假凭据验证请求结构能被对方接收（不产生真实调用/费用）。

用法（backend 目录）：
  ../.venv/bin/python scripts/vendor_smoke.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.asr.tencent import build_request  # noqa: E402

FEISHU = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
TENCENT = "https://asr.tencentcloudapi.com"


def feishu() -> bool:
    try:
        r = httpx.post(
            FEISHU,
            json={"app_id": "cli_dummy0000000000", "app_secret": "dummy"},
            timeout=15,
        )
        data = r.json()
        code = data.get("code")
        print(f"飞书: HTTP {r.status_code} code={code} msg={data.get('msg')}")
        # 10014 = app not found / 10003 = invalid param，都说明请求被正确解析
        return r.status_code == 200 and code in (10014, 10003, 10015, 10002)
    except Exception as exc:  # noqa: BLE001
        print(f"飞书: 连接失败 {exc}")
        return False


def tencent() -> bool:
    try:
        headers, body = build_request(
            "CreateRecTask",
            {
                "EngineModelType": "16k_zh_en_meeting",
                "ChannelNum": 1,
                "ResTextFormat": 0,
                "SourceType": 0,
                "Url": "https://example.com/a.wav",
            },
            "AKIDdummy0000000000",
            "dummysecret",
            "ap-guangzhou",
        )
        r = httpx.post(TENCENT, headers=headers, content=body, timeout=15)
        data = r.json()
        err = data.get("Response", {}).get("Error", {})
        print(f"腾讯: HTTP {r.status_code} Error.Code={err.get('Code')} Message={err.get('Message')}")
        # AuthFailure.* 表示签名结构被解析、只是凭据不对
        return r.status_code == 200 and str(err.get("Code", "")).startswith("AuthFailure")
    except Exception as exc:  # noqa: BLE001
        print(f"腾讯: 连接失败 {exc}")
        return False


if __name__ == "__main__":
    f = feishu()
    t = tencent()
    print(json.dumps({"feishu_reachable": f, "tencent_reachable": t}, ensure_ascii=False))
    sys.exit(0 if (f and t) else 1)
