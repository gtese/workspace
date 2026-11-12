/**
 * 备查台账定义（14 类）。
 *
 * 与《研发费用备查资料智能工作台》的 LEDGERS 定义保持一致，
 * 但字段名改为更适合数据库存储的形式，并补充了校验规则。
 *
 * 每个台账包含：
 *   key     台账标识
 *   name    台账名称
 *   desc    业务说明
 *   note    核查要点（展示给使用者，提醒稽查关注点）
 *   cols    字段定义 [{ k, t, w, type, opts, required }]
 *   derive  派生列 [{ t, fn }]（只读展示，不入库）
 *   validate(row)  行级校验，返回 [{ level, msg }]
 */

export const LEDGERS = [
  {
    key: 'roster',
    name: '研发人员名册',
    desc: '登记研发人员的认定标准、岗位职责、学历专业、聘用形式与工时。系统自动校验「非全时研发人员当期研发工时占比不得低于 50%」「劳务派遣人员原则上不得认定为研发人员」。',
    note: '核查要点：人员名册须与劳动合同、社保缴纳记录、工时记录表、工资表四方一致；不得将后勤服务（文秘、前台、餐饮、安保）人员计入研发人员。',
    cols: [
      { k: 'name', t: '姓名', w: 88, required: true },
      { k: 'dept', t: '所属部门', w: 108 },
      { k: 'post', t: '岗位', w: 118 },
      { k: 'duty', t: '主要研发职责', w: 170 },
      { k: 'edu', t: '学历', w: 80, type: 'select', opts: ['博士', '硕士', '本科', '专科', '其他'] },
      { k: 'major', t: '专业', w: 108 },
      { k: 'empType', t: '聘用形式', w: 110, type: 'select', opts: ['全职', '兼职', '劳务派遣', '外聘劳务', '合作方人员'] },
      { k: 'joinDate', t: '入职/合作起始', w: 116, type: 'date' },
      { k: 'rdHours', t: '研发工时(h)', w: 100, type: 'num' },
      { k: 'totalHours', t: '总工时(h)', w: 96, type: 'num' },
      { k: 'note', t: '佐证材料', w: 150 },
    ],
    derive: [
      { t: '研发工时占比', w: 104, fn: (r) => {
        const t = Number(r.totalHours) || 0, rd = Number(r.rdHours) || 0;
        return t ? (rd / t * 100).toFixed(1) + '%' : '—';
      } },
      { t: '认定校验', w: 158, fn: (r) => {
        if (!r.name) return '待填';
        if (r.empType === '劳务派遣') return '不得认定（劳务派遣）';
        const t = Number(r.totalHours) || 0, rd = Number(r.rdHours) || 0;
        if (!t || !rd) return '待补工时';
        return (rd / t) < 0.5 ? '不得认定（占比<50%）' : '符合';
      } },
    ],
  },

  {
    key: 'transfer',
    name: '研发人员调动记录',
    desc: '记录研发人员调入、调出研发部门，以及项目之间的人员调动，须经研发部负责人批准。',
    note: '核查要点：调入调出前后工作内容应有明显区别；同一人频繁调入调出会被质疑。',
    cols: [
      { k: 'date', t: '调动日期', w: 110, type: 'date' },
      { k: 'name', t: '姓名', w: 88, required: true },
      { k: 'fromDept', t: '调出部门/项目', w: 150 },
      { k: 'toDept', t: '调入部门/项目', w: 150 },
      { k: 'reason', t: '调动原因', w: 180 },
      { k: 'workAfter', t: '调动后工作内容', w: 170 },
      { k: 'approve', t: '审批人', w: 96 },
    ],
    validate: (r) => (r.workAfter && r.reason && !r.approve
      ? [{ level: 'warn', msg: '调动记录缺少审批人' }] : []),
  },

  {
    key: 'materialIn',
    name: '研发领料申请与出库',
    desc: '研发物料采购与领用须与研发计划匹配，按项目填写专门领料单，经审批后出库。',
    note: '核查要点：领料单须注明研发项目名称、领料部门、领料明细、数量；领料人应为研发部门员工；须与生产领料明确区分。',
    cols: [
      { k: 'date', t: '日期', w: 104, type: 'date' },
      { k: 'projCode', t: '项目编号', w: 110 },
      { k: 'item', t: '物料名称', w: 150, required: true },
      { k: 'spec', t: '规格型号', w: 120 },
      { k: 'qty', t: '数量', w: 76, type: 'num' },
      { k: 'unit', t: '单位', w: 64 },
      { k: 'amount', t: '金额(万元)', w: 100, type: 'num' },
      { k: 'applicant', t: '领料人', w: 88 },
      { k: 'approve', t: '审批人', w: 88 },
      { k: 'voucher', t: '单据编号', w: 120 },
    ],
  },

  {
    key: 'materialOut',
    name: '研发物料去向台账（能量守恒）',
    desc: '遵循「研发领料＝研发形成样品＋研发废料＋研发过程中合理消耗」，登记研发耗用物料的最终去向。',
    note: '核查要点：研发过程产出的产品或副产品成本不得计入研发投入；废料/样品后续处理（销售、赠送、生产领用、委外处置）须履行出入库手续，对应收入成本核算完整。',
    cols: [
      { k: 'date', t: '日期', w: 104, type: 'date' },
      { k: 'projCode', t: '项目编号', w: 110 },
      { k: 'type', t: '去向类型', w: 130, type: 'select', opts: ['研发样品', '研发样机', '研发废料', '合理损耗'] },
      { k: 'item', t: '物料/产出名称', w: 150, required: true },
      { k: 'qty', t: '数量', w: 76, type: 'num' },
      { k: 'amount', t: '金额(万元)', w: 96, type: 'num' },
      { k: 'laterUse', t: '后续处理方式', w: 140, type: 'select', opts: ['留存研发', '入库保管', '对外销售', '赠送', '生产领用', '委外处置', '报废'] },
      { k: 'income', t: '处置收入(万元)', w: 110, type: 'num' },
      { k: 'voucher', t: '单据编号', w: 120 },
    ],
    validate: (r) => {
      const out = [];
      if (r.laterUse === '对外销售' && !Number(r.income)) {
        out.push({ level: 'warn', msg: '去向为「对外销售」但未登记处置收入' });
      }
      return out;
    },
  },

  {
    key: 'assets',
    name: '研发固定资产台账',
    desc: '研发专用资产与生产用资产明确划分、单独造册登记；共用的须履行申请审批手续。',
    note: '核查要点：研发用房屋、设备折旧须有专门台账；共用资产的折旧/摊销分配方法须合理且各期一致；防止「生产用核心设备大部分用于研发」的异常情形。',
    cols: [
      { k: 'code', t: '资产编号', w: 100, required: true },
      { k: 'name', t: '资产名称', w: 150 },
      { k: 'model', t: '规格型号', w: 120 },
      { k: 'amount', t: '原值(万元)', w: 100, type: 'num' },
      { k: 'startDate', t: '启用日期', w: 104, type: 'date' },
      { k: 'usage', t: '使用性质', w: 130, type: 'select', opts: ['研发专用', '研发生产共用', '生产用'] },
      { k: 'location', t: '存放地点', w: 130 },
      { k: 'depLife', t: '折旧年限', w: 88 },
      { k: 'depYear', t: '年折旧额(万元)', w: 120, type: 'num' },
      { k: 'approve', t: '审批/调拨记录', w: 130 },
    ],
    validate: (r) => {
      const out = [];
      if (r.usage === '研发生产共用' && !r.approve) {
        out.push({ level: 'warn', msg: '共用资产须有申请审批手续' });
      }
      return out;
    },
  },

  {
    key: 'devHours',
    name: '研发设备月度工时记录',
    desc: '按不同研发项目编制月度设备工时记录表，经审批后作为设备折旧费用分配依据。',
    note: '核查要点：财务部依据审批后的月度设备工时记录表，以各项目设备使用工时占主要研发设备总工时的比例作为折旧分配依据；须与折旧费用分摊表勾稽。',
    cols: [
      { k: 'month', t: '月份', w: 86 },
      { k: 'devCode', t: '设备编号/名称', w: 170, required: true },
      { k: 'projCode', t: '对应项目', w: 120 },
      { k: 'hours', t: '使用工时(h)', w: 104, type: 'num' },
      { k: 'useType', t: '用途', w: 120, type: 'select', opts: ['研发用', '生产用', '调试/维修'] },
      { k: 'approve', t: '审核人', w: 88 },
      { k: 'note', t: '说明', w: 150 },
    ],
  },

  {
    key: 'otherFee',
    name: '研发其他费用归集单',
    desc: '研发过程中发生的差旅费、测试费、咨询费、专利费等，由项目人员在费用发生时填写归集单。',
    note: '核查要点：其他相关费用总额不得超过加计扣除研发费用总额的10%（限额＝第一至五项之和×10%÷(1-10%)）；高企口径不超过研发总费用的20%。',
    cols: [
      { k: 'date', t: '日期', w: 104, type: 'date' },
      { k: 'projCode', t: '项目编号', w: 110 },
      { k: 'type', t: '费用类别', w: 180, type: 'select', opts: [
        '技术图书资料费', '资料翻译费', '专家咨询费', '高新科技研发保险费',
        '研发成果检索分析评议论证鉴定评审评估验收费', '知识产权申请注册代理费',
        '差旅费', '会议费', '职工福利费', '补充养老保险费', '补充医疗保险费', '其他'] },
      { k: 'item', t: '费用明细', w: 170, required: true },
      { k: 'amount', t: '金额(万元)', w: 104, type: 'num' },
      { k: 'applicant', t: '经办人', w: 88 },
      { k: 'approve', t: '审批人', w: 88 },
      { k: 'voucher', t: '凭证号', w: 120 },
    ],
  },

  {
    key: 'outsource',
    name: '委外研发台账',
    desc: '委外研发须经过恰当审批，受托单位具备研发能力，交易价格公允，成果权属明确并经验收。',
    note: '核查要点：委托研发按实际发生额的80%计入加计扣除；委托境外研发还不得超过境内符合条件研发费用的2/3；委托、合作研发合同须经科技行政主管部门登记。',
    cols: [
      { k: 'projCode', t: '项目编号', w: 110 },
      { k: 'party', t: '受托单位', w: 170, required: true },
      { k: 'content', t: '委外研发内容', w: 180 },
      { k: 'amount', t: '合同金额(万元)', w: 116, type: 'num' },
      { k: 'actual', t: '实际发生额(万元)', w: 126, type: 'num' },
      { k: 'domestic', t: '境内/境外', w: 96, type: 'select', opts: ['境内', '境外'] },
      { k: 'related', t: '是否关联方', w: 104, type: 'select', opts: ['否', '是'] },
      { k: 'techReg', t: '科技部门登记号', w: 150 },
      { k: 'regDate', t: '登记日期', w: 104, type: 'date' },
      { k: 'stage', t: '阶段成果验收情况', w: 180 },
      { k: 'payMatch', t: '付款与成果匹配', w: 140, type: 'select', opts: ['阶段成果合格后付款', '预付', '其他'] },
    ],
    validate: (r) => {
      const out = [];
      if (r.party && Number(r.amount) > 0 && !r.techReg) {
        out.push({ level: 'warn', msg: '缺少科技行政主管部门登记号，未登记可能不得享受优惠' });
      }
      if (r.related === '是' && !r.payMatch) {
        out.push({ level: 'info', msg: '关联方委外须特别注意交易价格公允性' });
      }
      return out;
    },
  },

  {
    key: 'coop',
    name: '合作研发台账',
    desc: '合作研发须对合作单位尽调、签订书面合同，明确双方投资、分工、权利义务与成果产权归属。',
    note: '核查要点：合作研发共同完成的知识产权归属由合同约定，未约定的由各方共有；合作研发合同同样需经科技行政主管部门登记，未登记不得享受相关优惠。',
    cols: [
      { k: 'projCode', t: '项目编号', w: 110 },
      { k: 'party', t: '合作单位', w: 170, required: true },
      { k: 'content', t: '合作内容与分工', w: 200 },
      { k: 'ourInput', t: '本公司投入(万元)', w: 130, type: 'num' },
      { k: 'otherInput', t: '合作方投入(万元)', w: 130, type: 'num' },
      { k: 'ownership', t: '成果归属约定', w: 180 },
      { k: 'techReg', t: '科技部门登记号', w: 150 },
      { k: 'regDate', t: '登记日期', w: 104, type: 'date' },
    ],
  },

  {
    key: 'budget',
    name: '研发预算与执行差异',
    desc: '编制研发预算并跟踪实际执行，对预算超支或重大差异说明原因并提出解决方案。',
    note: '核查要点：研发预算与实际执行差异是 IPO 问询事项之一；预算应在立项时编制，并按项目跟踪。',
    cols: [
      { k: 'projCode', t: '项目编号', w: 110, required: true },
      { k: 'year', t: '年度', w: 80 },
      { k: 'budgetTotal', t: '预算总额(万元)', w: 126, type: 'num' },
      { k: 'actualTotal', t: '实际发生(万元)', w: 126, type: 'num' },
      { k: 'reason', t: '差异原因与说明', w: 230 },
      { k: 'approve', t: '审批人', w: 88 },
    ],
    derive: [
      { t: '差异额(万元)', w: 116, fn: (r) => {
        const b = Number(r.budgetTotal) || 0, a = Number(r.actualTotal) || 0;
        return (a - b).toFixed(2);
      } },
      { t: '差异率', w: 92, fn: (r) => {
        const b = Number(r.budgetTotal) || 0, a = Number(r.actualTotal) || 0;
        return b ? ((a - b) / b * 100).toFixed(1) + '%' : '—';
      } },
    ],
    validate: (r) => {
      const b = Number(r.budgetTotal) || 0, a = Number(r.actualTotal) || 0;
      if (b > 0 && Math.abs(a - b) / b > 0.2 && !r.reason) {
        return [{ level: 'warn', msg: '预算差异超过 20%，须说明原因' }];
      }
      return [];
    },
  },

  {
    key: 'capital',
    name: '研发资本化判定',
    desc: '区分研究阶段与开发阶段，逐项判定开发支出是否满足资本化五项条件。',
    note: '核查要点：五项条件须逐项论述并留痕，其中「技术上可行」与「经济上可行」是论证难点；研究阶段支出一律费用化。',
    cols: [
      { k: 'projCode', t: '项目编号', w: 110, required: true },
      { k: 'phase', t: '阶段', w: 110, type: 'select', opts: ['研究阶段', '开发阶段'] },
      { k: 'c1', t: '①技术可行性', w: 110, type: 'select', opts: ['满足', '不满足', '待论证'] },
      { k: 'c2', t: '②使用/出售意图', w: 120, type: 'select', opts: ['满足', '不满足', '待论证'] },
      { k: 'c3', t: '③能带来经济利益', w: 124, type: 'select', opts: ['满足', '不满足', '待论证'] },
      { k: 'c4', t: '④资源支持', w: 104, type: 'select', opts: ['满足', '不满足', '待论证'] },
      { k: 'c5', t: '⑤支出可靠计量', w: 120, type: 'select', opts: ['满足', '不满足', '待论证'] },
      { k: 'startDate', t: '资本化起点', w: 110, type: 'date' },
      { k: 'amount', t: '资本化金额(万元)', w: 130, type: 'num' },
      { k: 'life', t: '摊销年限(年)', w: 110, type: 'num' },
      { k: 'conclusion', t: '结论', w: 110, type: 'select', opts: ['资本化', '费用化', '待论证'] },
    ],
    derive: [
      { t: '五条件齐备', w: 104, fn: (r) => (['c1', 'c2', 'c3', 'c4', 'c5'].every((k) => r[k] === '满足') ? '是' : '否') },
      { t: '资本化金额(万元)', w: 130, fn: (r) => (Number(r.amount) || 0).toFixed(2) },
      { t: '税收年摊销(200%)(万元)', w: 170, fn: (r) => {
        const a = Number(r.amount) || 0, l = Number(r.life) || 10;
        return a && l ? (a * 2 / l).toFixed(2) : '—';
      } },
    ],
  },

  {
    key: 'proto',
    name: '研发样机成本与销售处理',
    desc: '登记研发样机的成本归集方法、销售意向、资产确认与对外销售处理。',
    note: '核查要点（准则解释第15号）：试运行销售的收入与成本应分别处理计入当期损益，不得以净额冲减研发支出；达成销售意向前计入研发费用，之后符合条件的可确认为存货。',
    cols: [
      { k: 'projCode', t: '项目编号', w: 110 },
      { k: 'name', t: '样机/产品名称', w: 160, required: true },
      { k: 'cost', t: '已归集成本(万元)', w: 130, type: 'num' },
      { k: 'intent', t: '是否有销售意图', w: 130, type: 'select', opts: ['有', '无'] },
      { k: 'orderDate', t: '取得订单日期', w: 116, type: 'date' },
      { k: 'recognize', t: '资产确认', w: 120, type: 'select', opts: ['计入研发费用', '确认为存货', '不确认'] },
      { k: 'saleDate', t: '销售日期', w: 104, type: 'date' },
      { k: 'saleIncome', t: '销售收入(万元)', w: 126, type: 'num' },
      { k: 'saleCost', t: '结转成本(万元)', w: 126, type: 'num' },
    ],
    derive: [
      { t: '会计处理提示', w: 230, fn: (r) => (r.recognize === '确认为存货'
        ? '销售时确认收入并结转存货成本' : '计入研发费用') },
    ],
  },

  {
    key: 'contract',
    name: '受托研发与合同履约成本划分',
    desc: '区分自主研发与受托研发。无法控制研发成果的受托研发支出，应按合同履约成本处理，计入营业成本，不得计入研发支出。',
    note: '核查要点（监管规则适用指引-会计类第2号、发行类第9号）：研发成果仅可用于该客户合同、无法用于其他合同的，表明企业无法控制成果；有充分证据表明能控制成果并预期带来经济利益，且能准确归集核算的，方可计入研发支出。',
    cols: [
      { k: 'contractName', t: '合同/项目名称', w: 170, required: true },
      { k: 'customer', t: '客户名称', w: 150 },
      { k: 'control', t: '能否控制研发成果', w: 140, type: 'select', opts: ['能控制', '不能控制', '待论证'] },
      { k: 'evidence', t: '控制权判断依据', w: 200 },
      { k: 'accounting', t: '会计处理', w: 150, type: 'select', opts: ['计入研发支出', '计入合同履约成本'] },
      { k: 'amount', t: '金额(万元)', w: 110, type: 'num' },
      { k: 'note', t: '备注', w: 150 },
    ],
    derive: [
      { t: '处理校验', w: 190, fn: (r) => {
        const a = r.accounting || (r.control === '能控制' ? '计入研发支出' : '计入合同履约成本');
        return (a === '计入研发支出' && r.control !== '能控制') ? '不得计入研发支出' : '符合';
      } },
    ],
  },

  {
    key: 'special',
    name: '研发特殊收入与冲减',
    desc: '研发过程中形成的下脚料、残次品、中间试制品等特殊收入，以及试制产品对外销售对应的材料费用，须冲减加计扣除研发费用。',
    note: '核查要点：特殊收入应从已归集研发费用中扣减，不足扣减的按零计算；研发活动直接形成产品或作为组成部分形成的产品对外销售的，研发费用中对应的材料费用不得加计扣除；产品销售与对应材料费用跨年度的，可在销售当年以材料费用发生额直接冲减当年研发费用。',
    cols: [
      { k: 'date', t: '日期', w: 104, type: 'date' },
      { k: 'projCode', t: '项目编号', w: 110 },
      { k: 'type', t: '类型', w: 150, type: 'select', opts: ['下脚料', '残次品', '中间试制品', '试制产品对外销售'] },
      { k: 'income', t: '收入(万元)', w: 110, type: 'num' },
      { k: 'materialCost', t: '对应材料费用(万元)', w: 150, type: 'num' },
      { k: 'note', t: '说明', w: 180 },
    ],
    derive: [
      { t: '对加计扣除的影响', w: 250, fn: (r) => (r.type === '试制产品对外销售'
        ? '对应材料费用不得加计扣除' : '特殊收入冲减加计扣除研发费用') },
    ],
  },

  {
    key: 'grant',
    name: '政府补助用于研发',
    desc: '企业取得来源于政府的补助用于研发活动的，须区分会计与税务处理的差异。',
    note: '核查要点：采用直接冲减研发费用方法且税务处理未确认为应税收入的，应按冲减后的余额计算加计扣除金额；确认为应税收入的，不冲减研发费用。',
    cols: [
      { k: 'date', t: '取得日期', w: 104, type: 'date' },
      { k: 'projCode', t: '对应项目', w: 120 },
      { k: 'name', t: '补助项目名称', w: 190, required: true },
      { k: 'amount', t: '金额(万元)', w: 110, type: 'num' },
      { k: 'taxTreat', t: '税务处理', w: 140, type: 'select', opts: ['确认为应税收入', '不征税收入', '未确认应税收入'] },
      { k: 'offset', t: '是否直接冲减研发费用', w: 160, type: 'select', opts: ['是', '否'] },
      { k: 'note', t: '说明', w: 150 },
    ],
    derive: [
      { t: '是否冲减加计基数', w: 150, fn: (r) => ((r.offset === '是' && r.taxTreat !== '确认为应税收入')
        ? '是（按冲减后余额加计）' : '否') },
    ],
  },
];

