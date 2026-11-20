"""上线前体检：一条命令告诉你还差什么。

用法（backend 目录）：
  ../.venv/bin/python scripts/doctor.py
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import audio  # noqa: E402
from app.config import get_settings  # noqa: E402

MM = Path.home() / ".mm"
OK, WARN, BAD = "✅", "⚠️ ", "❌"
problems: list[str] = []
warnings: list[str] = []


def check(cond: bool, ok_msg: str, bad_msg: str, fix: str = "") -> bool:
    if cond:
        print(f"{OK} {ok_msg}")
        return True
    print(f"{BAD} {bad_msg}")
    problems.append(f"{bad_msg} {fix}".strip())
    return False


def warn(cond: bool, ok_msg: str, warn_msg: str) -> None:
    if cond:
        print(f"{OK} {ok_msg}")
    else:
        print(f"{WARN}{warn_msg}")
        warnings.append(warn_msg)


def secret_file(name: str) -> Path:
    return MM / name


def main() -> int:
    s = get_settings()
    print(f"== 运行时 ({s.app_name}) ==")
    print(f"  数据目录: {s.data_dir}")
    print(f"  公开地址: {s.public_base_url}")

    check(
        (s.data_dir).exists() and os.access(s.data_dir, os.W_OK),
        "数据目录可写",
        "数据目录不可写",
        f"检查权限: {s.data_dir}",
    )
    free_gb = shutil.disk_usage(s.data_dir).free // (1024**3) if s.data_dir.exists() else 0
    warn(free_gb >= 20, f"磁盘剩余 {free_gb} GB", f"磁盘剩余仅 {free_gb} GB（建议 ≥20GB）")

    check(audio.ffmpeg_path() is not None, "ffmpeg 可用", "找不到 ffmpeg（非 wav 上传无法转码）", "装系统 ffmpeg 或 pip install imageio-ffmpeg")

    from app.db import engine

    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("SELECT 1")
        print(f"{OK} 数据库连接正常（{'sqlite' if s.is_sqlite else 'postgres'}）")
    except Exception as exc:  # noqa: BLE001
        print(f"{BAD} 数据库连接失败: {exc}")
        problems.append(f"数据库不可用: {exc}")

    warn(
        s.secret_key != "dev-only-change-me",
        "SECRET_KEY 已自定义",
        "SECRET_KEY 仍是默认值（上线前必须改，否则链接/会话可被伪造）",
    )

    print("\n== 飞书 ==")
    warn(MM.exists(), "~/.mm 存在", "~/.mm 不存在（mock 模式可忽略）")
    fs = secret_file("feishu-minutes")
    if fs.exists():
        mode = oct(fs.stat().st_mode & 0o777)
        warn(mode == "0o600", "飞书凭据文件权限 0600", f"凭据文件权限 {mode}（应为 0600）")
    if s.feishu_mode == "real":
        check(bool(s.feishu_app_id and s.feishu_app_secret), "飞书 App ID/Secret 已配置",
              "FEISHU_MODE=real 但缺少 App ID/Secret", "写入 ~/.mm/feishu-minutes")
    else:
        print(f"{WARN}FEISHU_MODE=mock：不会真的免登/发卡片")

    print("\n== 转写与纪要 ==")
    if s.asr_provider == "tencent":
        check(bool(s.tencent_secret_id and s.tencent_secret_key), "腾讯云 ASR 凭据已配置",
              "ASR_PROVIDER=tencent 但缺少密钥", "~/.mm/tencent-asr: TENCENT_SECRET_ID/KEY")
    else:
        print(f"{WARN}ASR_PROVIDER=mock：转写内容是假数据")
    if s.llm_provider == "deepseek":
        check(bool(s.deepseek_api_key), "DeepSeek Key 已配置",
              "LLM_PROVIDER=deepseek 但缺少 Key", "~/.mm/deepseek: DEEPSEEK_API_KEY")
    else:
        print(f"{WARN}LLM_PROVIDER=mock：纪要是假数据")

    print("\n== 分发 ==")
    warn(bool(s.website_callback_url), "网站回调已配置", "未配置网站回调（不会推给公司网站）")
    warn(bool(s.smtp_host) or s.email_mode != "real", "邮件已配置/未启用", "EMAIL_MODE=real 但缺 SMTP")
    warn(s.public_base_url.startswith("https://"), "公开地址是 HTTPS", "公开地址不是 HTTPS（手机录音会失败）")

    print("\n== 结论 ==")
    if problems:
        print(f"{BAD} {len(problems)} 个必须修复：")
        for p in problems:
            print("   -", p)
        return 1
    if warnings:
        print(f"{WARN}{len(warnings)} 项提醒（mock 模式下正常）：")
        for w in warnings:
            print("   -", w)
    print("可以继续。真实上线前请逐项完成 docs/07-上线验收清单.md。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
