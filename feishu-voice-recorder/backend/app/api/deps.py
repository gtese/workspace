from fastapi import Header, HTTPException

from ..config import get_settings
from ..security import verify_session


def current_open_id(
    authorization: str | None = Header(default=None),
    x_employee_open_id: str | None = Header(default=None),
) -> str:
    """优先用网页应用免登签发的会话 token；POC 阶段允许 X-Employee-Open-Id 兜底。"""
    if authorization and authorization.lower().startswith("bearer fm_"):
        open_id = verify_session(authorization.split(" ", 1)[1].strip())
        if open_id:
            return open_id
    if get_settings().feishu_mode == "real":
        # 生产环境必须登录飞书，不再接受自报 open_id
        raise HTTPException(status_code=401, detail="请登录飞书后使用")
    if x_employee_open_id:
        return x_employee_open_id
    return "demo"
