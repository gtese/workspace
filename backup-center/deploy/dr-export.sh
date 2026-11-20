#!/usr/bin/env bash
# backup-center 控制面离线导出：master.key / backup.db(VACUUM INTO) / ca/ / config / TLS
# 加密后写入两个已挂载的目标目录；需要 /etc/backup-center/dr.pass（0600）。
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/backup-center}"
CONF_DIR="${CONF_DIR:-/etc/backup-center}"
NODE_BIN="${NODE_BIN:-/opt/backup-center/bin/node}"
DEST1="${DEST1:-/data2/backup/dr-control}"
DEST2="${DEST2:-/mnt/backup-center/dr-control}"
PASSFILE="${PASSFILE:-/etc/backup-center/dr.pass}"
KEEP="${KEEP:-30}"
TS="$(date +%Y%m%d-%H%M%S)"

log() { echo "[dr-export] $*"; }
die() { echo "[dr-export] ERROR: $*" >&2; exit 1; }

[[ -r "$PASSFILE" ]] || die "缺少口令文件 $PASSFILE（0600）"
command -v openssl >/dev/null || die "缺少 openssl"
[[ -d "$DEST1" ]] || mkdir -p "$DEST1" 2>/dev/null || die "DEST1 不可用: $DEST1"
[[ -d "$DEST2" ]] || die "DEST2 不存在/未挂载: $DEST2（先挂载 NAS/USB）"

STG="$(mktemp -d "${TMPDIR:-/tmp}/bc-dr-XXXXXX")"
trap 'rm -rf "$STG"' EXIT
mkdir -p "$STG/ca" "$STG/tls"
chmod 700 "$STG"

log "DB 一致性快照"
OUT="$STG/backup.db" DATA_DIR="$DATA_DIR" "$NODE_BIN" -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.DATA_DIR+"/backup.db");
db.exec("VACUUM INTO \x27"+process.env.OUT.replace(/\x27/g,"\x27\x27")+"\x27");
'

cp -a "$DATA_DIR/master.key" "$STG/master.key"
cp -a "$DATA_DIR/ca/." "$STG/ca/"
[[ -f "$CONF_DIR/config.json" ]] && cp -a "$CONF_DIR/config.json" "$STG/config.json"
[[ -d "$CONF_DIR/tls" ]] && cp -a "$CONF_DIR/tls/." "$STG/tls/" || true

cat > "$STG/README.txt" <<TXT
backup-center 控制面离线恢复材料
导出时间: $TS
来源主机: $(hostname) ($DATA_DIR)
内容: master.key, backup.db, ca/, config.json(如有), tls/(如有)
恢复: 停 backup-center -> 覆盖 master.key/backup.db/ca/(config/tls) -> chown backup:backup -> 启动
TXT
chmod -R go-rwx "$STG"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/bc-dr-out-XXXXXX")"
trap 'rm -rf "$STG" "$TMP"' EXIT
tar -C "$STG" -czf "$TMP/backup-center-dr-$TS.tar.gz" .
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$PASSFILE" \
  -in "$TMP/backup-center-dr-$TS.tar.gz" -out "$TMP/backup-center-dr-$TS.tar.gz.enc"
( cd "$TMP" && sha256sum "backup-center-dr-$TS.tar.gz.enc" > "backup-center-dr-$TS.tar.gz.enc.sha256" )

for d in "$DEST1" "$DEST2"; do
  mkdir -p "$d"
  cp -f "$TMP/backup-center-dr-$TS.tar.gz.enc" "$d/"
  cp -f "$TMP/backup-center-dr-$TS.tar.gz.enc.sha256" "$d/"
  cp -f "$STG/README.txt" "$d/README.txt"
  ( cd "$d" && sha256sum -c "backup-center-dr-$TS.tar.gz.enc.sha256" >/dev/null ) || die "校验失败: $d"
  ls -1t "$d"/backup-center-dr-*.tar.gz.enc 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
  log "写入并校验: $d"
done
log "完成 $TS"
