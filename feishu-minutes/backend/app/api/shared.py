from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Recording
from ..security import verify_share
from .serializers import to_out

router = APIRouter(prefix="/api/v1", tags=["shared"])


@router.get("/shared/{recording_id}")
def shared_recording(
    recording_id: str, exp: str, sig: str, db: Session = Depends(get_db)
) -> dict:
    """分享链接的只读接口：凭签名访问，不需要登录。"""
    if not verify_share(recording_id, exp, sig):
        raise HTTPException(status_code=403, detail="分享链接无效或已过期")
    rec = db.get(Recording, recording_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="纪要不存在")
    return to_out(rec, include_detail=True).model_dump()
