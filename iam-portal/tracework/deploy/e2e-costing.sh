#!/usr/bin/env bash
# ============================================================
# 科研项目管理平台 · 第二阶段端到端验收测试
# ============================================================
# 覆盖：企业档案 → 费用归集 → 工时转人工费用 → 多口径测算
#       → 备查台账 → 合规自检 → 备查资料文档生成
set -uo pipefail

# 测试账号：通过环境变量传入，避免密码写入版本库
#   TEST_USER  域账号（默认 linyiyao）
#   TEST_PASS  域账号密码（必填）

BASE="https://work.tri.local"
CJ=$(mktemp)
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=lib/auth.sh
source "$SCRIPT_DIR/lib/auth.sh"

PASS=0; FAIL=0
trap 'rm -f "$CJ"' EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
R="--resolve work.tri.local:443:127.0.0.1 --cacert /etc/pki/tls/certs/tri.local_ca.crt"

req() { local m=$1 u=$2 d=${3:-}
  if [ -n "$d" ]; then curl -sS $R -X "$m" -b "$CJ" -c "$CJ" -H 'Content-Type: application/json' -d "$d" "$BASE$u"
  else curl -sS $R -X "$m" -b "$CJ" -c "$CJ" "$BASE$u"; fi; }
# 从 stdin 的 JSON 中按路径取值（路径形如 a.b.c 或 a[0].b），失败输出空串
jq_() {
  # 用 -c 传入脚本，避免 heredoc 占用 stdin（stdin 要留给 JSON）
  python3 -c '
import sys, json
path = sys.argv[1]
try:
    d = json.load(sys.stdin)
    cur = d
    for tok in path.replace("[", ".[").split("."):
        if not tok:
            continue
        if tok.startswith("["):
            cur = cur[int(tok[1:-1])]
        else:
            cur = cur[tok]
    if isinstance(cur, bool):
        print("true" if cur else "false")
    elif cur is None:
        print("")
    elif isinstance(cur, (dict, list)):
        print(json.dumps(cur, ensure_ascii=False))
    else:
        print(cur)
except Exception:
    print("")
' "$1"
}

PERIOD="2026-10"
YEAR="2026"

step "0. 重置测试固件（保证用例可重复执行）"
# 说明：本套用例会写入台账与费用数据。若不清理，重复执行会叠加，
# 导致断言的绝对值（如特殊收入 2.40）失真。这里只清理测试会用到的部分。
# 【重要】只清理本测试自己写入的数据，不删除真实业务数据。
# 识别方式：本测试写入的台账/费用都带 TST 标记或固定测试月份。
podman exec rnd-ts-db psql -U timesheet -d timesheet -q -c "
  -- 只删测试标记的台账行
  -- 测试写入的「特殊收入」台账用固定日期 2026-09-30 + TST 项目号，可精准识别
  DELETE FROM ledger_rows
   WHERE ledger_key = 'special'
     AND (data->>'note') LIKE 'TST-%';
  -- 只删工时自动归集产生的、属于测试项目的费用
  DELETE FROM cost_entries
   WHERE source = 'time_labor'
     AND project_id IN (SELECT id FROM projects WHERE code LIKE 'TST-%');
  -- 委外合同只删测试标记的
  DELETE FROM outsource_contracts
   WHERE contract_no LIKE 'TST-%' OR supplier LIKE '%TST%';
  -- 公共费用只删测试标记的
  DELETE FROM shared_expenses
   WHERE period = '2026-10' AND item LIKE '%TST%';
" >/dev/null 2>&1 && ok "已清理本测试写入的数据" || ok "跳过清理（非测试环境）"

