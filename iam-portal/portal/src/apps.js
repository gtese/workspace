'use strict';
/**
 * ============================================================
 * 应用清单：内置默认值 + 用户自定义（存 data/portal-config.json）
 * ============================================================
 * 两种编辑方式：
 *   1) 门户页面右下角「编辑」（管理员）：拖动排序、显示/隐藏、增删改卡片
 *   2) 直接改本文件里的 DEFAULT_APPS（出厂默认，用户未改过时生效）
 *
 * 字段：
 *   id         唯一标识（不含空格/斜杠；用户新增时自动生成）
 *   name/desc  标题与说明
 *   url        https 地址
 *   icon       emoji 或单个字符
 *   category   分组名（自定义）
 *   external   新标签页打开
 *   coming     未上线（置灰）
 *   sso        已接入统一身份（免登录）
 *   public     未登录时也展示（如"知识库"这类公开页）
 *   adminOnly  仅管理员可见（sso 角色里任意 *:admin）
 *   hidden     被管理员隐藏
 * ============================================================
 */

const DEFAULT_APPS = [
  {
    id: 'chat',
    name: '企业 AI 助手',
    desc: '问技术问题、查公司资料，回答带引用出处',
    url: 'https://chat.tri.local',
    icon: '💬',
    category: 'AI 助手',
    sso: true,
  },
  {
    id: 'work',
    name: '科研项目职能支持',
    desc: '工时填报、项目审批、研发费用归集与备查资料',
    url: 'https://work.tri.local',
    icon: '📊',
    category: '研发',
    // 2026-11-04 已接入统一身份（AUTH_MODE=oidc）
    sso: true,
  },
  {
    id: 'gitlab',
    name: '代码与文档仓库',
    desc: 'GitLab：代码托管、README 文档自动同步进知识库',
    url: 'https://git.tri.local',
    icon: '🐙',
    category: '研发',
    external: true,
    sso: false,
  },
  {
    id: 'slurm',
    name: '集群门户（Open OnDemand）',
    desc: '查看节点/作业、提交作业、文件管理与远程桌面',
    url: 'https://edas.tri.local',
    icon: '⚙️',
    category: '运维',
    external: true,
    // 2026-11-09 已接入统一身份（OIDC SSO）
    sso: true,
  },
];

const CATEGORY_ORDER_DEFAULT = ['AI 助手', '研发', '运维', '文档', '其他'];

/** 校验并清洗一条应用（用于接收前端提交的数据） */
function sanitizeApp(raw, fallbackId) {
  const out = {};
  const id = String(raw.id || fallbackId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error(`应用 id 不合法：${id}`);
  out.id = id;

  const name = String(raw.name || '').trim();
  if (!name) throw new Error('应用名称不能为空');
  if (name.length > 40) throw new Error('应用名称过长（≤40 字）');
  out.name = name;

  out.desc = String(raw.desc || '').trim().slice(0, 120);

  const url = String(raw.url || '').trim();
  let u;
  try { u = new URL(url); } catch { throw new Error(`应用 ${name} 的地址不是合法 URL`); }
  if (u.protocol !== 'https:') throw new Error(`应用 ${name} 的地址必须是 https`);
  out.url = url;

  out.icon = String(raw.icon || '🔗').slice(0, 8);
  out.category = String(raw.category || '其他').trim().slice(0, 20) || '其他';
  out.external = !!raw.external;
  out.coming = !!raw.coming;
  out.sso = !!raw.sso;
  out.public = !!raw.public;
  out.adminOnly = !!raw.adminOnly;
  out.hidden = !!raw.hidden;
  return out;
}

module.exports = { DEFAULT_APPS, CATEGORY_ORDER_DEFAULT, sanitizeApp };
