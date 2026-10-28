const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../.run/process-segments');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('分段过程区验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref, nextTick } from 'vue';
import ChatMessageItem from '../../src/components/chat/ChatMessageItem.vue';
import { AgentToolName } from '../../src/utils/toolNames';
import { useTheme } from '../../src/composables/useTheme';
import { setPreference } from '../../src/i18n';
import '../../src/style.css';
setPreference('zh-CN');
const { setTheme } = useTheme();
const dark = ref(true);
const turn = ref(null);
const mountKey = ref(0);
const message = ref({ id: 'answer', role: 'assistant', turnId: '900', timestamp: 0, content: '',
  isComplete: false, isThinking: true,
  aiMessages: [{ id: 'text:101', responseId: '101', order: 1, text: '现在开始修改配置。' },
    { id: 'text:102', responseId: '102', order: 1, text: '修改完成，继续核对依赖。' }],
  thoughtSteps: [{ id: 'thinking:103', responseId: '103', order: 0, title: '思考', status: 'running',
    content: '正在检查配置和依赖关系。'.repeat(70) + '最新片段可见' }],
  toolCalls: [{ id: 'edit', responseId: '101', order: 2, toolName: AgentToolName.EditFile,
    status: 'success', args: { path: 'C:/project/mcp.json' } },
    { id: 'run', responseId: '101', order: 3, toolName: AgentToolName.ExecuteCommand,
      status: 'success', args: { command: 'npm test', intention: '检查配置' } }] });
window.flush = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 320)); };
window.setDark = async value => { dark.value = value; setTheme(value ? 'dark' : 'light'); await window.flush(); };
window.appendThought = async () => { message.value.thoughtSteps[0].content += '继续输出'; await window.flush(); };
window.failEarlier = async () => { message.value.toolCalls[0].toolName = 'mcp_docs_' + 'very_long_operation_name_'.repeat(8);
  message.value.toolCalls[0].status = 'failed'; message.value.toolCalls[1].status = 'unknown'; await window.flush(); };
window.finish = async () => { message.value.isThinking = false; message.value.isComplete = true;
  message.value.content = '配置修改与检查已完成。'; message.value.thoughtSteps[0].status = 'success'; await window.flush(); };
window.reenterWaiting = async () => { turn.value = { status: 'WAITING' }; message.value.isComplete = false;
  message.value.isSuspended = true; mountKey.value++; await window.flush(); };
window.runClosedSegment = async () => { turn.value={status:'RUNNING'};
  message.value={id:'answer',role:'assistant',turnId:'900',timestamp:0,content:'',isComplete:false,
    aiMessages:[{id:'before',order:0,text:'开始核验。'},{id:'after',order:3,text:'继续等待命令收尾。'}],
    toolCalls:[{id:'long',toolName:AgentToolName.ExecuteCommand,order:1,status:'calling',query:JSON.stringify({command:'npm test',intention:'长任务核验'})},
      {id:'read',toolName:AgentToolName.ReadFile,order:2,status:'success',args:{path:'ApplicationContextAssemblyTest.java'}}]};
  mountKey.value++; await window.flush(); };
