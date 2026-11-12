#!/usr/bin/env bash
# 验证 finance 角色可被指派且权限正确
B=https://work.tri.local
R="--resolve work.tri.local:443:127.0.0.1 --cacert /etc/pki/tls/certs/tri.local_ca.crt"
CJ=/tmp/fr.txt
curl -sS $R -c $CJ -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"${TEST_USER:-linyiyao}\",\"password\":\"${TEST_PASS:?请设置 TEST_PASS 环境变量}\"}" $B/api/auth/login -o /dev/null

TARGET_ID=$(podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
  "SELECT id FROM users WHERE username='liaohonghui';" | tr -d ' ')
# 记录原角色，测试结束后恢复（避免污染真实数据）
ORIGINAL_ROLE=$(podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
  "SELECT role FROM users WHERE id=$TARGET_ID;" | tr -d ' ')

echo "=== 1. 指派 finance 角色 ==="
echo "  目标用户 liaohonghui (id=$TARGET_ID)"
echo -n "  变更前角色: "
podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
  "SELECT role FROM users WHERE id=$TARGET_ID;" | tr -d ' '

curl -sS $R -b $CJ -X PATCH -H 'Content-Type: application/json' \
  -d '{"role":"finance"}' "$B/api/admin/users/$TARGET_ID" > /tmp/patch_resp.json
python3 -c "
import json
d=json.load(open('/tmp/patch_resp.json'))
u=d.get('user') or {}
print('  PATCH 返回角色:', u.get('role','(失败)'))
"

echo
echo "=== 2. 数据库确认 ==="
podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
  "SELECT '  '||username||' -> '||role FROM users WHERE id=$TARGET_ID;"

echo
echo "=== 3. 非法角色应被拒绝 ==="
curl -sS $R -b $CJ -X PATCH -H 'Content-Type: application/json' \
  -d '{"role":"superuser"}' "$B/api/admin/users/$TARGET_ID" -w "\n  HTTP %{http_code}\n" | tail -3

echo
echo "=== 4. 恢复原角色（避免污染演示数据）==="
curl -sS $R -b $CJ -X PATCH -H 'Content-Type: application/json' \
  -d "{\"role\":\"${ORIGINAL_ROLE:-employee}\"}" "$B/api/admin/users/$TARGET_ID" -o /dev/null
podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
  "SELECT '  已恢复为 '||role FROM users WHERE id=$TARGET_ID;"

echo
echo "=== 5. 权限矩阵（按代码规则）==="
printf "  %-10s %-6s %-6s %-6s %-6s\n" 角色 审批 人事 财务 管理
for row in "admin:1:1:1:1" "hr:1:1:1:0" "finance:1:0:1:0" "pm:1:0:0:0" "employee:0:0:0:0"; do
  IFS=':' read -r r a h f m <<< "$row"
  printf "  %-10s %-6s %-6s %-6s %-6s\n" "$r" "$a" "$h" "$f" "$m"
done

echo
echo "=== 6. 前端角色下拉含 finance ==="
if podman exec rnd-ts-app sh -c "grep -q '财务部（研发费用归集' /app/web/dist/assets/AdminView-*.js"; then
  echo "  ✓ 系统管理页面可选择「财务部」角色"
else
  echo "  ✗ 前端未包含 finance 选项"
fi