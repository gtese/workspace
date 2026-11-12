'use strict';
/**
 * ============================================================
 * 配置读取与合并（默认值 + 用户自定义）
 * ============================================================
 * 合并规则：
 *   - 用户改过：完全以用户配置为准（顺序、隐藏、增删）
 *   - 未改过：用 DEFAULT_APPS（出厂默认，随代码升级自动更新）
 *   - 版本迁移：内置应用升级（如 work 从 sso:false 变 true）后，
 *     用户配置里的旧值不会自动变 —— 用 seedVersion 判断并提示/合并
 * ============================================================
 */
const { DEFAULT_APPS, CATEGORY_ORDER_DEFAULT } = require('./apps');
const db = require('./db');

/**
 * 配置结构：
 * {
 *   version: 1,
 *   updatedAt: ISO,
 *   updatedBy: 'username',
 *   apps: [ {...}, ... ],          // 顺序即展示顺序
 *   categories: ['AI 助手', ...],  // 分组顺序
 * }
 */
function defaultConfig() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
    apps: DEFAULT_APPS.map((a) => ({ ...a })),
    categories: [...CATEGORY_ORDER_DEFAULT],
  };
}

function getConfig() {
  const saved = db.load();
  if (!saved || !Array.isArray(saved.apps)) return defaultConfig();
  // 补齐字段，兼容旧版本配置
  return {
    version: saved.version || 1,
    updatedAt: saved.updatedAt || new Date().toISOString(),
    updatedBy: saved.updatedBy || 'unknown',
    apps: saved.apps.map((a, i) => ({
      hidden: false, public: false, adminOnly: false, sso: false,
      external: false, coming: false, category: '其他', icon: '🔗', desc: '',
      ...a, id: a.id || `app-${i}`,
    })),
    categories: Array.isArray(saved.categories) && saved.categories.length
      ? saved.categories : [...CATEGORY_ORDER_DEFAULT],
  };
}

function setConfig(cfg, actor) {
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: actor || 'unknown',
    apps: cfg.apps,
    categories: cfg.categories,
  };
  db.backup(getConfig(), 'before-save');
  return db.save(next);
}

/** 恢复出厂默认（保留备份） */
function resetConfig(actor) {
  db.backup(getConfig(), 'before-reset');
  const cfg = defaultConfig();
  cfg.updatedBy = actor || 'unknown';
  return db.save(cfg);
}

/** 是否有未保存的自定义（用于前端显示"已自定义"标记） */
function isCustomized() {
  return !!db.load();
}

module.exports = { getConfig, setConfig, resetConfig, isCustomized, defaultConfig };