window.completeCommand = async () => { message.value.toolCalls[0].status='success'; message.value.toolCalls[0].result='核验通过'; await window.flush(); };
</script>
<template><main class="mx-auto max-w-lx-chat px-4 py-10">
<ChatMessageItem :key="mountKey" :message="message" :turn="turn" :is-dark="dark" session-id="7" />
</main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp } from 'vue';
import App from './App.vue'; createApp(App).mount('#app'); window.ready = true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error',
    resolve: { dedupe: ['vue'] }, build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  window = new BrowserWindow({ width: 1000, height: 680, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', event => { if (event.level === 3) errors.push(event.message); });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  assert.equal(await evaluate('window.ready'), true);
  const measurements = [];
  for (const [name, width, dark] of [['dark', 1000, true], ['light', 1000, false], ['narrow', 360, true]]) {
    window.setContentSize(width, 680);
    await evaluate(`window.setDark(${dark})`);
    // 新契约：两段过程各有一行摘要（live 段 + summary 段），细节默认折叠 —— 先量折叠态。
    const geometry = await evaluate(`(() => {
      const headers = [...document.querySelectorAll('[data-testid=process-segment-toggle]')];
      const live = document.querySelector('[data-process-mode=live]');
      return { headers: headers.map(element => ({ expanded: element.getAttribute('aria-expanded'), height:element.getBoundingClientRect().height })),
        textCount: document.querySelectorAll('[data-testid=process-text]').length,
        details: document.querySelectorAll('[data-testid=process-segment-details]').length,
        liveCount:document.querySelectorAll('[data-process-mode=live]').length,
        liveSummaries:live.querySelectorAll('[data-testid=process-segment-toggle]').length,
        liveSweep:!!live.querySelector('[data-testid=process-segment-title].lx-sweep-text'),
        summarySweep:!!document.querySelector('[data-process-mode=summary] [data-testid=process-segment-title].lx-sweep-text'),
        width:document.documentElement.scrollWidth, viewport:innerWidth,
        background:getComputedStyle(document.body).backgroundColor, body:document.body.innerText };
    })()`);
    measurements.push({ name, ...geometry });
    assert.equal(geometry.background, dark ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)', '主题背景必须与组件配色一致');
    assert.equal(geometry.headers.length, 2, '运行段与收尾段各有一行摘要');
    assert.equal(geometry.textCount, 2);
    assert.equal(geometry.details, 0, '细节默认折叠，运行态不再直接铺满');
    assert.equal(geometry.liveCount, 1);
    assert.equal(geometry.liveSummaries, 1);
    assert.equal(geometry.liveSweep, true, 'live 模式的标题必须带扫光');
    assert.equal(geometry.summarySweep, false, 'summary 模式不挂扫光');
    assert.ok(geometry.headers.every(header => header.expanded === 'false' && header.height <= 28));
    assert.ok(geometry.width <= geometry.viewport + 1, '摘要不能撑宽页面');
    assert.match(geometry.body, /写入、执行命令/);
    // 展开 live 段后，思考框才进入布局，量它的高度。
    await evaluate('document.querySelector("[data-process-mode=live] [data-testid=process-segment-toggle]").click(); window.flush()');
    const liveGeometry = await evaluate(`(() => {
      const thinking = document.querySelector('[data-process-mode=live] .thinking-content');
      return { thinkingHeight: thinking ? thinking.clientHeight : -1,
        details: document.querySelectorAll('[data-testid=process-segment-details]').length };
    })()`);
    measurements.push({ name: name + '-expanded', ...liveGeometry });
    assert.equal(liveGeometry.details, 1, '展开后只多出 live 段的细节');
    assert.ok(liveGeometry.thinkingHeight > 0 && liveGeometry.thinkingHeight <= 288, '思考框有可视高度且限高');
    await fs.writeFile(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG());
    await evaluate('document.querySelector("[data-process-mode=live] [data-testid=process-segment-toggle]").click(); window.flush()');
  }
  await evaluate('window.failEarlier()');
  const failureGeometry = await evaluate(`(() => {
    const row = document.querySelector('[data-testid=process-segment-toggle]');
    const label = row.querySelector('[data-testid=process-segment-title]');
    const status = row.querySelector('[data-testid=process-segment-status]');
    return { right:row.getBoundingClientRect().right, labelRight:label.getBoundingClientRect().right,
      statusRight:status.getBoundingClientRect().right, status:status.textContent };
  })()`);
  assert.ok(failureGeometry.labelRight <= failureGeometry.right + 1 && failureGeometry.statusRight <= failureGeometry.right + 1,
    '长 MCP 名称和状态提示不能挤出窄屏折叠行：' + JSON.stringify(failureGeometry));
  assert.equal(failureGeometry.status, '1 项状态未知');
  await evaluate('document.querySelector("[data-testid=process-segment-toggle]").click(); window.flush()');
  assert.equal(await evaluate('document.querySelector("[data-testid=process-segment-toggle]").getAttribute("aria-expanded")'), 'true');
  await evaluate('document.querySelector("[data-testid=whole-process-toggle]").click(); window.flush()');
  assert.equal(await evaluate('document.querySelector("[data-testid=whole-process-toggle]").getAttribute("aria-expanded")'), 'false');
  assert.equal(await evaluate('document.querySelector("[data-testid=whole-process-content]").getBoundingClientRect().height'), 0);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=process-segment-details]").length'), 0);
  assert.doesNotMatch(await evaluate('document.body.innerText'), /现在开始修改配置|修改完成，继续核对依赖/);
  await evaluate('window.appendThought()');
  assert.equal(await evaluate('document.querySelector("[data-testid=whole-process-toggle]").getAttribute("aria-expanded")'), 'false');
  await evaluate('document.querySelector("[data-testid=whole-process-toggle]").click(); window.flush()');
  assert.equal(await evaluate('document.querySelector("[data-testid=process-segment-toggle]").getAttribute("aria-expanded")'), 'true');
  // 用户只展开过 summary 段；live 段仍保持默认折叠（新契约：细节从不自动铺开）。
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=process-segment-details]").length'), 1);
  assert.equal(await evaluate('document.querySelector("[data-process-mode=live] [data-testid=process-segment-toggle]").getAttribute("aria-expanded")'), 'false');
  await evaluate('window.finish()');
  assert.equal(await evaluate('document.querySelector("[data-testid=whole-process-toggle]").getAttribute("aria-expanded")'), 'true');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-testid=process-segment-toggle]")].map(button=>button.getAttribute("aria-expanded"))'), ['true','false']);
  assert.equal(await evaluate('document.querySelectorAll("[data-process-mode=live]").length'), 0);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=process-segment-details]").length'), 1);
  assert.match(await evaluate('document.body.innerText'), /配置修改与检查已完成/);
  await evaluate('document.querySelector("[data-testid=whole-process-toggle]").click(); window.flush()');
  assert.match(await evaluate('document.body.innerText'), /配置修改与检查已完成/);
  assert.doesNotMatch(await evaluate('document.body.innerText'), /现在开始修改配置|修改完成，继续核对依赖/);
  await fs.writeFile(path.join(output, 'whole-collapsed.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('window.reenterWaiting()');
  assert.equal(await evaluate('document.querySelector("[data-testid=whole-process-toggle]").getAttribute("aria-expanded")'), 'true',
    '重新进入等待中的会话，无需手动展开执行过程');
  assert.ok(await evaluate('document.querySelector("[data-testid=whole-process-content]").getBoundingClientRect().height > 0'));
  assert.match(await evaluate('document.body.innerText'), /现在开始修改配置/);
  assert.match(await evaluate('document.body.innerText'), /修改完成，继续核对依赖/);
  assert.equal(await evaluate('document.querySelectorAll("[data-process-mode=live]").length'), 1);
  await fs.writeFile(path.join(output, 'waiting-reentry.png'), (await window.webContents.capturePage()).toPNG());
  window.setContentSize(1000,680);
  await evaluate('window.setDark(false);window.runClosedSegment()');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=process-segment-toggle]").length'),1,
    '命令未结束时已有一行摘要，但文案是最新一步而非工具集合');
  assert.equal(await evaluate('document.querySelector("[data-testid=process-segment]").dataset.processMode'),'live');
  assert.match(await evaluate('document.querySelector("[data-testid=process-segment-title]").textContent'),/读取/,
    'live 模式标题取最新一步，不是工具集合');
  assert.equal(await evaluate('document.querySelector("[data-testid=process-segment-details]") === null'),true,
    '运行态细节默认折叠');
  await evaluate('document.querySelector("[data-testid=process-segment-toggle]").click(); window.flush()');
  await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="长任务核验").click();window.flush()');
  assert.match(await evaluate('document.body.innerText'),/正在执行中/);
  await fs.writeFile(path.join(output, 'running-between-text.png'), (await window.webContents.capturePage()).toPNG());
  // 收回手动展开，验证摘要行默认收起。
  await evaluate('document.querySelector("[data-testid=process-segment-toggle]").click(); window.flush()');
  await evaluate('window.completeCommand()');
  assert.equal(await evaluate('document.querySelector("[data-testid=process-segment]").dataset.processMode'),'summary');
  assert.equal(await evaluate('document.querySelector("[data-testid=process-segment-toggle]").getAttribute("aria-expanded")'),'false');
  assert.match(await evaluate('document.querySelector("[data-testid=process-segment-title]").textContent'),/执行命令、读取/);
  await fs.writeFile(path.join(output, 'completed-between-text.png'), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'measurements.json'), JSON.stringify(measurements, null, 2));
  console.log('过程区：运行节点不被摘要占位、文本间命令收尾后才生成摘要、整轮折叠、深浅主题、窄屏与历史展开选择保留验证通过。截图：' + output);
  clearTimeout(deadline); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); if (window) window.destroy(); app.exit(1); });