export const LEDGER_MAP = Object.fromEntries(LEDGERS.map((l) => [l.key, l]));

/** 生成一行空台账数据。 */
export function blankLedgerRow(key) {
  const def = LEDGER_MAP[key];
  if (!def) return {};
  const r = {};
  for (const c of def.cols) r[c.k] = '';
  return r;
}

/** 校验单行，返回问题列表。 */
export function validateLedgerRow(key, row) {
  const def = LEDGER_MAP[key];
  if (!def) return [];
  const issues = [];
  for (const c of def.cols) {
    if (c.required && !String(row[c.k] ?? '').trim()) {
      issues.push({ level: 'error', msg: `「${c.t}」为必填项` });
    }
    if (c.type === 'num' && row[c.k] !== '' && row[c.k] != null && !Number.isFinite(Number(row[c.k]))) {
      issues.push({ level: 'error', msg: `「${c.t}」必须为数字` });
    }
  }
  if (typeof def.validate === 'function') {
    issues.push(...(def.validate(row) ?? []));
  }
  return issues;
}

/** 台账清单（供前端菜单使用，不含函数）。 */
export function ledgerCatalog() {
  return LEDGERS.map((l) => ({
    key: l.key,
    name: l.name,
    desc: l.desc,
    note: l.note,
    cols: l.cols,
    derive: (l.derive ?? []).map((d) => ({ t: d.t, w: d.w })),
  }));
}

export function deriveValues(key, row) {
  const def = LEDGER_MAP[key];
  if (!def?.derive) return [];
  return def.derive.map((d) => String(d.fn(row) ?? ''));
}