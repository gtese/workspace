"""弱网重试验证：分段上传失败后保留音频，点「重试上传」继续，不需要重录。"""

from __future__ import annotations

import os
import sys

import httpx
from playwright.sync_api import sync_playwright

BASE = os.environ.get("FM_E2E_BASE", "http://127.0.0.1:8777")
UID = "e2e-retry"
HEADERS = {"X-Employee-Open-Id": UID}


def main() -> int:
    state = {"fail": True, "count": 0}
    args = [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--use-file-for-fake-audio-capture=/tmp/mic_10s.wav",
    ]
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="chrome", args=args)
        except Exception:
            browser = p.chromium.launch(args=args)
        ctx = browser.new_context(permissions=["microphone"], viewport={"width": 420, "height": 900})
        ctx.add_init_script(f"localStorage.setItem('fm_uid', '{UID}')")
        page = ctx.new_page()

        def handle(route):
            if state["fail"]:
                state["count"] += 1
                route.abort()
            else:
                route.continue_()

        page.route("**/api/v1/recordings/*/segments*", handle)
        page.goto(BASE, wait_until="domcontentloaded")
        page.fill("#title", "弱网重试")
        page.click("#btnStart")
        page.wait_for_timeout(3000)
        level = page.eval_on_selector("#levelBar", "el => el.style.width")
        page.click("#btnStop")
        page.wait_for_selector("#retryBox", state="visible", timeout=45000)
        print("level during recording:", level or "(0%)", "| failed uploads:", state["count"])

        state["fail"] = False
        page.unroute("**/api/v1/recordings/*/segments*")
        page.click("#btnRetryUpload")
        page.wait_for_selector("#result", state="visible", timeout=60000)
        text = page.inner_text("#result")
        browser.close()

    with httpx.Client(base_url=BASE, timeout=30, headers=HEADERS) as client:
        recs = client.get("/api/v1/recordings").json()
        rec = recs[0] if recs else None
        print("server:", rec and (rec["status"], rec["segment_count"]))

    ok = rec is not None and rec["status"] == "done" and rec["segment_count"] == 1 and "查看完整纪要" in text
    print("RETRY E2E:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