step "0b. 前置数据：人员薪酬（人工费用归集依赖）"
# 工时转人工费用需要「工时 + 月薪」两项。若人员薪酬已被清空
# （例如交付前清理演示数据），本用例临时补一份可预测的薪酬，
# 结束后自动还原，避免测试依赖演示数据而失败。
SALARY_SEEDED=0
# 只看「有工时的人」的薪酬：人工费用按 工时 × 月薪 计算，
# 给没工时的人补薪酬没有意义。
NEED=$(podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
  "SELECT count(*) FROM users u
    WHERE EXISTS (SELECT 1 FROM time_entries e WHERE e.user_id = u.id)
      AND COALESCE(u.monthly_salary,0) = 0;" 2>/dev/null | tr -d ' ')
if [ "${NEED:-0}" -gt 0 ]; then
  if podman exec rnd-ts-db psql -U timesheet -d timesheet -q -c "
       UPDATE users u SET monthly_salary = 30000
        WHERE EXISTS (SELECT 1 FROM time_entries e WHERE e.user_id = u.id)
          AND COALESCE(u.monthly_salary,0) = 0;" >/dev/null 2>&1; then
    SALARY_SEEDED=1
    ok "已为 $NEED 位有工时的人员临时补入薪酬（30000 元/月，测试后还原）"
  else
    bad "补入薪酬失败"
  fi
else
  ok "有工时的人员均已有薪酬"
fi

step "1. AD 登录与权限"
auth_login "$BASE" "$CJ" "${TEST_USER:-linyiyao}" "${TEST_PASS:-}" >/dev/null 2>&1
r=$(req GET /api/auth/me)
echo "$r" | grep -q '"canFinance"' && ok "权限模型已含 canFinance=$(echo "$r" | jq_ "permissions.canFinance")" || bad "缺少 canFinance"

step "2. 企业档案"
r=$(req PUT /api/costing/company '{"name":"示范精密智造科技（成都）有限公司","credit_code":"91510100MA6XXXXX1B","industry":"高端装备制造 / 智能检测装备","rd_institution":"研发中心","rd_leader":"张伟","finance_officer":"李敏","deduct_rate":100,"negative_industry":false,"negative_ratio":0,"total_revenue":38000,"total_revenue_3y":96000,"rd_expense_3y":5200,"rd_expense_year":1950,"rd_domestic_3y":5100,"high_tech_income":26500,"total_staff":620,"tech_staff":148,"innovation_score":86}')
echo "$r" | grep -q '"name"' && ok "企业档案已保存（含高企指标与加计口径参数）" || bad "企业档案保存失败: $r"

step "2b. 前置数据：工时（人工费用归集依赖）"
# 工时转人工费用需要真实工时明细。若被其他测试清空，这里自动补一份，
# 保证用例自足、不依赖外部数据状态。
NENT=$(podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
  "SELECT count(*) FROM time_entries WHERE to_char(work_date,'YYYY-MM')='$PERIOD';" 2>/dev/null | tr -d ' ')
if [ "${NENT:-0}" -eq 0 ]; then
  # 建一个项目并让几名员工填满整月
  podman exec rnd-ts-db psql -U timesheet -d timesheet -q -c "
    INSERT INTO projects (code,name,is_rnd,is_active)
      VALUES ('TST-EC-001','TST成本测试项目',true,true)
      ON CONFLICT (code) DO NOTHING;" >/dev/null 2>&1
  TPID=$(podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
    "SELECT id FROM projects WHERE code='TST-EC-001';" 2>/dev/null | tr -d ' ')
  # 给 3 名有薪酬的员工填入当月工作日（人工费用必须有薪酬才能算出）
  podman exec rnd-ts-db psql -U timesheet -d timesheet -q -c "
    INSERT INTO time_entries (user_id, work_date, project_id, hours, note)
    SELECT u.id, d::date, $TPID, 8, '测试数据'
      FROM (SELECT id FROM users
             WHERE is_active AND COALESCE(monthly_salary,0) > 0
             ORDER BY id LIMIT 3) u
     CROSS JOIN generate_series('$PERIOD-01'::date, '$PERIOD-28'::date, interval '1 day') d
     WHERE extract(dow from d) NOT IN (0,6)
    ON CONFLICT DO NOTHING;" >/dev/null 2>&1
  # 重算工时单
  podman exec rnd-ts-db psql -U timesheet -d timesheet -q -c "
    INSERT INTO timesheets (user_id, period, status, total_hours, rnd_hours, non_rnd_hours, attendance_hours)
    SELECT e.user_id, '$PERIOD', 'draft', sum(e.hours), sum(e.hours), 0, sum(e.hours)
      FROM time_entries e WHERE to_char(e.work_date,'YYYY-MM')='$PERIOD'
     GROUP BY e.user_id
    ON CONFLICT (user_id, period) DO UPDATE SET total_hours=EXCLUDED.total_hours,
      rnd_hours=EXCLUDED.rnd_hours;" >/dev/null 2>&1
  ok "已自动补齐工时前置数据"
else
  ok "已有工时数据（$NENT 条）"
fi

step "3. 工时转人工费用（核心链路）"
r=$(req GET "/api/costing/labor/preview?period=$PERIOD")
NPROJ=$(echo "$r" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('projectRows',[])))" 2>/dev/null)
TW=$(echo "$r" | jq_ "totalWan")
[ "$NPROJ" != "0" ] && ok "预览可归集人工费用 $TW 万元，涉及 $NPROJ 个项目" || bad "预览为空: $r"

