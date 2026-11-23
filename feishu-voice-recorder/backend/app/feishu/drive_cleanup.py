"""用员工 user_access_token 整理云盘：把 "Content transferred from voice"
文件夹改名为「AI录音」，并把嵌套的 AI录音 子目录内容合并到外层。
"""

from __future__ import annotations

import logging

import httpx

from ..db import SessionLocal
from ..models import DriveFolder
from ..user_tokens import get as get_user_token

log = logging.getLogger(__name__)
BASE = "https://open.feishu.cn/open-apis"


def _list(h: dict, folder: str = "") -> list[dict]:
    params = {"page_size": 200}
    if folder:
        params["folder_token"] = folder
    r = httpx.get(f"{BASE}/drive/v1/files", headers=h, params=params, timeout=20)
    data = r.json()
    if data.get("code") != 0:
        raise RuntimeError(f"列目录失败: {data.get('code')} {data.get('msg')}")
    return data.get("data", {}).get("files", [])


def _rename(h: dict, token: str, name: str) -> bool:
    r = httpx.patch(
        f"{BASE}/drive/v1/files/{token}",
        headers=h,
        params={"type": "folder"},
        json={"name": name},
        timeout=20,
    )
    return r.json().get("code") == 0


def _move(h: dict, token: str, ftype: str, folder: str) -> bool:
    r = httpx.post(
        f"{BASE}/drive/v1/files/{token}/move",
        headers=h,
        json={"type": ftype, "folder_token": folder},
        timeout=20,
    )
    return r.json().get("code") == 0


def _delete(h: dict, token: str) -> bool:
    r = httpx.delete(f"{BASE}/drive/v1/files/{token}", headers=h, params={"type": "folder"}, timeout=20)
    return r.json().get("code") == 0


def cleanup(open_id: str, execute: bool = False) -> dict:
    token = get_user_token(open_id)
    if not token:
        raise RuntimeError("没有该员工的 user_access_token，请先在飞书内重新打开 Trace Voice")
    h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    root = _list(h)
    outer = next((f for f in root if f.get("type") == "folder" and f.get("name") == "Content transferred from voice"), None)
    if not outer:
        return {"status": "not_found", "folders": [f.get("name") for f in root if f.get("type") == "folder"]}

    children = _list(h, outer["token"])
    inner = next((f for f in children if f.get("type") == "folder" and f.get("name") == "AI录音"), None)
    root_ai = next((f for f in root if f.get("type") == "folder" and f.get("name") == "AI录音"), None)

    plan = {
        "outer": outer["name"],
        "inner": inner["name"] if inner else None,
        "root_ai": root_ai["name"] if root_ai else None,
        "children": len(children),
    }
    if not execute:
        return {"status": "dry_run", "plan": plan}

    moved = 0
    # 若根目录已有 AI录音，则把内容并入它；否则把外层改名
    target = root_ai["token"] if root_ai else outer["token"]
    if not root_ai:
        if not _rename(h, outer["token"], "AI录音"):
            return {"status": "rename_failed", "plan": plan}
        # 后续新纪要继续放进这个改名后的目录
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

    if inner:
        for child in _list(h, inner["token"]):
            if _move(h, child["token"], child.get("type", "docx"), target):
                moved += 1
        _delete(h, inner["token"])

    if root_ai:  # 根目录已有 AI录音：把外层其余内容并入
        for child in _list(h, outer["token"]):
            if child["token"] != target and _move(h, child["token"], child.get("type", "docx"), target):
                moved += 1
        _delete(h, outer["token"])

    return {
        "status": "ok",
        "moved": moved,
        "renamed": True,
        "folder_token": target,
        "plan": plan,
    }
