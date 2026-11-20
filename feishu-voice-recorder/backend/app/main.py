import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .api import auth, media, recordings, shared
from .config import REPO_ROOT, get_settings
from .db import init_db
from .maintenance import cleanup_expired, cleanup_orphan_files, start_maintenance, stop_maintenance
from .pipeline import requeue_interrupted
from .schemas import HealthOut
from .worker import start_worker, stop_worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

WEB_DIR = REPO_ROOT / "web"


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN001, ARG001
    init_db()
    requeued = requeue_interrupted()
    cleaned = cleanup_expired()
    orphans = cleanup_orphan_files()
    s = get_settings()
    start_worker()
    start_maintenance()
    logging.getLogger(__name__).info(
        "启动 %s | asr=%s llm=%s feishu=%s | 重排队 %d | 过期音频 %d | 孤儿目录 %d",
        s.app_name, s.asr_provider, s.llm_provider, s.feishu_mode, requeued, cleaned, orphans,
    )
    yield
    stop_worker()
    stop_maintenance()


app = FastAPI(title="feishu-minutes", version="0.1.0", lifespan=lifespan)
app.include_router(auth.router)
app.include_router(recordings.router)
app.include_router(shared.router)
app.include_router(media.router)

if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    s = get_settings()
    return HealthOut(
        asr_provider=s.asr_provider, llm_provider=s.llm_provider, feishu_mode=s.feishu_mode
    )


NO_STORE = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache"}


def _page(name: str) -> FileResponse:
    return FileResponse(WEB_DIR / name, headers=NO_STORE)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return _page("recorder.html")


@app.get("/preview/card/{recording_id}", include_in_schema=False)
def card_preview(recording_id: str) -> FileResponse:  # noqa: ARG001
    return _page("card_preview.html")


@app.get("/mine", include_in_schema=False)
def mine_page() -> RedirectResponse:
    # 录音记录已合并到首页
    return RedirectResponse(url="/#records", status_code=307, headers=NO_STORE)


@app.get("/s/{recording_id}", include_in_schema=False)
def shared_page(recording_id: str) -> FileResponse:  # noqa: ARG001
    return _page("detail.html")


@app.get("/d/{recording_id}", include_in_schema=False)
def detail_page(recording_id: str) -> FileResponse:  # noqa: ARG001
    return _page("detail.html")
