"""邮件发送：本地 Postfix 或阿里云邮件推送 SMTP 都可，mock 模式只落日志。"""

from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage
from email.utils import formataddr

from .config import get_settings

log = logging.getLogger(__name__)


def send_mail(to: str, subject: str, text_body: str, html_body: str = "") -> bool:
    settings = get_settings()
    if settings.email_mode != "real":
        log.info("[mail:mock] to=%s subject=%s\n%s", to, subject, text_body)
        return True
    if not settings.smtp_host or not settings.smtp_sender:
        log.warning("邮件未配置 smtp_host/smtp_sender，跳过发送 to=%s", to)
        return False

    msg = EmailMessage()
    msg["From"] = formataddr((settings.smtp_sender_name, settings.smtp_sender))
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text_body)
    if html_body:
        msg.add_alternative(html_body, subtype="html")

    try:
        if settings.smtp_use_ssl:
            with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=20) as s:
                if settings.smtp_user:
                    s.login(settings.smtp_user, settings.smtp_password)
                s.send_message(msg)
        else:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as s:
                s.ehlo()
                if settings.smtp_use_starttls:
                    s.starttls()
                    s.ehlo()
                if settings.smtp_user:
                    s.login(settings.smtp_user, settings.smtp_password)
                s.send_message(msg)
        return True
    except Exception as exc:  # noqa: BLE001
        log.error("邮件发送失败 to=%s err=%s", to, exc)
        return False


def _wrap(title: str, body_html: str, cta_label: str, cta_url: str) -> str:
    return f"""\
<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:#f5f6f8;padding:32px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
    <h2 style="margin:0 0 16px;font-size:20px;color:#111">{title}</h2>
    <div style="font-size:15px;line-height:1.7;color:#333">{body_html}</div>
    <p style="margin:28px 0">
      <a href="{cta_url}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block">{cta_label}</a>
    </p>
    <p style="font-size:13px;color:#888;word-break:break-all">如果按钮无法点击，请复制链接到浏览器打开：<br>{cta_url}</p>
  </div>
</div>"""


def send_verify_email(to: str, link: str) -> bool:
    settings = get_settings()
    title = f"验证你的 {settings.site_name} 邮箱"
    text = f"欢迎注册 {settings.site_name}。\n\n请在 24 小时内点击链接完成验证：\n{link}\n"
    html = _wrap(title, "点击下面的按钮完成邮箱验证，链接 24 小时内有效。", "验证邮箱", link)
    return send_mail(to, title, text, html)


def send_reset_email(to: str, link: str) -> bool:
    settings = get_settings()
    title = f"重置 {settings.site_name} 密码"
    text = f"你正在重置密码，链接 60 分钟内有效：\n{link}\n\n如非本人操作请忽略本邮件。"
    html = _wrap(title, "点击下面的按钮重设密码，链接 60 分钟内有效。", "重置密码", link)
    return send_mail(to, title, text, html)


def send_invite_email(to: str, org_name: str, link: str) -> bool:
    settings = get_settings()
    title = f"邀请你加入 {org_name} - {settings.site_name}"
    text = f"{org_name} 邀请你加入团队。\n\n点击链接接受邀请：\n{link}\n"
    html = _wrap(title, f"你被邀请加入团队 <b>{org_name}</b>。", "接受邀请", link)
    return send_mail(to, title, text, html)


def send_order_email(to: str, order_id: str, minutes: float, amount: float, currency: str) -> bool:
    settings = get_settings()
    title = f"{settings.site_name} 充值已到账"
    text = f"充值单 {order_id} 已确认，到账 {minutes:g} 分钟，金额 {amount:g} {currency}。"
    return send_mail(to, title, text, f"<p>{text}</p>")
