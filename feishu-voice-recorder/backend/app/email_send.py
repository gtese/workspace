"""邮件分发：SMTP（real）或落盘（mock）。

凭据放 ~/.mm/smtp（SMTP_HOST/PORT/USER/PASSWORD/SENDER），或环境变量 FM_SMTP_*。
"""

from __future__ import annotations

import json
import logging
import smtplib
import time
from email.header import Header
from email.message import EmailMessage

from .config import get_settings

log = logging.getLogger(__name__)


def build_minutes_email(title: str, summary: dict, detail_url: str) -> tuple[str, str]:
    subject = f"纪要：{title}"

    def li(items: list[str]) -> str:
        return "".join(f"<li>{x}</li>" for x in items)

    points = li(summary.get("key_points") or [])
    decisions = li(summary.get("decisions") or [])
    todos = li(
        [
            f"{t.get('owner') + ' ' if t.get('owner') else ''}{t.get('item')}"
            f"{'（' + t.get('due') + '）' if t.get('due') else ''}"
            for t in (summary.get("todos") or [])
        ]
    )
    html = f"""<!doctype html><html><body style="font-family:-apple-system,'PingFang SC',sans-serif;line-height:1.6;color:#222">
<h2>{title}</h2>
<p>{summary.get('summary', '')}</p>
{('<h3>要点</h3><ul>' + points + '</ul>') if points else ''}
{('<h3>结论</h3><ul>' + decisions + '</ul>') if decisions else ''}
{('<h3>待办</h3><ul>' + todos + '</ul>') if todos else ''}
<p><a href="{detail_url}">查看完整纪要 / 播放录音</a></p>
<hr><p style="color:#888;font-size:12px">来自飞书「纪要录音」</p>
</body></html>"""
    return subject, html


class EmailSender:
    def __init__(self) -> None:
        self.settings = get_settings()

    def send(self, to: str, subject: str, html: str) -> dict:
        s = self.settings
        if s.email_mode != "real" or not s.smtp_host:
            outbox = s.data_dir / "outbox"
            outbox.mkdir(parents=True, exist_ok=True)
            path = outbox / f"email-{int(time.time() * 1000)}.json"
            path.write_text(
                json.dumps({"to": to, "subject": subject, "html": html}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            log.info("邮件 mock 已写入 %s", path)
            return {"mode": "mock", "path": str(path)}

        msg = EmailMessage()
        msg["From"] = s.smtp_sender or s.smtp_user
        msg["To"] = to
        msg["Subject"] = Header(subject, "utf-8")
        msg.set_content(html, subtype="html")

        if s.smtp_port == 465:
            server: smtplib.SMTP = smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, timeout=20)
        else:
            server = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20)
            server.starttls()
        try:
            if s.smtp_user:
                server.login(s.smtp_user, s.smtp_password)
            server.send_message(msg)
        finally:
            server.quit()
        return {"mode": "real", "to": to}
