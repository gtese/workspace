"""账号与会话：密码哈希、登录会话、一次性令牌。

不引入第三方密码库，用标准库 scrypt；会话只把 SHA-256 落库，泄库不可反推。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .models import EmailToken, User, utcnow
from .models import Session as LoginSession

_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1


def _b64e(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def _b64d(text: str) -> bytes:
    return base64.b64decode(text.encode())


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=32
    )
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64e(salt)}${_b64e(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_b64, dig_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        digest = hashlib.scrypt(
            password.encode(),
            salt=_b64d(salt_b64),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(_b64d(dig_b64)),
        )
        return hmac.compare_digest(digest, _b64d(dig_b64))
    except (ValueError, TypeError):
        return False


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")


def normalize_email(email: str) -> str:
    return email.strip().lower()


def valid_email(email: str) -> bool:
    return bool(EMAIL_RE.match(email or ""))


def password_problem(password: str) -> str:
    """返回错误描述，空串表示通过。"""
    if len(password or "") < 8:
        return "密码至少 8 位"
    if password.isdigit() or password.isalpha():
        return "密码需要同时包含字母和数字"
    return ""


# ---------------------------------------------------------------- 会话


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def issue_login_session(
    db: Session, user: User, ip: str = "", ua: str = ""
) -> tuple[str, datetime]:
    """返回 (明文 token, 过期时间)；明文只给客户端一次。"""
    settings = get_settings()
    token = "vt_" + secrets.token_urlsafe(32)
    expires = utcnow() + timedelta(days=settings.session_ttl_days)
    db.add(
        LoginSession(
            token_hash=_sha256(token),
            user_id=user.id,
            ip=ip[:64],
            ua=ua[:300],
            expires_at=expires,
        )
    )
    user.last_login_at = utcnow()
    db.commit()
    return token, expires


def resolve_login_session(db: Session, token: str) -> User | None:
    if not token or not token.startswith("vt_"):
        return None
    row = db.get(LoginSession, _sha256(token))
    if row is None or row.revoked_at is not None:
        return None
    expires = row.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    if expires < utcnow():
        return None
    user = db.get(User, row.user_id)
    if user is None or user.status != "active":
        return None
    return user


def revoke_login_session(db: Session, token: str) -> None:
    row = db.get(LoginSession, _sha256(token))
    if row is not None and row.revoked_at is None:
        row.revoked_at = utcnow()
        db.commit()


def revoke_all_sessions(db: Session, user_id: str) -> None:
    rows = db.scalars(
        select(LoginSession).where(
            LoginSession.user_id == user_id, LoginSession.revoked_at.is_(None)
        )
    ).all()
    for row in rows:
        row.revoked_at = utcnow()
    db.commit()


# ---------------------------------------------------------------- 一次性令牌


def issue_email_token(
    db: Session,
    kind: str,
    email: str,
    user_id: str = "",
    payload: str = "",
    ttl_minutes: int | None = None,
) -> str:
    settings = get_settings()
    ttl = ttl_minutes
    if ttl is None:
        ttl = settings.verify_token_minutes if kind == "verify" else settings.reset_token_minutes
    raw = secrets.token_urlsafe(32)
    db.add(
        EmailToken(
            token_hash=_sha256(raw),
            kind=kind,
            email=normalize_email(email),
            user_id=user_id,
            payload=payload,
            expires_at=utcnow() + timedelta(minutes=ttl),
        )
    )
    db.commit()
    return raw


def consume_email_token(db: Session, kind: str, raw: str) -> EmailToken | None:
    row = db.get(EmailToken, _sha256(raw or ""))
    if row is None or row.kind != kind or row.used_at is not None:
        return None
    expires = row.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    if expires < utcnow():
        return None
    row.used_at = utcnow()
    db.commit()
    return row
