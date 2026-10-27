const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../.run/session-recovery');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('会话恢复验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { reactive, ref, computed, nextTick } from 'vue';
import SessionConnectionNotice from '../../src/components/chat/SessionConnectionNotice.vue';
import SubAgentSidePanel from '../../src/components/chat/SubAgentSidePanel.vue';
import SubSessionDetailDrawer from '../../src/components/chat/SubSessionDetailDrawer.vue';
import { SessionEventStream } from '../../src/views/chat/sessionEventStream';
import { StreamSessionRouter } from '../../src/views/chat/streamSessionRouter';
import { useChatSubSession } from '../../src/views/chat/useChatSubSession';
import { chatApi } from '../../src/services/chat';
import { setPreference } from '../../src/i18n';
import '../../src/style.css';
setPreference('zh-CN');
const root = reactive({ id: '7', title: '会话', messages: [], subSessions: [{ id: '8', name: '成员', rootSessionId: '7', messages: [] }] });
const sub = root.subSessions[0];
const state = ref('IDLE');
const sessions = useChatSubSession({ currentActiveSession: computed(() => root) });
const drawerTargetId = ref('8');
const drawerSub = computed(() => root.subSessions.find(item => item.id === drawerTargetId.value));
const drawerOpen = ref(false);
let controller;
let requests = 0;
const timers = new Map(); let timerId = 0;
const pending = new Map();
chatApi.fetchSessionMessages = (id, cursor) => new Promise(resolve => {
  const key = String(id) + ':' + (cursor ?? 'initial');
  const queue = pending.get(key) ?? []; queue.push(resolve); pending.set(key, queue);
});
window.resolveHistory = (id, cursor = 'initial', ok = true) => {
  const resolve = pending.get(id + ':' + cursor)?.shift();
  if (!resolve) throw new Error('没有待完成的历史请求: ' + id + ':' + cursor);
  const start = cursor === 'initial' ? 100 : 90;
  const count = cursor === 'initial' ? 12 : 10;
  const views = Array.from({ length: count }, (_, index) => {
    const turnId = String(start + index);
    return { sessionId: id, turnId, status: 'COMPLETED', viewVersion: '1', userMessage: '任务' + turnId,
      blocks: [{ blockId: 'text:' + turnId, responseId: turnId, type: 'TEXT', order: 1,
        status: 'COMPLETE', isBody: true, text: ('历史轨迹 ' + id + ' ' + turnId + '\\n\\n').repeat(5) }] };
  });
  resolve({ ok, error: '旧请求失败', data: { records: [], turns: {}, messages: [],
    turnViews: Object.fromEntries(views.map(view => [view.turnId, view])), hasMore: cursor === 'initial', nextCursor: cursor === 'initial' ? 'older' : null } });
};
window.select = id => { void sessions.handleSelectSubSessionOption(id); };
window.panel = open => { sessions.isSubPanelOpen.value = open; };
window.grow = id => { const messages = root.subSessions.find(item => item.id === id).messages;
  messages[messages.length - 1].content += '\\n\\n' + '延后内容撑高布局\\n\\n'.repeat(30); };
root.subSessions.push({ id: '9', name: '第二成员', rootSessionId: '7', messages: [] });
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
window.drawer = (value, id = '8') => { drawerTargetId.value = id; drawerOpen.value = value; };
window.sendModel = (type, responseId = '100', content = '') => send(type, { type, executionId: 'e', timestamp: '', metaData: { rootSessionId: '7', sessionId: '8', turnId: '900' }, responseId, content, offset: 0, retryCount: 1, retryDelay: 1500, timeUnit: 'MILLISECONDS' });
</script><template>
<div style="height:500px;display:flex"><main style="flex:1"><SessionConnectionNotice :state="state" @reconnect="stream.reconnect()" /></main>
<SubAgentSidePanel :items="sessions.availableSubSessionItems.value" :active-sub-id="sessions.activeViewingSubSessionId.value"
  :active-sub-session="sessions.activeViewingSubSessionVO.value" :sub-messages="sessions.activeSubSessionMessages.value"
  :is-open="sessions.isSubPanelOpen.value" :is-loading-messages="sessions.isLoadingSubMessages.value"
  :is-loading-more-sub-messages="sessions.isLoadingMoreSubMessages.value" :has-more-sub-messages="sessions.hasMoreSubMessages.value"
  @load-more-messages="sessions.handleLoadMoreSubSessionHistory" @select-option="sessions.handleSelectSubSessionOption"
  :stream-health-state="state" @reconnect="stream.reconnect()" />
