# -*- coding: utf-8 -*-
"""OIDC 接入参考实现（Python 3 + Flask，仅标准库 + requests）。

适用：slurm-web 这类自研 Flask 后台。
与 Node 版本等价：授权码 + PKCE(S256)、state/nonce 校验、RP-Initiated Logout。
运行依赖：pip install flask requests
"""
import base64
import hashlib
import os
import secrets

import requests
from flask import Blueprint, current_app, redirect, request, session, jsonify, url_for

ISSUER = os.environ.get("OIDC_ISSUER", "https://sso.tri.local/realms/tri")
CLIENT_ID = os.environ.get("OIDC_CLIENT_ID", "slurm-web")
CLIENT_SECRET = os.environ.get("OIDC_CLIENT_SECRET", "")
REDIRECT_URI = os.environ.get("OIDC_REDIRECT_URI", "https://cluster.tri.local/auth/callback")
POST_LOGOUT_URI = os.environ.get("OIDC_POST_LOGOUT_URI", "https://cluster.tri.local/")
ROLES_OF_INTEREST = {"cluster:admin"}

bp = Blueprint("oidc", __name__)
_disc = {}


def discovery():
    if not _disc:
        _disc.update(requests.get(f"{ISSUER}/.well-known/openid-configuration", timeout=10).json())
    return _disc


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


@bp.get("/auth/login")
def login():
    state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode()).digest()
    session["oidc"] = {"state": state, "nonce": nonce, "verifier": verifier}
    d = discovery()
    q = requests.Request("GET", d["authorization_endpoint"], params={
        "client_id": CLIENT_ID, "redirect_uri": REDIRECT_URI, "response_type": "code",
        "scope": "openid profile email roles", "state": state, "nonce": nonce,
        "code_challenge": b64u(digest), "code_challenge_method": "S256",
    }).prepare().url
    return redirect(q)


@bp.get("/auth/callback")
def callback():
    pending = session.pop("oidc", None)
    if not pending or request.args.get("state") != pending["state"]:
        return jsonify(error="invalid_state"), 400
    if request.args.get("error"):
        return jsonify(error=request.args["error"],
                       detail=request.args.get("error_description")), 401
    d = discovery()
    tok = requests.post(d["token_endpoint"], data={
        "grant_type": "authorization_code", "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET, "code": request.args["code"],
        "redirect_uri": REDIRECT_URI, "code_verifier": pending["verifier"],
    }, timeout=15)
    if tok.status_code != 200:
        return jsonify(error="token_exchange_failed", detail=tok.text[:300]), 401
    tokens = tok.json()

    # 校验签名与声明（生产建议用 authlib/jwt 做完整校验；此处给出最小校验框架）
    claims = decode_jwt_payload(tokens["id_token"])
    if claims.get("iss") != ISSUER or CLIENT_ID not in _as_list(claims.get("aud")):
        return jsonify(error="invalid_token"), 401
    if claims.get("nonce") != pending["nonce"]:
        return jsonify(error="nonce_mismatch"), 401

    ui = requests.get(d["userinfo_endpoint"],
                      headers={"Authorization": f"Bearer {tokens['access_token']}"},
                      timeout=10).json()
    at = decode_jwt_payload(tokens["access_token"])
    roles = [r for r in at.get("realm_access", {}).get("roles", []) if ":" in r]
    session["user"] = {"sub": claims["sub"], "username": ui.get("preferred_username"),
                       "roles": roles}
    session.permanent = True
    return redirect(url_for("webui.index"))


@bp.post("/auth/logout")
def logout():
    user = session.pop("user", None)
    if user:
        d = discovery()
        return redirect(f"{d['end_session_endpoint']}?client_id={CLIENT_ID}"
                        f"&post_logout_redirect_uri={POST_LOGOUT_URI}")
    return redirect("/")


def current_user():
    return session.get("user")


def require_role(role):
    """装饰器用法示例：@require_role('cluster:admin')"""
    from functools import wraps

    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if not u:
                return redirect("/auth/login")
            if role not in u["roles"]:
                return jsonify(error="forbidden", need=role), 403
            return fn(*a, **kw)
        return wrapper
    return deco


def decode_jwt_payload(token: str) -> dict:
    import json
    p = token.split(".")[1]
    p += "=" * (-len(p) % 4)
    return json.loads(base64.urlsafe_b64decode(p))


def _as_list(v):
    return v if isinstance(v, list) else [v]


# 注册：app.register_blueprint(bp)
# 配置：
#   app.secret_key = os.environ["SESSION_SECRET"]
#   app.config.update(SESSION_COOKIE_SECURE=True, SESSION_COOKIE_HTTPONLY=True,
#                     SESSION_COOKIE_SAMESITE="Lax")
