import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .api import admin as admin_api
from .api import auth_users, billing_api, media, orgs, recordings, shared, uploads
from .billing import seed_plans
from .config import REPO_ROOT, get_settings
from .db import SessionLocal, init_db
from .maintenance import cleanup_expired, cleanup_orphan_files, start_maintenance, stop_maintenance
from .monitoring import snapshot, start_watchdog, stop_watchdog
from .pipeline import requeue_interrupted
from .schemas import HealthOut
from .worker import start_worker, stop_worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

WEB_DIR = REPO_ROOT / "web"
VERSION = "2.0.0"


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ANN001, ARG001
    init_db()
    db = SessionLocal()
    try:
        seed_plans(db)
    finally:
        db.close()
    requeued = requeue_interrupted()
    cleaned = cleanup_expired()
    orphans = cleanup_orphan_files()
    s = get_settings()
    start_worker()
    start_maintenance()
    start_watchdog()
    logging.getLogger(__name__).info(
        "启动 %s v%s | env=%s | asr=%s llm=%s feishu=%s mail=%s | 重排队 %d | 过期音频 %d | 孤儿目录 %d",
        s.site_name, VERSION, s.app_env, s.asr_provider, s.llm_provider,
        s.feishu_mode, s.email_mode, requeued, cleaned, orphans,
    )
    yield
    stop_worker()
    stop_maintenance()
    stop_watchdog()


app = FastAPI(title="v2txt", version=VERSION, lifespan=lifespan)
app.include_router(auth_users.router)
app.include_router(orgs.router)
app.include_router(billing_api.router)
app.include_router(admin_api.router)
app.include_router(recordings.router)
app.include_router(uploads.router)
app.include_router(shared.router)
app.include_router(media.router)

if WEB_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    s = get_settings()
    return HealthOut(
        asr_provider=s.asr_provider,
        llm_provider=s.llm_provider,
        feishu_mode=s.feishu_mode,
        version=VERSION,
        db_ok=snapshot().get("db_ok", False),
    )


@app.get("/api/v1/config")
def public_config() -> dict:
    s = get_settings()
    return {
        "site_name": s.site_name,
        "app_env": s.app_env,
        "allow_self_register": s.allow_self_register,
        "price_per_minute": s.price_per_minute_usd,
        "currency": s.billing_currency,
        "signup_bonus_minutes": s.signup_bonus_minutes,
        "upload_max_mb": s.upload_max_mb,
        "feishu_enabled": s.feishu_mode == "real",
    }


@app.post("/api/v1/ops/drive-cleanup")
def ops_drive_cleanup(payload: dict, x_ops_token: str = Header(default="")) -> dict:
    s = get_settings()
    if not s.ops_token or x_ops_token != s.ops_token:
        raise HTTPException(status_code=404, detail="Not Found")
    from .feishu.drive_cleanup import cleanup

    open_id = str(payload.get("open_id", ""))
    execute = bool(payload.get("execute", False))
    if not open_id:
        raise HTTPException(status_code=400, detail="open_id required")
    return cleanup(open_id, execute)


@app.get("/api/v1/ops/health")
def ops_health(x_ops_token: str = Header(default="")) -> dict:
    s = get_settings()
    if not s.ops_token or x_ops_token != s.ops_token:
        raise HTTPException(status_code=404, detail="Not Found")
    data = snapshot()
    data["version"] = VERSION
    return data


NO_STORE = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache"}


def _page(name: str) -> FileResponse:
    return FileResponse(WEB_DIR / name, headers=NO_STORE)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return _page("index.html")


@app.get("/login", include_in_schema=False)
def login_page() -> FileResponse:
    return _page("auth.html")


@app.get("/register", include_in_schema=False)
def register_page() -> FileResponse:
    return _page("auth.html")


@app.get("/forgot", include_in_schema=False)
def forgot_page() -> FileResponse:
    return _page("auth.html")


@app.get("/reset", include_in_schema=False)
def reset_page() -> FileResponse:
    return _page("auth.html")


@app.get("/verify", include_in_schema=False)
def verify_page() -> FileResponse:
    return _page("auth.html")


@app.get("/join", include_in_schema=False)
def join_page() -> FileResponse:
    return _page("auth.html")


@app.get("/app", include_in_schema=False)
def console_page() -> FileResponse:
    return _page("app.html")


@app.get("/billing", include_in_schema=False)
def billing_page() -> RedirectResponse:
    return RedirectResponse(url="/app#billing", status_code=307, headers=NO_STORE)


@app.get("/team", include_in_schema=False)
def team_page() -> RedirectResponse:
    return RedirectResponse(url="/app#team", status_code=307, headers=NO_STORE)


@app.get("/admin", include_in_schema=False)
def admin_page() -> FileResponse:
    return _page("admin.html")


@app.get("/preview/card/{recording_id}", include_in_schema=False)
def card_preview(recording_id: str) -> FileResponse:  # noqa: ARG001
    return _page("card_preview.html")


@app.get("/s/{recording_id}", include_in_schema=False)
def shared_page(recording_id: str) -> FileResponse:  # noqa: ARG001
    return _page("detail.html")


@app.get("/d/{recording_id}", include_in_schema=False)
def detail_page(recording_id: str) -> FileResponse:  # noqa: ARG001
    return _page("detail.html")


@app.exception_handler(404)
def not_found(request, exc):  # noqa: ANN001, ARG001
    if request.url.path.startswith("/api/"):
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    return _page("index.html")
