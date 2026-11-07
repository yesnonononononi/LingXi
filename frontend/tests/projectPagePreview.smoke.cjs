/**
 * 项目页面预览（阶段一）冒烟验证：offscreen Electron 里跑真实 iframe。
 *
 * <p>为什么必须用 npx electron 而不是 jsdom：本阶段的验收点是「iframe 内真实渲染出内容、能点、能输入、
 * 能滚动、能路由跳转、切换模式不丢输入、未启动服务与禁止嵌入有可理解反馈」，这些只有真 Chromium 才能证明。</p>
 *
 * <p>交互方式说明：目标页面与父页面跨源，父页面读不到 iframe 的 DOM（这正是隔离生效的证据）。
 * 因此测试通过 `webContents.mainFrame.frames` 找到目标子 frame，在**它自己的**上下文里派发真实 DOM 事件并读回 DOM。
 * 与「组件被渲染了」不同，这里断言的是页面里的计数、输入回显、滚动位置与 location.pathname。</p>
 *
 * <p>产物（构建、截图、profile）全部落在 node_modules/.tmp 下，工作区不留日志。</p>
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const {app, BrowserWindow, ipcMain, shell} = require('electron');
const {registerProjectPagePreview} = require('../electron/project-page-preview.cjs');
const {registerFilePreview} = require('../electron/file-preview.cjs');

const output = path.resolve(__dirname, '../node_modules/.tmp/project-page-preview-smoke');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});

let window;
const servers = [];
let closePreviewIpc;
let closeFileIpc;
const deadline = setTimeout(() => {
  console.error('项目页面预览冒烟验证超时');
  app.exit(1);
}, 180000);

/** 轮询等待父页面里的表达式为真。 */
async function waitFor(expression, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('界面未达到预期状态: ' + expression);
}

/** 在父页面执行表达式。 */
const run = expression => window.webContents.executeJavaScript(expression);

/**
 * 取一个「现在就拒绝连接」的本地端口（用于「服务未启动」场景）。
 *
 * <p>只用 `listen(0)` 再关闭不够：端口释放后可能被别的进程（或本进程后续的临时端口分配）重新占上，
 * 于是「未启动服务」用例实际打到了一个活端口，拿回 ERR_INVALID_HTTP_RESPONSE 之类的错误码。
 * 这里在返回前真的连一次，确认是连接被拒绝才算数。</p>
 *
 * @returns {Promise<number>} 确认拒绝连接的端口号。
 */
async function closedPort() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await freePort();
    const refused = await new Promise(resolve => {
      const socket = net.connect({host: '127.0.0.1', port});
      const done = value => {
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => done(false));
      socket.once('error', () => done(true));
    });
    if (refused) return port;
  }
  throw new Error('找不到确认拒绝连接的本地端口');
}

/** 取一个当前没被监听的本地端口（仅作为 {@link closedPort} 的候选来源）。 */
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** 目标子 frame（URL 属于指定 origin）。 */
function findFrame(origin) {
  const deadlineAt = Date.now() + 15000;
  while (Date.now() < deadlineAt) {
    const frames = window.webContents.mainFrame.frames || [];
    const matched = frames.find(frame => typeof frame.url === 'string' && frame.url.startsWith(origin));
    if (matched) return matched;
    // frames 是同步快照，靠外层等待重试
    return waitForFrameLater(origin);
  }
  throw new Error('未找到目标子 frame: ' + origin);
}

/** 等一帧后再找（避免忙等）。 */
async function waitForFrameLater(origin) {
  await new Promise(resolve => setTimeout(resolve, 100));
  const frames = window.webContents.mainFrame.frames || [];
  const matched = frames.find(frame => typeof frame.url === 'string' && frame.url.startsWith(origin));
  if (!matched) return findFrame(origin);
  return matched;
}

/** 在目标 frame 内执行脚本。 */
async function runInFrame(origin, expression) {
  const frame = await findFrame(origin);
  return frame.executeJavaScript(expression);
}

