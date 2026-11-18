# Keycloak 接入参数（backup-center 集中备份平台）

> 交给 IdP/Keycloak 管理员创建 client 用。服务端已就绪，只差 client 凭据。
> 系统名称：**TRI 集中备份平台（backup-center）**
> 访问域名：**https://backup.tri.local**
> Keycloak：realm **tri**，issuer `https://sso.tri.local/realms/tri`

## 1. Client 参数

| 项 | 值 |
|---|---|
| Client ID | `backup-center` |
| Client type | **Confidential**（Client authentication = ON） |
| Standard flow | ON（Authorization Code） |
| PKCE | **S256 required** |
| Implicit flow / Direct access grants / Service accounts | OFF |
| Root URL / Home URL | `https://backup.tri.local` |
| Valid redirect URIs | `https://backup.tri.local/auth/oidc/callback`（精确匹配，不要通配） |
| Web origins | `https://backup.tri.local` |
| Post logout redirect URI | `https://backup.tri.local/*` |

服务端请求的 scope：`openid profile email groups roles`。

## 2. 权限模型（Group_Roots 管理，其他员工只读）

| 身份 | 服务端角色 | 能力 |
|---|---|---|
| AD 组 `Group_Roots` 成员 | admin | 节点审批、备份计划、恢复、用户、设置、审计 |
| 其他企业员工 | viewer | 只读：查看节点/计划/快照、下载文件；不能修改、不能恢复 |
| 本地 `admin` | admin | 仅应急（IdP 故障时） |

服务端判定逻辑（大小写不敏感，兼容 `/Group_Roots` 前导斜杠）：

- `groups` 或 `roles` 中包含 `Group_Roots`；
- 或 `roles`（含 `realm_access.roles`）中包含 `backup:admin`；
- 命中任一 → admin；否则 → viewer（默认）。

## 3. 需要 IdP 侧配置的内容（二选一或都做）

### 方案 A：groups scope（推荐，直接按 AD 组判定）

- 给 client 分配 `groups` scope / Group Membership mapper；
- claim：`groups`，**full path = OFF**（值形如 `Group_Roots`），ID Token + Access Token + UserInfo 都输出；
- 无需新增业务角色。

### 方案 B：业务角色（贴合现有 ROLE_MAPPINGS 模型）

- 在 `iam-portal/oidc/deploy/scripts/configure.py` 的 `ROLE_MAPPINGS` 增加一行：

```python
"backup:admin": ["Group_Roots"],
```

- 然后 `./deploy/deploy.sh provision`（或重跑 configure.py apply）；
- 给 client 配置 realm roles mapper（claim `roles`，ID Token + Access Token + UserInfo，multivalued）；
- 服务端会把 `backup:admin` 识别为 admin。

## 4. 交付物（避免口令进聊天）

创建完成后请提供：

1. **Client ID**（预计 `backup-center`）；
2. **Client Secret**：写入 Mac 上的文件（0600），例如：
   ```bash
   umask 077; printf '%s' '<client-secret>' > ~/.keycloak-backup-center-secret
   ```
   或你指定的其他路径，告诉我路径即可；我会写入服务端 0600 配置并删除临时文件。
3. 说明采用方案 A（groups）还是方案 B（backup:admin 角色），便于验收；
4. 如方便，提供一个 `Group_Roots` 测试账号供我验证 admin 权限（也可你自己登录验证）。

## 5. 验收口径

- 登录页出现「统一身份登录（Keycloak）」；
- `Group_Roots` 成员 SSO 登录后 `/api/auth/me` 返回 `role=admin`，能看到「审批节点/新建计划/恢复」按钮；
- 非 `Group_Roots` 员工登录后 `role=viewer`，页面无写操作按钮，直接调用写接口返回 403；
- 登出后回到 `https://backup.tri.local/login`。

## 6. 服务端已具备的能力

- OIDC 授权码 + PKCE(S256) + state/nonce + JWKS RS256 验签；
- 支持 `groups`、`roles`、`realm_access.roles` 三种 claim 形态；
- OIDC 用户自动创建/更新，角色每次登录刷新；
- 本地 admin 与 SSO 并存（应急）。

> 也可由我用 `deploy/keycloak-setup.py` 完成（需要 Keycloak 管理员访问）：创建 client、mapper、`backup:admin` 角色并授予 `Group_Roots`。你只需提供管理员访问方式或直接运行该脚本。
