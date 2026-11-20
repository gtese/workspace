"""断点续录取证：已有 1 段录音，刷新后继续录，最终合并为 2 段。

前置：服务在跑；PLAYWRIGHT 有 Chrome。
"""

from __future__ import annotations

import os
import subprocess
import sys

import httpx
from playwright.sync_api import sync_playwright

BASE = os.environ.get("FM_E2E_BASE", "http://127.0.0.1:8777")
MIC = os.environ.get("FM_E2E_MIC", "/tmp/mic_10s.wav")
HEADERS = {"X-Employee-Open-Id": "e2e-resume"}


def main() -> int:
    with httpx.Client(base_url=BASE, timeout=30, headers=HEADERS) as client:
        rid = client.post("/api/v1/recordings", json={"title": "续录测试", "scene": "meeting"}).json()["id"]
        with open("/tmp/fm_seg0.wav", "rb") as fh:
            r = client.post(
                f"/api/v1/recordings/{rid}/segments?idx=0",
                files={"file": ("seg0.wav", fh, "audio/wav")},
            )
        assert r.status_code == 200, r.text
        before = client.get(f"/api/v1/recordings/{rid}").json()
        print("before: status", before["status"], "segs", before["segment_count"], "next", before["next_segment_index"])

    args = [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-audio-capture={MIC}",
    ]
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="chrome", args=args)
        except Exception:
            browser = p.chromium.launch(args=args)
        ctx = browser.new_context(permissions=["microphone"], viewport={"width": 420, "height": 900})
        ctx.add_init_script(f"localStorage.setItem('fm_rid', '{rid}'); localStorage.setItem('fm_uid', 'e2e-resume');")
        page = ctx.new_page()
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_selector("#resume", state="visible", timeout=15000)
        print("resume banner:", page.inner_text("#resume").replace("\n", " | "))
        page.click("#btnResume")
        page.wait_for_timeout(4000)
        page.click("#btnStop")
        page.wait_for_selector("#result", state="visible", timeout=60000)
        print("result:", page.inner_text("#result")[:120].replace("\n", " | "))
        browser.close()

    with httpx.Client(base_url=BASE, timeout=30, headers=HEADERS) as client:
        after = client.get(f"/api/v1/recordings/{rid}").json()
        print("after: status", after["status"], "segs", after["segment_count"])

    ok = after["status"] == "done" and after["segment_count"] == 2
    print("RESUME E2E:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
