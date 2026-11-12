#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pdk_mover_mailer.py — 通用 SMTP 发信器（正文由调用方生成文件）

用法:
    pdk_mover_mailer.py <host> <port> <from> <user> <pass> <to> <cc> <subject> <body_file>

说明:
    - to / cc 支持逗号分隔多个地址；cc 可为空字符串
    - 正文按 UTF-8 纯文本发送，不依赖 HTML
    - 优先 STARTTLS，服务端不支持时回落明文（内网 25 端口常见）
    - 退出码: 0 成功 / 1 参数或读文件错误 / 2 发送失败
"""

import smtplib
import ssl
import sys
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate


def split_addrs(s):
    return [x.strip() for x in (s or "").replace(";", ",").split(",") if x.strip()]


def main(argv):
    if len(argv) < 10:
        sys.stderr.write(__doc__)
        return 1

    host, port, mail_from, user, password, to, cc, subject, body_file = argv[1:10]
    try:
        port = int(port)
    except ValueError:
        port = 25

    to_list = split_addrs(to)
    cc_list = split_addrs(cc)
    if not to_list and not cc_list:
        sys.stderr.write("no recipient\n")
        return 1

    try:
        with open(body_file, "r", encoding="utf-8") as fh:
            body = fh.read()
    except OSError as exc:
        sys.stderr.write("read body failed: %s\n" % exc)
        return 1

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = formataddr(("PDK Sync", mail_from))
    msg["To"] = ", ".join(to_list)
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    msg["Date"] = formatdate(localtime=True)

    rcpts = to_list + cc_list
    try:
        srv = smtplib.SMTP(host, port, timeout=30)
        srv.ehlo()
        try:
            srv.starttls(context=ssl.create_default_context())
            srv.ehlo()
        except smtplib.SMTPException:
            pass  # 不支持 STARTTLS 时按明文继续
        if user:
            try:
                srv.login(user, password)
            except smtplib.SMTPException as exc:
                sys.stderr.write("login failed (continue as anonymous): %s\n" % exc)
        srv.sendmail(mail_from, rcpts, msg.as_string())
        srv.quit()
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("send failed: %s\n" % exc)
        return 2

    print("mail ok -> %s cc=%s" % (",".join(to_list), ",".join(cc_list)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