/** 起一个 HTTP 服务并登记，退出时统一关闭。 */
function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const DEMO_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>LingXi Demo Project</title>
<style>body{margin:0;font-family:sans-serif}#tall{height:3200px}</style></head><body>
<h1 id="heading">demo project page</h1>
<button id="inc" type="button">+1</button><span id="count">0</span>
<input id="name" aria-label="name"><span id="echo"></span>
<button id="nav" type="button">go next</button><span id="route"></span>
<div id="tall">tall</div>
<script>
const count = document.getElementById('count');
let n = 0;
document.getElementById('inc').addEventListener('click', () => { n += 1; count.textContent = String(n); });
document.getElementById('name').addEventListener('input', event => { document.getElementById('echo').textContent = event.target.value; });
document.getElementById('nav').addEventListener('click', () => { history.pushState({}, '', '/next'); document.getElementById('route').textContent = location.pathname; });
document.getElementById('route').textContent = location.pathname;
</script></body></html>`;

/** 静态结构断言：ChatView 的入口与渲染条件。 */
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
  await fs.mkdir(output, {recursive: true});
  await assertChatViewWiring();

  // 1. 真实可交互的项目页面
  const demo = await serve((request, response) => {
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    response.end(DEMO_PAGE);
  });
  const demoOrigin = 'http://127.0.0.1:' + demo.address().port;
  // 2. 禁止嵌入的对照页
  const deny = await serve((request, response) => {
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY'});
    response.end('<!doctype html><html><body><p id="denied">denied</p></body></html>');
  });
  const denyOrigin = 'http://127.0.0.1:' + deny.address().port;
  // 3. 「握手但不回应」的服务，用来走真实的等待超时路径
  const hang = await serve(() => { /* 故意不响应 */ });
  const hangOrigin = 'http://127.0.0.1:' + hang.address().port;
  // 4. 文件预览需要的假后端（让面板里能有一个文件标签用于模式切换）
  const workspace = path.join(output, 'workspace');
  await fs.mkdir(workspace, {recursive: true});
  await fs.writeFile(path.join(workspace, 'demo.ts'), 'export const demo = 1;\n');
  const backend = await serve((request, response) => {
    const data = request.url === '/config/current' ? {type: 'LOCAL'}
      : request.url.startsWith('/session/') ? {workspaceId: '100'}
        : {hostDir: workspace};
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({code: 1, data}));
  });
  const backendBase = 'http://127.0.0.1:' + backend.address().port;
  const deadPort = await closedPort();

  // 5. 用 Vite 现场构建一个只挂预览面板的宿主页面（与 filePreview.smoke.cjs 同一套路）
  const source = `<script setup>
import { computed, provide, ref } from 'vue';
import FilePreviewPanel from '../../../src/components/chat/FilePreviewPanel.vue';
import { useFilePreview } from '../../../src/composables/useFilePreview';
import { useProjectPagePreview } from '../../../src/composables/useProjectPagePreview';
import { FILE_PREVIEW_KEY } from '../../../src/types/filePreview';
import { PROJECT_PAGE_PREVIEW_KEY } from '../../../src/types/projectPagePreview';
import '../../../src/style.css';
localStorage.setItem('lingxi_api_base_url', ${JSON.stringify(backendBase)});
const file = useFilePreview();
provide(FILE_PREVIEW_KEY, file.openFilePreview);
const page = useProjectPagePreview({ timeoutMs: 4000 });
provide(PROJECT_PAGE_PREVIEW_KEY, page);
const mode = ref('page');
const visible = computed(() => file.filePreviewOpen.value || page.open.value);
window.__demo = { file, page, mode };
</script>
<template>
  <main style="display:flex;height:100vh;margin:0">
    <section style="flex:1;min-width:0;padding:24px">LX · 项目页面预览</section>
    <FilePreviewPanel
      v-if="file.fileTabs.value.length || page.open.value"
      v-show="visible"
      :tabs="file.fileTabs.value"
      :activeId="file.activeFileId.value"
      :isDark="false"
      :mode="mode"
      @update:mode="mode = \$event"
      @activate="file.activeFileId.value = \$event"
      @closeTab="file.closeFileTab"
      @close="() => { file.filePreviewOpen.value = false; page.close(); }"
      @refresh="file.refreshFile"
      @open="() => file.runFileAction('open')"
      @reveal="() => file.runFileAction('reveal')"
    />
  </main>
