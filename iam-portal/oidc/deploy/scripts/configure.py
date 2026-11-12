#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Keycloak 幂等配置工具（替代 keycloak-config-cli，避免额外镜像依赖）。

为什么不用 keycloak-config-cli：
  本环境外网受限，Keycloak 官方发行版以外的镜像难以稳定获取；
  本脚本只依赖 Python 3 标准库，覆盖本项目实际需要的配置面，
  并且每一步都做了「已存在则更新、不存在则创建」的幂等处理。

命令：
  apply   —— 根据环境变量完整配置 realm（幂等，可重复执行）
  sync-groups —— 只重新物化 AD 组成员关系（修改角色模型后必跑）
  verify-admin —— 只校验管理员账号能否登录（供 deploy.sh 判断是否需要 bootstrap）
  verify  —— 只读校验：AD 连接、用户同步、角色映射、client、事件
  dump    —— 导出当前 realm 配置到 deploy/realm/exported-realm.json（只读参考）

环境变量（见 deploy/.env.example）：
  KC_BASE_URL          Keycloak 对外地址，默认 https://sso.tri.local
  KC_ADMIN_USER / KC_ADMIN_PASSWORD   管理控制台账号
  KC_REALM             默认 tri
  LDAP_URL / LDAP_BASE_DN / LDAP_BIND_DN / LDAP_BIND_PASSWORD
  LDAP_ALLOWED_GROUP   准入 AD 组，默认 Group_AllStaffs
  OIDC_CLIENT_SECRET_MAN / _KB / _CHAT / _SLURM / _PORTAL / _OOD
  KC_CA_FILE           校验 sso.tri.local 所用 CA（默认系统信任库）
  DRY_RUN=1            只打印将要做的变更，不写入

