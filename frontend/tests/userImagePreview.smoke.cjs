const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

/**
 * 用户历史消息图片「放大查看」真 DOM 验证。
 *
 * <p>缺陷现场：点击用户气泡里的图片走 `window.open(url)`。主进程的 setWindowOpenHandler 只放行
 * http(s) 外链，data:/blob: 图片落到 action:'allow'，Electron 开出一个没有 preload 的空白窗口，
 * 用户看到的就是白屏。修复后必须复用全局唯一的 `common/ImageLightbox`。</p>
 *
 * <p>为什么不塞进 `chatImages.smoke.cjs`：那个用例先验输入区的图片上限按钮与 `/plan` 剥离，
 * 与本缺陷无关的红会挡在这几条断言前面。这里只挂 `ChatMessageItem`，一条链一件事。</p>
 */

const output = path.resolve(__dirname, '../node_modules/.tmp/user-image-preview');
const BASE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkAAAABgADNjd8qAAAAABJRU5ErkJggg==';
const FIRST = `${BASE}#first`;
const SECOND = `${BASE}#second`;

app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('用户图片预览验证超时'); app.exit(1); }, 120000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import ChatMessageItem from '../../../src/components/chat/ChatMessageItem.vue';
const messages = [
  { id:'m1', role:'user', content:'单张图', timestamp:0, imageUrls:[${JSON.stringify(FIRST)}] },
  { id:'m2', role:'user', content:'两张图', timestamp:0, imageUrls:[${JSON.stringify(FIRST)}, ${JSON.stringify(SECOND)}] },
];
</script><template><main style="max-width:720px;margin:auto;padding:24px">
<ChatMessageItem v-for="message in messages" :key="message.id" :message="message" :is-dark="false" />
</main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp, nextTick } from 'vue';
window.openCalls = []; window.runtimeErrors = [];
// 劫持 window.open：缺陷版本会在这里留下调用记录，用例据此变红（真开窗在 Electron 里是白窗）。
window.open = url => { window.openCalls.push(String(url)); return null; };
window.addEventListener('error', event => window.runtimeErrors.push(event.error?.stack || event.message));
window.addEventListener('unhandledrejection', event => window.runtimeErrors.push(event.reason?.stack || String(event.reason)));
const { default: App } = await import('./App.vue');
const mounted = createApp(App); mounted.mount('#app');
window.unmount = () => mounted.unmount();
window.flush = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 40)); };
await window.flush(); window.ready = true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error', build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  window = new BrowserWindow({ width: 860, height: 780, show: false, webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.message?.includes('Error')) console.error(event.message); });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate('window.ready === true')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await evaluate('window.ready'), true);

  // 两条消息共 3 个缩略图：1 + 2；每条消息各挂一个受控 dialog，所以按「哪个开着」来定位。
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=user-images] img").length'), 3);
  const openDialogCount = 'document.querySelectorAll("dialog[data-testid=user-image-lightbox][open]").length';
  const openDialog = '[...document.querySelectorAll("dialog[data-testid=user-image-lightbox]")].find(dialog => dialog.open)';
  assert.equal(await evaluate(openDialogCount), 0, '未点击时不得有打开的预览对话框');
  assert.equal(await evaluate('document.querySelectorAll("dialog[data-testid=user-image-lightbox] img").length'), 0,
    '未打开时对话框里不得预渲染大图');

  // 点第二张消息的第 2 张图：对话框打开，且大图就是被点的那一张（不能串成别的图）。
  await evaluate('document.querySelectorAll("[data-testid=user-images] img")[2].click(); window.flush()');
  assert.equal(await evaluate(openDialogCount), 1, '点击用户图片必须以预览对话框打开，而不是开新窗口');
  assert.equal(await evaluate(`${openDialog}.querySelector("img").src`),
    await evaluate('document.querySelectorAll("[data-testid=user-images] img")[2].src'));
  assert.match(await evaluate(`${openDialog}.getAttribute("aria-label")`), /用户上传图片 2/);
  assert.deepEqual(await evaluate('window.openCalls'), [], '放大查看不得再调用 window.open（Electron 里那是白窗）');

  // 关闭按钮：关掉后大图节点必须消失，不能留一张裂图。
  await evaluate(`${openDialog}.querySelector("button").click(); window.flush()`);
  assert.equal(await evaluate(openDialogCount), 0);
  assert.equal(await evaluate('document.querySelectorAll("dialog[data-testid=user-image-lightbox] img").length'), 0);

  // Esc 同样能关（原生 dialog 的 cancel 与组件内的 keydown 两条路径都指向同一个意图）。
  await evaluate('document.querySelectorAll("[data-testid=user-images] img")[0].click(); window.flush()');
  assert.equal(await evaluate(openDialogCount), 1);
  await evaluate(`${openDialog}.dispatchEvent(new KeyboardEvent("keydown", { key:"Escape", bubbles:true, cancelable:true })); window.flush()`);
  assert.equal(await evaluate(openDialogCount), 0);

  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  console.log('用户历史消息图片放大：复用 ImageLightbox 打开/关闭与 Esc 关闭通过，window.open 零调用。');
  clearTimeout(deadline);
  await evaluate('window.unmount()');
  window.destroy();
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); if (window) window.destroy(); app.exit(1); });
