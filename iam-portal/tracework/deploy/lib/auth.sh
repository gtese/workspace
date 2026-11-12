#!/usr/bin/env bash
# ============================================================
# 认证辅助库：自动适配 AUTH_MODE（ldap / oidc）
# ============================================================
# 背景：系统接入统一身份后，口令登录接口 POST /api/auth/login 不再存在，
# 所有测试脚本若仍用旧方式登录会全部失败。
#
# 用法：
#   source deploy/lib/auth.sh
#   auth_login "$BASE_URL" "$COOKIE_JAR" "$USERNAME" "$PASSWORD"
#
# 返回：
#   0  登录成功（cookie 已写入 $COOKIE_JAR）
#   1  登录失败
#
# 两种模式：
#   ldap：POST /api/auth/login {username,password}
#   oidc：无法用 curl 完成（需要浏览器交互），因此改用
#         「测试专用会话注入」—— 见 auth_login_oidc()。
# ============================================================

# 探测服务端认证模式
auth_mode() {
  local base="$1"
  local ca="${CA:---cacert /etc/pki/tls/certs/tri.local_ca.crt}"
  curl -sS $ca "$base/api/auth/mode" 2>/dev/null \
    | sed -n 's/.*"mode":"\([a-z]*\)".*/\1/p'
}

# 统一登录入口
auth_login() {
  local base="$1" jar="$2" user="$3" pass="$4"
  local mode
  mode=$(auth_mode "$base")
  if [ "$mode" = "oidc" ]; then
    auth_login_oidc "$base" "$jar" "$user"
  else
    local code
    code=$(curl -sS ${CA:---cacert /etc/pki/tls/certs/tri.local_ca.crt} \
      -c "$jar" -o /dev/null -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' \
      -d "{\"username\":\"$user\",\"password\":\"$pass\"}" \
      "$base/api/auth/login")
    [ "$code" = "200" ]
  fi
}

# OIDC 模式下的测试登录。
#
# 为什么不走完整的 OIDC 授权码流程？
#   · 需要浏览器交互（IdP 登录页）
#   · Keycloak 的 direct access grant 被禁用（安全加固）
#
# 因此测试改为「服务端签发测试会话」：
#   在服务器容器内调用 createSession() 生成会话 JWT，写进 cookie jar。
#   这种方式只在本机测试可用，且需要服务器访问权限。
auth_login_oidc() {
  local base="$1" jar="$2" user="$3"
  local token
  # 在容器内直接签发该用户的会话
  token=$(podman exec rnd-ts-app node --input-type=module -e "
    import { query } from '/app/src/db.js';
    import { createSession } from '/app/src/auth.js';
    const { rows } = await query('SELECT * FROM users WHERE username = \$1 AND is_active', ['$user']);
    if (!rows[0]) { console.log(''); process.exit(0); }
    const t = await createSession(rows[0]);
    console.log(t);
    const { closePool } = await import('/app/src/db.js');
    await closePool(); process.exit(0);
  " 2>/dev/null | tail -1)

  if [ -z "$token" ]; then
    echo "  auth_login_oidc: 无法为用户 $user 签发测试会话" >&2
    return 1
  fi

  # 写 cookie jar（Netscape 格式）
  local host
  host=$(echo "$base" | sed 's|https\?://||' | cut -d/ -f1)
  cat > "$jar" <<JAREOF
# Netscape HTTP Cookie File
$host	FALSE	/	TRUE	0	rnd_sid	$token
JAREOF
  return 0
}