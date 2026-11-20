"""分享链接浏览器验证：匿名打开 /s/<id> 能看到纪要与播放器。"""

from __future__ import annotations

import os
import sys
import time

import httpx
from playwright.sync_api import sync_playwright

BASE = os.environ.get("FM_E2E_BASE", "http://127.0.0.1:8777")
HEADERS = {"X-Employee-Open-Id": "e2e-share"}


def main() -> int:
    with httpx.Client(base_url=BASE, timeout=30, headers=HEADERS) as client:
        rid = client.post("/api/v1/recordings", json={"title": "分享 e2e", "scene": "client"}).json()["id"]
        with open("/tmp/fm_seg0.wav", "rb") as fh:
            client.post(
                f"/api/v1/recordings/{rid}/segments?idx=0",
                files={"file": ("a.wav", fh, "audio/wav")},
            )
        client.post(f"/api/v1/recordings/{rid}/finish")
        for _ in range(20):
            rec = client.get(f"/api/v1/recordings/{rid}").json()
            if rec["status"] in ("done", "failed"):
                break
            time.sleep(1)
        assert rec["status"] == "done", rec
        url = client.get(f"/api/v1/recordings/{rid}/share").json()["url"]

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="chrome")
        except Exception:
            browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 420, "height": 900})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_selector("text=摘要", timeout=15000)
        text = page.inner_text("body")
        has_audio = page.locator("audio").count() > 0
        browser.close()

    print("share page text:", text[:120].replace("\n", " | "))
    print("has audio player:", has_audio, "| errors:", errors[:3])
    ok = "分享 e2e" in text and "摘要" in text and has_audio and not errors
    print("SHARE E2E:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
