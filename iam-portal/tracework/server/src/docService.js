/**
 * 备查资料文档生成服务。
 *
 * 负责：装配文档上下文 → 调用模板 → 打包为 docx → 返回 Buffer。
 *
 * docx 是 zip 包。这里不引入 archiver/jszip 等依赖，而是自己写一个
 * 最小的 ZIP 写入器（仅 store 模式，不压缩）。理由：
 *   · 部署在内网受控环境，减少第三方依赖即减少供应链风险
 *   · docx 内的 XML 本身不大（单份 6~36KB），不压缩完全可以接受
 *   · ZIP store 格式非常简单，实现与验证成本低
 */

import { buildDocx, docxFiles, DOCS, findDoc, STAGES } from './docs.js';
import { computeDeduction, complianceCheck, CATS } from './costing.js';
import * as cr from './costingRepo.js';
import * as repo from './repo.js';

// ============================================================
// 最小 ZIP 写入器（store 模式）
// ============================================================

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 生成 ZIP 包。
 * @param {Array<{name:string, data:Buffer|string}>} files
 * @returns {Buffer}
 */
export function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const isDir = f.name.endsWith('/');

    // 本地文件头
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // flag: UTF-8 文件名
    lh.writeUInt16LE(0, 8);             // method: store
    lh.writeUInt16LE(0, 10);            // mod time
    lh.writeUInt16LE(0x21, 12);         // mod date (1980-01-01)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);  // compressed size
    lh.writeUInt32LE(data.length, 22);  // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);            // extra length

    chunks.push(lh, nameBuf);
    if (!isDir) chunks.push(data);

    // 中央目录项
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);            // version made by
    ch.writeUInt16LE(20, 6);            // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);            // extra
    ch.writeUInt16LE(0, 32);            // comment
    ch.writeUInt16LE(0, 34);            // disk
    ch.writeUInt16LE(0, 36);            // internal attrs
    ch.writeUInt32LE(isDir ? 0x41ED0010 : 0x81A40000, 38);  // external attrs
    ch.writeUInt32LE(offset, 42);       // 本地头偏移
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + (isDir ? 0 : data.length);
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** 把 document.xml 打包为 .docx Buffer。 */
export function packDocx(documentXml) {
  const f = docxFiles(documentXml);
  return makeZip([
    { name: '[Content_Types].xml', data: f.contentTypes },
    { name: '_rels/.rels', data: f.rels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: f.docRels },
    { name: 'word/styles.xml', data: f.styles },
  ]);
}

// ============================================================
// 文档上下文装配
// ============================================================

/** 统计某期间区间（用于年度口径）。 */
async function periodRange(period, scope) {
  return scope === 'month'
    ? { from: period, to: period, months: [period] }
    : {
      from: `${period}-01`,
      to: `${period}-12`,
      months: Array.from({ length: 12 }, (_, i) => `${period}-${String(i + 1).padStart(2, '0')}`),
    };
}

/**
 * 装配文档生成所需的全部上下文。
 */
