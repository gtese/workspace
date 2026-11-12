#!/usr/bin/env bash
# ============================================================
# 测试数据隔离工具库
# ============================================================
# 设计原则：
#   【铁律】测试绝不删除/修改真实业务数据（项目、用户、角色、资产）
#
# 做法：
#   1. 测试自己创建的数据一律带 `TST-` 前缀（项目号）或标记，
#      结束时**只删除自己创建的**，绝不 DELETE 全表。
#   2. 需要资产时自建 `TST-ASSET-*` 测试资产，不占用真实资产。
#   3. 需要工时数据时自建测试项目+工时，不碰真实工时。
#   4. 测试用户只用已有账号登录，绝不修改其角色（需要特定角色时
#      用已具备该角色的账号，或临时建 TST 用户并在结束时删除）。
#
# 用法：
#   source "$(dirname "$0")/lib/test-fixtures.sh"
#   tf_setup            # 创建测试固件，导出 TF_PROJECT_ID / TF_USER_ID 等
#   tf_teardown         # 只清理本脚本创建的数据
# ============================================================

# ---------- 基础 ----------
TF_PREFIX="TST"                      # 所有测试数据前缀
TF_DB="${TF_DB:-rnd-ts-db}"
TF_DB_USER="${TF_DB_USER:-timesheet}"
TF_DB_NAME="${TF_DB_NAME:-timesheet}"

tf_q() {
  podman exec "$TF_DB" psql -U "$TF_DB_USER" -d "$TF_DB_NAME" -tAc "$1" 2>/dev/null | tr -d ' '
}

# 记录本脚本创建的对象，teardown 时只删这些
TF_CREATED_PROJECTS=()
TF_CREATED_ASSETS=()
TF_CREATED_USERS=()

# ---------- 项目 ----------
# 创建一个测试项目（带 TST 前缀），返回 id
# 创建测试项目，结果写入全局变量 TF_PID
# 【注意】必须用全局变量而非 echo 返回值：$(...) 会开子 shell，
# 在其中修改的数组不会带回父 shell，导致 teardown 时数组为空。
tf_project() {
  local suffix="${1:-001}"
  local code="${TF_PREFIX}-PROJ-${suffix}"
  local name="测试项目${suffix}"
  tf_q "INSERT INTO projects (code,name,is_rnd,is_active)
        VALUES ('$code','$name',true,true)
        ON CONFLICT (code) DO NOTHING;" >/dev/null
  TF_PID=$(tf_q "SELECT id FROM projects WHERE code='$code';")
  # 去重后记录
  case " ${TF_CREATED_PROJECTS[*]:-} " in
    *" $TF_PID "*) ;;
    *) TF_CREATED_PROJECTS+=("$TF_PID") ;;
  esac
}

# 给测试项目挂审批人 / 成员
tf_approvers() {
  local pid="$1"; shift
  local uid
  for uid in "$@"; do
    tf_q "INSERT INTO project_approvers (project_id,user_id)
          VALUES ($pid,$uid) ON CONFLICT DO NOTHING;" >/dev/null
  done
}

tf_members() {
  local pid="$1"; shift
  local uid
  for uid in "$@"; do
    tf_q "INSERT INTO project_members (project_id,user_id)
          VALUES ($pid,$uid) ON CONFLICT DO NOTHING;" >/dev/null
  done
}

# ---------- 资产 ----------
# 创建测试资产（TST 前缀），挂到指定用户名下
tf_asset() {
  local holder_username="$1"
  local suffix="${2:-001}"
  local no="${TF_PREFIX}-ASSET-${suffix}"
  local hid
  hid=$(tf_q "SELECT id FROM users WHERE username='$holder_username';")
  tf_q "INSERT INTO assets (asset_no,device_type,brand,model,amount,depreciation_months,
                            holder_id,status,location,note)
        VALUES ('$no','测试设备','TST品牌','TST型号',10000,36,
                $hid,'在用','测试库位','测试固件')
        ON CONFLICT (asset_no) DO NOTHING;" >/dev/null
  TF_ASSET_ID=$(tf_q "SELECT id FROM assets WHERE asset_no='$no';")
  case " ${TF_CREATED_ASSETS[*]:-} " in
    *" $TF_ASSET_ID "*) ;;
    *) TF_CREATED_ASSETS+=("$TF_ASSET_ID") ;;
  esac
}

# ---------- 重置测试账号的工时状态 ----------
# 测试账号在测试月份可能有上一轮残留（草稿/已提交/已归档），
# 会导致本轮测试无法提交。这里只重置 **测试账号自己** 在指定月份的数据。
tf_reset_sheet() {
  local username="$1"
  local period="$2"
  local uid
  uid=$(tf_q "SELECT id FROM users WHERE username='$username';")
  [ -z "$uid" ] && return 1

  # 删除该用户在该月的工时明细、工时单、审批单
  tf_q "DELETE FROM time_entries
        WHERE user_id = $uid AND to_char(work_date,'YYYY-MM') = '$period';" >/dev/null
  tf_q "DELETE FROM approvals
        WHERE timesheet_id IN (SELECT id FROM timesheets
                                WHERE user_id = $uid AND period = '$period');" >/dev/null
  tf_q "DELETE FROM timesheet_stage_logs
        WHERE timesheet_id IN (SELECT id FROM timesheets
                                WHERE user_id = $uid AND period = '$period');" >/dev/null
  tf_q "DELETE FROM timesheets WHERE user_id = $uid AND period = '$period';" >/dev/null
  return 0
}

