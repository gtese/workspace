import { readFileSync, readdirSync } from 'node:fs';
const dir = 'views';
const utils = readFileSync('utils.js', 'utf8');
const exported = new Set();
for (const m of utils.matchAll(/export (?:const|function) (\w+)/g)) exported.add(m[1]);

let problems = 0;
for (const f of readdirSync(dir).filter(x => x.endsWith('.vue'))) {
  const src = readFileSync(`${dir}/${f}`, 'utf8');
  const tpl = (src.match(/<template>([\s\S]*)<\/template>/) || ['', ''])[1];
  const script = (src.match(/<script setup>([\s\S]*)<\/script>/) || ['', ''])[1];
  // 模板里用到的 utils 导出
  for (const name of exported) {
    const re = new RegExp(`\\b${name}\\b`);
    if (!re.test(tpl)) continue;
    // 检查是否在 script 中导入或定义
    const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(script);
    const defined = new RegExp(`(?:const|let|function|async function)\\s+${name}\\b`).test(script);
    if (!imported && !defined) {
      console.log(`  ✗ ${f}: 模板用了 ${name}，但既没导入也没定义`);
      problems++;
    }
  }
}
console.log(problems ? `\n发现 ${problems} 处问题` : '\n✓ 所有视图的 utils 引用均正确');
