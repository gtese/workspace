"""录音文件存储（本地磁盘）。路径约定：data/recordings/<recording_id>/seg_000.wav"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .config import get_settings


def data_dir() -> Path:
    d = get_settings().data_dir
    d.mkdir(parents=True, exist_ok=True)
    return d


def recording_dir(recording_id: str) -> Path:
    d = data_dir() / "recordings" / recording_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def segment_path(recording_id: str, idx: int) -> Path:
    return recording_dir(recording_id) / f"seg_{idx:03d}.wav"


def merged_path(recording_id: str) -> Path:
    return recording_dir(recording_id) / "merged.wav"


def segment_raw_path(recording_id: str, idx: int) -> Path:
    return recording_dir(recording_id) / f"seg_{idx:03d}.raw"


def save_segment_raw(recording_id: str, idx: int, data: bytes) -> tuple[Path, str]:
    """先按原始格式落盘（可能是 m4a/mp3/webm），再由 API 层转成 WAV。"""
    path = segment_raw_path(recording_id, idx)
    path.write_bytes(data)
    return path, hashlib.sha256(data).hexdigest()


def read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def rel_media_path(path: Path) -> str:
    """转成 /media/ 下的相对路径（用于签名 URL）。"""
    root = data_dir().resolve()
    return "/media/" + str(path.resolve().relative_to(root)).replace("\\", "/")
