from fastapi import APIRouter, Depends, HTTPException

from ..config import get_settings
from ..db import SessionLocal
from ..feishu.auth import FeishuAuth
from ..models import Employee
from ..schemas import FeishuLoginIn, FeishuLoginOut
from ..security import issue_session
from ..user_tokens import put as put_user_token
from .deps import current_open_id

router = APIRouter(prefix="/api/v1", tags=["auth"])


def _upsert_employee(open_id: str, name: str = "", email: str = "") -> None:
    db = SessionLocal()
    try:
        emp = db.get(Employee, open_id)
        if emp is None:
            emp = Employee(open_id=open_id)
            db.add(emp)
        if name:
            emp.name = name
        if email:
            emp.email = email
        db.commit()
    finally:
        db.close()


@router.get("/feishu/app-id")
def feishu_app_id() -> dict:
    """前端免登需要 App ID；未配置真实应用时返回空，前端走 open_id 模拟。"""
    s = get_settings()
    if s.feishu_mode == "real" and s.feishu_app_id:
        return {"app_id": s.feishu_app_id, "mode": "real"}
    return {"app_id": "", "mode": s.feishu_mode}


@router.post("/auth/feishu-login", response_model=FeishuLoginOut)
def feishu_login(body: FeishuLoginIn) -> FeishuLoginOut:
    s = get_settings()
    if not (s.feishu_mode == "real" and s.feishu_app_id and s.feishu_app_secret):
        _upsert_employee("demo", "演示员工")
        return FeishuLoginOut(open_id="demo", name="演示员工", token=issue_session("demo"), mock=True)
    try:
        info = FeishuAuth().login_with_code(body.code)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"飞书登录失败: {exc}") from exc
    _upsert_employee(info["open_id"], info.get("name", ""), info.get("email", ""))
    put_user_token(info["open_id"], info.get("user_access_token", ""))
    return FeishuLoginOut(
        open_id=info["open_id"],
        name=info.get("name", ""),
        token=issue_session(info["open_id"]),
        mock=False,
    )


@router.get("/me")
def me(open_id: str = Depends(current_open_id)) -> dict:
    db = SessionLocal()
    try:
        emp = db.get(Employee, open_id)
        return {
            "open_id": open_id,
            "name": emp.name if emp else "",
            "email": emp.email if emp else "",
        }
    finally:
        db.close()
