"""进程内令牌桶限流（按 open_id + 动作）。

单进程部署足够；多进程需换 Redis。超限返回 429 + Retry-After。
"""

from __future__ import annotations

import time
from threading import Lock

from fastapi import HTTPException

# action -> (每分钟次数, 突发上限)
LIMITS: dict[str, tuple[int, int]] = {
    "create": (20, 5),
    "segment": (120, 20),
    "finish": (20, 5),
    "send": (30, 5),
    "delete": (30, 5),
    "share": (30, 5),
    "rename": (60, 10),
    "upload": (20, 5),
    "auth_login": (10, 3),
    "auth_register": (6, 2),
    "auth_email": (6, 2),
    "order": (10, 3),
}

_lock = Lock()
_buckets: dict[str, tuple[float, float]] = {}  # key -> (tokens, updated)


def reset() -> None:
    with _lock:
        _buckets.clear()


def _allow(key: str, rate_per_second: float, burst: int) -> bool:
    now = time.monotonic()
    with _lock:
        tokens, updated = _buckets.get(key, (float(burst), now))
        tokens = min(float(burst), tokens + (now - updated) * rate_per_second)
        if tokens < 1:
            _buckets[key] = (tokens, now)
            return False
        _buckets[key] = (tokens - 1, now)
        return True


def enforce(open_id: str, action: str) -> None:
    per_minute, burst = LIMITS.get(action, (60, 10))
    if not _allow(f"{action}:{open_id}", per_minute / 60.0, burst):
        raise HTTPException(
            status_code=429,
            detail="操作过于频繁，请稍后再试",
            headers={"Retry-After": "30"},
        )
