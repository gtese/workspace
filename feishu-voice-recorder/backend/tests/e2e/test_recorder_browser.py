"""浏览器真录音 E2E：用 Chromium 假麦克风验证 H5 录音→上传→出纪要。

前置：
  PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers python -m playwright install chromium
  # 服务需在跑，且能访问 BASE
运行：
  PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers python tests/e2e/test_recorder_browser.py
"""

from __future__ import annotations

import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("FM_E2E_BASE", "http://127.0.0.1:8777")
MIC = os.environ.get("FM_E2E_MIC", "/tmp/mic_10s.wav")


def main() -> int:
    args = [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-audio-capture={MIC}",
        "--autoplay-policy=no-user-gesture-required",
    ]
    with sync_playwright() as p:
        try:  # 优先用系统 Chrome（本机已装），否则用 Playwright 自带 Chromium
            browser = p.chromium.launch(channel="chrome", args=args)
        except Exception:
            browser = p.chromium.launch(args=args)
        context = browser.new_context(permissions=["microphone"], viewport={"width": 420, "height": 900})
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)

        page.goto(BASE, wait_until="domcontentloaded")
        page.fill("#title", "浏览器 e2e 验证")
        page.click("#btnStart")
        page.wait_for_timeout(6000)  # 录 6 秒
        timer = page.inner_text("#timer")
        page.click("#btnStop")
        page.wait_for_selector("#result", state="visible", timeout=60000)

        result = page.inner_text("#result")
        status_log = page.inner_text("#status")
        print("timer:", timer)
        print("status log:\n" + status_log)
        print("result:", result[:400])
        if errors:
            print("browser errors:", errors[:5])
        browser.close()

        ok = "查看完整纪要" in result and "已上传" in status_log
        print("E2E:", "PASS" if ok else "FAIL")
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
