"""生成演示数据（虚构内容，仅用于截图/演示，不含任何真实会议信息）。

用法（backend 目录）：
  ../.venv/bin/python scripts/seed_demo.py
"""

from __future__ import annotations

import json
import math
import struct
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.models import STATUS_DONE, Recording, Segment  # noqa: E402

DEMO = [
    {
        "title": "客户 A 需求沟通",
        "scene": "client",
        "duration": 1560,
        "transcript": [
            (0, 42, "发言人1", "王总，这次主要想确认一下你们对数据看板这块的需求边界。"),
            (42, 108, "发言人2", "我们最核心的是三点：第一，要看得到每个门店的实时销售；第二，要能按区域对比；第三，月底要给总部导一份汇总。"),
            (108, 190, "发言人1", "明白。实时销售这块，数据源是你们的 POS 系统吗？大概多少家门店？"),
            (190, 260, "发言人2", "对，POS 直连。现在 87 家，年底可能到 120 家。"),
            (260, 352, "发言人1", "那我们按 120 家做容量设计。区域对比和汇总导出都可以做，汇总模板你们有现成的吗？"),
            (352, 430, "发言人2", "有，我让运营下周发你们一份 Excel。另外预算这块，我们希望分两期付。"),
            (430, 510, "发言人1", "分期可以谈，我们内部需要走一下审批。下周三之前给你答复。"),
            (510, 560, "发言人2", "好，那下周三我们线上碰一次，把技术方案和报价一起过。"),
        ],
        "summary": {
            "summary": "客户 A 希望建设门店数据看板，核心诉求是实时销售、区域对比和月度汇总导出。当前 87 家门店、年底预计 120 家，数据源为 POS 直连。双方约定下周三前给出分期付款方案，并线上评审技术方案与报价。",
            "key_points": [
                "核心需求三点：实时销售、区域对比、月度汇总导出",
                "数据源为 POS 直连，当前 87 家门店，年底预计 120 家",
                "汇总模板由客户运营下周提供 Excel",
                "付款希望分两期，需我方内部审批",
            ],
            "decisions": ["按 120 家门店做容量设计", "下周三线上评审技术方案与报价"],
            "todos": [
                {"owner": "我方", "item": "给出分期付款方案并走审批", "due": "下周三前"},
                {"owner": "客户运营", "item": "发送月度汇总 Excel 模板", "due": "下周"},
                {"owner": "我方", "item": "准备技术方案与报价", "due": "下周三"},
            ],
            "risks": ["分期付款需内部审批，存在延期风险"],
        },
    },
    {
        "title": "周会：Q4 交付节奏",
        "scene": "meeting",
        "duration": 2700,
        "transcript": [
            (0, 50, "发言人1", "先过一下三个项目的进度，重点是月底能不能按时交付。"),
            (50, 140, "发言人2", "项目一没问题，测试已经过了八成；项目二卡在供应商的接口上，他们承诺周五给。"),
            (140, 220, "发言人3", "项目二如果周五拿不到接口，我们周末就得加班。要不要先把非依赖的部分上线？"),
            (220, 300, "发言人1", "可以，拆成两批，先上不依赖供应商的部分。周五前给我一份拆分清单。"),
            (300, 380, "发言人2", "另外项目三的预算财务还没批，采购流程可能要走两周。"),
            (380, 460, "发言人3", "那项目三的启动时间就往后挪，先做方案设计。"),
        ],
        "summary": {
            "summary": "本周会重点核对 Q4 三个项目的交付节奏。项目一按计划推进；项目二受供应商接口影响，决定拆两批上线，先交付非依赖部分；项目三因预算审批和采购流程延后启动，先做方案设计。",
            "key_points": [
                "项目一测试进度约 80%，可按期交付",
                "项目二依赖供应商接口，改为分两批上线",
                "项目三预算未批，采购流程约需两周",
            ],
            "decisions": [
                "项目二拆分为两批，先上线非依赖供应商的部分",
                "项目三延期启动，先完成方案设计",
            ],
            "todos": [
                {"owner": "发言人2", "item": "周五前产出拆分清单", "due": "周五"},
                {"owner": "发言人2", "item": "跟进供应商接口交付", "due": "周五"},
                {"owner": "发言人3", "item": "推进项目三预算与采购审批", "due": "两周内"},
            ],
            "risks": ["项目二若周五拿不到接口，需要周末加班", "项目三预算审批可能拖到月底之后"],
        },
    },
]


def _write_tone(path: Path, seconds: int = 30, rate: int = 16000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = rate * seconds
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = b"".join(
            struct.pack("<h", int(2000 * math.sin(2 * math.pi * 220 * i / rate))) for i in range(n)
        )
        w.writeframes(frames)


def main() -> None:
    init_db()
    db = SessionLocal()
    try:
        if "--reset" in sys.argv:
            for rec in db.query(Recording).filter(Recording.owner_open_id == "demo").all():
                db.delete(rec)
            db.commit()
            print("已清空 demo 数据")
        for item in DEMO:
            exists = db.query(Recording).filter(Recording.title == item["title"]).first()
            if exists:
                print(f"跳过已存在：{item['title']} ({exists.id})")
                continue
            rec = Recording(
                owner_open_id="demo",
                title=item["title"],
                scene=item["scene"],
                status=STATUS_DONE,
                duration_sec=item["duration"],
                transcript_json=json.dumps(
                    {
                        "language": "zh",
                        "provider": "demo",
                        "segments": [
                            {"start": s, "end": e, "speaker": sp, "text": t}
                            for (s, e, sp, t) in item["transcript"]
                        ],
                    },
                    ensure_ascii=False,
                ),
                summary_json=json.dumps(item["summary"], ensure_ascii=False),
            )
            db.add(rec)
            db.commit()
            db.refresh(rec)
            base = get_settings().data_dir / "recordings" / rec.id
            _write_tone(base / "merged.wav")
            seg = base / "seg_000.wav"
            if not seg.exists():
                seg.write_bytes((base / "merged.wav").read_bytes())
            db.add(
                Segment(
                    recording_id=rec.id,
                    idx=0,
                    path=str(seg),
                    size=seg.stat().st_size,
                    duration_sec=30,
                )
            )
            db.commit()
            print(f"已创建：{item['title']} ({rec.id})")
    finally:
        db.close()


if __name__ == "__main__":
    main()
