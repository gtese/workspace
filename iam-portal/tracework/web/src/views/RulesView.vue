<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">规则说明</div>
        <div class="page-desc">与《研发项目工时分配管理办法》口径一致，供填报与审批参照。</div>
      </div>
    </div>

    <div class="rule-grid">
      <div v-for="(r, i) in rules" :key="i" class="rule">
        <div class="rule-t"><span class="no">{{ i + 1 }}</span>{{ r.t }}</div>
        <div class="rule-d" v-html="r.d"></div>
      </div>
    </div>

    <div class="card" style="margin-top:16px;">
      <div class="card-h"><div class="card-t">系统与流程说明</div></div>
      <div class="card-b" style="font-size:13px;color:var(--sub);line-height:1.9;">
        <p><b style="color:var(--ink);">账号与权限：</b>本系统使用公司域账号（Active Directory）登录，账号密码由域控验证，系统不保存任何用户密码。
          初始角色由 AD 组决定（{{ store.user?.role === 'admin' ? '您当前为系统管理员' : '普通研发人员' }}），管理员可在「系统管理」中调整。</p>
        <p style="margin-top:8px;"><b style="color:var(--ink);">数据留存：</b>研发人员工时记录及相关审批资料保存期限不少于 <b style="color:var(--ink);">10 年</b>，
          系统对所有关键操作保留审计日志。</p>
        <p style="margin-top:8px;"><b style="color:var(--ink);">填报口径：</b>研发费用中的职工薪酬包括从事研发活动人员的工资奖金、
          基本养老保险费、基本医疗保险费、失业保险费、工伤保险费、生育保险费和住房公积金等；
          职工薪酬按照研发员工参与各项目的 <b style="color:var(--ink);">工时占比</b> 进行分摊。</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useAppStore } from '../store.js';

const store = useAppStore();

const rules = [
  { t: '填报主体与口径', d: '研发费用中的职工薪酬包括从事研发活动人员的<b>工资奖金、基本养老保险费、基本医疗保险费、失业保险费、工伤保险费、生育保险费和住房公积金</b>等；职工薪酬按照研发员工参与各项目的<b>工时占比</b>进行分摊。' },
  { t: '项目号规范', d: '项目号格式为 <b>RD-YYYY-NNN</b>（如 RD-2026-001）。研发人员在工时系统中按项目填写各工作日的时间投入，须<b>按小时、按项目号如实填报</b>。' },
  { t: '填报规则', d: '工时最小填报单位为 <b>0.5 小时</b>；单日各项目填报合计<b>不得超过当日考勤工时</b>；当月填报截止时间为<b>每月最后一个工作日</b>。' },
  { t: '审批与核查', d: '人力资源部每月汇总研发工时数据，并按研发项目分类后提交各项目负责人审批；审批时限为收到后 <b>2 个工作日</b>内。项目经理负责审核报工情况并根据项目进展确认报工准确性。' },
  { t: '异常核查', d: '人力资源部门负责审核考勤工时的准确性，并确认研发报工与考勤工时相比<b>不存在明显异常</b>；异常单据须退回核实后方可进入财务核算。' },
  { t: '财务结转', d: '已审批的研发工时由人力资源部于<b>次月第 4 个工作日前</b>提交财务部，用于研发费用归集、高新认定与加计扣除等后续核算工作。' },
  { t: '分摊公式', d: '某项目当月分摊职工薪酬 = Σ 各员工（<b>员工当月职工薪酬 × 该项目工时 ÷ 该员工当月总工时</b>）。非研发工时（如培训）对应薪酬不计入研发费用。' },
  { t: '档案留存', d: '研发人员工时记录及相关审批资料保存期限<b>不少于 10 年</b>，作为研发费用归集与审计核查的依据。' },
];
</script>