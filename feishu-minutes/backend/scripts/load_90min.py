"""90 分钟场景压测：45 段 × 2 分钟，走真实上传接口与 worker。

用法（backend 目录，服务已在跑）：
  ../.venv/bin/python scripts/load_90min.py --minutes 90
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import time
import wave
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

HEADERS = {"X-Employee-Open-Id": "loadtest"}


def make_silence(path: Path, seconds: int, rate: int = 16000) -> None:
    n = rate * seconds
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * n)


def clean(recording_id: str) -> None:
    from app.db import SessionLocal
    from app.models import Recording
    from app.storage import recording_dir

    shutil.rmtree(recording_dir(recording_id), ignore_errors=True)
    db = SessionLocal()
    try:
        rec = db.get(Recording, recording_id)
        if rec:
            db.delete(rec)
            db.commit()
    finally:
        db.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=int, default=90)
    ap.add_argument("--segment-seconds", type=int, default=120)
    ap.add_argument("--base", default="http://127.0.0.1:8777")
    ap.add_argument("--clean", action="store_true", help="跑完删除录音与文件")
    args = ap.parse_args()

    seg_seconds = args.segment_seconds
    count = max(1, round(args.minutes * 60 / seg_seconds))
    tmp = Path(tempfile.mkdtemp(prefix="fm-load-"))
    print(f"生成 {count} 段 × {seg_seconds}s 静音音频 …")
    t0 = time.time()
    segs = []
    for i in range(count):
        p = tmp / f"seg_{i:03d}.wav"
        make_silence(p, seg_seconds)
        segs.append(p)
    gen = time.time() - t0

    with httpx.Client(base_url=args.base, timeout=120, headers=HEADERS) as client:
        rid = client.post("/api/v1/recordings", json={"title": f"压测 {args.minutes} 分钟", "scene": "meeting"}).json()["id"]
        up0 = time.time()
        for i, p in enumerate(segs):
            with p.open("rb") as fh:
                r = client.post(
                    f"/api/v1/recordings/{rid}/segments?idx={i}",
                    files={"file": (p.name, fh, "audio/wav")},
                )
            if r.status_code != 200:
                print("上传失败", i, r.status_code, r.text[:200])
                return 1
            if (i + 1) % 10 == 0:
                print(f"  已上传 {i + 1}/{count}")
        upload = time.time() - up0
        client.post(f"/api/v1/recordings/{rid}/finish")

        poll0 = time.time()
        status = "queued"
        while time.time() - poll0 < 900:
            rec = client.get(f"/api/v1/recordings/{rid}").json()
            status = rec["status"]
            if status in ("done", "failed"):
                break
            time.sleep(2)
        process = time.time() - poll0

    print(f"录音 {rid}")
    print(f"生成 {gen:.1f}s | 上传 {upload:.1f}s | 处理 {process:.1f}s | 状态 {status}")
    if status != "done":
        return 1
    print(f"时长 {rec['duration_sec']}s / 分段 {rec['segment_count']} | 端到端 {gen + upload + process:.1f}s")
    if args.clean:
        clean(rid)
        print("已清理")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