# ---------- 清理（只删自己创建的） ----------
tf_teardown() {
  local pid id
  # 1. 删除测试项目产生的工时/审批数据
  for pid in "${TF_CREATED_PROJECTS[@]:-}"; do
    [ -z "$pid" ] && continue
    tf_q "DELETE FROM time_entries WHERE project_id = $pid;" >/dev/null
    tf_q "DELETE FROM approvals WHERE project_id = $pid;" >/dev/null
  done

  # 2. 删除测试项目的审批人/成员/项目本身
  for pid in "${TF_CREATED_PROJECTS[@]:-}"; do
    [ -z "$pid" ] && continue
    tf_q "DELETE FROM project_approvers WHERE project_id = $pid;" >/dev/null
    tf_q "DELETE FROM project_members WHERE project_id = $pid;" >/dev/null
    tf_q "DELETE FROM projects WHERE id = $pid;" >/dev/null
  done

  # 3. 删除测试资产
  for id in "${TF_CREATED_ASSETS[@]:-}"; do
    [ -z "$id" ] && continue
    tf_q "DELETE FROM asset_assignments WHERE asset_id = $id;" >/dev/null
    tf_q "DELETE FROM assets WHERE id = $id;" >/dev/null
  done

  # 4. 删除测试用户
  for id in "${TF_CREATED_USERS[@]:-}"; do
    [ -z "$id" ] && continue
    tf_q "DELETE FROM project_members WHERE user_id = $id;" >/dev/null
    tf_q "DELETE FROM project_approvers WHERE user_id = $id;" >/dev/null
    tf_q "DELETE FROM users WHERE id = $id;" >/dev/null
  done

  # 4.5 兜底：按 TST-PROJ- 前缀清理所有测试项目
  #      （防止因调用方式导致数组未记录而残留）
  local tp
  for tp in $(tf_q "SELECT id FROM projects WHERE code LIKE 'TST-PROJ-%';" | tr ' ' '\n'); do
    [ -z "$tp" ] && continue
    tf_q "DELETE FROM time_entries WHERE project_id = $tp;" >/dev/null
    tf_q "DELETE FROM approvals WHERE project_id = $tp;" >/dev/null
    tf_q "DELETE FROM project_approvers WHERE project_id = $tp;" >/dev/null
    tf_q "DELETE FROM project_members WHERE project_id = $tp;" >/dev/null
    tf_q "DELETE FROM projects WHERE id = $tp;" >/dev/null
  done
  # 兜底清理 TST 前缀的测试资产
  for tp in $(tf_q "SELECT id FROM assets WHERE asset_no LIKE 'TST-ASSET-%';" | tr ' ' '\n'); do
    [ -z "$tp" ] && continue
    tf_q "DELETE FROM asset_assignments WHERE asset_id = $tp;" >/dev/null
    tf_q "DELETE FROM assets WHERE id = $tp;" >/dev/null
  done

  # 5. 清理因测试产生的空工时单（无明细的）
  tf_q "DELETE FROM timesheets t
        WHERE NOT EXISTS (SELECT 1 FROM time_entries e WHERE e.user_id = t.user_id
                          AND to_char(e.work_date,'YYYY-MM') = t.period)
          AND t.total_hours = 0;" >/dev/null 2>&1

  TF_CREATED_PROJECTS=()
  TF_CREATED_ASSETS=()
  TF_CREATED_USERS=()
}

# ---------- 安全检查 ----------
# 断言：真实数据未被改动（在测试前后各调用一次，比对数量）
tf_snapshot() {
  tf_q "SELECT
    (SELECT count(*) FROM projects) || '|' ||
    (SELECT count(*) FROM assets) || '|' ||
    (SELECT count(*) FROM users) || '|' ||
    (SELECT count(*) FROM project_approvers) || '|' ||
    (SELECT count(*) FROM project_members);"
}

tf_assert_real_untouched() {
  local before="$1" after
  after=$(tf_snapshot)
  if [ "$before" = "$after" ]; then
    tf_ok "真实数据未被改动（项目/资产/用户/审批人/成员 数量一致）"
    return 0
  else
    tf_bad "真实数据被改动！前=$before 后=$after"
    return 1
  fi
}

tf_ok()  { printf '    \033[32m✓\033[0m %s\n' "$*"; }
tf_bad() { printf '    \033[31m✗\033[0m %s\n' "$*"; }
tf_info(){ printf '    \033[36m·\033[0m %s\n' "$*"; }