/** 必须在真实 Electron 中验证原生视图、坐标与导航，DOM 模拟不能覆盖这些行为。 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const {app, BrowserWindow, WebContentsView, ipcMain, session} = require('electron');
const {registerProjectPagePreview} = require('../electron/project-page-preview.cjs');
const output = path.resolve(__dirname, '../node_modules/.tmp/project-page-preview-smoke');
app.setPath('userData', path.join(output, 'native-profile'));
app.on('window-all-closed', () => {});
let window;
let registration;
const servers = [];
const unexpectedRequests = [];
const nativeEvents = [];
const remoteOrigin = 'https://preview.lingxi.test';
const deadline = setTimeout(() => { console.error('原生网页预览验证超时'); app.exit(1); }, 240000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = expression => window.webContents.executeJavaScript(expression);
const getViews = () => window.contentView.children.filter(view => view instanceof WebContentsView && view.webContents !== window.webContents);
let activeView;
const getView = () => {
  const views = getViews();
  activeView = views.find(view => view.getVisible()) ?? (views.includes(activeView) ? activeView : views.at(-1));
  return activeView;
};
// 模拟用户点击必须带用户手势，否则 Chromium 会跳过脚本创建的历史条目。
const runPage = expression => getView().webContents.executeJavaScript(expression, true);
async function waitFor(check, message) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await check()) return;
    await delay(75);
  }
  throw new Error('界面未达到预期状态: ' + message);
}
const waitState = state => waitFor(() => run(`window.__demo.page.loadState.value === ${JSON.stringify(state)}`), state);
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#385f76"/><path d="M7 6v12h10" fill="none" stroke="white" stroke-width="2"/></svg>';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Native preview</title><link rel="icon" href="/icon.svg">
<style>body{font:16px sans-serif;margin:24px}#tall{height:3200px}</style></head><body>
<h1 id="heading">native project page</h1><button id="inc">+1</button><span id="count">0</span>
<input id="name"><span id="echo"></span><button id="nav">next</button><span id="route"></span>
<p><a id="remote" href="${remoteOrigin}/landing">remote</a></p>
<p><a id="popup" href="${remoteOrigin}/popup" target="_blank">popup</a></p><div id="tall">scroll</div>
<script>
let count = 0;
document.getElementById('inc').onclick = () => document.getElementById('count').textContent = String(++count);
document.getElementById('name').oninput = event => document.getElementById('echo').textContent = event.target.value;
document.getElementById('nav').onclick = () => { history.pushState({}, '', '/next'); document.getElementById('route').textContent = location.pathname; };
</script></body></html>`;
async function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
async function enter(url) {
  await run(`(() => { const input = document.querySelector('.address-input'); input.value = ${JSON.stringify(url)};
    input.dispatchEvent(new Event('input', {bubbles: true})); input.form.requestSubmit(); })()`);
}
async function assertBounds() {
  await waitFor(async () => {
    const rect = await run(`(() => { const r = document.querySelector('.frame-area').getBoundingClientRect(); return {x:r.x+1,y:r.y+1,width:r.width-2,height:r.height-2}; })()`);
    const actual = getView().getBounds();
    const scale = window.webContents.getZoomFactor();
    return Object.entries(rect).every(([key, value]) => Math.abs(actual[key] - Math.round(value * scale)) <= 2);
  }, '原生视图与面板对齐');
}
function restrictNetwork(targetSession, localOrigins) {
  targetSession.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (details, callback) => {
    const allowed = [...localOrigins, remoteOrigin].includes(new URL(details.url).origin);
    if (!allowed) unexpectedRequests.push(details.url);
    callback({cancel: !allowed});
  });
}
async function assertChatViewWiring() {
  const source = await fs.readFile(path.resolve(__dirname, '../src/views/chat/ChatView.vue'), 'utf8');
  // 选择器必须是稳定的 data-test：中文文案会随语言切换，不能拿来当选择器
  assert.match(source, /data-test="chat-project-page-entry"/, 'ChatView 的页面预览入口必须带稳定 data-test');
  assert.match(source, /:aria-label="t\('chat\.view\.projectPagePreview'\)"/, '入口 aria-label 必须走 i18n，不写死中文');
  assert.doesNotMatch(source, /aria-label="项目页面预览"/, '入口不应再出现写死的中文 aria-label');
  // 只要求「渲染条件里同时含文件标签与页面预览打开态」；后面追加新的模式（如 designPreviewOpen）
  // 不该让断言变红 —— 曾经的死板写法 `v-if="fileTabs.length || pagePreviewOpen"` 在 82ace60e
  // 给模板加上 `|| designPreviewOpen` 之后就一直是红的。
  assert.match(source, /v-if="[^"]*\bfileTabs\.length\b[^"]*\bpagePreviewOpen\b/,
    '面板渲染条件必须包含页面预览打开状态');
  assert.match(source, /v-show="previewPanelVisible"/, '面板隐藏必须用 v-show，避免丢掉 iframe 实例');
  assert.match(source, /watch\(\[localActiveId, localActiveWorkspaceId\][\s\S]{0,80}pagePreview\.close\(\)/, '切换会话/工作区必须销毁页面实例');
}

app.whenReady().then(async () => {
  await assertChatViewWiring();
  await fs.mkdir(output, {recursive: true});
  const redirectOrigin = (await serve((_request, response) => {
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    response.end(PAGE);
  })).replace('127.0.0.1', 'localhost');
  const origin = await serve((request, response) => {
    if (request.url === '/icon.svg') { response.writeHead(200, {'Content-Type': 'image/svg+xml'}); response.end(ICON); return; }
    if (request.url === '/redirect') { response.writeHead(302, {Location: redirectOrigin + '/redirected'}); response.end(); return; }
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'"});
    response.end(PAGE);
  });
  const hangOrigin = await serve(() => {});
  const dead = net.createServer();
  await new Promise(resolve => dead.listen(0, '127.0.0.1', resolve));
  const deadOrigin = 'http://127.0.0.1:' + dead.address().port;
  await new Promise(resolve => dead.close(resolve));
  const previewSession = session.fromPartition('persist:lingxi-project-pages');
  const remoteHandler = request => {
    assert.equal(new URL(request.url).origin, remoteOrigin);
    if (new URL(request.url).pathname === '/icon.svg') return new Response(ICON, {headers: {'Content-Type': 'image/svg+xml'}});
    return new Response(PAGE, {headers: {'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'"}});
  };
  previewSession.protocol.handle('https', remoteHandler);
  session.defaultSession.protocol.handle('https', remoteHandler);
  restrictNetwork(previewSession, [origin, redirectOrigin, hangOrigin, deadOrigin]);
  restrictNetwork(session.defaultSession, [origin, redirectOrigin, hangOrigin, deadOrigin]);
  const source = `<script setup>
import {provide, ref} from 'vue';
import FilePreviewPanel from '../../../src/components/chat/FilePreviewPanel.vue';
import LxModal from '../../../src/components/common/LxModal.vue';
import {useProjectPagePreview} from '../../../src/composables/useProjectPagePreview';
import {PROJECT_PAGE_PREVIEW_KEY} from '../../../src/types/projectPagePreview';
import '../../../src/style.css';
const page = useProjectPagePreview();
provide(PROJECT_PAGE_PREVIEW_KEY, page);
const mode = ref('page'); const visible = ref(true); const modal = ref(false);
window.__demo = {page, mode, visible, modal};
</script><template>
<main style="display:flex;height:100vh;margin:0"><section style="flex:1;min-width:0">LX · 原生网页预览</section>
<FilePreviewPanel v-if="page.open.value" v-show="visible" :tabs="[]" activeId="" :isDark="false" :mode="mode"
 @update:mode="mode = $event" @close="page.hide()" />
<LxModal :open="modal" overlay-class="z-50 bg-black/50" panel-class="bg-white p-8" aria-label="验证弹窗" @close="modal=false">确认操作</LxModal>
</main></template>`;
  await fs.writeFile(path.join(output, 'App.vue'), source);
  await fs.writeFile(path.join(output, 'entry.js'), "import {createApp} from 'vue'; import App from './App.vue'; createApp(App).mount('#app');");
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const {build} = await import('vite');
  const {default: vue} = await import('@vitejs/plugin-vue');
  await build({configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error', build: {outDir: path.join(output, 'dist'), emptyOutDir: true}});
  window = new BrowserWindow({width: 1440, height: 900, show: false, webPreferences: {
    preload: path.resolve(__dirname, '../electron/preload.cjs'), nodeIntegration: false, contextIsolation: true, backgroundThrottling: false,
  }});
  function TracedView(options) {
    const view = new WebContentsView(options);
    for (const name of ['did-start-navigation', 'did-navigate', 'did-finish-load', 'did-stop-loading', 'did-fail-load']) {
      view.webContents.on(name, (_event, ...args) => nativeEvents.push({id: view.webContents?.id, name, args: args.slice(0,4)}));
    }
    return view;
  }
  registration = registerProjectPagePreview({ipcMain, getWindow: () => window, WebContentsView: TracedView, session, timeoutMs: 1800});
  ipcMain.handle('window:set-titlebar-theme', () => {});
  await window.loadFile(path.join(output, 'dist/index.html'));
  await waitFor(() => run('!!window.__demo'), '组件挂载');
  await run('window.__demo.page.open.value = true');
  await waitFor(() => run("!!document.querySelector('.address-input')"), '地址栏出现');
  await waitFor(() => run('!!window.__demo.page.activeTabId.value'), '权威标签创建');
  await enter(origin + '/initial?q=1#section');
  await waitState('loaded');
  await waitFor(() => getView()?.getVisible(), '原生视图显示');
  const initialView = getView();
  const firstTabId = await run('window.__demo.page.activeTabId.value');
  assert.equal(await run("document.querySelectorAll('iframe').length"), 0);
  assert.equal(await runPage("document.getElementById('heading').textContent"), 'native project page');
  assert.equal(await runPage('window === window.top'), true, '网站必须是独立顶层页面');
  await waitFor(() => run("window.__demo.page.tabs.value[0]?.title === 'Native preview' && window.__demo.page.tabs.value[0]?.favicon.endsWith('/icon.svg')"), '标题与网站图标同步');
  assert.deepEqual(await runPage('({node:typeof require,bridge:typeof window.electronAPI})'), {node: 'undefined', bridge: 'undefined'});
  assert.notEqual(initialView.webContents.session, window.webContents.session);
  const preferences = initialView.webContents.getLastWebPreferences();
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(Boolean(preferences.preload), false);
  await assertBounds();
  assert.ok(initialView.getBounds().height > window.getContentSize()[1] * 0.7, '网页应占满面板主要高度');
  await runPage("document.getElementById('inc').click(); document.getElementById('inc').click()");
  assert.equal(await runPage("document.getElementById('count').textContent"), '2');
  await runPage("document.getElementById('name').value='kept'; document.getElementById('name').dispatchEvent(new Event('input'))");
  assert.equal(await runPage("document.getElementById('echo').textContent"), 'kept');
  await runPage('window.scrollTo(0,500)');
  await waitFor(() => runPage('window.scrollY > 0'), '网页滚动');
  await runPage("document.getElementById('nav').click()");
  await waitFor(() => run(`window.__demo.page.committedUrl.value === ${JSON.stringify(origin + '/next')}`), '页内路由同步地址');
  await waitFor(() => run('window.__demo.page.activeTab.value.canGoBack'), '后退可用');
  await run("document.querySelector('.address-bar button[aria-label=后退]').click()");
  await waitFor(() => run(`window.__demo.page.committedUrl.value === ${JSON.stringify(origin + '/initial?q=1#section')}`), '后退保留当前视图');
  assert.equal(getView(), initialView);
  await run("document.querySelector('.address-bar button[aria-label=前进]').click()");
  await waitFor(() => run(`window.__demo.page.committedUrl.value === ${JSON.stringify(origin + '/next')}`), '前进恢复页面');

  await run("document.querySelector('.mode-switch button[title=文件]').click()");
  await waitFor(() => !getView().getVisible(), '文件模式隐藏原生视图');
  assert.equal(getView(), initialView);
  assert.equal(initialView.webContents.isDestroyed(), false);
  await run("document.querySelector('.mode-switch button[title=项目页面]').click()");
  await waitFor(() => getView().getVisible(), '恢复页面模式');
  assert.equal(await runPage("document.getElementById('name').value"), 'kept');
  assert.equal(await runPage("document.getElementById('count').textContent"), '2');
  await run('window.__demo.visible.value=false');
  await waitFor(() => !getView().getVisible(), '祖先面板隐藏');
  await run('window.__demo.visible.value=true');
  await waitFor(() => getView().getVisible(), '祖先面板恢复');
  await run('window.__demo.modal.value=true');
  await waitFor(() => !getView().getVisible(), '弹窗显示时隐藏原生视图');
  assert.equal(await run("!!document.querySelector('[aria-modal=true]')"), true);
  await run('window.__demo.modal.value=false');
  await waitFor(() => getView().getVisible(), '弹窗关闭后恢复');
  assert.equal(getView(), initialView);
  await run("document.querySelector('button[aria-label=最大化预览]').click()");
  await assertBounds();
  assert.ok(getView().getBounds().width > 1200);
  await run("document.querySelector('button[aria-label=还原面板]').click()");
  await assertBounds();
  const widthBefore = getView().getBounds().width;
  await run("document.querySelector('.resize-handle').dispatchEvent(new PointerEvent('pointerdown',{button:0,clientX:1200,bubbles:true}))");
  await waitFor(() => !getView().getVisible(), '拖拽期间隐藏原生视图');
  await run("window.dispatchEvent(new PointerEvent('pointermove',{clientX:1100,bubbles:true}));window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))");
  await waitFor(() => getView().getVisible(), '拖拽结束恢复');
  await assertBounds();
  assert.ok(getView().getBounds().width > widthBefore + 50);
  window.setSize(1280, 820);
  await assertBounds();
  window.webContents.setZoomFactor(1.25);
  await delay(300);
  await assertBounds();
  window.webContents.setZoomFactor(1);
  await delay(300);
  await assertBounds();
  await runPage("sessionStorage.setItem('tab-marker','first')");
  await run("document.querySelector('.new-page-tab').click()");
  await waitFor(() => run('window.__demo.page.tabs.value.length === 2'), '新建标签');
  const secondTabId = await run('window.__demo.page.activeTabId.value');
  assert.notEqual(secondTabId, firstTabId);
  assert.equal(initialView.webContents.isDestroyed(), false);
  assert.equal(initialView.getVisible(), false);
  await enter(origin + '/second');
  await waitState('loaded');
  const secondView = getView();
  assert.notEqual(secondView, initialView);
  await runPage("document.getElementById('name').value='second-kept'; document.getElementById('inc').click(); sessionStorage.setItem('tab-marker','second')");
  await initialView.webContents.executeJavaScript("document.title='Background first tab'");
  await waitFor(() => run("window.__demo.page.tabs.value[0].title === 'Background first tab'"), '后台标题按标签更新');
  assert.equal(await run('window.__demo.page.activeTabId.value'), secondTabId);
  await run("(() => { const handle=document.querySelector('.resize-handle'); for(let i=0;i<12;i++) handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); })()");
  await delay(150);
  await assertBounds();
  assert.equal(await run("(() => { const active=document.querySelector('.page-tab.is-active').getBoundingClientRect(); const list=document.querySelector('.page-tabs').getBoundingClientRect(); return active.left >= list.left-1 && active.right <= list.right+1; })()"), true, '缩窄后当前标签和关闭按钮必须保持可见');
  assert.equal(await run("(() => { const bar=document.querySelector('.address-bar'); return bar.scrollWidth <= bar.clientWidth + 1; })()"), true, '320px 地址栏不应横向溢出');
  window.showInactive(); await delay(250);
  await fs.writeFile(path.join(output, 'browser-tabs-narrow.png'), (await window.webContents.capturePage()).toPNG());
  window.hide();
  await run("(() => { const handle=document.querySelector('.resize-handle'); for(let i=0;i<10;i++) handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true})); })()");
  await delay(150); await assertBounds();

  await run(`document.getElementById('page-tab-' + ${JSON.stringify(firstTabId)}).click()`);
  await waitFor(() => initialView.getVisible(), '切回第一个标签');
  assert.equal(await runPage("document.getElementById('name').value"), 'kept');
  assert.equal(await runPage("document.getElementById('count').textContent"), '2');
  assert.equal(await runPage("sessionStorage.getItem('tab-marker')"), 'first');
  assert.ok(await runPage('window.scrollY > 0'));
  await run(`document.getElementById('page-tab-' + ${JSON.stringify(secondTabId)}).click()`);
  await waitFor(() => secondView.getVisible(), '切回第二个标签');
  assert.equal(await runPage("document.getElementById('name').value"), 'second-kept');
  assert.equal(await runPage("sessionStorage.getItem('tab-marker')"), 'second');
  const secondContents = secondView.webContents;
  await run(`document.getElementById('page-tab-' + ${JSON.stringify(secondTabId)}).parentElement.querySelector('.close-page-tab').click()`);
  await waitFor(() => secondContents.isDestroyed(), '关闭单个标签释放实例');
  assert.equal(initialView.webContents.isDestroyed(), false);
  await waitFor(() => initialView.getVisible(), '关闭当前标签后选择相邻标签');
  await runPage("document.cookie='nativeLogin=kept; path=/'; document.getElementById('remote').click()");
  await waitFor(() => run(`window.__demo.page.committedUrl.value === ${JSON.stringify(remoteOrigin + '/landing')}`), '跨站链接在应用内跳转');
  await waitState('loaded');
  assert.equal(getView(), initialView);
  assert.equal(await run("document.querySelector('.address-input').value"), remoteOrigin + '/landing');
  const beforePopupCount = await run('window.__demo.page.tabs.value.length');
  await runPage("document.getElementById('popup').click()");
  await waitFor(() => run(`window.__demo.page.tabs.value.length === ${beforePopupCount + 1}`), '新窗口链接创建新标签');
  await waitFor(() => runPage('location.pathname === "/popup"'), '新窗口链接在新标签加载');
  await waitState('loaded');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(initialView.webContents.getURL(), remoteOrigin + '/landing');
  assert.equal(initialView.webContents.isDestroyed(), false);
  await enter(origin + '/redirect');
  await waitFor(() => run(`window.__demo.page.committedUrl.value === ${JSON.stringify(redirectOrigin + '/redirected')}`), '服务端跨域重定向');
  await waitState('loaded');
  await enter(origin + '/reload');
  await waitState('loaded');
  assert.match(await runPage('document.cookie'), /nativeLogin=kept/);
  const beforeReload = getView();
  const beforeReloadContents = beforeReload.webContents;
  await runPage("document.getElementById('inc').click()");
  await run("document.querySelector('.address-bar button[aria-label=重新加载]').click()");
  await waitFor(() => runPage("document.getElementById('count').textContent === '0'"), '刷新恢复页面初始内容');
  await waitState('loaded');
  assert.equal(getView(), beforeReload, '刷新不能重建视图或丢失历史');
  assert.equal(beforeReloadContents.isDestroyed(), false);
  assert.equal(beforeReloadContents.navigationHistory.canGoBack(), true);
  assert.equal(await runPage("document.getElementById('count').textContent"), '0');
  assert.match(await runPage('document.cookie'), /nativeLogin=kept/);
  await enter(deadOrigin + '/');
  await waitState('failed');
  assert.match(await run('window.__demo.page.diagnoseText.value'), /连接/);
  await enter(hangOrigin + '/');
  await waitState('timeout');
  assert.equal(getView().webContents.isDestroyed(), false);
  await run("document.querySelector('.address-bar button[aria-label=停止加载]').click()");
  await waitState('stopped');
  assert.equal(await run('window.__demo.page.activeTab.value.isLoading'), false);
  await enter(remoteOrigin + '/recovered');
  await waitState('loaded');
  const beforeHostReload = getViews().map(view => view.webContents);
  window.webContents.reload();
  await waitFor(() => beforeHostReload.every(contents => contents.isDestroyed()), '主页面刷新释放所有标签');
  await waitFor(() => run('!!window.__demo && !window.__demo.page.open.value'), '主页面重新挂载');
  assert.equal(getViews().length, 0);
  await run('window.__demo.page.open.value=true');
  await waitFor(() => run("!!document.querySelector('.address-input')"), '刷新后地址栏恢复');
  await enter(remoteOrigin + '/after-host-reload');
  await waitState('loaded');
  const beforeLastTabClose = getView().webContents;
  await run("document.querySelector('.close-page-tab').click()");
  await waitFor(() => beforeLastTabClose.isDestroyed(), '关闭最后标签释放实例');
  await waitFor(() => run("window.__demo.page.tabs.value.length === 1 && window.__demo.page.committedUrl.value === ''"), '最后标签关闭后创建权威空白标签');
  await enter(remoteOrigin + '/final');
  await waitState('loaded');
  const last = getView();
  const lastContents = last.webContents;
  await run("document.querySelector('button[aria-label=关闭文件预览]').click()");
  // 收起 ≠ 销毁：面板卸载、原生视图让位，但标签与网页进程必须活着（重开原样恢复）。
  await waitFor(() => run('!window.__demo.page.open.value'), '收起面板');
  await waitFor(() => !last.getVisible(), '收起后原生视图隐藏');
  assert.equal(lastContents.isDestroyed(), false, '收起不得销毁网页进程');
  assert.equal(await run('window.__demo.page.tabs.value.length'), 1, '收起不得丢标签');
  assert.equal(await run('window.__demo.page.committedUrl.value'), remoteOrigin + '/final');
  assert.equal(await run('window.__demo.page.loadState.value'), 'loaded');
  // 隐藏窗口不产帧（Chromium 会暂停 rAF），先让窗口可见再验证恢复链路。
  window.showInactive(); await delay(250);
  await run("window.__demo.mode.value = 'page'; window.__demo.page.open.value = true");
  await waitFor(() => run('!!window.__demo.page.open.value'), '重新打开面板');
  // 重开必须复现「收起前的原位」：不能依赖下一帧重新量尺寸（窗口隐藏 / rAF 被节流时会失效）。
  await waitFor(() => last.getVisible(), '重开后原生视图回到原位');
  assert.equal(getView(), last, '重开必须复用原视图');
  await assertBounds();
  assert.equal(await runPage('location.href'), remoteOrigin + '/final');
  assert.equal(await run('window.__demo.page.tabs.value.length'), 1);
  await run('window.__demo.page.close()');
  await waitFor(() => getViews().length === 0, '销毁会话释放所有标签');
  await waitFor(() => lastContents.isDestroyed(), '网页进程释放完成');
  assert.equal(await run('window.__demo.page.loadState.value'), 'idle');
  assert.deepEqual(unexpectedRequests, []);
  console.log('多标签网页预览验证通过: 新建/切换/关闭标签、独立输入与 sessionStorage、后台标题、图标、后退/前进、刷新保留历史、停止加载、最后标签与会话释放、 顶层加载禁止嵌入页面、权限隔离、点击/输入/滚动、页内及跨站导航、新窗口链接、重定向、刷新、登录保留、尺寸与缩放、隐藏保活、拖拽、弹窗遮挡、失败与超时、收起保活与销毁释放');
}).then(() => {
  clearTimeout(deadline);
  registration?.close();
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  window?.destroy();
  app.exit(0);
}).catch(async error => {
  console.error(error);
  console.error('原生事件:', JSON.stringify(nativeEvents.slice(-30)));
  if (window && !window.isDestroyed()) console.error('标签状态:', await run('JSON.stringify(window.__demo?.page.tabs.value)').catch(() => '不可读'));
  if (window && !window.isDestroyed()) console.error(await run('document.body.innerText.slice(0,1200)').catch(() => '页面不可读'));
  registration?.close();
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  window?.destroy();
  app.exit(1);
});
