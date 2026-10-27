const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/session-recovery');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('会话恢复验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { reactive, ref, nextTick } from 'vue';
import SessionConnectionNotice from '../../../src/components/chat/SessionConnectionNotice.vue';
import SubAgentSidePanel from '../../../src/components/chat/SubAgentSidePanel.vue';
import SubSessionDetailDrawer from '../../../src/components/chat/SubSessionDetailDrawer.vue';
import { SessionEventStream } from '../../../src/views/chat/sessionEventStream';
import { StreamSessionRouter } from '../../../src/views/chat/streamSessionRouter';
import { chatApi } from '../../../src/services/chat';
import { setPreference } from '../../../src/i18n';
import '../../../src/style.css';
setPreference('zh-CN');
const root = reactive({ id: '7', title: '会话', messages: [], subSessions: [{ id: '8', name: '成员', rootSessionId: '7', messages: [] }] });
const sub = root.subSessions[0];
const state = ref('IDLE');
const panelOpen = ref(true);
const drawerOpen = ref(false);
let controller;
let requests = 0;
const timers = new Map(); let timerId = 0;
chatApi.fetchSessionMessages = async () => ({ ok: true, data: { messages: [], records: [], turns: {}, turnViews: {}, hasMore: false, nextCursor: null } });
window.fetch = async () => { requests++; return new Response(new ReadableStream({ start(value) { controller = value; } })); };
const router = new StreamSessionRouter(); router.bindRootSession(root);
const stream = new SessionEventStream({
  onEvent: event => router.dispatch(event),
  onConnectionClosed: () => new Promise(() => {}),
  onHealthChange: (_root, value) => { state.value = value; },
  scheduleRetry: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
  cancelRetry: id => timers.delete(id),
});
const send = (type, payload = {}) => controller.enqueue(new TextEncoder().encode('event:' + type + '\\ndata:' + JSON.stringify(payload) + '\\n\\n'));
window.flush = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 100)); };
window.start = () => stream.acquire('7');
window.readyStream = () => send('READY');
window.drop = () => controller.error(new Error('Connection reset'));
window.retry = () => { const timer = [...timers.entries()].find(([, item]) => item.delay === 1000); if (timer) { timers.delete(timer[0]); timer[1].fn(); } };
window.requests = () => requests;
window.drawer = value => { drawerOpen.value = value; };
window.sendModel = (type, responseId = '100', content = '') => send(type, { type, executionId: 'e', timestamp: '', metaData: { rootSessionId: '7', sessionId: '8', turnId: '900' }, responseId, content, offset: 0, retryCount: 1, retryDelay: 1500, timeUnit: 'MILLISECONDS' });
</script><template>
<div style="height:500px;display:flex"><main style="flex:1"><SessionConnectionNotice :state="state" @reconnect="stream.reconnect()" /></main>
<SubAgentSidePanel :items="[{ id: '8', agentName: '成员', task: '', status: 'running', subSession: sub }]" active-sub-id="8"
  :active-sub-session="sub" :sub-messages="sub.messages" :is-open="panelOpen" :stream-health-state="state" @reconnect="stream.reconnect()" />
<SubSessionDetailDrawer :is-open="drawerOpen" :sub-session="sub" :stream-health-state="state" @reconnect="stream.reconnect()" />
</div></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp} from 'vue'; import App from './App.vue';
window.runtimeErrors=[];window.addEventListener('error',event=>window.runtimeErrors.push(event.message));
createApp(App).mount('#app');window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error',
    resolve: { dedupe: ['vue'] }, build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  const window = new BrowserWindow({ width: 1100, height: 620, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  assert.equal(await evaluate('window.ready'), true);
  const step = source => evaluate(`(async () => { ${source}; await window.flush(); })()`);
  const notices = () => evaluate(`[...document.querySelectorAll('[data-testid=session-connection-notice]')].map(element => element.textContent)`);
  await step('window.start()');
  assert.deepEqual(await notices(), [], '首次连接不显示断线提示');
  await step('window.readyStream()');
  await step('window.drawer(true)');
  await step('window.drop()');
  assert.equal((await notices()).length, 3, '主视图、子面板和抽屉都必须立即显示断线恢复提示');
  assert.ok((await notices()).every(text => text.includes('正在自动重连')));
  await step('window.retry()');
  assert.equal(await evaluate('window.requests()'), 2, '回查未返回也必须重连');
  assert.equal((await notices()).length, 3, '新连接收到 READY 前不能提前移除提示');
  await step('window.readyStream()');
  assert.deepEqual(await notices(), []);
  await step("window.sendModel('EXECUTION_STARTED'); window.sendModel('PARTIAL_THINKING', '100', '失败思考'); window.sendModel('INVOKE_RETRY')");
  assert.equal(await evaluate("document.querySelectorAll('.retry-notice').length"), 2, '同一子会话的面板和抽屉都显示模型重试');
  await step("window.sendModel('PARTIAL_THINKING', '101', '恢复思考')");
  assert.equal(await evaluate("document.querySelectorAll('.retry-notice').length"), 0);
  for (let index = 0; index < 6; index++) { await step('window.drop()'); if (index < 5) await step('window.retry()'); }
  assert.ok((await notices()).every(text => text.includes('重新连接')));
  await step("document.querySelector('[data-testid=session-connection-notice] button').click()");
  await step('window.readyStream()');
  assert.deepEqual(await notices(), []);
  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  console.log('PASS: 断线即时提示、回查挂起仍重连、主子会话提示、重试耗尽后手动恢复');
  await fs.writeFile(path.join(output, 'recovered.png'), (await window.webContents.capturePage()).toPNG());
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
