"""历史录音瘦身：把 merged.wav 转成 merged.m4a，并删除分段 WAV。

只处理数据库中状态为 done 的录音；转码失败保留原文件。

用法：../.venv/bin/python scripts/compact_storage.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import audio, storage  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import STATUS_DONE, Recording  # noqa: E402


def main() -> int:
    db = SessionLocal()
    converted = freed = 0
    try:
        for rec in db.query(Recording).filter(Recording.status == STATUS_DONE).all():
            wav = storage.merged_path(rec.id)
            m4a = storage.merged_m4a_path(rec.id)
            if not wav.exists():
                continue
            try:
                if not m4a.exists():
                    audio.convert_to_m4a(wav, m4a)
                before = wav.stat().st_size
                wav.unlink()
                for seg in rec.segments:
                    p = Path(seg.path)
                    if p.exists():
                        before += p.stat().st_size
                        p.unlink()
                freed += before - (m4a.stat().st_size if m4a.exists() else 0)
                converted += 1
                print(f"压缩 {rec.id}: 释放 {before // 1048576}MB")
            except Exception as exc:  # noqa: BLE001
                print(f"跳过 {rec.id}: {exc}")
    finally:
        db.close()
    print(f"完成: {converted} 条，共释放约 {freed // 1048576}MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
