'use strict';
/**
 * ============================================================
 * 门户配置存储（JSON 文件，原子写入 + 内存缓存）
 * ============================================================
 * 为什么用文件而不是数据库：
 *   门户只需存一份「应用列表 + 排序 + 可见性」，数据量极小（几 KB），
 *   引入 PostgreSQL 会让备份/迁移复杂化。文件放数据卷，随容器重建保留。
 *
 * 写入流程：写临时文件 → fsync → rename 覆盖（原子，不会写出半截 JSON）
 * 并发：单进程串行写（Node 单线程 + 写锁标志）。
 * ============================================================
 */
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'portal-config.json');

let cache = null;
let writing = false;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o755 });
}

/** 原子写：tmp → rename */
function writeAtomic(file, obj) {
  ensureDir();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w', 0o644);
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function load() {
  if (cache) return cache;
  ensureDir();
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      cache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return cache;
    } catch (e) {
      // 文件损坏：保留原文件供排查，回落到默认配置
      const bad = `${CONFIG_FILE}.corrupt-${Date.now()}`;
      try { fs.renameSync(CONFIG_FILE, bad); } catch { /* ignore */ }
      console.error('[db] 配置文件损坏，已改名备份:', bad, e.message);
    }
  }
  return null;
}

function save(cfg) {
  if (writing) throw new Error('配置正在保存，请稍后重试');
  writing = true;
  try {
    writeAtomic(CONFIG_FILE, cfg);
    cache = cfg;
  } finally {
    writing = false;
  }
  return cfg;
}

/** 备份历史（保留最近若干份，便于误操作后恢复） */
function backup(cfg, tag) {
  ensureDir();
  const dir = path.join(DATA_DIR, 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag}.json`);
  writeAtomic(file, cfg);
  // 只保留最近 30 份
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 30))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
  }
}

module.exports = { load, save, backup, CONFIG_FILE, DATA_DIR };
