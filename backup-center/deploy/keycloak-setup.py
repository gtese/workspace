#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 backup-center 幂等配置 Keycloak（realm tri）。

做的事：
  1. 创建/更新 confidential client `backup-center`（授权码 + PKCE，回调 https://backup.tri.local/auth/oidc/callback）
  2. 添加 claims mapper：groups（AD 组）与 roles（realm 角色）
  3. 创建 realm 角色 `backup:admin`
  4. 把 `backup:admin` 授予 AD 组 `Group_Roots`（该组成员登录即 admin，其他成员 viewer）

用法：
  export KC_ADMIN_PASSWORD='<Keycloak admin 口令>'   # 或 --admin-password-file ~/.mm/keycloak-admin
  python3 deploy/keycloak-setup.py [--check] [--write-secret /etc/backup-center/oidc.secret]

可选环境变量：
  KC_BASE_URL=https://sso.tri.local   KC_REALM=tri   KC_ADMIN_USER=admin
  BC_CLIENT_ID=backup-center          BC_PUBLIC_URL=https://backup.tri.local
  BC_ADMIN_GROUP=Group_Roots          BC_ADMIN_ROLE=backup:admin
  KC_CA_FILE=<企业根 CA pem 路径>

只使用 Python 标准库；输出 client secret（敏感，勿贴到聊天/日志）。
"""
import argparse
import getpass
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("KC_BASE_URL", "https://sso.tri.local").rstrip("/")
REALM = os.environ.get("KC_REALM", "tri")
ADMIN_USER = os.environ.get("KC_ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("KC_ADMIN_PASSWORD", "")
CLIENT_ID = os.environ.get("BC_CLIENT_ID", "backup-center")
PUBLIC_URL = os.environ.get("BC_PUBLIC_URL", "https://backup.tri.local").rstrip("/")
ADMIN_GROUP = os.environ.get("BC_ADMIN_GROUP", "Group_Roots")
ADMIN_ROLE = os.environ.get("BC_ADMIN_ROLE", "backup:admin")
CA_FILE = os.environ.get("KC_CA_FILE", "")

CTX = ssl.create_default_context(cafile=CA_FILE) if CA_FILE else ssl.create_default_context()


def call(method, path, token=None, body=None, form=None):
    url = BASE + path
    data = None
    headers = {"accept": "application/json"}
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["content-type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    if token:
        headers["authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=20) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = raw.decode(errors="replace")
        return e.code, parsed
    except urllib.error.URLError as e:
        print(f"连接 Keycloak 失败：{e}", file=sys.stderr)
        sys.exit(1)


def login():
    status, data = call("POST", f"/realms/{REALM}/protocol/openid-connect/token", form={
        "client_id": "admin-cli", "grant_type": "password",
        "username": ADMIN_USER, "password": ADMIN_PASS,
    })
    if status != 200 or "access_token" not in (data or {}):
        msg = (data or {}).get("error_description") if isinstance(data, dict) else data
        print(f"Keycloak 管理员登录失败：{msg}", file=sys.stderr)
        sys.exit(2)
    return data["access_token"]


def ensure_client(tok):
    status, found = call("GET", f"/admin/realms/{REALM}/clients?clientId={urllib.parse.quote(CLIENT_ID)}", tok)
    spec = {
        "clientId": CLIENT_ID,
        "name": "集中备份平台",
        "description": "backup-center：Web 集中式文件备份",
        "enabled": True,
        "protocol": "openid-connect",
        "publicClient": False,
        "standardFlowEnabled": True,
        "implicitFlowEnabled": False,
        "directAccessGrantsEnabled": False,
        "serviceAccountsEnabled": False,
        "consentRequired": False,
        "fullScopeAllowed": True,
        "redirectUris": [f"{PUBLIC_URL}/auth/oidc/callback"],
        "webOrigins": [PUBLIC_URL],
        "attributes": {
            "pkce.code.challenge.method": "S256",
            "post.logout.redirect.uris": f"{PUBLIC_URL}/*",
        },
    }
    if status == 200 and found:
        cid = found[0]["id"]
        status, _ = call("PUT", f"/admin/realms/{REALM}/clients/{cid}", tok, spec)
        if status not in (200, 204):
            print("更新 client 失败", status, file=sys.stderr)
            sys.exit(3)
        print(f"[ok] 已更新 client {CLIENT_ID}")
    else:
        status, _ = call("POST", f"/admin/realms/{REALM}/clients", tok, spec)
        if status not in (201, 204):
            print("创建 client 失败", status, file=sys.stderr)
            sys.exit(3)
        status, found = call("GET", f"/admin/realms/{REALM}/clients?clientId={urllib.parse.quote(CLIENT_ID)}", tok)
        cid = found[0]["id"]
        print(f"[ok] 已创建 client {CLIENT_ID}")
    return cid


def ensure_mappers(tok, cid):
    status, mappers = call("GET", f"/admin/realms/{REALM}/clients/{cid}/protocol-mappers/models", tok)
    mappers = mappers or []
    want = [
        {
            "name": "groups", "protocol": "openid-connect",
            "protocolMapper": "oidc-group-membership-mapper",
            "config": {
                "claim.name": "groups", "full.path": "false", "id.token.claim": "true",
                "access.token.claim": "true", "userinfo.claim": "true", "multivalued": "true",
            },
        },
        {
            "name": "realm roles", "protocol": "openid-connect",
            "protocolMapper": "oidc-usermodel-realm-role-mapper",
            "config": {
                "claim.name": "roles", "multivalued": "true", "id.token.claim": "true",
                "access.token.claim": "true", "userinfo.claim": "true", "jsonType.label": "String",
            },
        },
    ]
    for w in want:
        existing = next((m for m in mappers if m.get("name") == w["name"]), None)
        if existing:
            w2 = dict(w, id=existing["id"])
            status, _ = call("PUT", f"/admin/realms/{REALM}/clients/{cid}/protocol-mappers/models/{existing['id']}", tok, w2)
        else:
            status, _ = call("POST", f"/admin/realms/{REALM}/clients/{cid}/protocol-mappers/models", tok, w)
        if status not in (200, 201, 204):
            print(f"配置 mapper {w['name']} 失败：{status}", file=sys.stderr)
            sys.exit(4)
        print(f"[ok] mapper {w['name']}")


def ensure_role(tok):
    path = f"/admin/realms/{REALM}/roles/{urllib.parse.quote(ADMIN_ROLE, safe='')}"
    status, role = call("GET", path, tok)
    if status != 200:
        status, _ = call("POST", f"/admin/realms/{REALM}/roles", tok,
                         {"name": ADMIN_ROLE, "description": "backup-center 管理员（Group_Roots 成员）"})
        if status not in (201, 204):
            print("创建角色失败", status, file=sys.stderr)
            sys.exit(5)
        status, role = call("GET", path, tok)
        print(f"[ok] 已创建角色 {ADMIN_ROLE}")
    else:
        print(f"[ok] 角色已存在 {ADMIN_ROLE}")
    return role


def find_group(tok):
    status, groups = call("GET", f"/admin/realms/{REALM}/groups?search={urllib.parse.quote(ADMIN_GROUP)}&max=200", tok)
    for g in groups or []:
        if g.get("name", "").lower() == ADMIN_GROUP.lower():
            return g
    return None


def assign_group_role(tok, group, role):
    status, current = call("GET", f"/admin/realms/{REALM}/groups/{group['id']}/role-mappings/realm", tok)
    if isinstance(current, list) and any(r.get("name") == ADMIN_ROLE for r in current):
        print(f"[ok] 组 {ADMIN_GROUP} 已拥有 {ADMIN_ROLE}")
        return
    status, _ = call("POST", f"/admin/realms/{REALM}/groups/{group['id']}/role-mappings/realm", tok,
                     [{"id": role["id"], "name": role["name"]}])
    if status not in (204, 200):
        print("给组授予角色失败", status, file=sys.stderr)
        sys.exit(6)
    print(f"[ok] 已把 {ADMIN_ROLE} 授予组 {ADMIN_GROUP}")


def ensure_secret(tok, cid, write_path):
    status, sec = call("GET", f"/admin/realms/{REALM}/clients/{cid}/client-secret", tok)
    if status != 200 or not (sec or {}).get("value"):
        status, _ = call("POST", f"/admin/realms/{REALM}/clients/{cid}/client-secret", tok)
        status, sec = call("GET", f"/admin/realms/{REALM}/clients/{cid}/client-secret", tok)
    value = sec["value"]
    if write_path:
        os.makedirs(os.path.dirname(write_path) or ".", mode=0o700, exist_ok=True)
        fd = os.open(write_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(value + "\n")
        print(f"[ok] client secret 已写入 {write_path} (0600)")
    else:
        print(f"[ok] client secret: {value}")
    return value


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只检查，不做修改")
    ap.add_argument("--admin-password-file", help="从文件读取 Keycloak 管理员口令")
    ap.add_argument("--write-secret", help="把 client secret 写入指定文件（0600）")
    args = ap.parse_args()

    global ADMIN_PASS
    if args.admin_password_file:
        ADMIN_PASS = open(args.admin_password_file).read().strip()
    if not ADMIN_PASS:
        ADMIN_PASS = getpass.getpass(f"Keycloak 管理员 {ADMIN_USER} 口令: ")
    if not ADMIN_PASS:
        print("缺少 KC_ADMIN_PASSWORD", file=sys.stderr)
        sys.exit(2)

    tok = login()
    print(f"[ok] 管理员登录成功：{BASE} realm={REALM}")
    if args.check:
        status, found = call("GET", f"/admin/realms/{REALM}/clients?clientId={urllib.parse.quote(CLIENT_ID)}", tok)
        print(f"[check] client {CLIENT_ID}: {'存在' if found else '不存在'}")
        group = find_group(tok)
        print(f"[check] 组 {ADMIN_GROUP}: {'存在 id=' + group['id'] if group else '不存在（需确认 LDAP 组同步）'}")
        return

    cid = ensure_client(tok)
    ensure_mappers(tok, cid)
    role = ensure_role(tok)
    group = find_group(tok)
    if not group:
        print(f"[warn] 未找到组 {ADMIN_GROUP}。请确认 Keycloak 已同步该 AD 组后重跑本脚本。", file=sys.stderr)
        sys.exit(7)
    assign_group_role(tok, group, role)
    ensure_secret(tok, cid, args.write_secret)
    print("\n下一步：让服务端启用 OIDC（/etc/backup-center/config.json）：")
    print('  "oidc": {"enabled": true, "client_id": "backup-center", "client_secret": "<从上方获取>",')
    print(f'           "admin_group": "{ADMIN_GROUP}", "admin_role": "{ADMIN_ROLE}", "operator_group": ""}}')
    print("然后 systemctl restart backup-center")


if __name__ == "__main__":
    main()
