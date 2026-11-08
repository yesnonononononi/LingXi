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
const remoteOrigin = 'https://preview.lingxi.test';
const deadline = setTimeout(() => { console.error('原生网页预览验证超时'); app.exit(1); }, 240000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = expression => window.webContents.executeJavaScript(expression);
const getView = () => window.contentView.children.find(view => view instanceof WebContentsView && view.webContents !== window.webContents);
const runPage = expression => getView().webContents.executeJavaScript(expression);
async function waitFor(check, message) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await check()) return;
    await delay(75);
  }
  throw new Error('界面未达到预期状态: ' + message);
}
const waitState = state => waitFor(() => run(`window.__demo.page.loadState.value === ${JSON.stringify(state)}`), state);
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Native preview</title>
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
  assert.match(source, /v-if="fileTabs\.length \|\| pagePreviewOpen"/, '面板渲染条件必须包含页面预览打开状态');
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
  previewSession.protocol.handle('https', request => {
    assert.equal(new URL(request.url).origin, remoteOrigin);
    return new Response(PAGE, {headers: {'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'"}});
  });
  restrictNetwork(previewSession, [origin, redirectOrigin, hangOrigin, deadOrigin]);
  restrictNetwork(session.defaultSession, [origin, redirectOrigin, hangOrigin, deadOrigin]);
  const source = `<script setup>
import {provide, ref} from 'vue';
import FilePreviewPanel from '../../../src/components/chat/FilePreviewPanel.vue';
import LxModal from '../../../src/components/common/LxModal.vue';
import {useProjectPagePreview} from '../../../src/composables/useProjectPagePreview';
import {PROJECT_PAGE_PREVIEW_KEY} from '../../../src/types/projectPagePreview';
import '../../../src/style.css';
const page = useProjectPagePreview({timeoutMs: 1800});
provide(PROJECT_PAGE_PREVIEW_KEY, page);
const mode = ref('page'); const visible = ref(true); const modal = ref(false);
window.__demo = {page, mode, visible, modal};
</script><template>
<main style="display:flex;height:100vh;margin:0"><section style="flex:1;min-width:0">LX · 原生网页预览</section>
<FilePreviewPanel v-if="page.open.value" v-show="visible" :tabs="[]" activeId="" :isDark="false" :mode="mode"
 @update:mode="mode = $event" @close="page.close()" />
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
  registration = registerProjectPagePreview({ipcMain, getWindow: () => window, WebContentsView, session});
  ipcMain.handle('window:set-titlebar-theme', () => {});
  await window.loadFile(path.join(output, 'dist/index.html'));
  await waitFor(() => run('!!window.__demo'), '组件挂载');
  await run('window.__demo.page.open.value = true');
  await waitFor(() => run("!!document.querySelector('.address-input')"), '地址栏出现');
  await enter(origin + '/initial?q=1#section');
  await waitState('loaded');
  await waitFor(() => getView()?.getVisible(), '原生视图显示');
  const initialView = getView();
  assert.equal(await run("document.querySelectorAll('iframe').length"), 0);
  assert.equal(await runPage("document.getElementById('heading').textContent"), 'native project page');
  assert.equal(await runPage('window === window.top'), true, '网站必须是独立顶层页面');
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
  await runPage("document.cookie='nativeLogin=kept; path=/'; document.getElementById('remote').click()");
  await waitFor(() => run(`window.__demo.page.committedUrl.value === ${JSON.stringify(remoteOrigin + '/landing')}`), '跨站链接在应用内跳转');
  await waitState('loaded');
  assert.equal(getView(), initialView);
  assert.equal(await run("document.querySelector('.address-input').value"), remoteOrigin + '/landing');
  await runPage("document.getElementById('popup').click()");
  await waitFor(() => runPage('location.pathname === "/popup"'), '新窗口链接留在当前视图');
  await waitState('loaded');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
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
  await waitFor(() => getView() !== beforeReload, '刷新换代');
  await waitState('loaded');
  assert.equal(beforeReloadContents.isDestroyed(), true);
  assert.equal(await runPage("document.getElementById('count').textContent"), '0');
  assert.match(await runPage('document.cookie'), /nativeLogin=kept/);
  await enter(deadOrigin + '/');
  await waitState('failed');
  assert.match(await run('window.__demo.page.diagnoseText.value'), /连接/);
  await enter(hangOrigin + '/');
  await waitState('timeout');
  assert.equal(getView().webContents.isDestroyed(), false);
  await enter(remoteOrigin + '/recovered');
  await waitState('loaded');
  const beforeHostReload = getView().webContents;
  window.webContents.reload();
  await waitFor(() => beforeHostReload.isDestroyed(), '主页面刷新释放原生视图');
  await waitFor(() => run('!!window.__demo && !window.__demo.page.open.value'), '主页面重新挂载');
  assert.equal(getView(), undefined);
  await run('window.__demo.page.open.value=true');
  await waitFor(() => run("!!document.querySelector('.address-input')"), '刷新后地址栏恢复');
  await enter(remoteOrigin + '/after-host-reload');
  await waitState('loaded');
  const last = getView();
  const lastContents = last.webContents;
  window.showInactive();
  await delay(300);
  await fs.writeFile(path.join(output, 'native-page.png'), (await last.webContents.capturePage()).toPNG());
  window.hide();
  await run("document.querySelector('button[aria-label=关闭文件预览]').click()");
  await waitFor(() => !getView(), '关闭释放原生视图');
  await waitFor(() => lastContents.isDestroyed(), '网页进程释放完成');
  assert.equal(await run('window.__demo.page.loadState.value'), 'idle');
  assert.deepEqual(unexpectedRequests, []);
  console.log('原生网页预览验证通过: 顶层加载禁止嵌入页面、权限隔离、点击/输入/滚动、页内及跨站导航、新窗口链接、重定向、刷新、登录保留、尺寸与缩放、隐藏保活、拖拽、弹窗遮挡、失败与超时、关闭释放');
}).then(() => {
  clearTimeout(deadline);
  registration?.close();
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  window?.destroy();
  app.exit(0);
}).catch(async error => {
  console.error(error);
  if (window && !window.isDestroyed()) console.error(await run('document.body.innerText.slice(0,1200)').catch(() => '页面不可读'));
  registration?.close();
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  window?.destroy();
  app.exit(1);
});
