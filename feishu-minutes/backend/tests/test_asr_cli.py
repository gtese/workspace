import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.asr import cli  # noqa: E402
from app.audio import ffmpeg_path  # noqa: E402
from tests.test_audio import make_wav  # noqa: E402


def test_cli_mock_on_wav(tmp_path: Path, capsys) -> None:
    wav = make_wav(tmp_path / "a.wav", 2.0)
    out = tmp_path / "t.json"
    transcript = cli.run(wav, provider_name="mock", out_json=out)
    assert transcript.segments
    assert out.exists()
    data = out.read_text(encoding="utf-8")
    assert '"provider": "mock"' in data
    assert '"duration_sec"' in data


def test_cli_converts_m4a(tmp_path: Path, capsys) -> None:
    import subprocess

    if not ffmpeg_path():
        return
    wav = make_wav(tmp_path / "b.wav", 2.0)
    m4a = tmp_path / "b.m4a"
    subprocess.run(
        [ffmpeg_path(), "-y", "-loglevel", "error", "-i", str(wav), "-c:a", "aac", str(m4a)],
        check=True,
        capture_output=True,
    )
    transcript = cli.run(m4a, provider_name="mock")
    assert transcript.segments
