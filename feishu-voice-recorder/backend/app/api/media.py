from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..config import get_settings
from ..security import verify

router = APIRouter(tags=["media"])


@router.get("/media/{path:path}")
def media(path: str, exp: str, sig: str) -> FileResponse:
    if not verify(f"/media/{path}", exp, sig):
        raise HTTPException(status_code=403, detail="链接无效或已过期")
    root = get_settings().data_dir.resolve()
    target = (root / path).resolve()
    if not str(target).startswith(str(root)) or not target.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(target, media_type="audio/wav", filename=Path(target).name)
