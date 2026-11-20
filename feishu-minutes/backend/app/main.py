import logging

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

from .api import media, recordings
from .config import REPO_ROOT, get_settings
from .db import init_db
from .schemas import HealthOut

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

WEB_DIR = REPO_ROOT / "web"


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN001, ARG001
    init_db()
    s = get_settings()
    logging.getLogger(__name__).info(
        "启动 %s | asr=%s llm=%s feishu=%s", s.app_name, s.asr_provider, s.llm_provider, s.feishu_mode
    )
    yield


app = FastAPI(title="feishu-minutes", version="0.1.0", lifespan=lifespan)
app.include_router(recordings.router)
app.include_router(media.router)

if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    s = get_settings()
    return HealthOut(
        asr_provider=s.asr_provider, llm_provider=s.llm_provider, feishu_mode=s.feishu_mode
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(WEB_DIR / "recorder.html")


@app.get("/d/{recording_id}", include_in_schema=False)
def detail_page(recording_id: str) -> FileResponse:  # noqa: ARG001
    return FileResponse(WEB_DIR / "detail.html")