<SubSessionDetailDrawer :is-open="drawerOpen" :sub-session="drawerSub" :stream-health-state="state" @reconnect="stream.reconnect()" />
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
  await step("window.select('8'); window.resolveHistory('8'); window.start()");
  assert.deepEqual(await notices(), [], '首次连接不显示断线提示');
  await step('window.readyStream()');
  await step('window.drawer(true)');
  await step("window.resolveHistory('8')");
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
  await step('window.drawer(false); window.panel(false)');
  const measure = selector => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    return el ? { top: el.scrollTop, distance: el.scrollHeight - el.clientHeight - el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight } : null; })()`);
  const panelSelector = '[data-testid=sub-session-messages]';
  const drawerSelector = '[data-testid=sub-session-detail-messages]';
  const atBottom = async (selector, label) => {
    const geometry = await measure(selector);
    assert.ok(geometry && geometry.viewport > 0 && geometry.height > geometry.viewport + 300, label + ': 必须有真实长列表 ' + JSON.stringify(geometry));
    assert.ok(geometry.distance <= 2, label + ': 最新消息应在视口底部 ' + JSON.stringify(geometry));
  };
  // 新会话的请求故意晚于旧实现的 50 毫秒补滚，且完成后不再发任何实时事件。
  await step("window.select('9')");
  await new Promise(resolve => setTimeout(resolve, 180));
  await step("window.resolveHistory('9')");
  await atBottom(panelSelector, '慢历史加载完成');
  await step('window.panel(false)');
  await step('window.panel(true)');
  await atBottom(panelSelector, '缓存列表重开');
  await step("window.grow('9')");
  await atBottom(panelSelector, '正文延后增高');
  await step(`(() => { const el = document.querySelector('${panelSelector}'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: -150 }));
    el.scrollTop = 350; el.dispatchEvent(new Event('scroll')); })()`);
  await step("window.grow('9')");
  assert.ok(Math.abs((await measure(panelSelector)).top - 350) <= 2, '用户上翻时新内容不能抢走视口');
  const anchor = await evaluate(`(() => { const el = document.querySelector('${panelSelector}'); el.scrollTop = 0; el.dispatchEvent(new Event('scroll'));
    window.historyAnchor = el.querySelector('[data-testid=user-message]'); return window.historyAnchor.getBoundingClientRect().top; })()`);
  await step("window.resolveHistory('9', 'older')");
  const after = await evaluate('window.historyAnchor.getBoundingClientRect().top');
  assert.ok(Math.abs(anchor - after) <= 2, '前置分页必须保持阅读锚点: ' + JSON.stringify({ anchor, after }));
  await step("window.select('8')");
  await step("window.resolveHistory('8')");
  await atBottom(panelSelector, '切回子会话补齐历史');
  await step("window.select('9')");
  await step("window.select('8')");
  await atBottom(panelSelector, '切回已缓存子会话');
  await step("window.drawer(true, '8')");
  await new Promise(resolve => setTimeout(resolve, 180));
  await step("window.resolveHistory('8')");
  await atBottom(drawerSelector, '详情抽屉加载完成');
  await step("window.grow('8')");
  await atBottom(drawerSelector, '详情正文增高');
  await step(`(() => { const el = document.querySelector('${drawerSelector}'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: -150 }));
    el.scrollTop = 400; el.dispatchEvent(new Event('scroll')); })()`);
  await step("window.grow('8')");
  assert.ok(Math.abs((await measure(drawerSelector)).top - 400) <= 2, '详情抽屉上翻时也不能抢走视口');
  await step('window.drawer(false)');
  await step("window.drawer(true, '8')");
  await step("window.drawer(true, '9')");
  await step("window.resolveHistory('8', 'initial', false)");
  assert.equal(await evaluate(`document.querySelector('${drawerSelector}').textContent.includes('正在拉取')`), true, '旧请求失败不能结束新会话的加载态');
  await step("window.resolveHistory('9')");
  await atBottom(drawerSelector, '快速切换抽屉后的最新会话');
  // 重新拉历史期间仍有实时重试到达，加载状态不能把提示整块藏起来。
  await step('window.drawer(false)');
  await step("window.drawer(true, '8'); window.panel(false); window.select(null)");
  await step("window.select('8')");
  await step("window.sendModel('INVOKE_RETRY', '101')");
  assert.equal(await evaluate("document.querySelectorAll('.retry-notice').length"), 2, '历史尚未返回时仍要渲染实时重试提示');
  await step("window.resolveHistory('8')");
  assert.equal(await evaluate("document.querySelectorAll('.retry-notice').length"), 2, '历史补齐不能抹掉实时提示');
  await fs.writeFile(path.join(output, 'sub-session-bottom.png'), (await window.webContents.capturePage()).toPNG());
  console.log('PASS: 慢加载、缓存重开、切换、内容增高、主动上翻、历史分页锚点、抽屉请求乱序');
  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  console.log('PASS: 断线即时提示、回查挂起仍重连、主子会话提示、重试耗尽后手动恢复');
  await fs.writeFile(path.join(output, 'recovered.png'), (await window.webContents.capturePage()).toPNG());
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
