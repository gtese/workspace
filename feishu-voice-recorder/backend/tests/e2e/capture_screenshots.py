"""用 Playwright 截取产品截图，输出到 docs/screenshots/。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx
from playwright.sync_api import sync_playwright

BASE = os.environ.get("FM_E2E_BASE", "http://127.0.0.1:8777")
OUT = Path(os.environ.get("FM_SHOT_DIR", Path(__file__).resolve().parents[3] / "docs" / "screenshots"))
HEADERS = {"X-Employee-Open-Id": "demo"}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    with httpx.Client(base_url=BASE, timeout=30, headers=HEADERS) as client:
        recs = client.get("/api/v1/recordings").json()
    client_rec = next((r for r in recs if "客户" in r["title"]), recs[0] if recs else None)
    if not client_rec:
        print("没有可截图的数据，先跑 scripts/seed_demo.py")
        return 1

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="chrome")
        except Exception:
            browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": 430, "height": 932}, device_scale_factor=2
        )
        ctx.add_init_script("localStorage.setItem('fm_uid', 'demo')")
        page = ctx.new_page()
        page.on("pageerror", lambda e: print("pageerror:", e))

        page.goto(BASE + "/", wait_until="domcontentloaded")
        page.wait_for_timeout(600)
        page.screenshot(path=str(OUT / "01-recorder.png"), full_page=True)

        page.goto(BASE + f"/d/{client_rec['id']}", wait_until="domcontentloaded")
        page.wait_for_selector("text=摘要", timeout=15000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / "02-detail.png"), full_page=True)

        page.goto(BASE + f"/preview/card/{client_rec['id']}", wait_until="domcontentloaded")
        page.wait_for_selector("text=纪要完成", timeout=15000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / "03-feishu-card.png"), full_page=True)

        page.goto(BASE + "/mine", wait_until="domcontentloaded")
        page.wait_for_selector(".item", timeout=15000)
        page.wait_for_timeout(400)
        page.screenshot(path=str(OUT / "04-mine.png"), full_page=True)

        browser.close()
    print("已输出到", OUT)
    for f in sorted(OUT.glob("*.png")):
        print(" -", f.name, f.stat().st_size // 1024, "KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
