"""用员工 user_access_token 自动对齐「AI录音」目录。

场景：员工可能手动重命名/移动过云盘目录，导致本地缓存 token 失效。
员工下次登录时（或生成纪要前）自动：
1. 在个人云盘根目录找到名为「AI录音」的文件夹
2. 若里面还有嵌套的旧「AI录音」子目录，把内容上移并删除空目录
3. 把 token 写回 drive_folders，后续纪要直接放这里
"""

from __future__ import annotations

import logging

import httpx

from ..db import SessionLocal
from ..models import DriveFolder
from ..user_tokens import get as get_user_token

log = logging.getLogger(__name__)
BASE = "https://open.feishu.cn/open-apis"
FOLDER_NAME = "AI录音"


def _list(h: dict, folder: str = "") -> list[dict]:
    params = {"page_size": 200}
    if folder:
        params["folder_token"] = folder
    r = httpx.get(f"{BASE}/drive/v1/files", headers=h, params=params, timeout=20)
    data = r.json()
    if data.get("code") != 0:
        raise RuntimeError(f"列目录失败: {data.get('code')} {data.get('msg')}")
    return data.get("data", {}).get("files", [])


def _move(h: dict, token: str, ftype: str, folder: str) -> bool:
    r = httpx.post(
        f"{BASE}/drive/v1/files/{token}/move",
        headers=h,
        json={"type": ftype, "folder_token": folder},
        timeout=20,
    )
    return r.json().get("code") == 0


def _delete_folder(h: dict, token: str) -> bool:
    r = httpx.delete(f"{BASE}/drive/v1/files/{token}", headers=h, params={"type": "folder"}, timeout=20)
    return r.json().get("code") == 0


def sync_folder_from_user(open_id: str) -> str | None:
    token = get_user_token(open_id)
    if not token:
        return None
    h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    try:
        root = _list(h)
        outer = next(
            (f for f in root if f.get("type") == "folder" and f.get("name") == FOLDER_NAME), None
        )
        if not outer:
            return None
        # 合并嵌套的旧 AI录音 子目录
        children = _list(h, outer["token"])
        inner = next(
            (f for f in children if f.get("type") == "folder" and f.get("name") == FOLDER_NAME), None
        )
        if inner:
            for item in _list(h, inner["token"]):
                _move(h, item["token"], item.get("type", "docx"), outer["token"])
            _delete_folder(h, inner["token"])
            log.info("合并嵌套目录完成: %s", inner["token"])

        db = SessionLocal()
        try:
            row = db.get(DriveFolder, open_id)
            if row is None:
                db.add(DriveFolder(open_id=open_id, folder_token=outer["token"]))
            else:
                row.folder_token = outer["token"]
            db.commit()
        finally:
            db.close()
        return outer["token"]
    except Exception:  # noqa: BLE001
        log.exception("自动对齐 AI录音 目录失败")
        return None


def ensure_folder_from_user(open_id: str, token: str | None = None) -> str | None:
    """确保用户云盘根目录有「AI录音」目录：先找，找不到就用**用户身份**直接建。

    用用户 token 建目录的好处：目录天生就在用户自己的「我的空间」里，名字不会
    被飞书改成「Content transferred from voice」这种默认名。
    """
    token = token or get_user_token(open_id)
    if not token:
        return None
    h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    try:
        existing = next(
            (f for f in _list(h) if f.get("type") == "folder" and f.get("name") == FOLDER_NAME),
            None,
        )
        if existing:
            folder = existing["token"]
        else:
            r = httpx.post(
                f"{BASE}/drive/v1/files/create_folder",
                headers=h,
                json={"name": FOLDER_NAME, "folder_token": ""},
                timeout=20,
            )
            data = r.json()
            if data.get("code") != 0:
                log.warning("创建 AI录音 目录失败: %s", data.get("msg"))
                return None
            folder = data["data"]["token"]
            log.info("已在用户云盘创建「%s」目录: %s", FOLDER_NAME, folder)

        db = SessionLocal()
        try:
            row = db.get(DriveFolder, open_id)
            if row is None:
                db.add(DriveFolder(open_id=open_id, folder_token=folder))
            else:
                row.folder_token = folder
            db.commit()
        finally:
            db.close()
        return folder
    except Exception:  # noqa: BLE001
        log.exception("准备 AI录音 目录失败")
        return None
