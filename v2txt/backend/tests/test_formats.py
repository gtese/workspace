import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.audio import ffmpeg_path  # noqa: E402
from app.main import app  # noqa: E402

from tests.test_audio import make_wav  # noqa: E402

from .conftest import headers_for

HEADERS = headers_for("u_formats")


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _encode(src: Path, dst: Path, codec: str) -> None:
    exe = ffmpeg_path()
    assert exe
    subprocess.run(
        [exe, "-y", "-loglevel", "error", "-i", str(src), "-c:a", codec, str(dst)],
        check=True,
        capture_output=True,
    )


def test_upload_m4a_is_transcoded(client: TestClient, tmp_path: Path) -> None:
    if not ffmpeg_path():
        pytest.skip("本机无 ffmpeg")
    wav = make_wav(tmp_path / "src.wav", 2.0, freq=500)
    m4a = tmp_path / "src.m4a"
    _encode(wav, m4a, "aac")

    r = client.post("/api/v1/recordings", json={"title": "m4a 上传", "scene": "client"}, headers=HEADERS)
    rid = r.json()["id"]
    with m4a.open("rb") as fh:
        r = client.post(
            f"/api/v1/recordings/{rid}/segments?idx=0",
            files={"file": ("src.m4a", fh, "audio/mp4")},
            headers=HEADERS,
        )
    assert r.status_code == 200, r.text

    r = client.post(f"/api/v1/recordings/{rid}/finish", headers=HEADERS)
    assert r.status_code == 200
    r = client.get(f"/api/v1/recordings/{rid}", headers=HEADERS)
    body = r.json()
    assert body["status"] == "done"
    assert body["duration_sec"] >= 1
    assert body["audio_url"]


def test_upload_garbage_rejected_and_cleaned(client: TestClient) -> None:
    r = client.post("/api/v1/recordings", json={"title": "坏文件", "scene": "memo"}, headers=HEADERS)
    rid = r.json()["id"]
    r = client.post(
        f"/api/v1/recordings/{rid}/segments?idx=0",
        files={"file": ("bad.m4a", b"not audio at all", "audio/mp4")},
        headers=HEADERS,
    )
    assert r.status_code == 400
    rec_dir = Path(__file__).resolve().parents[1] / ".." / "data" / "recordings" / rid
    if rec_dir.exists():
        assert not list(rec_dir.glob("*.raw"))
        assert not list(rec_dir.glob("*.wav"))


def test_stats(client: TestClient) -> None:
    r = client.get("/api/v1/stats", headers=HEADERS)
    assert r.status_code == 200
    body = r.json()
    assert body["recordings"] >= 1
    assert body["minutes"] >= 0
    assert "estimated_cost_yuan" in body
