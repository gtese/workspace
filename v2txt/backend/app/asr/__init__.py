from ..config import get_settings
from .aliyun import AliyunASR
from .aliyun_filetrans import AliyunFiletransASR
from .base import ASRProvider
from .mock import MockASR
from .tencent import TencentASR


def get_asr_provider() -> ASRProvider:
    provider = get_settings().asr_provider.lower()
    if provider == "tencent":
        return TencentASR()
    if provider == "aliyun":
        return AliyunASR()
    if provider == "aliyun_filetrans":
        return AliyunFiletransASR()
    return MockASR()
