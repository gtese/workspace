<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">备查资料生成</div>
        <div class="page-desc">
          25 份研发费用备查资料，按六个环节组织，数据自动取自系统，可导出 Word。
        </div>
      </div>
      <div class="controls">
        <div class="field">
          <label>口径</label>
          <select v-model="scope" @change="load">
            <option value="year">按年度</option>
            <option value="month">按月度</option>
          </select>
        </div>
        <div class="field">
          <label>{{ scope === 'year' ? '年度' : '月份' }}</label>
          <select v-model="period" @change="load">
            <option v-if="scope === 'year'" v-for="y in years" :key="y" :value="y">{{ y }} 年</option>
            <option v-else v-for="p in periods" :key="p" :value="p">{{ periodLabel(p) }}</option>
          </select>
        </div>
        <button class="btn pri" @click="downloadAll">整包下载 Word 合集</button>
      </div>
    </div>

    <LoadState :loading="loading" :error="error" @retry="load">
      <template v-if="stages.length">
        <div class="kpis">
          <div class="kpi pri">
            <div class="kpi-label">资料总数</div>
            <div class="kpi-value">{{ total }}</div>
            <div class="kpi-note">份</div>
          </div>
          <div class="kpi ok">
            <div class="kpi-label">已生成</div>
            <div class="kpi-value">{{ readyCount }}</div>
            <div class="kpi-note">可下载</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">环节</div>
            <div class="kpi-value">{{ stages.length }}</div>
            <div class="kpi-note">研发组织 → 结题备查</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">输出格式</div>
            <div class="kpi-value" style="font-size:15px;">Word (.docx)</div>
            <div class="kpi-note">带企业抬头与签章位</div>
          </div>
        </div>

        <div class="hint">
          资料数据自动取自系统：项目七要素、研发人员名册、工时记录、费用辅助账、
          多口径测算结果、合规自检结论等。生成前请先在
          <b>费用归集</b> 与 <b>备查台账</b> 中完善数据。
        </div>

        <div v-for="s in stages" :key="s.id" class="card">
          <div class="card-h">
            <div class="card-t">{{ s.name }}</div>
            <div class="card-s">{{ s.desc }}</div>
          </div>
          <div class="card-b flush">
            <div class="tbl-wrap">
              <table>
                <thead><tr>
                  <th style="width:56px;">序号</th>
                  <th>资料名称</th>
                  <th style="width:110px;">状态</th>
                  <th style="width:210px;">操作</th>
                </tr></thead>
                <tbody>
                  <tr v-for="(doc, i) in s.docs" :key="doc.key">
                    <td class="num">{{ i + 1 }}</td>
                    <td>
                      <div>{{ doc.name }}</div>
                      <div style="font-size:11px;color:var(--faint);">编号 {{ doc.key }}</div>
                    </td>
                    <td>
                      <span class="chip" :class="doc.status === 'ready' ? 'ok' : 'gray'">
                        <span class="dot"></span>{{ doc.status === 'ready' ? '已生成' : '未生成' }}
                      </span>
                    </td>
                    <td>
                      <button class="btn pri sm" @click="download(doc)">下载 Word</button>
                      <button class="btn ghost sm" style="margin-left:6px;" @click="preview(doc)">预览</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </template>
    </LoadState>

    <!-- 预览弹窗 -->
    <Modal v-if="previewDoc" :title="`预览 · ${previewDoc.name}`" width="860px" @close="closePreview">
      <div v-if="previewLoading" class="loading"><span class="spinner"></span>加载中…</div>
      <div v-else-if="previewError" class="alert bad">{{ previewError }}</div>
      <div v-else class="doc-preview" v-html="previewHtml"></div>
      <template #footer>
        <button class="btn ghost" @click="closePreview">关闭</button>
        <button class="btn pri" @click="download(previewDoc)">下载 Word</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { costingApi } from '../api.js';
import LoadState from '../components/LoadState.vue';
import Modal from '../components/Modal.vue';
import { periodLabel, recentPeriods } from '../utils.js';

const periods = recentPeriods();
const thisYear = new Date().getFullYear();
const years = [thisYear, thisYear - 1, thisYear - 2].map(String);
const scope = ref('year');
const period = ref(String(thisYear));
const stages = ref([]);
const total = ref(0);
const readyCount = ref(0);
const loading = ref(false);
const error = ref('');

const previewDoc = ref(null);
const previewHtml = ref('');
const previewLoading = ref(false);
const previewError = ref('');

async function load() {
  loading.value = true; error.value = '';
  try {
    const r = await costingApi.docs(period.value);
    stages.value = r.stages;
    total.value = r.total;
    readyCount.value = r.readyCount;
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}

function download(doc) {
  const url = costingApi.docDownloadUrl(doc.key, period.value, scope.value);
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.__toast?.('已开始下载', 'ok');
  setTimeout(load, 800);
}

function downloadAll() {
  const url = costingApi.docDownloadAllUrl(period.value, scope.value);
  const a = document.createElement('a');
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.__toast?.('正在生成合集，请稍候…');
  setTimeout(load, 2000);
}

/** 把生成的 OOXML 转成可读的 HTML 预览。 */
function xmlToHtml(xml) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = '';
  // 逐个段落解析：提取 w:t 文本，并识别表格结构
  const blocks = xml.split(/<w:tbl>|<\/w:tbl>/);
  let inTable = false;
  for (let bi = 0; bi < blocks.length; bi++) {
    const seg = blocks[bi];
    if (!inTable) {
      // 普通段落
      const paras = seg.split('<w:p>').slice(1);
      for (const p of paras) {
        const texts = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('');
        const isCenter = p.includes('w:jc w:val="center"');
        const isBold = p.includes('<w:b/>');
        const t = esc(texts).trim();
        if (!t) { out += '<p style="height:6px"></p>'; continue; }
        out += `<p style="${isCenter ? 'text-align:center;' : ''}${isBold ? 'font-weight:700;' : ''}">${t}</p>`;
      }
      inTable = true;
    } else {
      // 表格段
      const rows = seg.split('<w:tr>').slice(1);
      if (rows.length) {
        out += '<table>';
        for (const r of rows) {
          const cells = [...r.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((m) => {
            const ts = [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join('');
            return esc(ts);
          });
          const isHead = r.includes('<w:tblHeader/>');
          out += '<tr>' + cells.map((c) => isHead ? `<th>${c}</th>` : `<td>${c}</td>`).join('') + '</tr>';
        }
        out += '</table>';
      }
      inTable = false;
    }
  }
  return out;
}

async function preview(doc) {
  previewDoc.value = doc;
  previewLoading.value = true; previewError.value = '';
  try {
    const r = await costingApi.docPreview(doc.key, period.value, scope.value);
    previewHtml.value = xmlToHtml(r.xml);
  } catch (e) { previewError.value = e.message; }
  finally { previewLoading.value = false; }
}

function closePreview() { previewDoc.value = null; previewHtml.value = ''; }

onMounted(load);
</script>

<style scoped>
.doc-preview {
  font-size: 13px;
  line-height: 1.8;
  color: var(--ink);
  max-height: 62vh;
  overflow: auto;
  padding: 4px 2px;
}
.doc-preview :deep(p) { margin: 5px 0; }
.doc-preview :deep(table) {
  width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 12px;
}
.doc-preview :deep(th) {
  background: #F2F6FC; border: 1px solid #9FB0C8; padding: 5px 7px; font-weight: 700; text-align: left;
}
.doc-preview :deep(td) { border: 1px solid #9FB0C8; padding: 5px 7px; }
</style>