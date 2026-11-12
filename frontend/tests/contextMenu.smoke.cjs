/**
 * 右键菜单的**行为**冒烟测试（offscreen Electron + 真实 DOM 事件）。
 *
 * 为什么不是只跑单测：单测只证明「算出来的禁用态」对，证明不了「右键真的弹出菜单」——
 * 监听器没挂、Teleport 没渲染、文案没走 i18n、点了菜单项没派发命令，这些全都只在真 DOM 里暴露。
 *
 * 覆盖：右键输入框弹出四项且禁用态正确、正文选区只有复制、空白处不弹、点菜单项派发命令并关闭、
 * Esc / 方向键 + 回车、中英文文案切换、只读输入框禁用粘贴、控制台无错误。
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const fixture = path.resolve(__dirname, '../node_modules/.tmp/context-menu');
app.setPath('userData', path.join(fixture, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('超时退出'); app.exit(1); }, 120000);

const fail = message => { throw new Error(message); };

app.whenReady().then(async () => {
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'App.vue'), `<script setup>
import ContextMenu from '../../../src/components/common/ContextMenu.vue';
import { useI18n } from '../../../src/i18n/index';
window.setLocale = value => useI18n().setPreference(value);
// 输入框自己的 keydown 记录：用来证明菜单打开时 Enter 不会漏到输入框（不会误发送）
window.typed = [];
const onKeydown = event => { window.typed.push(event.key); };
</script>
<template>
  <div>
    <textarea id="editor" @keydown="onKeydown">hello world</textarea>
    <input id="reader" readonly value="readonly text">
    <p id="prose">可选中正文</p>
    <div id="blank" style="height:80px">空白区域</div>
    <ContextMenu />
  </div>
</template>`);

  await fs.writeFile(path.join(fixture, 'entry.js'), `import { createApp, nextTick } from 'vue';
import App from './App.vue';
// 主进程桥接的替身：只记录派发了哪条命令，不碰真实剪贴板
window.commands = [];
window.electronAPI = { edit: command => { window.commands.push(command); return Promise.resolve(true); } };
createApp(App).mount('#app');
window.flush = async () => { await nextTick(); await new Promise(r => setTimeout(r, 60)); };
window.rightClick = selector => {
  const el = document.querySelector(selector);
  if (!el) throw new Error('元素缺失: ' + selector);
  const rect = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: rect.left + 4, clientY: rect.top + 4,
  }));
};
window.selectText = (selector, start, end) => {
  const el = document.querySelector(selector);
  el.focus();
  el.setSelectionRange(start, end);
};
window.menuOpen = () => !!document.querySelector('[role="menu"]');
window.menuItems = () => Array.from(document.querySelectorAll('[role="menuitem"]'))
  .map(button => ({ command: button.dataset.command, disabled: button.disabled, text: button.textContent.trim() }));
window.clickItem = command => {
  const el = document.querySelector('[role="menuitem"][data-command="' + command + '"]');
  if (!el) throw new Error('菜单项缺失: ' + command);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
window.pressKey = key => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
window.pressKeyIn = (selector, key) => {
  const el = document.querySelector(selector);
  if (!el) throw new Error('元素缺失: ' + selector);
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};
window.ready = true;`);

  await fs.writeFile(path.join(fixture, 'index.html'),
    '<html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');

  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({
    configFile: false, root: fixture, base: './', plugins: [vue()], logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(fixture, 'dist'), emptyOutDir: true },
  });

  window = new BrowserWindow({
    width: 640, height: 480, show: false,
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
  const assert = (condition, message) => { if (!condition) fail(message); };

  for (let i = 0; i < 200 && !(await evaluate('window.ready === true')); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await run(`window.setLocale('zh-CN')`);

  const items = () => evaluate('window.menuItems()');

  // 0. 右键输入框（无选区）：弹出四项，剪切/复制灰、粘贴/全选可用
  await run(`window.rightClick('#editor')`);
  assert(await evaluate('window.menuOpen()'), '右键输入框后菜单未渲染');
  let menu = await items();
  assert(menu.length === 4, '菜单必须恒为四项，实际 ' + menu.length);
  assert(menu.map(item => item.command).join(',') === 'cut,copy,paste,selectAll', '菜单项顺序不对: ' + menu.map(item => item.command));
  assert(menu.find(item => item.command === 'cut').disabled === true, '无选区时剪切应为禁用');
  assert(menu.find(item => item.command === 'copy').disabled === true, '无选区时复制应为禁用');
  assert(menu.find(item => item.command === 'paste').disabled === false, '输入框里粘贴应可用');
  assert(menu.find(item => item.command === 'selectAll').disabled === false, '输入框里全选应可用');
  assert(menu.find(item => item.command === 'paste').text === '粘贴', '文案未走中文 i18n: ' + menu.find(item => item.command === 'paste').text);

  // 1. 单选区内右键：剪切/复制变为可用
  await run(`window.rightClick('#editor'); window.selectText('#editor', 0, 5); window.rightClick('#editor')`);
  menu = await items();
  assert(menu.find(item => item.command === 'cut').disabled === false, '选中文本后剪切应可用');
  assert(menu.find(item => item.command === 'copy').disabled === false, '选中文本后复制应可用');

  // 2. 点菜单项：派发命令 + 菜单关闭
  await run(`window.clickItem('copy')`);
  assert(await evaluate('window.commands.join(",") === "copy"'), '点复制未派发 copy 命令: ' + await evaluate('window.commands.join(",")'));
  assert(await evaluate('window.menuOpen()') === false, '点菜单项后菜单未关闭');

  // 3. 只读输入框：粘贴/剪切禁用，全选仍可用
  await run(`window.rightClick('#reader')`);
  menu = await items();
  assert(menu.length === 4, '只读输入框也应有四项菜单');
  assert(menu.find(item => item.command === 'paste').disabled === true, '只读输入框里粘贴应禁用');
  assert(menu.find(item => item.command === 'cut').disabled === true, '只读输入框里剪切应禁用');
  assert(menu.find(item => item.command === 'selectAll').disabled === false, '只读输入框仍应能全选');

  // 4. Esc 关闭
  await run(`window.pressKey('Escape')`);
  assert(await evaluate('window.menuOpen()') === false, 'Esc 未关闭菜单');

  // 5. 方向键 + 回车：先把选区清空，首项可用项是粘贴，下移一格到全选
  await run(`window.selectText('#editor', 0, 0); window.rightClick('#editor')`);
  await run(`window.pressKey('ArrowDown')`);
  await run(`window.pressKey('Enter')`);
  assert(await evaluate('window.commands.join(",") === "copy,selectAll"'), '键盘操作未派发 selectAll: ' + await evaluate('window.commands.join(",")'));
  assert(await evaluate('window.menuOpen()') === false, '回车上屏后菜单未关闭');

  // 5b. 菜单打开时的按键不得漏进输入框（Enter 会触发发送），关闭后必须能正常到达
  await run('window.typed.length = 0');
  await run(`window.rightClick('#editor'); window.pressKeyIn('#editor', 'ArrowDown'); window.pressKeyIn('#editor', 'Enter')`);
  assert(await evaluate('window.typed.length') === 0, '菜单打开时按键漏进了输入框: ' + await evaluate('window.typed.join(",")'));
  await run(`window.pressKeyIn('#editor', 'Enter')`);
  assert(await evaluate('window.typed.join(",") === "Enter"'), '菜单关闭后按键未到达输入框（拦截失效）: ' + await evaluate('window.typed.join(",")'));

  // 6. 空白处右键：不弹菜单
  await run(`window.rightClick('#blank')`);
  assert(await evaluate('window.menuOpen()') === false, '空白处不该弹出全禁用的空壳菜单');

  // 7. 切英文：文案跟着变
  await run(`window.setLocale('en-US')`);
  await run(`window.rightClick('#editor')`);
  menu = await items();
  assert(menu.find(item => item.command === 'selectAll').text === 'Select all', '英文文案未生效: ' + menu.find(item => item.command === 'selectAll').text);
  assert(menu.find(item => item.command === 'cut').text === 'Cut', '英文文案未生效: ' + menu.find(item => item.command === 'cut').text);
  await run(`window.pressKey('Escape')`);

  const realErrors = consoleErrors.filter(message => !message.startsWith('[Vue warn]'));
  assert(realErrors.length === 0, '渲染进程存在控制台错误: ' + realErrors.join(' | '));

  console.log('右键菜单冒烟测试全部通过');
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => {
  console.error(error && error.message ? error.message : error);
  clearTimeout(deadline);
  app.exit(1);
});
