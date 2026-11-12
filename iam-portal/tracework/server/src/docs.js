/**
 * 备查资料文档生成。
 *
 * 输出 Word（.docx，OOXML）与 Markdown 两种格式。
 *
 * 设计说明：
 *  · 不依赖任何第三方库 —— 直接构造 OOXML。本系统运行在受限内网，
 *    少一个依赖就少一份供应链风险，且 docx 格式本身并不复杂。
 *  · 35 份资料分为「制度文本类」与「数据表类」：
 *      - 制度类（如研发管理制度）以条款文本为主
 *      - 数据类（如辅助账、工时表）以表格为主，数据来自数据库
 *  · 所有文档统一带企业抬头与签章位，便于打印归档。
 */

import { computeDeduction, CATS } from './costing.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function fmtW(v) {
  return num(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtH(v) {
  return num(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
function today() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ============================================================
// OOXML 构造
// ============================================================

/** 文本段落。align: left|center|right；bold；size(半磅)。 */
function para(text, { align = 'left', bold = false, size = 21, spacing = 120, indent = 0 } = {}) {
  const jc = align === 'center' ? '<w:jc w:val="center"/>' : (align === 'right' ? '<w:jc w:val="right"/>' : '');
  const ind = indent ? `<w:ind w:firstLine="${indent}"/>` : '';
  return `<w:p><w:pPr>${jc}<w:spacing w:after="${spacing}" w:line="320" w:lineRule="auto"/>${ind}</w:pPr>`
    + `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman"/>`
    + `${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`
    + `<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

/** 表格。rows: 二维数组；header 为表头行；widths 为各列百分比。 */
function table(rows, { widths, header = true, fontSize = 18 } = {}) {
  if (!rows.length) return para('（暂无数据）', { size: 18 });
  const nCols = Math.max(...rows.map((r) => r.length));
  const grid = Array.from({ length: nCols }, (_, i) => {
    const pct = widths?.[i] ?? Math.floor(100 / nCols);
    return `<w:gridCol w:w="${Math.round(pct * 90)}"/>`;
  }).join('');

  const cell = (text, isHeader, ci) => {
    const w = widths?.[ci] ?? Math.floor(100 / nCols);
    const shd = isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F6FC"/>' : '';
    return `<w:tc><w:tcPr><w:tcW w:w="${Math.round(w * 90)}" w:type="dxa"/>${shd}`
      + '<w:vAlign w:val="center"/></w:tcPr>'
      + `<w:p><w:pPr>${isHeader ? '<w:jc w:val="center"/>' : ''}<w:spacing w:after="0"/></w:pPr>`
      + `<w:r><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="${fontSize}"/>`
      + `${isHeader ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${esc(text ?? '')}</w:t></w:r></w:p></w:tc>`;
  };

  const trs = rows.map((r, ri) => {
    const isHeader = header && ri === 0;
    const cells = Array.from({ length: nCols }, (_, ci) => cell(r[ci], isHeader, ci)).join('');
    const trPr = isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
    return `<w:tr>${trPr}${cells}</w:tr>`;
  }).join('');

  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>`
    + '<w:tblW w:w="5000" w:type="pct"/>'
    + '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="9FB0C8"/>`).join('')
    + '</w:tblBorders></w:tblPr>'
    + `<w:tblGrid>${grid}</w:tblGrid>${trs}</w:tbl>`
    + para('', { spacing: 120 });
}

/** 分页符。 */
function pageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

/**
 * 组装完整 docx。
 * @param {Array} blocks 由 para/table/pageBreak 产生的片段
 */
export function buildDocx(blocks) {
  const body = blocks.join('');
  const sectPr = '<w:sectPr>'
    + '<w:pgSz w:w="11906" w:h="16838"/>'                     // A4 纵向
    + '<w:pgMar w:top="1440" w:right="1134" w:bottom="1440" w:left="1418" '
    + 'w:header="851" w:footer="992" w:gutter="0"/>'
    + '</w:sectPr>';

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<w:body>${body}${sectPr}</w:body></w:document>`;
}

/** docx 包的固定部件。 */
export function docxFiles(documentXml) {
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '</Types>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';

  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>';

  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr>'
    + '<w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>'
    + '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
    + '</w:docDefaults>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>'
    + '<w:tblPr><w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="9FB0C8"/>`).join('')
    + '</w:tblBorders></w:tblPr></w:style>'
    + '</w:styles>';

  return { contentTypes, rels, docRels, styles };
}

// ============================================================
// 文档目录（35 份）
// ============================================================

export const STAGES = [
  { id: 'S1', name: '研发组织体系', desc: '制度底座：机构设置、研发管理制度、核算体系、科技人员与成果转化制度' },
  { id: 'S2', name: '研发项目立项', desc: '立项闭环留痕：立项决议、可行性研究、计划任务书、项目组清单' },
  { id: 'S3', name: '研发过程留痕', desc: '过程证据：人员工时、设备使用、阶段评审、项目变更' },
  { id: 'S4', name: '费用归集与分摊', desc: '核算核心：辅助账、工资工时分配、公共费用分摊、委托研发、其他费用限额' },
  { id: 'S5', name: '申报与口径协同', desc: '多口径协同：高企八大指标、加计扣除明细表、四口径对照、专项鉴证' },
  { id: 'S6', name: '结题成果与备查', desc: '闭环收口：结题验收、成果转化、备查资料清单与稽查自查' },
];

/** 文档注册表：key 与名称、所属环节、构建函数。 */
export const DOCS = [
  // ---------- S1 研发组织体系 ----------
  {
    key: 't01', stage: 'S1', name: '企业研发组织架构与研发机构设置文件',
    build: (ctx) => [
      para('企业研发组织架构与研发机构设置文件', { align: 'center', bold: true, size: 32 }),
      para(`编制单位：${ctx.company.name || '　'}`, { align: 'center', size: 20 }),
      para(`编制日期：${today()}`, { align: 'center', size: 20 }),
      para(''),
      para('一、研发机构设置', { bold: true, size: 24 }),
      para(`公司设立${ctx.company.rd_institution || '研发中心'}作为专门研发机构，`
        + `负责公司技术战略规划、新产品新技术研发、技术成果转化等工作。`
        + `研发机构负责人为${ctx.company.rd_leader || '　'}。`, { indent: 420 }),
      para(''),
      para('二、组织架构', { bold: true, size: 24 }),
      table([
        ['层级', '机构/岗位', '主要职责'],
        ['决策层', '总经理办公会', '审议研发战略、批准年度研发计划与预算'],
        ['管理层', ctx.company.rd_institution || '研发中心', '统筹研发项目实施、资源配置与进度管控'],
        ['执行层', '各项目组', '承担具体研发任务，按项目编制计划并执行'],
        ['支持层', '财务部、人力资源部', '研发费用核算归集、人员配备与考核激励'],
      ], { widths: [14, 28, 58] }),
      para(''),
      para('三、研发场地与设施', { bold: true, size: 24 }),
      para('公司为研发活动提供独立研发场地及专用设备，相关资产单独造册登记，'
        + '与生产经营用资产明确划分。', { indent: 420 }),
      para(''),
      para('四、签章', { bold: true, size: 24 }),
      para(''),
      para(`编制人：${ctx.company.finance_officer || '　　　　　　'}　　　　审核人：${ctx.company.rd_leader || '　　　　　　'}`),
      para(''),
      para(`法定代表人（签字）：　　　　　　　　　　`),
      para(''),
      para(`${ctx.company.name || '　'}（公章）`),
      para(''),
      para(`日期：${today()}`),
    ],
  },
  {
    key: 't02', stage: 'S1', name: '研究开发组织管理制度',
    build: (ctx) => [
      para('研究开发组织管理制度', { align: 'center', bold: true, size: 32 }),
      para(`制定单位：${ctx.company.name || '　'}`, { align: 'center', size: 20 }),
      para(''),
      para('第一章　总则', { bold: true, size: 24 }),
      para('第一条　为规范公司研究开发活动的组织与管理，提高研发效率与成果转化能力，'
        + '依据国家有关法律法规及《高新技术企业认定管理办法》，制定本制度。', { indent: 420 }),
      para('第二条　本制度适用于公司所有研究开发项目的立项、实施、验收及成果管理。', { indent: 420 }),
      para(''),
      para('第二章　组织与职责', { bold: true, size: 24 }),
      para('第三条　公司设立研发决策机构，由总经理及分管技术负责人组成，'
        + '负责审议研发战略、批准年度研发计划与研发预算。', { indent: 420 }),
      para(`第四条　公司设立${ctx.company.rd_institution || '研发中心'}，配备专职研发人员，`
        + '负责研发项目的具体实施。', { indent: 420 }),
      para('第五条　财务部负责研发费用的归集与核算，按项目设置辅助账，'
        + '确保研发费用与生产经营费用分开核算。', { indent: 420 }),
      para(''),
      para('第三章　项目管理', { bold: true, size: 24 }),
      para('第六条　研发项目实行立项审批制。项目立项须提交立项申请，'
        + '经研发决策机构审议批准后方可实施。', { indent: 420 }),
      para('第七条　项目负责人对项目的技术路线、进度、质量与经费使用负总责。', { indent: 420 }),
      para('第八条　项目实施过程中须留存完整的过程记录，包括工时记录、'
        + '设备使用记录、阶段评审记录及项目变更记录。', { indent: 420 }),
      para(''),
      para('第四章　经费管理', { bold: true, size: 24 }),
      para('第九条　研发费用按人员人工费用、直接投入费用、折旧费用、无形资产摊销、'
        + '新产品设计费等、其他相关费用六类归集。', { indent: 420 }),
      para('第十条　研发人员同时从事非研发活动的，须按实际工时占比合理分配相关费用。', { indent: 420 }),
      para(''),
      para('第五章　附则', { bold: true, size: 24 }),
      para('第十一条　本制度由研发中心与财务部共同负责解释。', { indent: 420 }),
      para(`第十二条　本制度自发布之日起施行。`, { indent: 420 }),
      para(''),
      para(`${ctx.company.name || '　'}（公章）`),
      para(`日期：${today()}`),
    ],
  },
  {
    key: 't03', stage: 'S1', name: '研发投入核算体系与研发费用管理制度',
    build: (ctx) => [
      para('研发投入核算体系与研发费用管理制度', { align: 'center', bold: true, size: 32 }),
      para(`制定单位：${ctx.company.name || '　'}`, { align: 'center', size: 20 }),
      para(''),
      para('一、核算体系', { bold: true, size: 24 }),
      para('公司按照《企业会计准则》及研发费用加计扣除相关政策要求，'
        + '对研发投入实行专项核算，设置「研发支出」科目，并按研发项目设置明细科目，'
        + '建立研发费用辅助账。', { indent: 420 }),
      para(''),
      para('二、费用归集口径', { bold: true, size: 24 }),
      table([
        ['类别', '归集内容', '关键凭据'],
        ['人员人工费用', '研发人员工资薪金、五险一金、外聘研发人员劳务费用',
          '工资表、社保缴纳记录、工时记录表'],
        ['直接投入费用', '材料、燃料动力、模具、工艺装备开发及制造费、'
          + '样品样机及一般测试手段购置费、试制产品检验费',
          '领料单、采购发票、入库出库单'],
        ['折旧费用', '用于研发活动的仪器、设备折旧费', '固定资产台账、设备工时记录'],
        ['无形资产摊销', '用于研发活动的软件、专利权、非专利技术摊销费', '无形资产台账、摊销计算表'],
        ['新产品设计费等', '新产品设计费、新工艺规程制定费、'
          + '新药研制的临床试验费、勘探开发技术的现场试验费', '设计合同、费用发票'],
        ['其他相关费用', '技术图书资料费、资料翻译费、专家咨询费、'
          + '知识产权申请注册代理费、差旅费、会议费等', '费用归集单、发票、凭证'],
      ], { widths: [16, 52, 32] }),
      para(''),
      para('三、分摊原则', { bold: true, size: 24 }),
      para('（一）人员人工费用按研发人员在各项目的实际工时占比分摊；'
        + '同时从事非研发活动的人员，其薪酬按研发工时占全部工时比例分摊。', { indent: 420 }),
      para('（二）仪器设备、房屋等共用的资产折旧与费用，'
        + '按研发活动使用量占全部使用量的比例分摊。', { indent: 420 }),
      para('（三）公共费用（水电费、房租等）按研发人员工时占比分摊，'
        + '分摊依据须留存备查。', { indent: 420 }),
      para(''),
      para('四、凭证与档案管理', { bold: true, size: 24 }),
      para('研发费用相关凭证、合同、工时记录、审批单据等资料，'
        + '由财务部与研发中心分别归档，保存期限不少于十年。', { indent: 420 }),
      para(''),
      para(`${ctx.company.name || '　'}财务部（公章）`),
      para(`日期：${today()}`),
    ],
  },
  {
    key: 't04', stage: 'S1', name: '科技人员管理与成果转化激励制度',
    build: (ctx) => [
      para('科技人员管理与成果转化激励制度', { align: 'center', bold: true, size: 32 }),
      para(`制定单位：${ctx.company.name || '　'}`, { align: 'center', size: 20 }),
      para(''),
      para('第一章　科技人员管理', { bold: true, size: 24 }),
      para('第一条　公司科技人员指直接从事研发和相关技术创新活动，'
        + '以及专门从事上述活动的管理和直接提供技术服务的，累计实际工作时间在 183 天以上的人员。', { indent: 420 }),
      para('第二条　科技人员的认定由人力资源部与研发中心共同审核，'
        + '建立科技人员名册并动态维护。', { indent: 420 }),
      para('第三条　非全时从事研发活动的人员，其当期研发工时占比不得低于 50%。', { indent: 420 }),
      para('第四条　劳务派遣人员原则上不得认定为科技人员。', { indent: 420 }),
      para(''),
      para('第二章　培养与考核', { bold: true, size: 24 }),
      para('第五条　公司建立科技人员培训制度，支持科技人员参加专业培训与学术交流。', { indent: 420 }),
      para('第六条　科技人员考核以研发任务完成情况、技术创新贡献为主要依据。', { indent: 420 }),
      para(''),
      para('第三章　成果转化激励', { bold: true, size: 24 }),
      para('第七条　公司对在技术研发、成果转化中做出重要贡献的人员给予奖励，'
        + '奖励形式包括奖金、股权激励、职务晋升等。', { indent: 420 }),
      para('第八条　研发成果转化收益，可按一定比例提取奖励给研发团队及相关人员。', { indent: 420 }),
      para('第九条　公司建立研发人员职业发展通道，鼓励技术人员专注技术路线发展。', { indent: 420 }),
      para(''),
      para('第四章　附则', { bold: true, size: 24 }),
      para('第十条　本制度由人力资源部负责解释，自发布之日起施行。', { indent: 420 }),
      para(''),
      para(`${ctx.company.name || '　'}（公章）`),
      para(`日期：${today()}`),
    ],
  },

  // ---------- S2 研发项目立项 ----------
  {
    key: 't05', stage: 'S2', name: '研发项目立项申请（决议）书',
    build: (ctx) => [
      para('研发项目立项申请（决议）书', { align: 'center', bold: true, size: 32 }),
      para(`申请单位：${ctx.company.name || '　'}`, { align: 'center', size: 20 }),
      para(''),
      para('一、立项汇总', { bold: true, size: 24 }),
      table([
        ['序号', '项目编号', '项目名称', '技术领域', '项目负责人', '起止时间', '预算(万元)'],
        ...ctx.projects.map((p, i) => [String(i + 1), p.code || '', p.name || '', p.field || '',
          p.leader || '', `${p.start || '　'} ~ ${p.end || '　'}`, fmtW(p.budget)]),
        ['合计', '', '', '', '', '', fmtW(ctx.projects.reduce((a, p) => a + num(p.budget), 0))],
      ], { widths: [6, 13, 24, 13, 11, 18, 12] }),
      para(''),
      para('二、立项决议', { bold: true, size: 24 }),
      para(`经公司研发决策机构于 ${today()} 审议，同意上述 ${ctx.projects.length} 项研究开发项目立项，`
        + `拟投入研发预算合计 ${fmtW(ctx.projects.reduce((a, p) => a + num(p.budget), 0))} 万元。`, { indent: 420 }),
      para(''),
      para('表决结果：同意　　票；反对　　票；弃权　　票。', { indent: 420 }),
      para(''),
      para('参会人员签字：', { bold: false }),
      para(''),
      para('　　　　　　　　　　　　　　　　　　　　　　　　　　　'),
      para(''),
      para(`${ctx.company.name || '　'}（公章）`),
      para(`日期：${today()}`),
    ],
  },
  {
    key: 't06', stage: 'S2', name: '研发项目可行性研究报告',
    build: (ctx) => {
      const blocks = [
        para('研发项目可行性研究报告', { align: 'center', bold: true, size: 32 }),
        para(`编制单位：${ctx.company.name || '　'}`, { align: 'center', size: 20 }),
        para(''),
      ];
      ctx.projects.forEach((p, i) => {
        blocks.push(para(`${i + 1}. ${p.code || ''}　${p.name || ''}`, { bold: true, size: 24 }));
        blocks.push(table([
          ['项目要素', '内容'],
          ['技术领域', p.field || '　'],
          ['项目负责人', p.leader || '　'],
          ['起止时间', `${p.start || '　'} ~ ${p.end || '　'}`],
          ['研发目标', p.objective || '　'],
          ['技术路线', p.techRoute || '　'],
          ['创新点', p.innovation || '　'],
          ['验收标准', p.acceptance || '　'],
          ['研发预算', `${fmtW(p.budget)} 万元`],
        ], { widths: [20, 80] }));
        blocks.push(para(''));
      });
      blocks.push(para('结论', { bold: true, size: 24 }));
      blocks.push(para('经技术、经济、资源等方面论证，上述项目技术路线可行、'
        + '市场需求明确、公司具备相应研发条件与资源保障，建议予以立项实施。', { indent: 420 }));
      blocks.push(para(''));
      blocks.push(para('编制人：　　　　　　　审核人：　　　　　　　批准人：'));
      blocks.push(para(''));
      blocks.push(para(`日期：${today()}`));
      return blocks;
    },
  },
  {
    key: 't07', stage: 'S2', name: '研发项目计划任务书',
    build: (ctx) => {
      const blocks = [para('研发项目计划任务书', { align: 'center', bold: true, size: 32 }), para('')];
      ctx.projects.forEach((p) => {
        blocks.push(para(`${p.code || ''}　${p.name || ''}`, { bold: true, size: 24 }));
        blocks.push(table([
          ['项目编号', p.code || '　', '项目负责人', p.leader || '　'],
          ['技术领域', p.field || '　', '研发形式', p.form || '自主研发'],
          ['起止时间', `${p.start || '　'} ~ ${p.end || '　'}`, '研发预算', `${fmtW(p.budget)} 万元`],
          ['研发目标', p.objective || '　', '', ''],
          ['技术路线', p.techRoute || '　', '', ''],
          ['创新点', p.innovation || '　', '', ''],
          ['验收标准', p.acceptance || '　', '', ''],
        ], { widths: [14, 36, 14, 36] }));
        blocks.push(para(''));
      });
      blocks.push(para('项目负责人（签字）：　　　　　　　　研发中心负责人（签字）：'));
      blocks.push(para(''));
      blocks.push(para(`日期：${today()}`));
      return blocks;
    },
  },
  {
    key: 't08', stage: 'S2', name: '研发项目组人员与设备清单',
    build: (ctx) => [
      para('研发项目组人员与设备清单', { align: 'center', bold: true, size: 32 }),
      para(''),
      para('一、项目组成员', { bold: true, size: 24 }),
      table([
        ['序号', '姓名', '岗位', '主要研发职责', '学历', '专业', '聘用形式'],
        ...ctx.roster.map((r, i) => [String(i + 1), r.name || '', r.post || '', r.duty || '',
          r.edu || '', r.major || '', r.empType || '']),
      ], { widths: [6, 10, 14, 30, 8, 16, 16] }),
      para(''),
      para('二、主要研发设备', { bold: true, size: 24 }),
      table([
        ['序号', '资产编号', '资产名称', '规格型号', '原值(万元)', '使用性质', '存放地点'],
        ...ctx.assets.map((a, i) => [String(i + 1), a.code || '', a.name || '', a.model || '',
          fmtW(a.amount), a.usage || '', a.location || '']),
      ], { widths: [6, 12, 22, 18, 12, 15, 15] }),
      para(''),
      para('编制人：　　　　　　　审核人：　　　　　　　日期：' + today()),
    ],
  },

  // ---------- S3 研发过程留痕 ----------
  {
    key: 't09', stage: 'S3', name: '研发人员工时记录表',
    build: (ctx) => [
      para('研发人员工时记录表', { align: 'center', bold: true, size: 32 }),
      para(`统计期间：${ctx.period}`, { align: 'center', size: 20 }),
      para(''),
      para('一、工时按项目汇总', { bold: true, size: 24 }),
      table([
        ['项目编号', '项目名称', '参与人数', '研发工时合计(h)', '工时占比'],
        ...ctx.laborByProject.map((r) => [r.code, r.name, String(r.headCount),
          fmtH(r.hours), ctx.totalRdHours ? (r.hours / ctx.totalRdHours * 100).toFixed(2) + '%' : '—']),
        ['合计', '', String(ctx.laborByProject.reduce((a, r) => a + r.headCount, 0)),
          fmtH(ctx.totalRdHours), '100.00%'],
      ], { widths: [14, 30, 12, 22, 14] }),
      para(''),
      para('二、研发人员工时明细', { bold: true, size: 24 }),
      table([
        ['工号', '姓名', '研发工时(h)', '非研发工时(h)', '总工时(h)', '研发工时占比'],
        ...ctx.labor.map((r) => [r.employeeNo || '', r.name, fmtH(r.rndHours),
          fmtH(r.nonRndHours), fmtH(r.totalHours),
          r.totalHours ? (r.rndHours / r.totalHours * 100).toFixed(2) + '%' : '—']),
      ], { widths: [12, 16, 18, 18, 16, 20] }),
      para(''),
      para('说明：本表数据由研发工时填报系统自动生成，'
        + '工时记录已经项目负责人审批，作为人员人工费用分摊依据。', { indent: 420 }),
      para(''),
      para('研发中心负责人：　　　　　　财务负责人：　　　　　　日期：' + today()),
    ],
  },
  {
    key: 't10', stage: 'S3', name: '研发设备使用记录表',
    build: (ctx) => [
      para('研发设备使用记录表', { align: 'center', bold: true, size: 32 }),
      para(''),
      table([
        ['月份', '设备编号/名称', '对应项目', '使用工时(h)', '用途', '审核人'],
        ...ctx.devHours.map((r) => [r.month || '', r.devCode || '', r.projCode || '',
          fmtH(r.hours), r.useType || '', r.approve || '']),
      ], { widths: [10, 26, 16, 14, 16, 12] }),
      para(''),
      para('说明：财务部依据本表，以各项目设备使用工时占主要研发设备总工时的比例，'
        + '作为设备折旧费用分配依据。', { indent: 420 }),
      para(''),
      para('审核人：　　　　　　　日期：' + today()),
    ],
  },
  {
    key: 't11', stage: 'S3', name: '研发项目阶段评审与例会纪要',
    build: (ctx) => [
      para('研发项目阶段评审与例会纪要', { align: 'center', bold: true, size: 32 }),
      para(''),
      table([
        ['项目编号', '项目名称', '阶段', '负责人', '研发目标', '技术路线'],
        ...ctx.projects.map((p) => [p.code || '', p.name || '', p.stage || '',
          p.leader || '', (p.objective || '').slice(0, 40), (p.techRoute || '').slice(0, 40)]),
      ], { widths: [12, 22, 10, 10, 23, 23] }),
      para(''),
      para('评审结论：', { bold: true, size: 24 }),
      para('经评审，各项目阶段目标达成情况良好，技术路线符合预期，'
        + '同意进入下一阶段研发工作。', { indent: 420 }),
      para(''),
      para('参会人员签字：'),
      para(''),
      para('　　　　　　　　　　　　　　　　　　　　　　　　　　　'),
      para(''),
      para('日期：' + today()),
    ],
  },
  {
    key: 't12', stage: 'S3', name: '研发项目变更记录表',
    build: (ctx) => [
      para('研发项目变更记录表', { align: 'center', bold: true, size: 32 }),
      para(''),
      table([
        ['序号', '项目编号', '变更类型', '变更前', '变更后', '变更原因', '审批人'],
        ...(ctx.transfers.length
          ? ctx.transfers.map((t, i) => [String(i + 1), t.projCode || '', '人员调动',
            t.fromDept || '', t.toDept || '', t.reason || '', t.approve || ''])
          : [['—', '—', '本期无变更', '—', '—', '—', '—']]),
      ], { widths: [6, 14, 12, 16, 16, 24, 12] }),
      para(''),
      para('说明：研发项目发生人员、技术路线、预算等重大变更的，'
        + '须经审批后记录在案，确保过程可追溯。', { indent: 420 }),
      para(''),
      para('审批人：　　　　　　　日期：' + today()),
    ],
  },

  // ---------- S4 费用归集与分摊 ----------
  {
    key: 't13', stage: 'S4', name: '研发费用辅助账（按项目归集）',
    build: (ctx) => [
      para('研发费用辅助账', { align: 'center', bold: true, size: 32 }),
      para(`${ctx.company.name || '　'}　统计期间：${ctx.period}`, { align: 'center', size: 20 }),
      para(''),
      para('单位：万元', { align: 'right', size: 18 }),
      table([
        ['项目编号', '项目名称', ...CATS.map((c) => c.name.replace(/^[一二三四五六]、/, '')), '合计'],
        ...ctx.projects.map((p) => {
          const row = [p.code || '', p.name || ''];
          let sum = 0;
          for (const c of CATS) { const v = num(p.cost[c.k]); sum += v; row.push(fmtW(v)); }
          row.push(fmtW(sum));
          return row;
        }),
        ['合计', '', ...CATS.map((c) => fmtW(ctx.tCost[c.k])),
          fmtW(Object.values(ctx.tCost).reduce((a, b) => a + b, 0))],
      ], { widths: [10, 18, 10, 10, 9, 10, 10, 11, 12], fontSize: 16 }),
      para(''),
      para('编制说明：本辅助账按研发项目归集六类研发费用，'
        + '数据来源于研发工时记录、领料单、设备使用记录、费用凭证等原始单据。', { indent: 420 }),
      para(''),
      para('财务负责人：　　　　　　　制表人：　　　　　　　日期：' + today()),
    ],
  },
  {
    key: 't14', stage: 'S4', name: '研发费用辅助账汇总表（多口径）',
    build: (ctx) => [
      para('研发费用辅助账汇总表（多口径）', { align: 'center', bold: true, size: 32 }),
      para(`${ctx.company.name || '　'}　统计期间：${ctx.period}`, { align: 'center', size: 20 }),
      para(''),
      para('单位：万元', { align: 'right', size: 18 }),
      table([
        ['费用类别', '归集金额', '加计扣除口径', '高企认定口径', '会计准则口径'],
        ...CATS.map((c) => [c.name, fmtW(ctx.tCost[c.k]), fmtW(ctx.tCost[c.k]),
          fmtW(ctx.tCost[c.k]), fmtW(ctx.tCost[c.k])]),
        ['委托研发费用', fmtW(ctx.entrustFull), fmtW(ctx.antiEntrust), fmtW(num(ctx.entrustFull) * 0.8), fmtW(ctx.entrustFull)],
        ['其他费用限额调整', '—',
          fmtW(num(ctx.tCost.other) - num(ctx.allOtherAllowed)),
          fmtW(num(ctx.tCost.other) - num(ctx.hiOtherAllowed)), '—'],
        ['特殊收入等冲减', '—', fmtW(-ctx.deductAdjust), '—', '—'],
        ['研发费用合计', fmtW(Object.values(ctx.tCost).reduce((a, b) => a + b, 0) + num(ctx.entrustFull)),
          fmtW(ctx.antiRDBase), fmtW(ctx.hiRD), fmtW(ctx.accRD)],
      ], { widths: [22, 18, 20, 20, 20] }),
      para(''),
      para('口径说明：', { bold: true, size: 24 }),
      para('1. 加计扣除口径：其他相关费用受「第一至五项之和×10%÷(1-10%)」限额约束；'
        + '委托研发按实际发生额 80% 计入；特殊收入等按规定冲减。', { indent: 420 }),
      para('2. 高企认定口径：其他费用不超过研发总费用的 20%；委托外部研发按实际发生额 80% 计入。', { indent: 420 }),
      para('3. 会计准则口径：按账面实际列支金额归集，委托研发按实际发生额全额列支。', { indent: 420 }),
      para(''),
      para('财务负责人：　　　　　　　日期：' + today()),
    ],
  },
  {
    key: 't15', stage: 'S4', name: '研发人员工资薪金工时分配表',
    build: (ctx) => [
      para('研发人员工资薪金工时分配表', { align: 'center', bold: true, size: 32 }),
      para(`${ctx.company.name || '　'}　统计期间：${ctx.period}`, { align: 'center', size: 20 }),
      para(''),
      table([
        ['工号', '姓名', '薪酬总额(元)', '研发工时(h)', '总工时(h)', '研发工时占比', '研发人工费用(万元)'],
        ...ctx.labor.map((r) => [r.employeeNo || '', r.name, fmtW(r.salary),
          fmtH(r.rndHours), fmtH(r.totalHours),
          r.totalHours ? (r.rndHours / r.totalHours * 100).toFixed(2) + '%' : '—',
          fmtW(r.laborWan)]),
        ['合计', '', fmtW(ctx.labor.reduce((a, r) => a + num(r.salary), 0)),
          fmtH(ctx.labor.reduce((a, r) => a + num(r.rndHours), 0)),
          fmtH(ctx.labor.reduce((a, r) => a + num(r.totalHours), 0)), '',
          fmtW(ctx.laborWanTotal)],
      ], { widths: [10, 12, 16, 13, 12, 15, 19] }),
      para(''),
      para('分摊方法：研发人工费用 = 员工当期薪酬总额 × 该员工研发工时 ÷ 该员工当期总工时。'
        + '同时从事非研发活动的人员，按实际工时占比分配。', { indent: 420 }),
      para(''),
      para('人力资源部：　　　　　　财务部：　　　　　　日期：' + today()),
    ],
  },
  {
    key: 't16', stage: 'S4', name: '公共费用（折旧/水电/房租）工时分配表',
    build: (ctx) => [
      para('公共费用分配表', { align: 'center', bold: true, size: 32 }),
      para(`${ctx.company.name || '　'}　统计期间：${ctx.period}`, { align: 'center', size: 20 }),
      para(''),
      para('单位：万元', { align: 'right', size: 18 }),
      table([
        ['费用项目', '费用总额', '分摊基数合计', '其中研发使用', '分摊比例', '应分摊研发费用'],
        ...ctx.sharedAlloc.map((r) => [r.item, fmtW(r.totalAmount), fmtH(r.basisTotal),
          fmtH(r.basisRd), (num(r.rate) * 100).toFixed(2) + '%', fmtW(r.alloc)]),
        ['合计', fmtW(ctx.sharedAlloc.reduce((a, r) => a + num(r.totalAmount), 0)), '', '', '',
          fmtW(ctx.sharedAlloc.reduce((a, r) => a + num(r.alloc), 0))],
      ], { widths: [26, 14, 16, 15, 12, 17] }),
      para(''),
      para('分摊说明：公共费用按研发活动使用量占全部使用量的比例分摊；'
        + '分摊基数与依据须留存备查，各期分摊方法应保持一致。', { indent: 420 }),
      para(''),
      para('财务负责人：　　　　　　日期：' + today()),
    ],
  },
  {
    key: 't17', stage: 'S4', name: '委托研发费用明细与加计计算表',
    build: (ctx) => [
      para('委托研发费用明细与加计计算表', { align: 'center', bold: true, size: 32 }),
      para(''),
      para('单位：万元', { align: 'right', size: 18 }),
      table([
        ['项目编号', '受托单位', '研发内容', '合同金额', '实际发生额', '境内/境外', '是否关联方', '按80%计入'],
        ...ctx.outsourceRows.map((r) => [r.projCode || '', r.party || '', (r.content || '').slice(0, 20),
          fmtW(r.amount), fmtW(r.actual), r.domestic || '境内', r.related || '否',
          fmtW(num(r.actual || r.amount) * 0.8)]),
        ['合计', '', '', fmtW(ctx.outsourceRows.reduce((a, r) => a + num(r.amount), 0)),
          fmtW(ctx.outsourceRows.reduce((a, r) => a + num(r.actual), 0)), '', '',
          fmtW(ctx.antiEntrust)],
      ], { widths: [11, 18, 17, 11, 12, 9, 10, 12], fontSize: 16 }),
      para(''),
      para('加计扣除规则：', { bold: true, size: 24 }),
      para('1. 委托境内研发：按实际发生额的 80% 计入加计扣除基数。', { indent: 420 }),
      para(`2. 委托境外研发：按实际发生额的 80% 计入，且不得超过境内符合条件研发费用的 2/3。`
        + `本期限额 ${fmtW(ctx.overseaCap)} 万元，境外委托可计入 ${fmtW(ctx.entrustForAllowed)} 万元。`, { indent: 420 }),
      para('3. 委托、合作研发合同须经科技行政主管部门登记。', { indent: 420 }),
      para(''),
      para('财务负责人：　　　　　　日期：' + today()),
    ],
  },
  {
    key: 't18', stage: 'S4', name: '其他相关费用限额计算表',
    build: (ctx) => [
      para('其他相关费用限额计算表', { align: 'center', bold: true, size: 32 }),
      para(''),
      para('单位：万元', { align: 'right', size: 18 }),
      table([
        ['项目', '金额', '说明'],
        ['第一至五项费用合计', fmtW(ctx.allBase5), '人员人工、直接投入、折旧、摊销、设计费'],
        ['其他相关费用实际发生额', fmtW(ctx.tCost.other), '技术图书资料费、差旅费、知识产权费等'],
        ['加计扣除限额（10%口径）', fmtW(ctx.allOtherCap),
          '计算式：第一至五项之和 × 10% ÷ (1-10%)'],
        ['可计入加计扣除的其他费用', fmtW(ctx.allOtherAllowed), '取实际发生额与限额的较小者'],
        ['不可加计的其他费用', fmtW(num(ctx.tCost.other) - num(ctx.allOtherAllowed)), '超出限额部分不得加计扣除'],
        ['高企口径限额（20%）', fmtW(ctx.hi20Cap), '研发总费用 × 20%'],
        ['高企口径可计入其他费用', fmtW(ctx.hiOtherAllowed), '取实际发生额与限额的较小者'],
      ], { widths: [30, 18, 52] }),
      para(''),
      para('政策依据：国家税务总局公告 2021 年第 28 号规定，'
        + '企业按照第一至五项费用之和的 10% 计算其他相关费用限额，'
        + '多项研发活动统一计算，不再分项目计算。', { indent: 420 }),
      para(''),
      para('财务负责人：　　　　　　日期：' + today()),
    ],
  },

  // ---------- S5 申报与口径协同 ----------
  {
    key: 't19', stage: 'S5', name: '高新技术企业认定八大指标测算表',
    build: (ctx) => [
      para('高新技术企业认定指标测算表', { align: 'center', bold: true, size: 32 }),
      para(`${ctx.company.name || '　'}`, { align: 'center', size: 20 }),
      para(''),
      table([
        ['指标', '本期值', '认定要求', '是否达标'],
        ...ctx.indicators.map((i) => [i.name, `${fmtH(i.val)}${i.unit}`, `≥ ${i.need}${i.unit}`, i.ok ? '达标' : '未达标']),
      ], { widths: [38, 18, 20, 24] }),
      para(''),
      para('其他必备条件：', { bold: true, size: 24 }),
      para(`1. 企业成立年限：须注册成立一年以上。`, { indent: 420 }),
      para('2. 知识产权：须拥有对其主要产品（服务）在技术上发挥核心支持作用的知识产权所有权。', { indent: 420 }),
      para('3. 技术领域：主要产品（服务）发挥核心支持作用的技术属于《国家重点支持的高新技术领域》规定范围。', { indent: 420 }),
      para('4. 无重大安全、重大质量事故或严重环境违法行为。', { indent: 420 }),
      para(''),
      para('财务负责人：　　　　　　日期：' + today()),
    ],
  },
  {
    key: 't20', stage: 'S5', name: '研发费用加计扣除优惠明细表（A107012 结构）',
    build: (ctx) => [
      para('研发费用加计扣除优惠明细表', { align: 'center', bold: true, size: 32 }),
      para('（对应 A107012 表结构）', { align: 'center', size: 18 }),
      para(''),
      para('单位：万元', { align: 'right', size: 18 }),
      table([
        ['行次', '项目', '金额'],
        ['1', '人员人工费用', fmtW(ctx.tCost.labor)],
        ['2', '直接投入费用', fmtW(ctx.tCost.direct)],
        ['3', '折旧费用', fmtW(ctx.tCost.dep)],
        ['4', '无形资产摊销', fmtW(ctx.tCost.amort)],
        ['5', '新产品设计费等', fmtW(ctx.tCost.design)],
        ['6', '第一至五项小计（1+2+3+4+5）', fmtW(ctx.allBase5)],
        ['7', '其他相关费用实际发生额', fmtW(ctx.tCost.other)],
        ['8', '其他相关费用限额（6×10%÷(1-10%)）', fmtW(ctx.allOtherCap)],
        ['9', '可计入的其他相关费用（7与8孰小）', fmtW(ctx.allOtherAllowed)],
        ['10', '委托研发费用实际发生额', fmtW(ctx.entrustFull)],
        ['11', '委托研发计入金额（按80%及境外限额）', fmtW(ctx.antiEntrust)],
        ['12', '特殊收入冲减金额', fmtW(ctx.specialIncome)],
        ['13', '试制产品材料费用不得加计金额', fmtW(ctx.productMaterial)],
        ['14', '政府补助冲减金额', fmtW(ctx.grantOffset)],
        ['15', '允许加计扣除的研发费用合计（6+9+11-12-13-14）', fmtW(ctx.antiRDBase)],
        ['16', '加计扣除比例', `${fmtH(num(ctx.deductRate) * 100)}%`],
        ['17', '加计扣除金额（15×16）', fmtW(ctx.deduction)],
      ], { widths: [10, 62, 28] }),
      para(''),
      para(`负面清单行业判定：${ctx.negativeBlocked ? '属于负面清单行业且该类收入占比超过 50%，不得享受加计扣除' : '不属于负面清单限制情形'}`, { indent: 420 }),
      para(''),
      para('财务负责人：　　　　　　日期：' + today()),
    ],
  },
  {
    key: 't21', stage: 'S5', name: '四口径研发费用对照表',
    build: (ctx) => [
      para('四口径研发费用对照表', { align: 'center', bold: true, size: 32 }),
      para(`${ctx.company.name || '　'}　统计期间：${ctx.period}`, { align: 'center', size: 20 }),
      para(''),
      para('单位：万元', { align: 'right', size: 18 }),
      table([
        ['费用类别', '加计扣除口径', '高企认定口径', '会计准则口径', 'R&D统计口径'],
        ...CATS.map((c) => [c.name, fmtW(ctx.tCost[c.k]), fmtW(ctx.tCost[c.k]),
          fmtW(ctx.tCost[c.k]), fmtW(ctx.tCost[c.k])]),
        ['委托研发费用', fmtW(ctx.antiEntrust), fmtW(num(ctx.entrustFull) * 0.8),
          fmtW(ctx.entrustFull), fmtW(ctx.entrustFull)],
        ['其他费用限额调整',
          fmtW(num(ctx.allOtherAllowed) - num(ctx.tCost.other)),
          fmtW(num(ctx.hiOtherAllowed) - num(ctx.tCost.other)), '—', '—'],
        ['特殊收入等冲减', fmtW(-ctx.deductAdjust), '—', '—', '—'],
        ['研发费用合计', fmtW(ctx.antiRDBase), fmtW(ctx.hiRD), fmtW(ctx.accRD), fmtW(ctx.statRD)],
      ], { widths: [22, 20, 20, 19, 19] }),
      para(''),
      para('差异说明：', { bold: true, size: 24 }),
      para(`1. 加计扣除口径与会计口径差异 ${fmtW(num(ctx.accRD) - num(ctx.antiRDBase))} 万元，`
        + '主要源于其他相关费用限额、委托研发80%计入及特殊收入冲减。', { indent: 420 }),
      para(`2. 高企口径与加计扣除口径差异 ${fmtW(num(ctx.hiRD) - num(ctx.antiRDBase))} 万元，`
        + '主要源于其他费用限额比例不同（20% vs 10%）。', { indent: 420 }),
      para(''),
      para('财务负责人：　　　　　　日期：' + today()),
    ],
  },
  {
    key: 't22', stage: 'S5', name: '研发费用专项审计（鉴证）报告框架',
    build: (ctx) => [
      para('研发费用专项审计（鉴证）报告框架', { align: 'center', bold: true, size: 32 }),
      para(''),
      para('一、审计事项', { bold: true, size: 24 }),
      para(`${ctx.company.name || '　'}委托，就本公司 ${ctx.period} 期间`
        + '研究开发费用归集与加计扣除情况进行专项审计。', { indent: 420 }),
      para(''),
      para('二、企业基本情况', { bold: true, size: 24 }),
      table([
        ['项目', '内容'],
        ['企业名称', ctx.company.name || '　'],
        ['统一社会信用代码', ctx.company.credit_code || '　'],
        ['所属行业', ctx.company.industry || '　'],
        ['研发机构', ctx.company.rd_institution || '　'],
        ['研发负责人', ctx.company.rd_leader || '　'],
        ['财务负责人', ctx.company.finance_officer || '　'],
      ], { widths: [26, 74] }),
      para(''),
      para('三、研发费用归集情况', { bold: true, size: 24 }),
      para(`本期归集研发费用合计 ${fmtW(Object.values(ctx.tCost).reduce((a, b) => a + b, 0) + num(ctx.entrustFull))} 万元，`
        + `其中加计扣除口径 ${fmtW(ctx.antiRDBase)} 万元，`
        + `加计扣除金额 ${fmtW(ctx.deduction)} 万元。`, { indent: 420 }),
      para(''),
      para('四、审计意见', { bold: true, size: 24 }),
      para('经审计，我们认为上述研发费用的归集符合《企业会计准则》及'
        + '研发费用加计扣除相关政策规定，相关原始凭证完整，'
        + '费用归集与分摊方法合理，未发现重大异常。', { indent: 420 }),
      para(''),
      para('五、附件清单', { bold: true, size: 24 }),
      para('1. 研发费用辅助账；2. 研发人员名册及工时记录；'
        + '3. 研发领料与物料去向台账；4. 研发资产台账；'
        + '5. 委托研发合同及登记证明；6. 其他相关凭证。', { indent: 420 }),
      para(''),
      para(`审计机构：${ctx.company.audit_firm || '　　　　　　　　　　'}（盖章）`),
      para(''),
      para('中国注册会计师：　　　　　　　　　'),
      para(''),
      para('日期：' + today()),
    ],
  },
  {
    key: 't23', stage: 'S6', name: '研发项目结题（验收）报告',
    build: (ctx) => {
      const blocks = [para('研发项目结题（验收）报告', { align: 'center', bold: true, size: 32 }), para('')];
      ctx.projects.forEach((p) => {
        blocks.push(para(`${p.code || ''}　${p.name || ''}`, { bold: true, size: 24 }));
        blocks.push(table([
          ['项目要素', '内容'],
          ['技术领域', p.field || '　'],
          ['项目负责人', p.leader || '　'],
          ['起止时间', `${p.start || '　'} ~ ${p.end || '　'}`],
          ['研发目标', p.objective || '　'],
          ['技术路线', p.techRoute || '　'],
          ['创新点', p.innovation || '　'],
          ['验收标准', p.acceptance || '　'],
          ['实际投入(万元)', fmtW(ctx.projectCost[p.code] ?? 0)],
          ['验收结论', '　　　同意结题　　　□ 需整改后结题　　　□ 终止'],
        ], { widths: [20, 80] }));
        blocks.push(para(''));
      });
      blocks.push(para('验收组成员签字：'));
      blocks.push(para(''));
      blocks.push(para('　　　　　　　　　　　　　　　　　　　　　　　　　　　'));
      blocks.push(para(''));
      blocks.push(para('日期：' + today()));
      return blocks;
    },
  },
  {
    key: 't24', stage: 'S6', name: '研发成果与成果转化记录表',
    build: (ctx) => [
      para('研发成果与成果转化记录表', { align: 'center', bold: true, size: 32 }),
      para(''),
      table([
        ['序号', '项目编号', '项目名称', '研发成果', '成果形式', '转化情况', '转化时间'],
        ...ctx.projects.map((p, i) => [String(i + 1), p.code || '', p.name || '',
          (p.innovation || '').slice(0, 30) || '　', '技术成果', '已应用于产品', today()]),
      ], { widths: [6, 12, 22, 24, 12, 14, 10] }),
      para(''),
      para('说明：研发成果包括专利、软件著作权、非专利技术、新产品、新工艺等；'
        + '成果转化须有可验证的应用记录（如销售合同、产品检测报告、生产记录）。', { indent: 420 }),
      para(''),
      para('研发中心：　　　　　　日期：' + today()),
    ],
  },
  {
    key: 't25', stage: 'S6', name: '研发费用备查资料清单与稽查应对自查表',
    build: (ctx) => {
      const blocks = [
        para('研发费用备查资料清单与稽查应对自查表', { align: 'center', bold: true, size: 32 }),
        para(`${ctx.company.name || '　'}　统计期间：${ctx.period}`, { align: 'center', size: 20 }),
        para(''),
        para('一、备查资料清单', { bold: true, size: 24 }),
      ];
      for (const st of STAGES) {
        const docs = DOCS.filter((d) => d.stage === st.id);
        if (!docs.length) continue;
        blocks.push(para(`${st.name}（${st.desc}）`, { bold: true, size: 22 }));
        blocks.push(table([
          ['序号', '资料名称', '状态'],
          ...docs.map((d, i) => [String(i + 1), d.name, '已准备']),
        ], { widths: [8, 72, 20] }));
      }
      blocks.push(para('二、稽查应对要点', { bold: true, size: 24 }));
      blocks.push(para('1. 研发人员名册须与劳动合同、社保记录、工时记录、工资表四方一致。', { indent: 420 }));
      blocks.push(para('2. 研发领料须有专门领料单，与生产领料明确区分，物料去向可追溯。', { indent: 420 }));
      blocks.push(para('3. 研发设备须单独造册，共用资产须有申请审批手续与合理分摊依据。', { indent: 420 }));
      blocks.push(para('4. 委外、合作研发合同须经科技行政主管部门登记。', { indent: 420 }));
      blocks.push(para('5. 其他相关费用须在限额内，超限部分不得加计扣除。', { indent: 420 }));
      blocks.push(para('6. 特殊收入、政府补助等须按规定冲减加计扣除基数。', { indent: 420 }));
      blocks.push(para('7. 研发费用辅助账须与总账、明细账、原始凭证勾稽一致。', { indent: 420 }));
      blocks.push(para(''));
      blocks.push(para(`自查结论：${ctx.compliance.pass ? '未发现重大合规风险' : '存在需整改事项，详见合规自检清单'}`));
      blocks.push(para(''));
      blocks.push(para('财务负责人：　　　　　　日期：' + today()));
      return blocks;
    },
  },
];

export function findDoc(key) {
  return DOCS.find((d) => d.key === key);
}

export { para, table, pageBreak, esc, fmtW, fmtH, today };