</template>`;
  await fs.writeFile(path.join(output, 'App.vue'), source);
  await fs.writeFile(path.join(output, 'entry.js'), "import { createApp } from 'vue'; import App from './App.vue'; createApp(App).mount('#app');");
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const {build} = await import('vite');
  const {default: vue} = await import('@vitejs/plugin-vue');
  await build({configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error', build: {outDir: path.join(output, 'dist'), emptyOutDir: true}});

  window = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: {
      preload: path.resolve(__dirname, '../electron/preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  window.webContents.on('console-message', event => {
    if (event.level === 'error') console.error('宿主页面:', event.message);
  });
  const remoteRequests = [];
  window.webContents.session.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*']}, (details, callback) => {
    const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(\/|$)/.test(details.url);
    if (!loopback) remoteRequests.push(details.url);
    callback({cancel: !loopback});
  });
  closePreviewIpc = registerProjectPagePreview({ipcMain, getWindow: () => window});
  closeFileIpc = registerFilePreview({ipcMain, shell, getWindow: () => window});
  ipcMain.handle('window:set-titlebar-theme', () => {});

  await window.loadFile(path.join(output, 'dist/index.html'));
  await waitFor('!!window.__demo');

  // ---- 1. 打开面板进入页面模式，通过界面输入地址并点「打开」 ----
  await run(`window.__demo.page.open.value = true`);
  await waitFor(`!!document.querySelector('.project-page-preview')`);
  await waitFor(`!!document.querySelector('.address-input')`);
  await run(`(() => {
    const input = document.querySelector('.address-input');
    input.value = ${JSON.stringify(demoOrigin + '/settings/profile?tab=theme')};
    input.dispatchEvent(new Event('input', {bubbles: true}));
    document.querySelector('.address-input').form.querySelector('button.primary').click();
  })()`);
  await waitFor(`!!document.querySelector('.page-frame')`);
  await waitFor(`window.__demo.page.loadState.value === 'loaded'`);
  assert.match(await run(`document.querySelector('.status-text').textContent`), /已收到页面加载事件/);
  assert.match(await run(`document.querySelector('.browse-mode').textContent`), /编辑能力尚未接入/);

  // iframe 属性：sandbox 白名单 + referrerpolicy + title
  const frameAttrs = await run(`(() => {
    const frame = document.querySelector('iframe.page-frame');
    return {sandbox: frame.getAttribute('sandbox'), referrer: frame.getAttribute('referrerpolicy'), title: frame.getAttribute('title'), src: frame.getAttribute('src')};
  })()`);
  assert.equal(frameAttrs.sandbox, 'allow-scripts allow-same-origin allow-forms allow-modals');
  assert.doesNotMatch(frameAttrs.sandbox, /allow-top-navigation|allow-popups|allow-downloads/);
  assert.equal(frameAttrs.referrer, 'no-referrer');
  assert.equal(frameAttrs.title, '项目页面预览');
  assert.match(frameAttrs.src, /\/settings\/profile\?tab=theme$/);

  // ---- 1b. 高度契约：地址栏/状态行是内容高度，iframe 吃掉面板的绝大部分（P1 布局回归的防晒霜） ----
  const heights = await run(`(() => {
    const size = selector => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {h: Math.round(rect.height), y: Math.round(rect.top)};
    };
    return {
      panel: size('.file-preview-panel'),
      body: size('.project-page-preview'),
      addressBar: size('.address-bar'),
      statusRow: size('.status-row'),
      frameArea: size('.frame-area'),
      frame: size('iframe.page-frame'),
    };
  })()`);
  for (const [name, box] of Object.entries(heights)) {
    assert.ok(box && box.h > 0, `缺少可见的盒子: ${name} -> ` + JSON.stringify(box));
  }
  assert.ok(heights.addressBar.h < 80, '地址栏必须是内容高度，不能吃掉面板高度: ' + JSON.stringify(heights.addressBar));
  assert.ok(heights.statusRow.h < 80, '状态行必须是内容高度: ' + JSON.stringify(heights.statusRow));
  assert.ok(heights.frameArea.h >= heights.panel.h * 0.6,
    `iframe 区域必须占面板可用高度的绝大部分: frameArea=${heights.frameArea.h} panel=${heights.panel.h}`);
  assert.ok(heights.frame.h >= heights.panel.h * 0.6,
    `iframe 实际渲染高度必须占面板可用高度的绝大部分: frame=${heights.frame.h} panel=${heights.panel.h}`);
  assert.ok(heights.frame.y > heights.addressBar.y, 'iframe 必须在地址栏下方（列方向布局，不是被压到 1/3）');
  console.log('高度实测: ' + JSON.stringify(heights));

  // ---- 1c. 主进程事件过滤：加载完成后的「空导航」不得把状态打回「正在尝试加载」 ----
  // 回归依据（实测事件流取证）：webContents 的 did-start-loading 是「标签页转圈」级事件，
  // 空载、被立刻取消的空导航也会触发，而且随后只来 did-stop-loading、永远没有完成事件；
  // 子 frame 的完成证据只走 did-frame-finish-load。若把 did-start-loading 当成「页面开始导航」上报，
  // 界面就会从「已收到页面加载事件」退回「正在尝试加载」，再靠 15s 超时兜底 —— 状态是错的，只是不卡死。
  await new Promise(resolve => setTimeout(resolve, 4000));
  assert.equal(await run(`window.__demo.page.loadState.value`), 'loaded',
    '加载完成后的空导航不得把状态打回 loading');
  assert.equal(await run(`document.querySelector('.status-text').textContent`), '已收到页面加载事件');

  // ---- 2. iframe 内真实渲染 + 点击 / 输入 / 滚动 / 路由 ----
  const heading = await runInFrame(demoOrigin, `document.getElementById('heading').textContent`);
  assert.equal(heading, 'demo project page');
  const crossOriginBlocked = await run(`(() => { try { const frame = document.querySelector('iframe.page-frame'); const doc = frame.contentDocument; return doc ? 'readable' : 'null'; } catch (error) { return 'blocked:' + error.name; } })()`);
  assert.equal(crossOriginBlocked, 'null', '用户页面不能注入主页面权限域（跨源拿不到 DOM）');

  await runInFrame(demoOrigin, `document.getElementById('inc').click()`);
  await runInFrame(demoOrigin, `document.getElementById('inc').click()`);
  assert.equal(await runInFrame(demoOrigin, `document.getElementById('count').textContent`), '2');
  // 说明：offscreen 窗口不接收 webContents.sendInputEvent 的合成鼠标事件（实测投递后计数不变），
  // 因此这里的点击/输入是在目标 frame 自己的上下文里派发真实 DOM 事件并读回 DOM，
  // 而不是靠「组件被渲染了」来替代交互验证。

  await runInFrame(demoOrigin, `(() => { const input = document.getElementById('name'); input.value = 'lingxi-kept'; input.dispatchEvent(new Event('input', {bubbles: true})); return document.getElementById('echo').textContent; })()`);
  assert.equal(await runInFrame(demoOrigin, `document.getElementById('echo').textContent`), 'lingxi-kept');

  await runInFrame(demoOrigin, `window.scrollTo(0, 500); document.documentElement.scrollTop`);
  await new Promise(resolve => setTimeout(resolve, 200));
  const scrolled = await runInFrame(demoOrigin, `window.scrollY || document.documentElement.scrollTop`);
  assert.ok(scrolled > 0, '页面应能滚动，实际 scrollY=' + scrolled);

  await runInFrame(demoOrigin, `document.getElementById('nav').click()`);
  assert.equal(await runInFrame(demoOrigin, `location.pathname`), '/next');
  assert.equal(await runInFrame(demoOrigin, `document.getElementById('route').textContent`), '/next');

  // ---- 3. 模式切换：切到文件再切回，iframe 实例与输入都在 ----
  await run(`window.__demo.frameNode = document.querySelector('iframe.page-frame')`);
  await run(`document.querySelector('.mode-switch button[title="文件"]').click()`);
  await waitFor(`!document.querySelector('.file-tabs') ? false : true`);
  assert.equal(await run(`!!document.querySelector('.page-frame')`), true, '文件模式不得卸载 iframe');
  // 隐藏的是正文根元素 .project-page-preview（v-show 落在根上，计算 display 必须变成 none），
  // 但组件仍挂载、iframe 实例仍活着 —— 这正是输入与登录状态保活的机制
  assert.equal(await run(`getComputedStyle(document.querySelector('.project-page-preview')).display`), 'none');
  await run(`document.querySelector('.mode-switch button[title="项目页面"]').click()`);
  await waitFor(`getComputedStyle(document.querySelector('.project-page-preview')).display !== 'none'`);
  assert.equal(await run(`document.querySelector('iframe.page-frame') === window.__demo.frameNode`), true, 'iframe 必须是同一个实例');
  assert.equal(await runInFrame(demoOrigin, `document.getElementById('name').value`), 'lingxi-kept');
  assert.equal(await runInFrame(demoOrigin, `document.getElementById('count').textContent`), '2');

  // ---- 4. 最大化 / 还原 / 拖拽宽度 ----
  await run(`document.querySelector('button[aria-label="最大化预览"]').click()`);
  await waitFor(`!!document.querySelector('.file-preview-panel.is-maximized')`);
  await run(`document.querySelector('button[aria-label="还原面板"]').click()`);
  await waitFor(`!document.querySelector('.file-preview-panel.is-maximized')`);
  const widthBefore = await run(`(() => {
    const panel = document.querySelector('.file-preview-panel');
    const handle = document.querySelector('.resize-handle');
    const before = panel.getBoundingClientRect().width;
    handle.dispatchEvent(new PointerEvent('pointerdown', {button: 0, clientX: 1200, bubbles: true}));
    window.dispatchEvent(new PointerEvent('pointermove', {clientX: 1100, bubbles: true}));
    window.dispatchEvent(new PointerEvent('pointerup', {bubbles: true}));
    return before;
  })()`);
  // 宽度绑定在 :style 上，Vue 的 DOM 更新是下一拍，必须等一拍再量
  await new Promise(resolve => setTimeout(resolve, 300));
  const widthAfter = await run(`document.querySelector('.file-preview-panel').getBoundingClientRect().width`);
  assert.ok(widthAfter > widthBefore + 50, '拖拽应改变面板宽度: ' + JSON.stringify({before: widthBefore, after: widthAfter}));

  // ---- 5. 重新加载：换代并恢复页面初始化行为 ----
  const beforeReload = await run(`window.__demo.page.generation.value`);
  await run(`document.querySelector('.address-bar button[aria-label="重新加载"]').click()`);
  await waitFor(`window.__demo.page.generation.value > ${beforeReload}`);
  await waitFor(`window.__demo.page.loadState.value === 'loaded'`);
  assert.equal(await runInFrame(demoOrigin, `document.getElementById('count').textContent`), '0', '重新加载后页面回到初始化状态');

  // ---- 6. 未监听端口：给出可理解的失败反馈 ----
  await run(`window.__demo.page.openAddress('http://127.0.0.1:${deadPort}/')`);
  await waitFor(`window.__demo.page.loadState.value === 'failed'`, 200);
  const refused = await run(`({status: document.querySelector('.status-text').textContent, hint: document.querySelector('.diagnose-text') ? document.querySelector('.diagnose-text').textContent : ''})`);
  assert.match(refused.status, /已确认失败/);
  assert.match(refused.hint, /无法连接|连接/);
  assert.doesNotMatch(refused.hint, /X-Frame-Options/, '连接被拒绝时不得猜成被拒绝嵌入');

  // ---- 7. 握手但不回应的服务：等待超时（超时后不销毁 iframe） ----
  await run(`window.__demo.page.openAddress(${JSON.stringify(hangOrigin + '/')})`);
  await waitFor(`window.__demo.page.loadState.value === 'timeout'`, 200);
  assert.equal(await run(`!!document.querySelector('iframe.page-frame')`), true, '超时不得销毁 iframe');
  assert.match(await run(`document.querySelector('.status-text').textContent`), /加载等待超时/);
  assert.match(await run(`document.querySelector('.diagnose-text').textContent`), /超时/);

  // ---- 8. 禁止嵌入的对照页：提示检查 X-Frame-Options / CSP frame-ancestors ----
  await run(`window.__demo.page.openAddress(${JSON.stringify(denyOrigin + '/')})`);
  await waitFor(`window.__demo.page.loadState.value === 'failed'`, 200);
  const blocked = await run(`({hint: document.querySelector('.diagnose-text').textContent, detail: window.__demo.page.failureDetail.value})`);
  assert.match(blocked.hint, /X-Frame-Options|frame-ancestors/);
  assert.match(blocked.detail, /ERR_BLOCKED_BY_RESPONSE/);

  // ---- 9. 关闭即销毁：iframe 卸载、状态归零 ----
  await run(`document.querySelector('button[aria-label="关闭文件预览"]').click()`);
  await waitFor(`!document.querySelector('iframe.page-frame')`);
  assert.equal(await run(`window.__demo.page.committedUrl.value`), '');
  assert.equal(await run(`window.__demo.page.loadState.value`), 'idle');

  assert.deepEqual(remoteRequests, [], '不应请求任何非回环地址');
  await fs.writeFile(path.join(output, 'page-preview.png'), (await window.webContents.capturePage()).toPNG());
  console.log('项目页面预览验证通过: 真实渲染 / 点击 / 输入 / 滚动 / 路由 / 模式切换保活 / 最大化 / 拖拽 / 重新加载 / 未启动服务 / 等待超时 / 禁止嵌入');
  console.log('截图与产物目录: ' + output);
}).then(() => {
  clearTimeout(deadline);
  closePreviewIpc?.close();
  closeFileIpc?.();
  for (const server of servers) server.close();
  window?.destroy();
  app.exit(0);
}).catch(async error => {
  console.error(error);
  if (window && !window.isDestroyed()) {
    const text = await window.webContents.executeJavaScript('document.body.innerText.slice(0, 1200)').catch(() => '<unavailable>');
    console.log(text);
  }
  closePreviewIpc?.close();
  closeFileIpc?.();
  for (const server of servers) server.close();
  app.exit(1);
});
