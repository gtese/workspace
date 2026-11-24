"""进程内缓存员工 user_access_token（登录时写入，约 1 小时有效）。

仅用于需要用户身份的云盘整理操作（如重命名/移动文件）；不落盘。
"""

from __future__ import annotations

import threading
import time

_lock = threading.Lock()
_tokens: dict[str, tuple[str, float]] = {}


def put(open_id: str, token: str, ttl: int = 3600) -> None:
    with _lock:
        _tokens[open_id] = (token, time.time() + ttl)


def get(open_id: str) -> str | None:
    with _lock:
        item = _tokens.get(open_id)
    if not item:
        return None
    token, exp = item
    if time.time() > exp:
        with _lock:
            _tokens.pop(open_id, None)
        return None
    return token
