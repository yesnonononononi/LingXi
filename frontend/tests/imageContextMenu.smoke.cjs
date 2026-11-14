/**
 * 图片预览右键菜单的真 DOM 冒烟（offscreen Electron）。
 *
 * <p>为什么必须有这一层：单测只证明「算出来的两项」和「主进程 handler 收得住」，
 * 但下面三件事只有真浏览器暴露 ——</p>
 * <ol>
 *   <li>右键落在大图上时，全站唯一的浮层要弹出「复制图片 / 保存图片」两项（不是文本四项）；</li>
 *   <li><b>浮层必须挂进那个模态 dialog</b>：`showModal()` 的元素在浏览器 top layer，
 *       挂在 body 的浮层会被整个盖住 —— 视觉上像「菜单没出现」，实际是点不到；</li>
 *   <li>点菜单项要真的把字节送到主进程（图源是 `data:`/`blob:`，主进程拿不到，必须渲染层取）。</li>
 * </ol>
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const fixture = path.resolve(__dirname, '../node_modules/.tmp/image-context-menu');
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkAAAABgADNjd8qAAAAABJRU5ErkJggg==';

app.setPath('userData', path.join(fixture, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('图片右键菜单冒烟超时'); app.exit(1); }, 120000);

app.whenReady().then(async () => {
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'App.vue'), `<script setup>
import { ref } from 'vue';
import ContextMenu from '../../../src/components/common/ContextMenu.vue';
import ImageLightbox from '../../../src/components/common/ImageLightbox.vue';
import { useI18n } from '../../../src/i18n/index';
const IMAGE = ${JSON.stringify(IMAGE)};
const name = 'shot';
const open = ref(true);
window.setLocale = value => useI18n().setPreference(value);
window.setOpen = value => { open.value = value; };
</script>
<template>
  <div>
    <p id="prose">可选中正文</p>
    <ImageLightbox
      :open="open"
      :src="IMAGE"
      :name="name"
      test-id="smoke-lightbox"
      @close="open = false"
    />
    <ContextMenu />
  </div>
</template>`);

  await fs.writeFile(path.join(fixture, 'entry.js'), `import { createApp, nextTick } from 'vue';
import App from './App.vue';
// 主进程桥接的替身：只记录收到了什么，不碰真实剪贴板与文件系统
window.calls = [];
window.electronAPI = {
  image: {
    copy: bytes => { window.calls.push({ kind: 'copy', size: bytes.byteLength }); return Promise.resolve({ ok: true }); },
    save: (bytes, name) => { window.calls.push({ kind: 'save', size: bytes.byteLength, name }); return Promise.resolve({ ok: true, path: 'x.png' }); },
  },
};
createApp(App).mount('#app');
window.flush = async () => { await nextTick(); await new Promise(r => setTimeout(r, 80)); };
window.rightClick = selector => {
  const el = document.querySelector(selector);
  if (!el) throw new Error('元素缺失: ' + selector);
  const rect = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 2,
  }));
};
window.menu = () => document.querySelector('[role="menu"]');
window.menuItems = () => Array.from(document.querySelectorAll('[role="menuitem"]'))
  .map(button => ({ command: button.dataset.command, text: button.textContent.trim() }));
window.clickItem = command => {
  const el = document.querySelector('[role="menuitem"][data-command="' + command + '"]');
  if (!el) throw new Error('菜单项缺失: ' + command);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
window.pressKey = key => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
window.pressKeyOn = (selector, key) => {
  const el = document.querySelector(selector);
  if (!el) throw new Error('元素缺失: ' + selector);
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};
window.ready = true;`);

  await fs.writeFile(path.join(fixture, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');

  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({
    configFile: false, root: fixture, base: './', plugins: [vue()], logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(fixture, 'dist'), emptyOutDir: true },
  });

  window = new BrowserWindow({
    width: 720, height: 560, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false },
  });
  const consoleErrors = [];
  window.webContents.on('console-message', event => {
    if (event.level === 'error') consoleErrors.push(event.message);
  });
  await window.loadFile(path.join(fixture, 'dist/index.html'));

  const evaluate = async source => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { throw new Error('渲染进程求值失败: ' + source, { cause: error }); }
  };
  const run = async source => { await evaluate(source); await evaluate('window.flush()'); };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  for (let i = 0; i < 200 && !(await evaluate('window.ready === true')); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await run(`window.setLocale('zh-CN')`);

  const dialogOpen = 'document.querySelector("dialog[data-testid=smoke-lightbox]").open';
  assert(await evaluate(dialogOpen) === true, '夹具应当先打开图片预览');

  // 1. 右键大图：弹出图片两项（不是文本四项）
  await run(`window.rightClick('dialog[data-testid=smoke-lightbox] img')`);
  assert(await evaluate('!!window.menu()'), '右键大图后菜单未渲染');
  const items = await evaluate('window.menuItems()');
  assert(items.length === 2, '图片菜单必须只有两项，实际 ' + JSON.stringify(items));
  assert(items.map(item => item.command).join(',') === 'copyImage,saveImage', '菜单项顺序不对: ' + items.map(item => item.command));
  assert(items[0].text === '复制图片', '文案未走中文 i18n: ' + items[0].text);
  assert(items[1].text === '保存图片', '文案未走中文 i18n: ' + items[1].text);

  // 2. 浮层必须挂进那个模态 dialog，否则会被 top layer 盖住（看得见也点不到）
  const inDialog = 'window.menu().closest("dialog") === document.querySelector("dialog[data-testid=smoke-lightbox]")';
  assert(await evaluate(inDialog) === true, '菜单必须挂在模态 dialog 内部（top layer 契约）');
  assert(await evaluate(dialogOpen) === true, '右键不得把预览对话框关掉');

  // 3. 点「复制图片」：字节送到主进程，菜单关闭
  await run(`window.clickItem('copyImage')`);
  let calls = await evaluate('window.calls');
  assert(calls.length === 1 && calls[0].kind === 'copy', '点复制图片未派发复制动作: ' + JSON.stringify(calls));
  assert(calls[0].size > 0, '复制必须带上真实字节，不能是空载荷');
  assert(await evaluate('!!window.menu()') === false, '点菜单项后菜单未关闭');

  // 4. 点「保存图片」：默认文件名跟着图片名称走
  await run(`window.rightClick('dialog[data-testid=smoke-lightbox] img')`);
  await run(`window.clickItem('saveImage')`);
  calls = await evaluate('window.calls');
  const save = calls.find(call => call.kind === 'save');
  assert(save, '点保存图片未派发保存动作: ' + JSON.stringify(calls));
  assert(save.size > 0, '保存必须带上真实字节');
  assert(/^shot\./.test(save.name), '默认文件名必须来自图片名称: ' + save.name);

  // 5. Esc 先关菜单、再关对话框（两件事不能混成一步）
  await run(`window.rightClick('dialog[data-testid=smoke-lightbox] img')`);
  await run(`window.pressKey('Escape')`);
  assert(await evaluate('!!window.menu()') === false, 'Esc 未关闭菜单');
  assert(await evaluate(dialogOpen) === true, 'Esc 只该关菜单，不该连预览一起关掉');
  // 第二次 Esc 落在对话框自己身上：菜单已收，键盘不再被菜单接管，对话框的 keydown 才收得到
  await run(`window.pressKeyOn('dialog[data-testid=smoke-lightbox]', 'Escape')`);
  assert(await evaluate(dialogOpen) === false, 'Esc 第二次应当关闭预览');

  // 6. 右键对话框里的非图片区域：不弹图片菜单（落点判定不能按「对话框开着」猜）
  await run(`window.setOpen(true)`);
  await run(`window.rightClick('dialog[data-testid=smoke-lightbox] .lx-image-lightbox__name')`);
  const strayItems = await evaluate('window.menu() ? window.menuItems() : []');
  assert(strayItems.every(item => item.command !== 'copyImage'), '非图片落点不该出现图片菜单');

  const realErrors = consoleErrors.filter(message => !message.startsWith('[Vue warn]'));
  assert(realErrors.length === 0, '渲染进程存在控制台错误: ' + realErrors.join(' | '));

  console.log('图片预览右键菜单：两项菜单、挂在模态 dialog 内、复制/保存派发与 Esc 分层关闭全部通过');
  clearTimeout(deadline);
  window.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error);
  clearTimeout(deadline);
  if (window) window.destroy();
  app.exit(1);
});
