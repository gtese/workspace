"""飞书事件长连接（WebSocket）消费者。

用途：
- 让开发者后台的「使用长连接接收事件」验证通过
- 群里 @机器人 发「录音 / 纪要 / 链接」时，回复网页应用入口链接

启动：python -m app.feishu.events（独立进程，见 systemd feishu-events.service）
"""

from __future__ import annotations

import json
import logging

import lark_oapi as lark
from lark_oapi.api.im.v1 import (
    CreateMessageRequest,
    CreateMessageRequestBody,
    P2ImMessageReceiveV1,
)

from ..config import get_settings

log = logging.getLogger(__name__)

TRIGGERS = ("录音", "纪要", "trace", "Trace", "voice", "Voice")


def _app_url() -> str:
    return get_settings().public_base_url.rstrip("/") + "/"


def _client() -> lark.Client:
    s = get_settings()
    return (
        lark.Client.builder()
        .app_id(s.feishu_app_id)
        .app_secret(s.feishu_app_secret)
        .build()
    )


def _reply_text(chat_id: str, text: str) -> None:
    req = (
        CreateMessageRequest.builder()
        .receive_id_type("chat_id")
        .request_body(
            CreateMessageRequestBody.builder()
            .receive_id(chat_id)
            .msg_type("text")
            .content(json.dumps({"text": text}, ensure_ascii=False))
            .build()
        )
        .build()
    )
    resp = _client().im.v1.message.create(req)
    if not resp.success():
        log.warning("回复消息失败: %s %s", resp.code, resp.msg)


def on_message(data: P2ImMessageReceiveV1) -> None:
    try:
        msg = data.event.message
        if msg.message_type != "text":
            return
        text = json.loads(msg.content or "{}").get("text", "")
        log.info("收到消息 chat=%s text=%s", msg.chat_id, text[:80])
        if any(k in text for k in TRIGGERS):
            _reply_text(
                msg.chat_id,
                f"打开 Trace Voice 开始录音：{_app_url()}\n录完会自动生成纪要并同步飞书文档。",
            )
    except Exception:  # noqa: BLE001
        log.exception("处理消息事件失败")


def build_ws_client() -> lark.ws.Client:
    s = get_settings()
    handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(on_message)
        .build()
    )
    return lark.ws.Client(
        s.feishu_app_id,
        s.feishu_app_secret,
        event_handler=handler,
        log_level=lark.LogLevel.INFO,
    )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log.info("启动飞书长连接事件消费者…")
    build_ws_client().start()


if __name__ == "__main__":
    main()
