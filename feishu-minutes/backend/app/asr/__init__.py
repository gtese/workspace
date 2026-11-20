from ..config import get_settings
from .base import ASRProvider
from .mock import MockASR
from .tencent import TencentASR


def get_asr_provider() -> ASRProvider:
    provider = get_settings().asr_provider.lower()
    if provider == "tencent":
        return TencentASR()
    return MockASR()
