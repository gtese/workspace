from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings

_settings = get_settings()
_settings.data_dir.mkdir(parents=True, exist_ok=True)


class Base(DeclarativeBase):
    pass


def _sqlite_pragmas(conn, _record) -> None:  # noqa: ANN001
    """WAL + NORMAL：读写不互相阻塞，写入吞吐显著提升。"""
    cur = conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA busy_timeout=15000")
    cur.execute("PRAGMA cache_size=-64000")   # 64MB
    cur.execute("PRAGMA temp_store=MEMORY")
    cur.execute("PRAGMA mmap_size=134217728")
    cur.close()


engine = create_engine(
    _settings.db_url,
    connect_args={"check_same_thread": False, "timeout": 15} if _settings.is_sqlite else {},
    pool_pre_ping=True,
)
if _settings.is_sqlite:
    from sqlalchemy import event as _sa_event

    _sa_event.listen(engine, "connect", _sqlite_pragmas)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from . import models  # noqa: F401  确保模型已注册

    Base.metadata.create_all(bind=engine)
    from .schema_migrate import ensure_schema

    ensure_schema(engine)
