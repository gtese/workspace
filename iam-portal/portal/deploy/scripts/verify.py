#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""门户端到端验收（模拟浏览器 + 业务后端）。

用法：python3 deploy/scripts/verify.py <域账号> <口令> [BASE]
覆盖：未登录跳转 → IdP 登录 → 建会话 → /api/me → /api/apps → 首页 → 登出 → 再认证
"""
import json, re, ssl, sys, urllib.parse, http.client, os

BASE = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("PORTAL_BASE", "https://portal.tri.local")
USER, PW = (sys.argv[1], sys.argv[2]) if len(sys.argv) > 2 else (None, None)
CA = os.environ.get("CA_FILE", "")
u = urllib.parse.urlparse(BASE)
ctx = ssl.create_default_context(cafile=CA or None)

results = []
def check(name, ok, detail=""):
    results.append((name, ok))
    print(("  ✓ " if ok else "  ✗ ") + name + (f"  — {detail}" if detail else ""))

class Browser:
    def __init__(self):
        self.jar = {}
    def req(self, host, path, body=None, headers=None, accept="text/html"):
        h = {"Accept": accept, "Connection": "close", "User-Agent": "portal-verify"}
        if self.jar:
            h["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.jar.items())
        if body is not None:
            body = urllib.parse.urlencode(body).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded"
        h.update(headers or {})
        c = http.client.HTTPSConnection(host or u.hostname, u.port or 443, timeout=30, context=ctx)
        c.request("GET" if body is None else "POST", path, body=body, headers=h)
        r = c.getresponse(); data = r.read().decode("utf-8", "replace")
        for k, v in r.getheaders():
            if k.lower() == "set-cookie":
                n, vv = v.split(";", 1)[0].split("=", 1)
                if vv.strip(): self.jar[n.strip()] = vv.strip()
                else: self.jar.pop(n.strip(), None)
        c.close()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, data

def main():
    if not USER:
        print(__doc__); return 2
    b = Browser()
    st, h, _ = b.req(None, "/")
    loc = h.get("location", "")
    check("1. 未登录访问自动跳统一身份", st == 302 and "/auth/login" in loc, f"{st} {loc[:50]}")

    st, h, _ = b.req(None, "/auth/login")
    idp = h.get("location", "")
    check("2a. 跳转 IdP 且带 PKCE", "code_challenge_method=S256" in idp, idp[:60])
    iu = urllib.parse.urlparse(idp)
    st, h, page = b.req(iu.netloc, iu.path + "?" + iu.query)
    check("2b. IdP 返回登录页", st == 200 and 'name="username"' in page, f"HTTP {st}")

    m = re.search(r'action="([^"]*login-actions/authenticate[^"]*)"', page)
    if not m:
        check("3. 找到登录表单", False, page[:120]); return summary()
    a = urllib.parse.urlparse(m.group(1).replace("&amp;", "&"))
    st, h, _ = b.req(a.netloc, a.path + "?" + a.query,
                     {"username": USER, "password": PW, "credentialId": ""})
    loc2 = h.get("location", "")
    check("3a. IdP 认证通过并回跳门户", st == 302 and "/auth/callback" in loc2, f"{st} {loc2[:50]}")
    u2 = urllib.parse.urlparse(loc2)
    st, h, _ = b.req(None, u2.path + "?" + u2.query)
    has_sid = any(k.startswith("portal_") for k in b.jar)
    check("3b. 门户回调建立会话", st == 302 and has_sid, f"{st} cookie={list(b.jar)}")

    st, _, body = b.req(None, "/api/me", accept="application/json")
    me = json.loads(body) if st == 200 else {}
    check("4. /api/me 返回身份", st == 200 and me.get("username") == USER,
          json.dumps(me, ensure_ascii=False)[:120])

    st, _, body = b.req(None, "/api/apps", accept="application/json")
    apps = json.loads(body).get("apps", []) if st == 200 else []
    ids = [x["id"] for x in apps]
    check("5. 返回应用列表", st == 200 and len(apps) > 0, f"{ids}")
    check("5b. 含要求的应用", all(x in ids for x in ("chat", "work", "gitlab")), f"{ids}")

    st, _, html = b.req(None, "/")
    check("6. 门户首页可访问", st == 200 and "企业应用门户" in html, f"HTTP {st}")

    st, _, body = b.req(None, "/auth/logout", body={}, accept="application/json")
    try: lo = json.loads(body).get("logoutUrl", "")
    except Exception: lo = ""
    check("7. 登出返回带 id_token_hint 的地址", st == 200 and "id_token_hint=" in lo, lo[:70])
    if lo:
        iu2 = urllib.parse.urlparse(lo)
        st2, h2, body2 = b.req(iu2.netloc, iu2.path + "?" + iu2.query)
        check("7b. IdP 登出无报错", "We are sorry" not in body2,
              f"HTTP {st2} -> {h2.get('location','')[:40]}")

    st, h, _ = b.req(None, "/auth/login")
    iu3 = urllib.parse.urlparse(h.get("location", ""))
    st3, _, page3 = b.req(iu3.netloc, iu3.path + "?" + iu3.query)
    check("8. 登出后再登录需重新输入账号", st3 == 200 and 'name="username"' in page3, f"HTTP {st3}")

    return summary()

def summary():
    failed = [n for n, ok in results if not ok]
    print("\n== 结果：%d/%d 通过%s ==" % (len(results) - len(failed), len(results),
          "" if not failed else "，失败：" + "；".join(failed)))
    return 0 if not failed else 2

if __name__ == "__main__":
    sys.exit(main())
