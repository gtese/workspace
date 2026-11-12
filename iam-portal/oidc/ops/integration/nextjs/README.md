# Next.js 系统接入 OIDC（参考）

适用于未来用 Next.js App Router 写的系统。推荐使用成熟库，不要手写：

- `openid-client`（官方推荐的 OIDC 客户端，Node 环境）
- 或 `next-auth` 的 `Keycloak` provider（`next-auth@5`）

## next-auth 配置要点

```ts
// auth.ts
import NextAuth from "next-auth";
import Keycloak from "next-auth/providers/keycloak";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Keycloak({
      clientId: process.env.OIDC_CLIENT_ID!,
      clientSecret: process.env.OIDC_CLIENT_SECRET!,
      issuer: "https://sso.tri.local/realms/tri",
      // 必须与 IdP 侧 client 的 redirectUris 完全一致
      redirectProxyUrl: "https://xxx.tri.local/api/auth/callback/keycloak",
    }),
  ],
  session: { strategy: "jwt" },          // 令牌不落浏览器
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account) {
        token.roles = ((account as any).access_token && decodeJwt((account as any).access_token).realm_access?.roles) || [];
      }
      return token;
    },
    async session({ session, token }) {
      (session as any).roles = token.roles;
      return session;
    },
  },
});
```

## 与自研系统的差异（注意）

| 项 | 说明 |
|---|---|
| 会话 | next-auth 用加密 JWT cookie，**不需要**服务端 session 表 |
| 登出 | 调 `signOut({ redirectTo })` 即可触发 IdP 登出；需要在 provider 中配置 `end_session_endpoint` |
| 角色 | 在 `jwt` 回调里从 access_token 解析 `realm_access.roles`，放进 session 供页面判断 |
| PKCE | next-auth 5 默认对 confidential client 不带 PKCE，可在 provider 上设置 `checks: ["pkce","state"]` |

## 通用提醒

- `AUTH_SECRET` 用 `openssl rand -base64 32` 生成，放 `.env`；
- 回调地址必须精确匹配 IdP 里 client 的 `redirectUris`（本项目给的是 `https://xxx.tri.local/*`，够用但不推荐生产放宽）；
- 不要在前端组件里调用 IdP 的 token 端点，全部走后端 Route Handler。
