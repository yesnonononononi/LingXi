/**
 * LxModal 关闭策略的**行为**冒烟测试（offscreen Electron + 真实 DOM 事件）。
 *
 * 为什么不是静态断言：遮罩点击与 Esc 的正确性只体现在「事件真的没关掉弹窗」，
 * 拿正则扫源码只能证明代码长什么样，证明不了行为。这里真按 Esc、真点遮罩。
 *
 * 覆盖：默认策略（遮罩关 / Esc 关）、策略关闭时两者都不关、面板内点击不穿透关闭、
 * 关闭后监听器清理、重新打开后恢复、无障碍语义（role / aria-modal / aria-label）。
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const fixture = path.resolve(__dirname, '../node_modules/.tmp/lx-modal-policy');
app.setPath('userData', path.join(fixture, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('超时退出'); app.exit(1); }, 120000);

const fail = message => { throw new Error(message); };

app.whenReady().then(async () => {
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'App.vue'), `<script setup>
import { ref } from 'vue';
import LxModal from '../../../src/components/common/LxModal.vue';
window.closeCount = 0;
const open = ref(true);
const backdrop = ref(true);
const esc = ref(true);
window.setPolicy = (nextBackdrop, nextEsc) => { backdrop.value = nextBackdrop; esc.value = nextEsc; };
window.setOpen = value => { open.value = value; };
window.reset = () => { window.closeCount = 0; };
const onClose = () => { window.closeCount += 1; };
</script>
<template>
  <LxModal
    :open="open"
    :close-on-backdrop="backdrop"
    :close-on-esc="esc"
    aria-label="策略测试面板"
    overlay-class="z-50 bg-black/50"
    panel-class="w-full max-w-sm rounded-2xl bg-white p-4"
    @close="onClose"
  >
    <button type="button">内部按钮</button>
  </LxModal>
</template>`);

  await fs.writeFile(path.join(fixture, 'entry.js'), `import { createApp, nextTick } from 'vue';
import App from './App.vue';
createApp(App).mount('#app');
window.flush = async () => { await nextTick(); await new Promise(r => setTimeout(r, 60)); };
window.pressEscape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
window.clickSelector = selector => {
  const el = document.querySelector(selector);
  if (!el) throw new Error('元素缺失: ' + selector);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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

  for (let i = 0; i < 200 && !(await evaluate('window.ready === true')); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  const assert = (condition, message) => { if (!condition) fail(message); };
  const count = () => evaluate('window.closeCount');
  const OVERLAY = 'div.fixed.inset-0';

  // 0. 挂载即渲染，且具备无障碍语义
  assert(await evaluate(`!!document.querySelector('${OVERLAY}')`), '遮罩层未渲染');
  assert(await evaluate(`(() => { const d = document.querySelector('[role="dialog"]'); return !!d && d.getAttribute('aria-modal') === 'true' && d.getAttribute('aria-label') === '策略测试面板'; })()`),
    'role=dialog / aria-modal / aria-label 语义缺失');
  assert(await evaluate(`(() => { const d = document.querySelector('[role="dialog"]'); return d !== null && d.parentElement.classList.contains('fixed'); })()`),
    '面板必须是遮罩层的直接子节点');

  // 1. 默认策略：Esc 关闭
  await run('window.reset()');
  await run('window.pressEscape()');
  assert(await count() === 1, 'closeOnEsc 默认应为 true（Esc 未触发 close）');

  // 2. 关闭 Esc 策略后 Esc 无效
  await run('window.reset(); window.setPolicy(true, false)');
  await run('window.pressEscape()');
  assert(await count() === 0, 'closeOnEsc=false 时 Esc 仍触发了 close');

  // 3. 默认策略：点遮罩关闭
  await run('window.reset(); window.setPolicy(true, true)');
  await run(`window.clickSelector('${OVERLAY}')`);
  assert(await count() === 1, 'closeOnBackdrop 默认应为 true（点遮罩未触发 close）');

  // 4. 关闭遮罩策略后点遮罩无效
  await run('window.reset(); window.setPolicy(false, true)');
  await run(`window.clickSelector('${OVERLAY}')`);
  assert(await count() === 0, 'closeOnBackdrop=false 时点遮罩仍触发了 close');

  // 5. 面板内部点击永不穿透关闭
  await run('window.reset(); window.setPolicy(true, true)');
  await run(`window.clickSelector('[role="dialog"] button')`);
  assert(await count() === 0, '面板内部点击不应关闭弹窗');

  // 6. 关闭后不得残留 keydown 监听
  await run('window.reset(); window.setPolicy(true, true)');
  await run('window.setOpen(false)');
  await run('window.pressEscape()');
  assert(await count() === 0, '弹窗关闭后 Esc 仍触发了 close（监听器未清理）');
  assert(await evaluate(`document.querySelector('${OVERLAY}') === null`), 'open=false 时遮罩层仍在 DOM 中');

  // 7. 重新打开后 Esc 恢复生效
  await run('window.setOpen(true)');
  await run('window.reset()');
  await run('window.pressEscape()');
  assert(await count() === 1, '重新打开后 Esc 未恢复生效');

  const realErrors = consoleErrors.filter(message => !message.startsWith('[Vue warn]'));
  assert(realErrors.length === 0, '渲染进程存在控制台错误: ' + realErrors.join(' | '));

  console.log('LxModal 关闭策略冒烟测试全部通过（7 组断言）');
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => {
  console.error(error && error.message ? error.message : error);
  clearTimeout(deadline);
  app.exit(1);
});