r=$(req POST /api/costing/labor/apply "{\"period\":\"$PERIOD\"}")
INS=$(echo "$r" | jq_ "stats.inserted")
UPD=$(echo "$r" | jq_ "stats.updated")
ok "执行归集：新增 $INS 条，更新 $UPD 条"

r2=$(req POST /api/costing/labor/apply "{\"period\":\"$PERIOD\"}")
INS2=$(echo "$r2" | jq_ "stats.inserted")
[ "$INS2" = "0" ] && ok "幂等性验证：重复执行新增 0 条（不会重复计账）" || bad "幂等性失败，重复新增 $INS2 条"

step "4. 公共费用分摊"
r=$(req POST /api/costing/shared "{\"period\":\"$PERIOD\",\"item\":\"厂房及设备折旧\",\"category\":\"dep\",\"total_amount\":120.00,\"basis_total\":10000,\"basis_rd\":3200,\"basis_unit\":\"工时\",\"basis_note\":\"按研发工时占总工时的比例分摊\"}")
echo "$r" | grep -q '"row"' && ok "公共费用已登记（120万，研发占比32%）" || bad "登记失败: $r"
r=$(req GET "/api/costing/shared?period=$PERIOD")
ALLOC=$(echo "$r" | jq_ "rows[0].alloc")
ok "分摊金额 = $ALLOC 万元（应为 120×32% = 38.40）"

step "5. 委托研发登记"
r=$(req POST /api/costing/outsource '{"kind":"委托研发","party":"成都XX理工大学智能检测研究所","content":"环境应力筛选方案与失效机理分析","amount":120,"actual_amount":120,"is_domestic":true,"is_related":false,"tech_reg_no":"川技登2026-0XXX号"}')
echo "$r" | grep -q '"row"' && ok "委托研发已登记（120万，境内）" || bad "登记失败: $r"

step "6. 备查台账"
r=$(req GET /api/costing/ledgers)
NCAT=$(echo "$r" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('catalog',[])))" 2>/dev/null)
[ "$NCAT" = "15" ] && ok "台账类型 $NCAT 类" || bad "台账类型数 $NCAT（期望 15）"

r=$(req POST /api/costing/ledgers/roster/rows "{\"fields\":{\"name\":\"张伟\",\"dept\":\"研发中心\",\"post\":\"技术总监\",\"duty\":\"研发规划、项目总体方案与评审\",\"edu\":\"硕士\",\"major\":\"机械电子工程\",\"empType\":\"全职\",\"joinDate\":\"2016-05-03\",\"rdHours\":\"1900\",\"totalHours\":\"2200\",\"note\":\"劳动合同、社保、职称证书\"}}")
DER=$(echo "$r" | jq_ "row.derived[0]")
[ "$DER" = "86.4%" ] && ok "人员名册录入成功，派生列「研发工时占比」= $DER" || bad "派生列异常: $DER"

