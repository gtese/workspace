/**
 * 静态检查：后端源码中是否调用了「本项目模块导出但未导入」的函数。
 *
 * 背景：曾出现 routes.js 里直接用 query() 但没从 db.js 导入，
 * 导致 /api/version 返回 500。node --check 查不出这类问题。
 *
 * 精确定位做法：
 *   1. 收集各模块的全部导出名（db.js / repo.js / service.js 等）
 *   2. 对每个文件，找出「调用了这些名字」但「既没导入也没本地定义」的情况
 *   这样可避免把 SQL 字符串里的 to_char() 等误报为问题。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] || 'src';

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (f.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);

// 1) 收集所有模块的导出名
const exportedBy = new Map();   // name -> [modules]
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var|class)\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  for (const n of names) {
    if (!exportedBy.has(n)) exportedBy.set(n, []);
    exportedBy.get(n).push(file);
  }
}

let problems = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // 去掉字符串字面量与注释，避免 SQL/文本误报
  const stripped = src
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // 已导入
  const imported = new Set();
  for (const m of src.matchAll(/import\s+\{([^}]+)\}\s+from/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) imported.add(n);
    }
  }
  for (const m of src.matchAll(/const\s+\{([^}]+)\}\s*=\s*await\s+import/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':').pop().split('=')[0].trim();
      if (n) imported.add(n);
    }
  }

  // 本文件定义
  const defined = new Set();
  for (const m of stripped.matchAll(/(?:async\s+)?function\s+(\w+)/g)) defined.add(m[1]);
  for (const m of stripped.matchAll(/(?:const|let|var)\s+(\w+)/g)) defined.add(m[1]);
  for (const m of stripped.matchAll(/class\s+(\w+)/g)) defined.add(m[1]);
  for (const m of stripped.matchAll(/(?:const|let|var)\s+\{([^}]+)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':').pop().split('=')[0].trim();
      if (n) defined.add(n);
    }
  }

  // 检查：本项目某模块导出、本文件调用了、但没导入也没定义
  for (const [name, mods] of exportedBy) {
    if (imported.has(name) || defined.has(name)) continue;
    // 排除本文件自己的导出
    if (mods.includes(file)) continue;
    // 裸调用 name(
    const re = new RegExp(`(^|[^.\\w$])${name}\\s*\\(`, 'm');
    if (!re.test(stripped)) continue;

    const idx = stripped.search(re);
    const line = stripped.slice(0, idx).split('\n').length;
    console.log(`  ✗ ${file}:${line}  调用了 \`${name}()\` 但未导入（来自 ${mods.join(', ')}）`);
    problems++;
  }
}

console.log(problems ? `\n发现 ${problems} 处未导入的跨模块调用` : '\n✓ 未发现未导入的跨模块调用');
process.exit(problems ? 1 : 0);