export async function buildDocContext(period, scope = 'year') {
  const { from, to, months } = await periodRange(period, scope);

  const [company, projects, costRows, sharedRows, outsourceRows, users, ledgers] = await Promise.all([
    cr.getCompany(),
    repo.listProjects(),
    cr.costSummaryRange(from, to),
    cr.listSharedRange(from, to),
    cr.listOutsource(),
    repo.listUsers({ activeOnly: true }),
    Promise.all([
      cr.listLedger('roster'), cr.listLedger('assets'), cr.listLedger('devHours'),
      cr.listLedger('transfer'), cr.listLedger('special'), cr.listLedger('grant'),
      cr.listLedger('capital'), cr.listLedger('outsource'), cr.listLedger('materialIn'),
      cr.listLedger('materialOut'), cr.listLedger('otherFee'), cr.listLedger('budget'),
      cr.listLedger('coop'), cr.listLedger('proto'), cr.listLedger('contract'),
    ]),
  ]);
  const [rosterL, assetsL, devHoursL, transferL, specialL, grantL, capitalL,
    outsourceL, materialInL, materialOutL, otherFeeL, budgetL, coopL, protoL, contractL] = ledgers;

  // ---- 项目：六类费用 + 委托研发 ----
  const projectMap = new Map();
  for (const p of projects) {
    projectMap.set(p.id, {
      id: p.id, code: p.code, name: p.name, isRnd: p.is_rnd, form: p.form,
      field: p.field, leader: p.leader, stage: p.stage,
      start: p.start_date ? String(p.start_date).slice(0, 10) : '',
      end: p.end_date ? String(p.end_date).slice(0, 10) : '',
      budget: p.budget, objective: p.objective, techRoute: p.tech_route,
      innovation: p.innovation, acceptance: p.acceptance,
      cost: { labor: 0, direct: 0, dep: 0, amort: 0, design: 0, other: 0 },
      rdHours: 0, entrust: { amount: 0, domestic: true },
    });
  }
  for (const r of costRows) {
    if (!r.is_rnd) continue;
    const rec = projectMap.get(r.project_id);
    if (rec) rec.cost[r.category] = Math.round(((rec.cost[r.category] ?? 0) + Number(r.amount)) * 100) / 100;
  }
  for (const o of outsourceRows) {
    if (o.kind !== '委托研发') continue;
    const amt = Number(o.actual_amount || o.amount || 0);
    if (amt <= 0) continue;
    if (!o.project_id) {
      // 未指定项目的委托研发：单独归集，避免被丢弃（限额按企业整体计算）
      if (!projectMap.has('__ENTRUST__')) {
        projectMap.set('__ENTRUST__', {
          id: '__ENTRUST__', code: 'WD-未分项目', name: '委托研发（未指定项目）',
          isRnd: true, form: '委托研发',
          cost: { labor: 0, direct: 0, dep: 0, amort: 0, design: 0, other: 0 },
          rdHours: 0, entrust: { amount: 0, domestic: true },
        });
      }
      const rec = projectMap.get('__ENTRUST__');
      rec.entrust.amount += amt;
      rec.entrust.domestic = o.is_domestic !== false;
      continue;
    }
    const rec = projectMap.get(o.project_id);
    if (!rec) continue;
    rec.entrust.amount += amt;
    rec.entrust.domestic = o.is_domestic !== false;
  }

  // ---- 工时 ----
  const hoursByProj = new Map();
  const perUser = new Map();
  for (const m of months) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await repo.monthEntriesAll(m);
    for (const e of rows) {
      if (!perUser.has(e.user_id)) perUser.set(e.user_id, { rnd: new Map(), nonRnd: 0 });
      const u = perUser.get(e.user_id);
      if (e.is_rnd) {
        u.rnd.set(e.project_id, (u.rnd.get(e.project_id) ?? 0) + Number(e.hours));
        hoursByProj.set(e.project_id, (hoursByProj.get(e.project_id) ?? 0) + Number(e.hours));
      } else {
        u.nonRnd += Number(e.hours);
      }
    }
  }
  for (const [pid, h] of hoursByProj) {
    const rec = projectMap.get(pid);
    if (rec) rec.rdHours = Math.round(h * 100) / 100;
  }
  const totalRdHours = Math.round([...hoursByProj.values()].reduce((a, b) => a + b, 0) * 100) / 100;

  // 人员工时与人工费用
  const projById = new Map(projects.map((p) => [p.id, p]));
  const labor = [];
  for (const u of users) {
    const rec = perUser.get(u.id);
    if (!rec) continue;
    let rndHours = 0;
    for (const h of rec.rnd.values()) rndHours += h;
    const totalHours = rndHours + rec.nonRnd;
    if (totalHours <= 0) continue;
    const salary = Number(u.monthly_salary ?? 0);
    labor.push({
      userId: u.id, employeeNo: u.employee_no, name: u.display_name,
      salary, rndHours: Math.round(rndHours * 100) / 100,
      nonRndHours: Math.round(rec.nonRnd * 100) / 100,
      totalHours: Math.round(totalHours * 100) / 100,
      laborWan: Math.round(salary * rndHours / totalHours / 10000 * 100) / 100,
    });
  }
  const laborWanTotal = Math.round(labor.reduce((a, r) => a + r.laborWan, 0) * 100) / 100;

  // 项目级人工费用
  const laborByProject = [...hoursByProj.entries()].map(([pid, hours]) => {
    const p = projById.get(pid);
    return { code: p?.code ?? '', name: p?.name ?? '', hours: Math.round(hours * 100) / 100,
      headCount: 0 };
  });
  for (const [uid, rec] of perUser) {
    for (const [pid, h] of rec.rnd) {
      if (h <= 0) continue;
      const row = laborByProject.find((r) => r.code === (projById.get(pid)?.code ?? ''));
      if (row) row.headCount++;
    }
  }
  laborByProject.sort((a, b) => a.code.localeCompare(b.code));

  // ---- 公共费用分摊 ----
  const sharedAlloc = sharedRows.map((s) => {
    const total = Number(s.total_amount), bt = Number(s.basis_total), br = Number(s.basis_rd);
    const rate = bt > 0 ? br / bt : 0;
    return {
      period: s.period, item: s.item, category: s.category,
      totalAmount: total, basisTotal: bt, basisRd: br, rate,
      alloc: Math.round(total * rate * 100) / 100,
    };
  });

  // ---- 测算 ----
  const projectList = [...projectMap.values()];
  const daily = {
    special: specialL.map((r) => r.data),
    grant: grantL.map((r) => r.data),
    capital: capitalL.map((r) => r.data),
    outsource: outsourceL.map((r) => r.data),
    roster: rosterL.map((r) => r.data),
  };
  const result = computeDeduction({
    company, projects: projectList, shared: sharedRows, daily,
  });

  const projectCost = {};
  for (const p of projectList) {
    projectCost[p.code] = Object.values(p.cost).reduce((a, b) => a + b, 0);
  }

  // 合规自检结果（t25「备查资料清单与稽查自查表」需要）
  const compliance = complianceCheck({ company, projects: projectList, daily }, result);

  return {
    company: company ?? {},
    period, scope,
    projects: projectList,
    projectCost,
    compliance,
    roster: rosterL.map((r) => r.data),
    assets: assetsL.map((r) => r.data),
    devHours: devHoursL.map((r) => r.data),
    transfers: transferL.map((r) => r.data),
    materialIn: materialInL.map((r) => r.data),
    materialOut: materialOutL.map((r) => r.data),
    otherFee: otherFeeL.map((r) => r.data),
    budgetRows: budgetL.map((r) => r.data),
    coopRows: coopL.map((r) => r.data),
    protoRows: protoL.map((r) => r.data),
    contractRows: contractL.map((r) => r.data),
    outsourceRows: outsourceL.map((r) => r.data),
    labor, laborWanTotal, laborByProject, totalRdHours,
    sharedAlloc,
    ...result,
  };
}

/** 生成单份文档的 docx Buffer。 */
export async function generateDocx(docKey, period, scope) {
  const doc = findDoc(docKey);
  if (!doc) {
    const e = new Error('文档不存在');
    e.statusCode = 404; e.code = 'NOT_FOUND';
    throw e;
  }
  const ctx = await buildDocContext(period, scope);
  const xml = buildDocx(doc.build(ctx));
  return { buffer: packDocx(xml), name: doc.name, key: doc.key, ctx };
}

/** 生成全部文档的合集（一个 docx 内含全部，按环节分页）。 */
export async function generateAllDocx(period, scope) {
  const ctx = await buildDocContext(period, scope);
  const blocks = [];
  let first = true;
  for (const st of STAGES) {
    const docs = DOCS.filter((d) => d.stage === st.id);
    if (!docs.length) continue;
    if (!first) blocks.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    first = false;
    for (const d of docs) {
      blocks.push(...d.build(ctx));
      blocks.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    }
  }
  const xml = buildDocx(blocks);
  return { buffer: packDocx(xml), name: `研发费用备查资料合集_${period}`, ctx };
}

export { DOCS, STAGES, findDoc, CATS };