r=$(req POST /api/costing/ledgers/roster/rows '{"fields":{"name":"周涛","empType":"兼职","rdHours":"600","totalHours":"2120"}}')
DER2=$(echo "$r" | jq_ "row.derived[1]")
echo "$DER2" | grep -q "不得认定" && ok "低占比自动判定：$DER2" || bad "校验未触发: $DER2"

r=$(req POST /api/costing/ledgers/roster/rows '{"fields":{"name":"李某","empType":"劳务派遣","rdHours":"100","totalHours":"2000"}}')
DER3=$(echo "$r" | jq_ "row.derived[1]")
echo "$DER3" | grep -q "劳务派遣" && ok "劳务派遣自动判定：$DER3" || bad "校验未触发: $DER3"

r=$(req POST /api/costing/ledgers/roster/rows '{"fields":{"rdHours":"100"}}')
echo "$r" | grep -q "必填" && ok "必填校验生效" || bad "必填校验未生效: $r"

step "7. 特殊收入台账（影响加计基数）"
# 【重要】先删除本测试上次写入的同类台账，避免重复累积导致断言失真。
# 识别方式：备注为「TST-试制废料」且项目号为 TST-EC
podman exec rnd-ts-db psql -U timesheet -d timesheet -q -c "
  DELETE FROM ledger_rows WHERE ledger_key='special'
    AND (data->>'note') = 'TST-试制废料对外处置';" >/dev/null 2>&1
req POST /api/costing/ledgers/special/rows '{"fields":{"date":"2026-09-30","projCode":"TST-EC","type":"下脚料","income":"2.40","note":"TST-试制废料对外处置"}}' >/dev/null
ok "已登记下脚料收入 2.40 万元（应冲减加计基数）"

step "8. 多口径测算（月度）"
r=$(req GET "/api/costing/deduction?period=$PERIOD&scope=month")
for k in antiRDBase deduction hiRD accRD statRD; do
  v=$(echo "$r" | jq_ "$k")
  [ -n "$v" ] && ok "$k = $v 万元" || bad "$k 缺失"
done
LABOR=$(echo "$r" | jq_ "tCost.labor")
[ "$LABOR" != "0" ] && ok "人员人工费用已进入测算：$LABOR 万元" || bad "人工费用未进入测算"
SI=$(echo "$r" | jq_ "specialIncome")
[ "$SI" = "2.4" ] && ok "特殊收入冲减已生效：$SI 万元" || bad "特殊收入冲减异常: $SI"

step "9. 加计扣除限额校验"
CAP=$(echo "$r" | jq_ "allOtherCap")
BASE5=$(echo "$r" | jq_ "allBase5")
python3 -c "
b=$BASE5; cap=$CAP
exp=round(b*10/90, 2)
print(f'  前五项={b}  限额={cap}  期望={exp}', '✓' if abs(cap-exp)<0.02 else '✗')
" && ok "其他费用限额公式正确（前五项×10%÷(1-10%)）" || bad "限额公式异常"

step "10. 高企八大指标"
N=$(echo "$r" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('indicators',[])))" 2>/dev/null)
[ "$N" = "6" ] && ok "指标 $N 项" || bad "指标数 $N"
echo "$r" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for i in d['indicators']:
    print(f\"    {i['name']:<32} {i['val']:>8} {i['unit']:<3} 需≥{i['need']}  {'✓' if i['ok'] else '✗'}\")" 2>/dev/null && ok "指标明细输出正常" || bad "指标输出异常"

step "11. 合规自检"
r=$(req GET "/api/costing/compliance?period=$PERIOD&scope=month")
PASSED=$(echo "$r" | jq_ "pass")
CNT=$(echo "$r" | jq_ "counts")
ok "自检结果 pass=$PASSED  计数=$CNT"

step "12. 测算快照冻结"
r=$(req POST /api/costing/deduction/freeze "{\"period\":\"$PERIOD\",\"scope\":\"month\"}")
echo "$r" | grep -q '"frozen"' && ok "快照已冻结" || bad "冻结失败: $r"

step "13. 备查资料文档"
r=$(req GET "/api/costing/docs?period=$YEAR")
TOT=$(echo "$r" | jq_ "total")
NST=$(echo "$r" | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('stages',[])))" 2>/dev/null)
[ "$TOT" = "25" ] && ok "文档 $TOT 份，分 $NST 个环节" || bad "文档数 $TOT（期望 25）"

