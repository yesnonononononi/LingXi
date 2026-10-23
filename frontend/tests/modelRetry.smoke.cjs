const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/model-retry');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('重试提示验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { reactive, computed, ref } from 'vue';
import ChatMessageItem from '../../../src/components/chat/ChatMessageItem.vue';
import { TurnStreamReducer } from '../../../src/views/chat/turnStreamReducer';
import { useI18n } from '../../../src/i18n';
import '../../../src/style.css';
const messages = reactive([]);
const isDark = ref(false);
const reducer = new TurnStreamReducer(() => messages, {sessionId:'7'});
const message = computed(() => messages.find(item => item.role === 'assistant'));
window.emitEvent = event => reducer.consume(event);
window.snapshot = () => JSON.parse(JSON.stringify(message.value));
window.language = useI18n().setPreference;
window.dark = value => {
  isDark.value = value;
  for (const element of [document.documentElement, document.body]) {
    element.classList.toggle('dark', value);
    element.classList.toggle('light', !value);
  }
};
window.dark(false);
</script><template><main style="max-width:680px;margin:24px auto"><ChatMessageItem v-if="message" :message="message" :is-dark="isDark" session-id="7" /></main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp,nextTick} from 'vue';
localStorage.setItem('lingxi-locale','zh-CN');
window.runtimeErrors=[];window.addEventListener('error',event=>window.runtimeErrors.push(event.message));
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,150));};
const {default:App}=await import('./App.vue');createApp(App).mount('#app');window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  window = new BrowserWindow({ width: 800, height: 420, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  for (let attempt = 0; attempt < 100 && !await evaluate('window.ready === true'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await evaluate('window.ready'), true);
  const metaData = { sessionId: '7', turnId: '9007199254741000' };
  const emit = event => evaluate(`window.emitEvent(${JSON.stringify({ executionId: 'e', timestamp: '', metaData, ...event })});window.flush()`);
  await emit({ type: 'EXECUTION_STARTED' });
  await emit({ type: 'PARTIAL_TEXT', responseId: '9007199254740992', offset: 0, order: 1, content: '未完成片段' });
  await emit({ type: 'INVOKE_RETRY', responseId: '9007199254740992', retryCount: 1, retryDelay: 750, timeUnit: 'MILLISECONDS' });
  assert.equal(await evaluate('document.querySelector("[role=status]").textContent.trim()'), '请求暂时失败，正在第 1 次重试…');
  assert.equal(await evaluate('document.body.textContent.includes("未完成片段")'), false);
  assert.equal((await evaluate('window.snapshot()')).isComplete, false);
  await fs.writeFile(path.join(output, 'retry-light.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('window.dark(true);window.flush()');
  assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(0, 0, 0)');
  await fs.writeFile(path.join(output, 'retry-dark.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('window.language("en-US");window.flush()');
  assert.equal(await evaluate('document.querySelector("[role=status]").textContent.trim()'), 'Request temporarily failed. Retrying (1)…');
  await emit({ type: 'PARTIAL_TEXT', responseId: '9007199254740992', offset: 0, order: 1, content: '旧回调' });
  assert.equal(await evaluate('document.body.textContent.includes("旧回调")'), false);
  await emit({ type: 'AI_MESSAGE', responseId: '9007199254740993', text: '恢复成功', order: 1, isBody: true });
  assert.equal(await evaluate('document.querySelector("[role=status]")'), null);
  assert.equal((await evaluate('window.snapshot()')).content, '恢复成功');
  await emit({ type: 'EXECUTION_COMPLETED' });
  assert.equal((await evaluate('window.snapshot()')).isComplete, true);
  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  console.log('重试组件通过：等待提示、失败片段撤下、旧回调丢弃、深浅主题、双语和成功接续。');
  clearTimeout(deadline); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); if (window) window.destroy(); app.exit(1); });
