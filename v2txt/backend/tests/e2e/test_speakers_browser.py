"""浏览器验证：说话人改名 + 全文搜索。"""

from __future__ import annotations

import os
import sys
import time

import httpx
from playwright.sync_api import sync_playwright

BASE = os.environ.get("FM_E2E_BASE", "http://127.0.0.1:8777")
UID = "e2e-spk"
HEADERS = {"X-Employee-Open-Id": UID}


def main() -> int:
    with httpx.Client(base_url=BASE, timeout=30, headers=HEADERS) as client:
        rid = client.post("/api/v1/recordings", json={"title": "改名与搜索", "scene": "meeting"}).json()["id"]
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

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="chrome")
        except Exception:
            browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 420, "height": 900})
        ctx.add_init_script(f"localStorage.setItem('fm_uid', '{UID}')")
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(BASE + f"/d/{rid}", wait_until="domcontentloaded")
        page.wait_for_selector(".speaker.editable", timeout=15000)
        page.on("dialog", lambda d: d.accept("王五"))
        page.click(".speaker.editable")
        page.wait_for_timeout(2500)
        text = page.inner_text("body")
        renamed = "王五" in text

        page.goto(BASE + "/mine", wait_until="domcontentloaded")
        page.fill("#q", "进展")
        page.wait_for_selector(".item .snippet", timeout=15000)
        hits_text = page.inner_text("#list")
        searched = "改名与搜索" in hits_text

        browser.close()

    print("renamed:", renamed, "| searched:", searched, "| errors:", errors[:3])
    ok = renamed and searched and not errors
    print("SPEAKER/SEARCH E2E:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
