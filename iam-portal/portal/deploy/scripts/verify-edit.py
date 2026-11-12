#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""门户编辑功能验收：登录 → 读配置 → 改配置 → 校验 → 还原。

用法：python3 deploy/scripts/verify-edit.py <管理员域账号> <口令> [BASE] [CA]
说明：用 linyiyao（kb:admin）这类管理员账号跑；会自动还原成运行前的配置。
"""
import http.client, json, os, re, ssl, sys, urllib.parse

BASE = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("PORTAL_BASE", "https://portal.tri.local")
CA = sys.argv[4] if len(sys.argv) > 4 else os.environ.get("CA_FILE", "")
USER, PW = sys.argv[1], sys.argv[2]
u = urllib.parse.urlparse(BASE)
ctx = ssl.create_default_context(cafile=CA or None)
results = []

def check(name, ok, detail=""):
    results.append((name, ok))
    print(("  ✓ " if ok else "  ✗ ") + name + (f"  — {detail}" if detail else ""))

class B:
    def __init__(self): self.jar = {}
    def req(self, host, path, body=None, headers=None, method=None):
        h = {"Accept": "application/json", "Connection": "close", "User-Agent": "verify-edit"}
        if self.jar: h["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.jar.items())
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        c = http.client.HTTPSConnection(host or u.hostname, u.port or 443, timeout=30, context=ctx)
        c.request(method or ("POST" if data is not None else "GET"), path, body=data, headers=h)
        r = c.getresponse(); txt = r.read().decode("utf-8", "replace")
        for k, v in r.getheaders():
            if k.lower() == "set-cookie":
                n, vv = v.split(";", 1)[0].split("=", 1)
                if vv.strip(): self.jar[n.strip()] = vv.strip()
                else: self.jar.pop(n.strip(), None)
        c.close()
        try: js = json.loads(txt) if txt else None
        except Exception: js = None
        return r.status, js, txt

def main():
    b = B()
    # 1. 发起登录
    c = http.client.HTTPSConnection(u.hostname, 443, timeout=30, context=ctx)
    c.request("GET", "/auth/login", headers={"Connection": "close"})
    r = c.getresponse(); r.read()
    loc = r.getheader("location") or ""
    c.close()
    iu = urllib.parse.urlparse(loc)
    st, _, html = b.req(iu.netloc, iu.path + "?" + iu.query)
    m = re.search(r'action="([^"]*login-actions/authenticate[^"]*)"', html)
    if not m: check("登录页可达", False, f"HTTP {st}"); return summary()
    a = urllib.parse.urlparse(m.group(1).replace("&amp;", "&"))
    c = http.client.HTTPSConnection(a.netloc, 443, timeout=30, context=ctx)
    c.request("POST", a.path + "?" + a.query,
              body=urllib.parse.urlencode({"username": USER, "password": PW, "credentialId": ""}),
              headers={"Content-Type": "application/x-www-form-urlencoded",
                       "Cookie": "; ".join(f"{k}={v}" for k, v in b.jar.items()), "Connection": "close"})
    r = c.getresponse(); r.read()
    for k, v in r.getheaders():
        if k.lower() == "set-cookie":
            n, vv = v.split(";", 1)[0].split("=", 1)
            if vv.strip(): b.jar[n.strip()] = vv.strip()
    loc2 = r.getheader("location") or ""
    c.close()
    cb = urllib.parse.urlparse(loc2)
    st, _, _ = b.req(None, cb.path + "?" + cb.query)
    check("1. 管理员登录", any(k.startswith("portal_") for k in b.jar), f"cookies={list(b.jar)}")

    # 2. 权限：非管理员访问配置接口
    st, js, _ = b.req(None, "/api/admin/config")
    check("2. 管理员可读配置", st == 200 and isinstance(js, dict) and "apps" in js, f"HTTP {st}")
    if st != 200: return summary()
    original = js

    # 3. 保存修改（改第一条的名称 + 调换顺序）
    apps = original["apps"]
    check("3. 默认应用包含 work 且 sso=true",
          any(a["id"] == "work" and a.get("sso") for a in apps),
          str([(a["id"], a.get("sso")) for a in apps]))
    modified = [dict(a) for a in apps]
    modified[0]["name"] = modified[0]["name"] + "（已改名测试）"
    modified.reverse()
    st, js, txt = b.req(None, "/api/admin/config", method="PUT",
                        body={"apps": modified, "categories": original.get("categories", [])},
                        headers={"Content-Type": "application/json"})
    check("4. 保存配置", st == 200, f"HTTP {st} {txt[:80]}")

    # 4. 重新读取，确认顺序与改名生效
    st, cfg2, _ = b.req(None, "/api/admin/config")
    ok_order = [a["id"] for a in cfg2["apps"]] == [a["id"] for a in modified]
    ok_rename = "（已改名测试）" in cfg2["apps"][-1]["name"]
    check("5. 顺序已保存", ok_order, str([a["id"] for a in cfg2["apps"]]))
    check("6. 改名已保存", ok_rename, cfg2["apps"][-1]["name"])

    # 5. 卡片渲染是否反映新顺序
    st, js, _ = b.req(None, "/api/apps")
    check("7. 门户读到的顺序一致", [a["id"] for a in js["apps"]] == [a["id"] for a in modified],
          str([a["id"] for a in js["apps"]]))

    # 6. 非法输入被拒（http 地址 / 空名称）
    bad = [dict(modified[0])]; bad[0]["url"] = "http://insecure.example"
    st, _, txt = b.req(None, "/api/admin/config", method="PUT",
                       body={"apps": bad, "categories": []}, headers={"Content-Type": "application/json"})
    check("8. 非 https 地址被拒绝", st == 400, f"HTTP {st} {txt[:60]}")
    bad2 = [dict(modified[0])]; bad2[0]["name"] = ""
    st, _, txt = b.req(None, "/api/admin/config", method="PUT",
                       body={"apps": bad2, "categories": []}, headers={"Content-Type": "application/json"})
    check("9. 空名称被拒绝", st == 400, f"HTTP {st} {txt[:60]}")

    # 7. 还原
    st, _, _ = b.req(None, "/api/admin/config", method="PUT",
                     body={"apps": original["apps"], "categories": original.get("categories", [])},
                     headers={"Content-Type": "application/json"})
    st, cfg3, _ = b.req(None, "/api/admin/config")
    check("10. 还原为原始配置", st == 200 and [a["name"] for a in cfg3["apps"]] == [a["name"] for a in original["apps"]])

    return summary()

def summary():
    failed = [n for n, ok in results if not ok]
    print("\n== 结果：%d/%d 通过%s ==" % (len(results) - len(failed), len(results),
          "" if not failed else "，失败：" + "；".join(failed)))
    return 0 if not failed else 2

if __name__ == "__main__":
    sys.exit(main())
