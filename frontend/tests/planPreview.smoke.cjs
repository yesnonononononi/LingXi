const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/plan-preview');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('计划书预览验证超时'); app.exit(1); }, 120000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  const content = '## 设计与验证\n\n完整阅读计划，再决定是否执行。\n\n'
    + '| 常量 | 路径 | 生命周期 | 是否入仓 |\n| --- | --- | --- | --- |\n'
    + '| ARTIFACT_ROOT | `<repo>/.lingxi/tmp/visual` | 可再生运行时产物 | 否 |\n\n'
    + '```sh\nnpm run build\n```\n\n'
    + Array.from({ length: 20 }, (_, index) => `### 步骤 ${index + 1}\n\n验证执行结果并记录关键依据。\n\n`).join('')
    + '计划末尾校验标记';
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref, provide } from 'vue';
import PlanCard from '../../../src/components/chat/PlanCard.vue';
import FilePreviewPanel from '../../../src/components/chat/FilePreviewPanel.vue';
import { DECIDE_TOOL_CALL_KEY } from '../../../src/types/toolDecision';
import { PLAN_PREVIEW_KEY } from '../../../src/types/previewPanel';
import { setPreference } from '../../../src/i18n';
import '../../../src/style.css';
const dark = ref(false);
const card = ref({kind:'PLAN',toolCallId:'plan-1',conversationId:'42',title:'交付计划与产物管理',content:${JSON.stringify(content)},pending:true,status:'pending',version:'7',allowedActions:['APPROVE','REJECT']});
const panelOpen = ref(false);
const planTabs = ref([]);
const unifiedTabs = ref([]);
const activeTabKey = ref('');
window.decisions = [];
window.insertedTips = [];
const onSendToChat = payload => window.insertedTips.push(payload.prompt);
provide(DECIDE_TOOL_CALL_KEY, async payload => window.decisions.push(payload));
provide(PLAN_PREVIEW_KEY, tab => {
  const existing = planTabs.value.find(item => item.id === tab.id);
  if (existing) {
    existing.title = tab.title;
    existing.promptCard = tab.promptCard;
  } else {
    planTabs.value.push({ ...tab });
    unifiedTabs.value.push({ key: 'plan:' + tab.id, kind: 'plan', targetId: tab.id, title: tab.title });
  }
  activeTabKey.value = 'plan:' + tab.id;
  panelOpen.value = true;
});
window.setDark = value => { dark.value = value; document.documentElement.classList.toggle('dark', value); };
window.completePlan = () => { Object.assign(card.value, {pending:false,status:'completed',outcome:'APPROVED',allowedActions:[]}); };
window.updatePlan = () => { card.value.content += '\\n\\n权威正文已更新'; };
window.setEnglish = () => setPreference('en-US');
window.panelOpen = panelOpen;
</script>
<template>
  <main style="display:flex;height:100vh;margin:0">
    <section style="flex:1;min-width:0;padding:20px;max-width:720px">
      <PlanCard :prompt-card="card" :is-dark="dark" />
    </section>
    <FilePreviewPanel
      v-if="panelOpen"
      :visible="panelOpen"
      :tabs="[]"
      activeId=""
      :unifiedTabs="unifiedTabs"
      :activeTabKey="activeTabKey"
      :planTabs="planTabs"
      :isDark="dark"
      @activateTab="activeTabKey = $event"
      @close="panelOpen = false"
      @sendToChat="onSendToChat"
    />
  </main>
</template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp,nextTick} from 'vue';
localStorage.setItem('lingxi-locale','zh-CN');
window.runtimeErrors=[];
window.addEventListener('error', event => window.runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection', event => window.runtimeErrors.push(String(event.reason)));
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,80));};
const {default:App}=await import('./App.vue');createApp(App).mount('#app');window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile:false,root:output,base:'./',plugins:[vue()],logLevel:'error',build:{target:'esnext',outDir:path.join(output,'dist'),emptyOutDir:true} });
  const window = new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate('window.ready===true')) break;
    await new Promise(resolve => setTimeout(resolve,50));
  }
  const run = async source => { await evaluate(source); await evaluate('window.flush()'); };
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);

  await evaluate('window.flush()');
  // 1. 主卡片只展示标题 + 蓝色执行按钮，不内嵌 Markdown 正文、不弹模态框
  assert.equal(await evaluate('document.querySelector("[data-testid=plan-card] [data-testid=plan-execute-button]") !== null'), true, '主卡片必须渲染蓝色执行按钮');
  assert.equal(await evaluate('document.querySelector("[data-testid=plan-card]").textContent.includes("计划末尾校验标记")'), false, '主卡片不应直接内嵌计划正文');
  assert.equal(await evaluate('document.querySelector("[role=dialog]") === null'), true, '不应存在独立模态预览框');

  // 2. 点击卡片在右侧预览面板打开「实现计划」Tab
  await click('[data-testid=plan-card]');
  assert.equal(await evaluate('window.panelOpen.value'), true, '点击卡片必须展开右侧预览面板');
  assert.equal(await evaluate('!!document.querySelector("[data-testid=plan-preview-content] table") && !!document.querySelector("[data-testid=plan-preview-content] pre")'), true, '右侧 Tab 必须保留 Markdown 排版');
  assert.equal(await evaluate('document.querySelector("[data-testid=plan-preview-content]").textContent.includes("计划末尾校验标记")'), true, '右侧 Tab 长文不能截断');

  // 3. Tips 插入按钮测试
  await run('(() => { const el = document.querySelector(".plan-tip-input"); el.value = "请先补充单元测试"; el.dispatchEvent(new Event("input", {bubbles: true})); })()');
  await click('[data-testid=plan-insert-tip]');
  assert.deepEqual(await evaluate('window.insertedTips'), ['请先补充单元测试'], '点击插入 Tip 应触发 sendToChat');

  // 4. 动态更新计划内容
  await run('window.updatePlan()');
  assert.equal(await evaluate('document.querySelector("[data-testid=plan-preview-content]").textContent.includes("权威正文已更新")'), true);

  // 5. 点击主卡片蓝色执行按钮（不冒泡误伤）
  await click('[data-testid=plan-execute-button]');
  assert.equal(await evaluate('window.decisions.length'), 1, '点击执行按钮应提交 APPROVE');
  assert.equal(await evaluate('window.decisions[0].action'), 'APPROVE');

  // 6. 已决态更新
  await run('window.completePlan()');
  assert.equal(await evaluate('document.querySelector("[data-testid=plan-execute-button]") === null'), true, '已决态不再显示执行按钮');
  assert.deepEqual(await evaluate('window.runtimeErrors'), [], '不得出现运行时错误');

  clearTimeout(deadline);
  window.destroy();
  app.exit(0);
}).catch(err => { console.error(err); app.exit(1); });
