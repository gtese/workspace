"""纪要写回飞书：生成云文档并放进用户云盘「AI录音」目录。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import pipeline  # noqa: E402
from app.accounts import hash_password  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.feishu import folder_sync  # noqa: E402
from app.models import (  # noqa: E402
    STATUS_DONE,
    DeliveryLog,
    Document,
    DriveFolder,
    Membership,
    Org,
    Recording,
    Segment,
    User,
)
from app.worker import Worker  # noqa: E402

from tests.test_audio import make_wav  # noqa: E402


class FakeDocClient:
    created: list[dict] = []
    folders: list[str] = []

    def __init__(self) -> None:
        pass

    def create_user_folder(self, open_id: str, name: str = "AI录音") -> str:
        self.folders.append(open_id)
        return "fld_new"

    def create_minutes_doc(
        self,
        title: str,
        summary: dict,
        share_url: str,
        open_id: str,
        folder_token: str = "",
        user_token: str = "",
    ) -> dict:
        self.created.append(
            {
                "title": title,
                "open_id": open_id,
                "folder": folder_token,
                "url": share_url,
                "user_token": user_token,
            }
        )
        return {
            "document_id": "doc_test",
            "url": "https://feishu.cn/docx/doc_test",
            "folder_ok": bool(folder_token),
        }


def _feishu_user(db, open_id: str) -> User:
    user = db.query(User).filter(User.feishu_open_id == open_id).first()
    if user is not None:
        return user
    user = User(
        email=f"{open_id}@feishu.local",
        password_hash=hash_password("Xx123456"),
        name="飞书用户",
        feishu_open_id=open_id,
        feishu_tenant_key="tk_docs",
    )
    db.add(user)
    db.flush()
    org = Org(name="飞书团队", kind="team", owner_id=user.id, feishu_tenant_key="tk_docs")
    db.add(org)
    db.flush()
    db.add(Membership(org_id=org.id, user_id=user.id, role="owner"))
    user.default_org_id = org.id
    db.commit()
    return user


def _queued(db, user: User, tmp_path: Path, title: str) -> str:
    rec = Recording(
        org_id=user.default_org_id,
        owner_user_id=user.id,
        owner_open_id=user.feishu_open_id,
        title=title,
        scene="meeting",
        status="queued",
    )
    db.add(rec)
    db.commit()
    db.refresh(rec)
    wav = make_wav(tmp_path / f"{rec.id}.wav", 1.0)
    db.add(Segment(recording_id=rec.id, idx=0, path=str(wav), size=wav.stat().st_size))
    db.commit()
    return rec.id


def _enable_docs(monkeypatch) -> None:
    base = get_settings()
    settings = base.model_copy(
        update={"feishu_mode": "real", "feishu_doc_enabled": True, "feishu_card_enabled": False}
    )
    monkeypatch.setattr(pipeline, "get_settings", lambda: settings)
    monkeypatch.setattr(pipeline, "FeishuDocClient", FakeDocClient)
    monkeypatch.setattr(folder_sync, "sync_folder_from_user", lambda open_id: "")
    monkeypatch.setattr(folder_sync, "ensure_folder_from_user", lambda open_id, token=None: "fld_new")
    monkeypatch.setattr(pipeline.feishu_oauth, "user_token_for", lambda db, user: "user-token")
    FakeDocClient.created.clear()
    FakeDocClient.folders.clear()


def test_doc_written_into_ai_folder(monkeypatch, tmp_path: Path) -> None:
    _enable_docs(monkeypatch)
    db = SessionLocal()
    try:
        user = _feishu_user(db, "ou_docs_1")
        rid = _queued(db, user, tmp_path, "写回飞书测试")
        db.query(DriveFolder).filter(DriveFolder.open_id == "ou_docs_1").delete()
        db.commit()
    finally:
        db.close()

    assert Worker().process_one() is True

    db = SessionLocal()
    try:
        rec = db.get(Recording, rid)
        assert rec.status == STATUS_DONE
        docs = db.query(Document).filter(Document.recording_id == rid).all()
        assert len(docs) == 1
        assert docs[0].url == "https://feishu.cn/docx/doc_test"

        logs = {x.channel: x for x in db.query(DeliveryLog).filter(DeliveryLog.recording_id == rid)}
        assert "feishu_doc" not in logs  # 成功时不写失败日志

        folder = db.get(DriveFolder, "ou_docs_1")
        assert folder is not None and folder.folder_token == "fld_new"

        assert FakeDocClient.created[-1]["open_id"] == "ou_docs_1"
        assert FakeDocClient.created[-1]["folder"] == "fld_new"
    finally:
        db.close()


def test_cached_folder_is_reused(monkeypatch, tmp_path: Path) -> None:
    _enable_docs(monkeypatch)
    db = SessionLocal()
    try:
        user = _feishu_user(db, "ou_docs_2")
        db.merge(DriveFolder(open_id="ou_docs_2", folder_token="fld_cached"))
        db.commit()
        rid = _queued(db, user, tmp_path, "复用目录测试")
    finally:
        db.close()

    assert Worker().process_one() is True

    db = SessionLocal()
    try:
        assert db.get(Recording, rid).status == STATUS_DONE
        assert FakeDocClient.created[-1]["folder"] == "fld_cached"
        assert FakeDocClient.folders == []  # 不应重复创建目录
    finally:
        db.close()


def test_non_feishu_user_skips_doc(monkeypatch, tmp_path: Path) -> None:
    _enable_docs(monkeypatch)
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == "u_test@example.com").one()
        rid = _queued(db, user, tmp_path, "邮箱用户不写飞书")
    finally:
        db.close()

    assert Worker().process_one() is True

    db = SessionLocal()
    try:
        assert db.get(Recording, rid).status == STATUS_DONE
        assert db.query(Document).filter(Document.recording_id == rid).count() == 0
        assert FakeDocClient.created == []
    finally:
        db.close()