退出码：0 成功；1 配置失败；2 校验不通过。
"""

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
LDAP_URL = os.environ.get("LDAP_URL", "ldaps://tri-sh-dc01.tri.local:636")
LDAP_BASE_DN = os.environ.get("LDAP_BASE_DN", "DC=tri,DC=local")
LDAP_BIND_DN = os.environ.get("LDAP_BIND_DN", "")
LDAP_BIND_PASSWORD = os.environ.get("LDAP_BIND_PASSWORD", "")
LDAP_ALLOWED_GROUP = os.environ.get("LDAP_ALLOWED_GROUP", "Group_AllStaffs")
DRY_RUN = os.environ.get("DRY_RUN", "") in ("1", "true", "yes")
CA_FILE = os.environ.get("KC_CA_FILE", "")
VERBOSE = os.environ.get("VERBOSE", "") in ("1", "true", "yes")

CLIENT_SECRETS = {
    "man-timesheet": os.environ.get("OIDC_CLIENT_SECRET_MAN", ""),
    "knowledge-hub": os.environ.get("OIDC_CLIENT_SECRET_KB", ""),
    "chat-openwebui": os.environ.get("OIDC_CLIENT_SECRET_CHAT", ""),
    "slurm-web": os.environ.get("OIDC_CLIENT_SECRET_SLURM", ""),
    "portal": os.environ.get("OIDC_CLIENT_SECRET_PORTAL", ""),
    "ood": os.environ.get("OIDC_CLIENT_SECRET_OOD", ""),
}

# ---------------------------------------------------------------- 组 → 角色映射
# 这是整个方案里唯一维护「谁拥有什么业务角色」的地方（见方案文档 §2.4）。
# 修改后重新执行 `configure.py apply` 即可生效，无需重启 Keycloak。
ROLE_MAPPINGS = {
    # 业务角色        : 授予这些 AD 组（CN，不区分大小写）
    "kb:admin":         ["Group_Roots"],
    "kb:reviewer":      ["Group_KBReviewers", "Group_Roots"],   # Group_KBReviewers 尚未建组时用 Group_Roots 兜底
    "ts:admin":         ["Group_Roots"],
    "ts:finance":       ["Group_Finance", "Group_Roots"],
    "cluster:admin":    ["Group_Roots"],
}

# 不导入 Keycloak 的 AD 组（内建管理组会把域管的全部能力带进来，且数量大）
SKIP_GROUPS = {
    "Administrators", "Domain Admins", "Enterprise Admins", "Schema Admins",
    "Domain Controllers", "Read-only Domain Controllers", "Enterprise Read-only Domain Controllers",
    "DnsAdmins", "Backup Operators", "Server Operators", "Account Operators",
    "Print Operators", "Group Policy Creator Owners", "Protected Users",
    "Remote Desktop Users", "Denied RODC Password Replication Group", "Certificate Service DCOM Access",
}


# ---------------------------------------------------------------- HTTP 基础设施
def _opener():
    ctx = ssl.create_default_context(cafile=CA_FILE or None)
    return urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))


OPENER = _opener()


def http(method, path, body=None, token=None, form=False, expect=None):
    url = BASE + path
    data = None
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with OPENER.open(req, timeout=120) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        if expect and e.code in expect:
            return e.code, raw
        raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {raw[:400]}")


def admin_token():
    if not ADMIN_PASS:
        throw("未设置 KC_ADMIN_PASSWORD（见 deploy/.env）")
    st, body = http("POST", "/realms/master/protocol/openid-connect/token", {
        "client_id": "admin-cli", "username": ADMIN_USER,
        "password": ADMIN_PASS, "grant_type": "password"}, form=True)
    return body["access_token"]


def throw(msg):
    raise SystemExit("✗ " + msg)


def log(msg):
    print(msg, flush=True)


def plan(msg):
    print(("  [dry-run] " if DRY_RUN else "  → ") + msg, flush=True)


# ---------------------------------------------------------------- realm / 组件
def ensure_realm(T):
    st, _ = http("GET", f"/admin/realms/{REALM}", token=T, expect=(404,))
    if st == 200:
        plan(f"realm '{REALM}' 已存在，跳过创建")
        return
    plan(f"创建 realm '{REALM}'")
    if not DRY_RUN:
        http("POST", "/admin/realms", {
            "realm": REALM, "enabled": True, "displayName": "TRI 统一身份",
            "sslRequired": "external", "registrationAllowed": False,
            "loginWithEmailAllowed": True, "resetPasswordAllowed": False,
            "bruteForceProtected": True, "failureFactor": 5,
            "ssoSessionIdleTimeout": 28800, "ssoSessionMaxLifespan": 86400,
            "clientSessionIdleTimeout": 28800, "clientSessionMaxLifespan": 86400,
            "accessTokenLifespan": 300, "defaultSignatureAlgorithm": "RS256",
            "attributes": {"frontendUrl": BASE},
            "eventsEnabled": True, "eventsExpiration": 15552000,
            "eventsListeners": ["jboss-logging"],
            "adminEventsEnabled": True, "adminEventsDetailsEnabled": True,
        }, token=T)


def components(T, ptype=None):
    path = f"/admin/realms/{REALM}/components" + (f"?type={ptype}" if ptype else "")
    st, body = http("GET", path, token=T)
    return body


def find_provider(T):
    for c in components(T, "org.keycloak.storage.UserStorageProvider"):
        if c.get("name") == "AD":
            return c
    return None


def ensure_ldap(T):
    """LDAP 用户联邦：以 AD 为准，只读。前置条件：镜像已包含企业根 CA。"""
    cfg = {
        "enabled": ["true"], "priority": ["0"], "vendor": ["ad"], "editMode": ["READ_ONLY"],
        "connectionUrl": [LDAP_URL], "bindDn": [LDAP_BIND_DN],
        "bindCredential": [LDAP_BIND_PASSWORD],
        "useTruststoreSpi": ["ldapsOnly"], "connectionTimeout": ["10000"],
        "startTls": ["false"], "authType": ["simple"],
        "usersDn": [LDAP_BASE_DN],
        "userObjectClasses": ["person, organizationalPerson, user"],
        "usernameLDAPAttribute": ["sAMAccountName"],
        "rdnLDAPAttribute": ["cn"], "uuidLDAPAttribute": ["objectGUID"],
        "searchScope": ["2"], "pagination": ["true"], "batchSizeForSync": ["1000"],
        "importEnabled": ["true"], "syncRegistrations": ["true"],
        "validatePasswordPolicy": ["false"], "trustEmail": ["true"],
        "allowKerberosAuthentication": ["false"], "debug": ["false"],
        "connectionPooling": ["true"],
    }
    # 先做连通性自检，失败直接报错（比导入后才报错更直观）
    plan("测试 AD LDAPS 连接")
    if not DRY_RUN:
        st, body = http("POST", f"/admin/realms/{REALM}/testLDAPConnection", {
            "action": "testConnection", "connectionUrl": LDAP_URL,
            "bindDn": LDAP_BIND_DN, "bindCredential": LDAP_BIND_PASSWORD,
            "useTruststoreSpi": "ldapsOnly", "connectionTimeout": "10000",
            "startTls": False}, token=T, expect=(204, 400))
        if st != 204:
            throw(f"AD 连接失败：{body}。请确认镜像已内置企业根 CA（docker/keycloak/Containerfile）")
    prov = find_provider(T)
    # 注意：provider 的 parentId 必须是 realm 的 **内部 id**（uuid），不是 realm 名称，
    # 否则同步会报 "Realm with id tri not found"（部署文档 §排障会记录这个坑）。
    st, realm = http("GET", f"/admin/realms/{REALM}", token=T)
    if prov:
        plan("更新 LDAP 用户联邦（AD）")
        if not DRY_RUN:
            prov["config"] = cfg
            if prov.get("parentId") != realm["id"]:
                prov["parentId"] = realm["id"]
            http("PUT", f"/admin/realms/{REALM}/components/{prov['id']}", prov, token=T)
    else:
        plan("创建 LDAP 用户联邦（AD）")
        if not DRY_RUN:
            http("POST", f"/admin/realms/{REALM}/components", {
                "name": "AD", "providerId": "ldap",
                "providerType": "org.keycloak.storage.UserStorageProvider",
                "parentId": realm["id"], "config": cfg}, token=T)


def ensure_group_mapper(T):
    """AD 组 → Keycloak 组。

    实测结论：TCP 后端下 *嵌套组推导*（preserve.group.inheritance=true）会让 AD 的
    「Administrators」等内建组引用 DN 不存在的成员而失败，且 AD 嵌套组展开在
    2000+ 对象时很慢。这里关闭继承、跳过内建组，直接用 memberOf 解析每人的组。
    """
    prov = find_provider(T)
    target = None
    for c in components(T, "org.keycloak.storage.ldap.mappers.LDAPStorageMapper"):
        if c.get("parentId") == prov["id"] and c.get("providerId") == "group-ldap-mapper":
            target = c
            break
    cfg = {
        "groups.dn": [LDAP_BASE_DN], "group.name.ldap.attribute": ["cn"],
        "group.object.classes": ["group"], "preserve.group.inheritance": ["false"],
        "membership.ldap.attribute": ["member"], "membership.attribute.type": ["DN"],
        "membership.user.ldap.attribute": ["memberOf"],
        "groups.path": ["/"], "mode": ["READ_ONLY"],
        "user.roles.retrieve.strategy": ["LOAD_GROUPS_BY_MEMBER_ATTRIBUTE"],
        "group.filter": ["(!(cn=Administrators))"],
    }
    if target:
        plan("更新 AD 组映射（group-ldap-mapper）")
        if not DRY_RUN:
            target["config"] = cfg
            http("PUT", f"/admin/realms/{REALM}/components/{target['id']}", target, token=T)
    else:
        plan("创建 AD 组映射（group-ldap-mapper）")
        if not DRY_RUN:
            http("POST", f"/admin/realms/{REALM}/components", {
                "name": "AD Groups", "providerId": "group-ldap-mapper",
                "providerType": "org.keycloak.storage.ldap.mappers.LDAPStorageMapper",
                "parentId": prov["id"], "config": cfg}, token=T)


def ensure_verify_client(T):
    """验收用公开 client（授权码 + PKCE）。仅用于 verify-oidc.py，可随时禁用。"""
    cid = "oidc-verify"
    st, body = http("GET", f"/admin/realms/{REALM}/clients?clientId={cid}", token=T)
    spec = {
        "clientId": cid, "name": "OIDC 验收客户端", "enabled": True, "protocol": "openid-connect",
        "publicClient": True, "standardFlowEnabled": True, "implicitFlowEnabled": False,
        "directAccessGrantsEnabled": False,
        "redirectUris": ["https://sso.tri.local/oidc/callback"],
        "webOrigins": ["+"],
        "attributes": {"pkce.code.challenge.method": "S256",
                       "post.logout.redirect.uris": "https://sso.tri.local/*"},
    }
    if body:
        plan("更新 client oidc-verify（验收用）")
        if not DRY_RUN:
            spec["id"] = body[0]["id"]
            http("PUT", f"/admin/realms/{REALM}/clients/{body[0]['id']}", spec, token=T)
    else:
        plan("创建 client oidc-verify（验收用）")
        if not DRY_RUN:
            http("POST", f"/admin/realms/{REALM}/clients", spec, token=T)


def ensure_roles(T):
    for name, desc in [("ts:admin", "工时系统管理员"), ("ts:finance", "工时系统财务角色"),
                       ("kb:admin", "知识平台管理员"), ("kb:reviewer", "知识审核人"),
                       ("cluster:admin", "集群管理后台管理员")]:
        st, _ = http("GET", f"/admin/realms/{REALM}/roles/{urllib.parse.quote(name)}", token=T, expect=(404,))
        if st == 404:
            plan(f"创建 realm 角色 {name}")
            if not DRY_RUN:
                http("POST", f"/admin/realms/{REALM}/roles", {"name": name, "description": desc}, token=T)


def ensure_group_claims_scope(T):
    """群组 claim 只在 userinfo 里给，不进 ID Token（避免 Cookie 膨胀，见方案 §2.2）。"""
    st, body = http("GET", f"/admin/realms/{REALM}/client-scopes", token=T)
    existing = [s for s in body if s.get("name") == "roles"]
    if not existing:
        plan("创建 client scope 'roles'（业务角色 claim）")
        if not DRY_RUN:
            http("POST", f"/admin/realms/{REALM}/client-scopes", {
                "name": "roles", "protocol": "openid-connect",
                "attributes": {"include.in.token.scope": "true", "display.on.consent.screen": "false"},
                "protocolMappers": [{
                    "name": "realm roles", "protocol": "openid-connect",
                    "protocolMapper": "oidc-usermodel-realm-role-mapper",
                    "config": {"claim.name": "realm_access.roles", "jsonType.label": "String",
                               "multivalued": "true", "access.token.claim": "true",
                               "id.token.claim": "true", "userinfo.token.claim": "true"}}]}, token=T)
    # 默认 scope 里加 roles，让所有 client 都能拿到业务角色
    st, body = http("GET", f"/admin/realms/{REALM}/default-default-client-scopes", token=T)
    if not any(s.get("name") == "roles" for s in body):
        st, scopes = http("GET", f"/admin/realms/{REALM}/client-scopes", token=T)
        sid = [s["id"] for s in scopes if s.get("name") == "roles"]
        if sid and not DRY_RUN:
            plan("把 'roles' 加入 realm 默认 scope")
            http("PUT", f"/admin/realms/{REALM}/default-default-client-scopes/{sid[0]}", token=T)


def ensure_clients(T):
    specs = [
        # 工时系统：2026-11 起主域名 work.tri.local（man.tri.local 兼容保留）
        ("man-timesheet", "科研项目职能支持（工时）", "https://work.tri.local", True),
        ("knowledge-hub", "企业知识平台", "https://ai.tri.local", True),
        ("chat-openwebui", "企业 AI 助手（Open WebUI）", "https://chat.tri.local", True),
        ("slurm-web", "集群管理后台", "https://cluster.tri.local", False),
        # 企业应用门户：登录后展示应用列表（见 portal 仓库）
        ("portal", "企业应用门户", "https://portal.tri.local", True),
        # 集群门户 Open OnDemand：OIDC SSO，回调 https://edas.tri.local/oidc
        ("ood", "集群门户（Open OnDemand）", "https://edas.tri.local", True),
    ]
    for cid, name, origin, enabled in specs:
        secret = CLIENT_SECRETS.get(cid, "")
        if not secret:
            throw(f"未设置 client '{cid}' 的 secret（见 .env）")
        st, body = http("GET", f"/admin/realms/{REALM}/clients?clientId={urllib.parse.quote(cid)}", token=T)
        spec = {
            "clientId": cid, "name": name, "enabled": enabled, "protocol": "openid-connect",
            "publicClient": False, "secret": secret,
            "standardFlowEnabled": True, "implicitFlowEnabled": False,
            "directAccessGrantsEnabled": False, "serviceAccountsEnabled": False,
            "rootUrl": origin, "baseUrl": "/",
            "redirectUris": [origin + "/*"], "webOrigins": [origin],
            "attributes": {
                "pkce.code.challenge.method": "S256",
                "post.logout.redirect.uris": origin + "/*",
                "backchannel.logout.session.required": "true",
                "access.token.lifespan": "300",
            },
        }
        # 工时系统同时保留 man.tri.local 兼容域名
        if cid == "man-timesheet":
            spec["redirectUris"] = ["https://work.tri.local/*", "https://man.tri.local/*"]
            spec["webOrigins"] = ["https://work.tri.local", "https://man.tri.local"]
            spec["attributes"]["post.logout.redirect.uris"] = (
                "https://work.tri.local/*##https://man.tri.local/*")
        # Open OnDemand 使用 mod_auth_openidc 2.4.x，不强制 PKCE
        if cid == "ood":
            spec["attributes"].pop("pkce.code.challenge.method", None)
        if body:
            plan(f"更新 client {cid}")
            if not DRY_RUN:
                spec["id"] = body[0]["id"]
                http("PUT", f"/admin/realms/{REALM}/clients/{body[0]['id']}", spec, token=T)
        else:
            plan(f"创建 client {cid}")
            if not DRY_RUN:
                http("POST", f"/admin/realms/{REALM}/clients", spec, token=T)


def sync_user_groups(T, quiet=False):
    """把每个用户的 AD 组「物化」为 Keycloak 的用户-组关系。

    背景（本机实测）：
      - Keycloak 的 group-ldap-mapper 下，用户所属组是**动态解析**的：
        管理端 GET /users/{id}/groups 能正确列出该用户在 AD 中的组；
      - 但令牌里的角色是按「用户-组」持久关系 + 组角色递归计算的，
        关系表为空时 realm_access.roles 也是空。
      - 因此需要把动态结果写回 Keycloak（PUT /users/{id}/groups/{gid}，幂等）。

    这一步只用 Keycloak 管理 API，不直连 AD：
    本环境的 AD 拒绝无分页的子树搜索（超时/重置连接），而 Keycloak 已自带分页。
    """
    st, users = http("GET", f"/admin/realms/{REALM}/users?briefRepresentation=true&max=1000", token=T)
    added, with_groups = 0, 0
    for u in users:
        st, groups = http("GET", f"/admin/realms/{REALM}/users/{u['id']}/groups", token=T)
        if groups:
            with_groups += 1
        if DRY_RUN:
            if groups:
                print(f"  [dry-run] {u['username']} -> {[g['name'] for g in groups]}")
            continue
        for g in groups:
            # PUT 是幂等的：已存在则无副作用
            http("PUT", f"/admin/realms/{REALM}/users/{u['id']}/groups/{g['id']}", token=T, expect=(200, 204, 409))
            added += 1
    msg = f"用户-组关系物化：{with_groups}/{len(users)} 个用户有 AD 组，写入/更新 {added} 条"
    (print if quiet else log)("  " + msg)


def ensure_groups_scope_assigned(T):
    """确保业务 client 请求了 groups scope（AD 组 → groups claim）。

    需要它的系统：目前只有工时系统（rnd-timesheet）——它的权限模型
    依赖 AD 组成员（allowlist / 财务 / 管理员判定），见接入文档。
    其它系统不要盲目开启：组 claim 只应在 userinfo 里下发（不进 ID Token）。
    """
    # 需要 groups claim 的系统（权限计算依赖 AD 组）：
    #   man-timesheet —— 准入 / 财务 / 管理员判定
    #   knowledge-hub —— 部门标识，以及「部门 / 项目组」可见范围计算
    #   chat-openwebui —— AD 组 → Open WebUI 组（知识库部门/项目组共享范围）
    #   portal        —— 门户按 AD 组收敛可见应用
    #   oidc-verify   —— 验收脚本
    clients_needing_groups = {"man-timesheet", "knowledge-hub", "chat-openwebui",
                              "oidc-verify", "portal"}
    st, scopes = http("GET", f"/admin/realms/{REALM}/client-scopes", token=T)
    gid = next((x["id"] for x in scopes if x.get("name") == "groups"), None)
    if not gid:
        plan("创建 client scope 'groups'（AD 组 claim，仅在 userinfo 下发）")
        if not DRY_RUN:
            st, _ = http("POST", f"/admin/realms/{REALM}/client-scopes", {
                "name": "groups", "protocol": "openid-connect",
                "attributes": {"include.in.token.scope": "true", "display.on.consent.screen": "false"},
                "protocolMappers": [{
                    "name": "groups", "protocol": "openid-connect",
                    "protocolMapper": "oidc-group-membership-mapper",
                    "config": {"full.path": "false", "claim.name": "groups",
                               "id.token.claim": "false", "access.token.claim": "false",
                               "userinfo.token.claim": "true"}}]}, token=T)
            st, scopes = http("GET", f"/admin/realms/{REALM}/client-scopes", token=T)
            gid = next(x["id"] for x in scopes if x.get("name") == "groups")
    for cid in clients_needing_groups:
        st, clients = http("GET", f"/admin/realms/{REALM}/clients?clientId={urllib.parse.quote(cid)}", token=T)
        if not clients:
            log(f"  ! client {cid} 不存在，跳过 groups scope 分配")
            continue
        c = clients[0]
        st, assigned = http("GET", f"/admin/realms/{REALM}/clients/{c['id']}/optional-client-scopes", token=T)
        if not any(x.get("name") == "groups" for x in assigned):
            plan(f"给 client {cid} 分配 optional scope 'groups'（请求时按需下发）")
            if not DRY_RUN:
                http("PUT", f"/admin/realms/{REALM}/clients/{c['id']}/optional-client-scopes/{gid}", token=T)


def sync_users(T):
    prov = find_provider(T)
    plan("全量同步 AD 用户与组（首次约 100 用户，秒级）")
    if DRY_RUN:
        return
    st, body = http("POST", f"/admin/realms/{REALM}/user-storage/{prov['id']}/sync?action=triggerFullSync",
                    {}, token=T, expect=(200, 400, 500))
    if st != 200:
        throw(f"用户同步失败：{body}. 常见原因：provider.parentId 不是 realm 内部 id / AD 组含无效成员")
    log("  " + str(body))
    st, n = http("GET", f"/admin/realms/{REALM}/users/count", token=T)
    n = int(n)  # 该端点返回纯文本数字而非 JSON
    log(f"  同步后 realm 内用户数：{n}")
    st, groups = http("GET", f"/admin/realms/{REALM}/groups?briefRepresentation=true&max=2000", token=T)
    log(f"  同步后组数：{len(groups)}")


def map_roles(T):
    """按 ROLE_MAPPINGS 把 AD 组（Keycloak group）映射到业务角色。

    说明：AD 组的成员在 group-ldap-mapper 下是动态解析的，因此给组挂角色 = 给成员授权，
    无需在 Keycloak 里复制成员关系。这是本方案「组 → 角色只维护一处」的实现。
    """
    st, groups = http("GET", f"/admin/realms/{REALM}/groups?briefRepresentation=true&max=2000", token=T)
    by_name = {g["name"].lower(): g for g in groups}
    for role, ad_groups in ROLE_MAPPINGS.items():
        st, r = http("GET", f"/admin/realms/{REALM}/roles/{urllib.parse.quote(role)}", token=T, expect=(404,))
        if st == 404:
            log(f"  ! 角色 {role} 不存在，跳过映射")
            continue
        for gname in ad_groups:
            g = by_name.get(gname.lower())
            if not g:
                log(f"  ! AD 组 {gname} 未同步到 Keycloak，跳过（{role}）")
                continue
            st, cur = http("GET", f"/admin/realms/{REALM}/groups/{g['id']}/role-mappings/realm", token=T)
            if any(x["name"] == role for x in cur):
                continue
            plan(f"授权：AD 组 {gname} -> 角色 {role}")
            if not DRY_RUN:
                http("POST", f"/admin/realms/{REALM}/groups/{g['id']}/role-mappings/realm",
                     [{"id": r["id"], "name": role}], token=T)


def ensure_events(T):
    st, realm = http("GET", f"/admin/realms/{REALM}", token=T)
    want = {"eventsEnabled": True, "eventsExpiration": 15552000,
            "adminEventsEnabled": True, "adminEventsDetailsEnabled": True,
            "eventsListeners": ["jboss-logging"]}
    patch = {k: v for k, v in want.items() if realm.get(k) != v}
    if patch:
        plan(f"开启审计事件：{', '.join(patch)}")
        if not DRY_RUN:
            realm.update(patch)
            http("PUT", f"/admin/realms/{REALM}", realm, token=T)


# ---------------------------------------------------------------- 命令实现
def cmd_apply():
    T = admin_token()
    log(f"== 应用 realm 配置：{REALM} @ {BASE} ==")
    ensure_realm(T)
    ensure_ldap(T)
    ensure_group_mapper(T)
    ensure_roles(T)
    ensure_group_claims_scope(T)
    ensure_clients(T)
    ensure_verify_client(T)
    ensure_groups_scope_assigned(T)
    sync_users(T)
    sync_user_groups(T)
    map_roles(T)
    ensure_events(T)
    log("== 配置完成 ==")
    log("下一步：./deploy/scripts/verify-oidc.py 做端到端验收")


def cmd_verify_admin():
    try:
        admin_token()
    except Exception as e:  # noqa: BLE001
        log(f"管理员账号不可用：{e}")
        return 3
    log("管理员账号可登录")
    return 0


def cmd_verify():
    T = admin_token()
    ok = True
    log(f"== 校验 {REALM} @ {BASE} ==")
    prov = find_provider(T)
    if not prov:
        throw("未找到 LDAP 用户联邦 provider 'AD'")
    st, realm = http("GET", f"/admin/realms/{REALM}", token=T)
    log(f"  provider.parentId = {prov.get('parentId')} / realm.id = {realm['id']}")
    ok &= prov.get("parentId") == realm["id"]
    st, n = http("GET", f"/admin/realms/{REALM}/users/count", token=T)
    n = int(n)
    log(f"  用户数：{n} " + ("✓" if n > 0 else "✗"))
    ok &= n > 0
    st, groups = http("GET", f"/admin/realms/{REALM}/groups?briefRepresentation=true&max=2000", token=T)
    log(f"  组数：{len(groups)} " + ("✓" if groups else "✗"))
    ok &= bool(groups)
    for role in ROLE_MAPPINGS:
        st, r = http("GET", f"/admin/realms/{REALM}/roles/{urllib.parse.quote(role)}", token=T, expect=(404,))
        log(f"  角色 {role}：" + ("存在" if st == 200 else "缺失"))
        ok &= st == 200
    st, clients = http("GET", f"/admin/realms/{REALM}/clients?briefRepresentation=true&max=100", token=T)
    ids = sorted(c["clientId"] for c in clients if c["clientId"] in CLIENT_SECRETS)
    log(f"  业务 client：{ids}")
    ok &= set(ids) == set(CLIENT_SECRETS)
    st, ev = http("GET", f"/admin/realms/{REALM}/events?type=LOGIN_ERROR&max=3", token=T, expect=(404,))
    log(f"  审计事件（最近登录失败样本）：{len(ev) if isinstance(ev, list) else ev}")
    log("== 校验结果：" + ("通过 ✓" if ok else "未通过 ✗") + " ==")
    return 0 if ok else 2


def cmd_dump():
    T = admin_token()
    st, realm = http("GET", f"/admin/realms/{REALM}", token=T)
    for k in ("defaultRole", "defaultRoles"):
        realm.pop(k, None)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "realm", "exported-realm.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(realm, f, ensure_ascii=False, indent=2, sort_keys=True)
    log(f"已导出：{os.path.normpath(out)}")


def main():
    global ADMIN_PASS
    if not ADMIN_PASS:
        ADMIN_PASS = os.environ.get("KC_BOOTSTRAP_ADMIN_PASSWORD", "")
        if not ADMIN_PASS:
            throw("未设置 KC_ADMIN_PASSWORD（或 KC_BOOTSTRAP_ADMIN_PASSWORD）")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "apply"
    if cmd == "apply":
        cmd_apply()
    elif cmd == "sync-groups":
        T = admin_token()
        log("== 重新物化 AD 组成员关系（切换组→角色映射后必须执行）==")
        sync_user_groups(T)
    elif cmd == "verify-admin":
        sys.exit(cmd_verify_admin())
    elif cmd == "verify":
        sys.exit(cmd_verify())
    elif cmd == "dump":
        cmd_dump()
    else:
        throw(f"未知命令：{cmd}（可用：apply / verify-admin / verify / dump）")


if __name__ == "__main__":
    main()