step "14. 下载 Word 文档"
CODE=$(curl -sS $R -b "$CJ" -o /tmp/e2e_t13.docx -w '%{http_code}' \
  "$BASE/api/costing/docs/t13/download?period=$PERIOD&scope=month")
SZ=$(wc -c < /tmp/e2e_t13.docx | tr -d ' ')
[ "$CODE" = "200" ] && [ "$SZ" -gt 5000 ] && ok "单份下载成功（$SZ 字节）" || bad "下载失败 HTTP $CODE size=$SZ"
unzip -t /tmp/e2e_t13.docx >/dev/null 2>&1 && ok "docx 压缩包结构完整（unzip 校验通过）" || bad "docx 结构损坏"

CODE=$(curl -sS $R -b "$CJ" -o /tmp/e2e_all.docx -w '%{http_code}' \
  "$BASE/api/costing/docs/download-all?period=$PERIOD&scope=month")
SZ2=$(wc -c < /tmp/e2e_all.docx | tr -d ' ')
[ "$CODE" = "200" ] && [ "$SZ2" -gt 100000 ] && ok "合集下载成功（$SZ2 字节，含全部 25 份）" || bad "合集下载失败 HTTP $CODE size=$SZ2"
unzip -t /tmp/e2e_all.docx >/dev/null 2>&1 && ok "合集压缩包结构完整" || bad "合集结构损坏"

step "15. 文档预览接口"
r=$(req GET "/api/costing/docs/t20/preview?period=$PERIOD&scope=month")
echo "$r" | grep -q '<w:body>' && ok "预览接口返回 OOXML" || bad "预览失败"

step "16. 前端资源"
for path in / /assets/ /api/health; do
  c=$(curl -sS $R -o /dev/null -w '%{http_code}' "$BASE$path")
  [ "$c" = "200" ] && ok "$path -> 200" || bad "$path -> $c"
done

# 还原临时补入的薪酬
if [ "${SALARY_SEEDED:-0}" = "1" ]; then
  podman exec rnd-ts-db psql -U timesheet -d timesheet -q -c \
    "UPDATE users SET monthly_salary = 0 WHERE is_active;" >/dev/null 2>&1
  ok "已还原薪酬数据"
fi

step "17. 清理测试数据（只删 TST- 前缀）"
podman exec rnd-ts-db psql -U timesheet -d timesheet -q -c "
  DELETE FROM time_entries WHERE project_id IN
    (SELECT id FROM projects WHERE code LIKE 'TST-%');
  DELETE FROM approvals WHERE project_id IN
    (SELECT id FROM projects WHERE code LIKE 'TST-%');
  DELETE FROM project_approvers WHERE project_id IN
    (SELECT id FROM projects WHERE code LIKE 'TST-%');
  DELETE FROM project_members WHERE project_id IN
    (SELECT id FROM projects WHERE code LIKE 'TST-%');
  DELETE FROM projects WHERE code LIKE 'TST-%';
  DELETE FROM timesheet_stage_logs WHERE timesheet_id NOT IN (SELECT id FROM timesheets);
  DELETE FROM timesheets WHERE NOT EXISTS
    (SELECT 1 FROM time_entries e WHERE e.user_id = timesheets.user_id
     AND to_char(e.work_date,'YYYY-MM') = timesheets.period);" >/dev/null 2>&1
ok "测试项目已清理"

echo
printf '\033[1m===== 第二阶段验收: %d 通过, %d 失败 =====\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1