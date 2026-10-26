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
</script>
<template><main class="mx-auto max-w-lx-chat px-4 py-10">
<ChatMessageItem :message="message" :is-dark="dark" session-id="7" />
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
    const geometry = await evaluate(`(() => {
      const headers = [...document.querySelectorAll('[data-testid=process-segment-toggle]')];
      const previews = [...document.querySelectorAll('[data-testid=process-segment-preview]')];
      const preview = previews.at(-1); const text = preview.firstElementChild.firstChild;
      const range = document.createRange(); range.setStart(text, text.length - 6); range.setEnd(text, text.length);
      const end = range.getBoundingClientRect(); const box = preview.getBoundingClientRect();
      return { headers: headers.map(element => ({ expanded: element.getAttribute('aria-expanded'), height:element.getBoundingClientRect().height })),
        textCount: document.querySelectorAll('[data-testid=process-text]').length,
        details: document.querySelectorAll('[data-testid=process-segment-details]').length,
        width:document.documentElement.scrollWidth, viewport:innerWidth, tailLeft:end.left, tailRight:end.right,
        previewLeft:box.left, previewRight:box.right, background:getComputedStyle(document.body).backgroundColor, body:document.body.innerText };
    })()`);
    measurements.push({ name, ...geometry });
    assert.equal(geometry.background, dark ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)', '主题背景必须与组件配色一致');
    assert.equal(geometry.headers.length, 2);
    assert.equal(geometry.textCount, 2);
    assert.equal(geometry.details, 0, '折叠时不能挂载详细 Markdown 和工具结果');
    assert.ok(geometry.headers.every(header => header.expanded === 'false' && header.height <= 28));
    assert.ok(geometry.width <= geometry.viewport + 1, '摘要不能撑宽页面');
    assert.ok(geometry.tailRight <= geometry.previewRight + 1 && geometry.tailLeft >= geometry.previewLeft - 1, '最新尾部必须实际位于裁剪窗口内');
    assert.match(geometry.body, /写入、执行命令/);
    await fs.writeFile(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG());
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
  assert.match(failureGeometry.status, /1 项失败.*1 项状态未知/);
  await evaluate('document.querySelectorAll("[data-testid=process-segment-toggle]")[1].click(); window.flush()');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=process-segment-toggle]")[1].getAttribute("aria-expanded")'), 'true');
  await evaluate('document.querySelector("[data-testid=whole-process-toggle]").click(); window.flush()');
  assert.equal(await evaluate('document.querySelector("[data-testid=whole-process-toggle]").getAttribute("aria-expanded")'), 'false');
  assert.equal(await evaluate('document.querySelector("[data-testid=whole-process-content]").getBoundingClientRect().height'), 0);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=process-segment-details]").length'), 0);
  assert.doesNotMatch(await evaluate('document.body.innerText'), /现在开始修改配置|修改完成，继续核对依赖/);
  await evaluate('window.appendThought()');
  assert.equal(await evaluate('document.querySelector("[data-testid=whole-process-toggle]").getAttribute("aria-expanded")'), 'false');
  await evaluate('document.querySelector("[data-testid=whole-process-toggle]").click(); window.flush()');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=process-segment-toggle]")[1].getAttribute("aria-expanded")'), 'true');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=process-segment-details]").length'), 1);
  await evaluate('window.finish()');
  assert.equal(await evaluate('document.querySelector("[data-testid=whole-process-toggle]").getAttribute("aria-expanded")'), 'true');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=process-segment-toggle]")[1].getAttribute("aria-expanded")'), 'true');
  assert.match(await evaluate('document.body.innerText'), /配置修改与检查已完成/);
  await evaluate('document.querySelector("[data-testid=whole-process-toggle]").click(); window.flush()');
  assert.match(await evaluate('document.body.innerText'), /配置修改与检查已完成/);
  assert.doesNotMatch(await evaluate('document.body.innerText'), /现在开始修改配置|修改完成，继续核对依赖/);
  await fs.writeFile(path.join(output, 'whole-collapsed.png'), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'measurements.json'), JSON.stringify(measurements, null, 2));
  console.log('过程区：整轮折叠、独立分段、深浅主题、窄屏、尾部裁剪与手动展开保留验证通过。截图：' + output);
  clearTimeout(deadline); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); if (window) window.destroy(); app.exit(1); });
