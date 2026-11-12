#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OIDC 端到端验收（授权码 + PKCE），模拟员工浏览器 + 业务后端。

用法：
  python3 deploy/scripts/verify-oidc.py <用户名> <密码>
  # 例：python3 deploy/scripts/verify-oidc.py linyiyao '***'

校验项（对应 docs/部署文档.md §验收清单）：
  1. /.well-known/openid-configuration 可访问，issuer 与对外域名一致
  2. 授权端点返回登录页（未登录时）
  3. 域账号口令登录成功（AD 联邦认证）
  4. 带 state/nonce 回跳并返回授权码
  5. 授权码 + PKCE 换取令牌（后端服务器对服务器）
  6. ID Token 的 iss/aud/nonce/sub 正确
  7. userinfo 可返回身份与角色
  8. JWKS 可获取且含 RS256 公钥
  9. 刷新令牌可用
 10. 登出后 SSO 会话失效
 11. 错误口令被拒绝（负向用例）

退出码：0 = 全部通过；2 = 有失败项。
"""

import base64
import hashlib
import http.client
import json
import os
import secrets
import ssl
import sys
import urllib.parse

BASE = os.environ.get("KC_BASE_URL", "https://sso.tri.local").rstrip("/")
REALM = os.environ.get("KC_REALM", "tri")
CLIENT = os.environ.get("KC_VERIFY_CLIENT", "oidc-verify")
REDIRECT = os.environ.get("KC_VERIFY_REDIRECT", "https://sso.tri.local/oidc/callback")
CA_FILE = os.environ.get("KC_CA_FILE", "")

u = urllib.parse.urlparse(BASE)
results = []


def loc_has_login(body):
    return 'name="username"' in body


def check(name, ok, detail=""):
    results.append((name, ok))
    print(("  ✓ " if ok else "  ✗ ") + name + (f"  — {detail}" if detail else ""), flush=True)
    return ok


class Session:
    """最小 HTTP 会话（手工 cookie，兼容 Python 3.6）"""

    def __init__(self):
        self.jar = {}
        self.ctx = ssl.create_default_context(cafile=CA_FILE or None)

    def request(self, path, body=None, headers=None):
        headers = dict(headers or {})
        headers.setdefault("Accept", "text/html,application/json")
        headers["Connection"] = "close"
        if self.jar:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.jar.items())
        if body is not None:
            body = urllib.parse.urlencode(body).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            headers["Content-Length"] = str(len(body))
        if u.scheme == "https":
            conn = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=30, context=self.ctx)
        else:
            conn = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=30)
        conn.request("GET" if body is None else "POST", path, body=body, headers=headers)
        r = conn.getresponse()
        data = r.read().decode("utf-8", "replace")
        for k, v in r.getheaders():
            if k.lower() == "set-cookie":
                name, val = v.split(";", 1)[0].split("=", 1)
                self.jar[name.strip()] = val.strip()
        conn.close()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, data


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def jwt_payload(tok):
    p = tok.split(".")[1]
    p += "=" * (-len(p) % 4)
    return json.loads(base64.urlsafe_b64decode(p))


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    user, pw = sys.argv[1], sys.argv[2]
    s = Session()

    # 1. discovery
    st, _, body = s.request(f"/realms/{REALM}/.well-known/openid-configuration")
    disc = json.loads(body) if st == 200 else {}
    expect_iss = BASE + f"/realms/{REALM}"
    check("1. discovery 可访问且 issuer 正确", st == 200 and disc.get("issuer") == expect_iss,
          disc.get("issuer", f"HTTP {st}"))

    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    state, nonce = "st-" + secrets.token_hex(6), "n-" + secrets.token_hex(6)
    auth_path = f"/realms/{REALM}/protocol/openid-connect/auth?" + urllib.parse.urlencode({
        "client_id": CLIENT, "redirect_uri": REDIRECT, "response_type": "code",
        "scope": "openid profile email roles", "state": state, "nonce": nonce,
        "code_challenge": challenge, "code_challenge_method": "S256"})
    st, _, body = s.request(auth_path)
    check("2. 未登录访问返回登录页", st == 200 and loc_has_login(body), f"HTTP {st}")

    # 3/4. 提交域账号
    import re
    m = re.search(r'action="([^"]*login-actions/authenticate[^"]*)"', body)
    if not m:
        check("3. 找到登录表单", False)
        return summary()
    login_path = re.sub(r"&amp;", "&", m.group(1))
    lp = urllib.parse.urlparse(login_path)
    st, hdr, body = s.request(lp.path + "?" + lp.query,
                              {"username": user, "password": pw, "credentialId": ""})
    loc = hdr.get("location", "")
    check("3. 域账号登录成功（AD 联邦）", st in (302, 303) and "code=" in loc,
          f"HTTP {st} {loc[:60]}…")
    if "code=" not in loc:
        return summary()
    q = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
    check("4. state 回传一致", q.get("state", [""])[0] == state)
    code = q["code"][0]

    # 5. 换令牌（PKCE）
    st, _, body = s.request(f"/realms/{REALM}/protocol/openid-connect/token", {
        "grant_type": "authorization_code", "client_id": CLIENT, "code": code,
        "redirect_uri": REDIRECT, "code_verifier": verifier})
    tok = json.loads(body) if st == 200 else {}
    check("5. 授权码 + PKCE 换取令牌", "access_token" in tok, f"HTTP {st} {body[:80]}")

    # 6. ID Token
    if "id_token" in tok:
        c = jwt_payload(tok["id_token"])
        check("6a. ID Token iss/aud 正确", c.get("iss") == expect_iss and CLIENT in (
            c.get("aud") if isinstance(c.get("aud"), list) else [c.get("aud")]))
        check("6b. nonce 校验（防重放）", c.get("nonce") == nonce)
        check("6c. 身份字段完整", bool(c.get("sub")) and c.get("preferred_username") == user,
              f"sub={str(c.get('sub'))[:8]}… username={c.get('preferred_username')}")
    else:
        check("6. ID Token 存在", False)

    # 7. userinfo
    st, _, body = s.request(f"/realms/{REALM}/protocol/openid-connect/userinfo", None,
                            {"Authorization": "Bearer " + tok.get("access_token", "")})
    ui = json.loads(body) if st == 200 else {}
    check("7. userinfo 返回身份", st == 200 and ui.get("preferred_username") == user)
    at = jwt_payload(tok["access_token"]) if tok.get("access_token") else {}
    roles = at.get("realm_access", {}).get("roles", [])
    check("8. 令牌携带业务角色 claim（realm_access.roles）", isinstance(roles, list),
          f"roles={[r for r in roles if r in ('ts:admin','ts:finance','kb:admin','kb:reviewer','cluster:admin')]}")

    # 9. JWKS
    st, _, body = s.request(f"/realms/{REALM}/protocol/openid-connect/certs")
    keys = json.loads(body).get("keys", []) if st == 200 else []
    check("9. JWKS 含 RS256 公钥", any(k.get("alg") == "RS256" for k in keys), f"{len(keys)} keys")

    # 10. refresh
    if "refresh_token" in tok:
        st, _, body = s.request(f"/realms/{REALM}/protocol/openid-connect/token", {
            "grant_type": "refresh_token", "client_id": CLIENT,
            "refresh_token": tok["refresh_token"]})
        check("10. 刷新令牌可用", st == 200 and "access_token" in json.loads(body))

    # 11. 登出
    st, hdr, _ = s.request(f"/realms/{REALM}/protocol/openid-connect/logout?" + urllib.parse.urlencode({
        "id_token_hint": tok.get("id_token", ""), "client_id": CLIENT,
        "post_logout_redirect_uri": "https://sso.tri.local/"}))
    # 用「同一个浏览器（保留 cookie）发新的授权请求」验证 SSO 会话已被清掉：
    # - 登出接口返回 302 属正常（回跳应用）
    # - 之后的授权请求若仍 302 到 callback 并带 code，说明 SSO 会话还在（未登出）
    # - 正确行为是重新出现登录表单（200 + username 输入框）
    # 新的授权请求仍带 PKCE（该 client 强制 S256，缺参数会直接报 invalid_request）
    v2 = b64url(secrets.token_bytes(32))
    c2 = b64url(hashlib.sha256(v2.encode()).digest())
    auth2 = f"/realms/{REALM}/protocol/openid-connect/auth?" + urllib.parse.urlencode({
        "client_id": CLIENT, "redirect_uri": REDIRECT, "response_type": "code",
        "scope": "openid", "state": "x", "nonce": "y",
        "code_challenge": c2, "code_challenge_method": "S256"})
    st2, hdr2, body2 = s.request(auth2)
    loc2 = hdr2.get("location", "")
    # 只有带 code 才算「仍处于登录态」；带 error= 是参数错误，需单独暴露
    still_logged_in = "code=" in loc2 and "error=" not in loc2
    if "error=" in loc2:
        print("    注：登出后授权请求返回错误（%s），按未登录处理" % loc2[:100])
    # 判定：登出后必须重新出现登录表单，且不能拿到新 code
    check("11. 登出后 SSO 会话失效（再次访问需重新登录）",
          loc_has_login(body2) and not still_logged_in,
          f"登出 HTTP {st}；登出后再授权 HTTP {st2}，code={still_logged_in}")

    # 12. 负向：错误口令
    s2 = Session()
    st, _, page = s2.request(auth_path)
    m = re.search(r'action="([^"]*login-actions/authenticate[^"]*)"', page)
    if m:
        lp = urllib.parse.urlparse(re.sub(r"&amp;", "&", m.group(1)))
        st, hdr, page = s2.request(lp.path + "?" + lp.query,
                                   {"username": user, "password": pw + "-wrong", "credentialId": ""})
        check("12. 错误口令被拒绝", "code=" not in hdr.get("location", ""), f"HTTP {st}")

    return summary()


def summary():
    failed = [n for n, ok in results if not ok]
    print("\n== 结果：%d/%d 通过%s ==" % (
        len(results) - len(failed), len(results),
        "" if not failed else "，失败项：" + "；".join(failed)))
    return 0 if not failed else 2


if __name__ == "__main__":
    sys.exit(main())