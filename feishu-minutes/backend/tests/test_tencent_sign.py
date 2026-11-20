import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.asr.tencent import build_request  # noqa: E402


def test_tc3_request_shape() -> None:
    headers, body = build_request(
        "CreateRecTask",
        {"EngineModelType": "16k_zh_en_meeting", "ChannelNum": 1, "Url": "https://x/a.wav"},
        "AKIDEXAMPLE",
        "SECRETEXAMPLE",
        "ap-guangzhou",
    )
    payload = json.loads(body)
    assert "Action" not in payload  # Action 只放请求头
    assert payload["EngineModelType"] == "16k_zh_en_meeting"

    assert headers["X-TC-Action"] == "CreateRecTask"
    assert headers["X-TC-Region"] == "ap-guangzhou"
    assert headers["Content-Type"] == "application/json; charset=utf-8"
    auth = headers["Authorization"]
    assert auth.startswith("TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/")
    assert "/asr/tc3_request" in auth
    assert "SignedHeaders=content-type;host" in auth
    assert len(auth.rsplit("Signature=", 1)[1]) == 64


def test_tc3_signature_deterministic_for_same_inputs(monkeypatch) -> None:
    # 固定时间戳，保证签名可复现（验证签名只依赖输入）
    monkeypatch.setattr("app.asr.tencent.time.time", lambda: 1700000000)
    h1, b1 = build_request("DescribeTaskStatus", {"TaskId": 1}, "AK", "SK", "ap-guangzhou")
    h2, b2 = build_request("DescribeTaskStatus", {"TaskId": 1}, "AK", "SK", "ap-guangzhou")
    assert h1["Authorization"] == h2["Authorization"]
    assert b1 == b2
