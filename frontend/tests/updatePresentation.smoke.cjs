const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/update-presentation');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('更新界面验证超时'); app.exit(1); }, 60000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import AboutTab from '../../../src/views/settings/tabs/AboutTab.vue';
import { useTheme } from '../../../src/composables/useTheme';
import { stripUpdateClaim } from '../../../src/types/update';
import '../../../src/style.css';
const { setTheme } = useTheme();
window.setTheme = setTheme;
window.stripUpdateClaim = stripUpdateClaim;
</script><template><main style="max-width:560px;padding:24px;margin:auto"><AboutTab /></main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp, nextTick } from 'vue';
window.fixture = { currentVersion:'0.0.3', enabled:true, phase:'idle', error:null, progress:{percent:0}, pending:null };
window.actions = { check:0, download:0, install:0 };
window.electronAPI = { updater: {
  getState: async () => window.fixture,
  onState: fn => { window.updateState = fn; return () => {}; },
  check: async () => { window.actions.check++; return {ok:true}; },
  download: async () => { window.actions.download++; return {ok:true}; },
  install: async () => { window.actions.install++; return {ok:true}; },
  openLog: async () => {},
} };
window.setUpdate = async payload => { window.updateState(payload); await nextTick(); };
const { default: App } = await import('./App.vue');
let mounted = createApp(App);
mounted.mount('#app');
window.remount = async () => { mounted.unmount(); mounted = createApp(App); mounted.mount('#app'); await nextTick(); await nextTick(); };
await nextTick(); window.ready = true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error', build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  window = new BrowserWindow({ width: 650, height: 720, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadFile(path.join(output, 'dist/index.html'));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await window.webContents.executeJavaScript('window.ready === true')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await window.webContents.executeJavaScript('window.ready'), true);
  async function emit(payload) {
    await window.webContents.executeJavaScript(`window.setUpdate(${JSON.stringify({currentVersion:'0.0.3', ...payload})})`);
  }
  const claim = 'forceupdate=false\nminSupportedVersion=\nsignature=TEST_SIGNATURE';
  const htmlClaim = '<div class="snippet-clipboard-content" data-snippet-clipboard-copy-content="' + claim + '"><pre lang="lx-update"><code>' + claim + '</code></pre></div>';
  const providerClaim = '<pre><code class="language-lx-update">' + claim + '</code></pre>';
  const notes = '<h2>体验优化</h2><ul><li>更新内容支持正文排版</li><li>版本提示更清晰</li></ul>' + htmlClaim + '<p>' + '长文本'.repeat(120) + '</p><a href="https://example.com">查看详情</a>';
  const same = {state:'not-available', availableVersion:'0.0.3', installable:false, rejectReason:null, releaseNotes:notes};
  await emit(same);
  await window.webContents.executeJavaScript(`window.fixture = { ...window.fixture, phase:'not-available', pending: { version:'0.0.3', releaseNotes:${JSON.stringify(notes)}, forceupdate:false, mandatory:false, installable:false, rejectReason:null } }; window.remount()`);
  for (const theme of ['light', 'dark']) {
    await window.webContents.executeJavaScript(`window.setTheme('${theme}')`);
    const result = await window.webContents.executeJavaScript(`(() => {
      const status = [...document.querySelectorAll('span')].find(node => node.textContent.trim() === '当前已是最新版本');
      const notes = document.querySelector('.update-notes');
      return { status: status?.textContent.trim(), classes:status?.className, color:status && getComputedStyle(status).color,
        heading:notes?.querySelector('h2')?.textContent, items:notes?.querySelectorAll('li').length,
        text:notes?.textContent, overflow:notes && notes.scrollWidth > notes.clientWidth,
        link:notes?.querySelector('a')?.getAttribute('rel') };
    })()`);
    assert.equal(result.status, '当前已是最新版本');
    assert.match(result.classes, theme === 'light' ? /text-gray-500/ : /text-zinc-400/);
    assert.equal(result.heading, '体验优化');
    assert.equal(result.items, 2);
    assert.equal(result.text.includes('TEST_SIGNATURE'), false);
    assert.equal(result.text.includes('<div'), false);
    assert.equal(result.overflow, false);
    assert.equal(result.link, 'noopener noreferrer');
    await fs.writeFile(path.join(output, theme + '.png'), (await window.webContents.capturePage()).toPNG());
  }
  for (const releaseNotes of [htmlClaim, providerClaim, '\x60\x60\x60lx-update\n' + claim + '\n\x60\x60\x60']) {
    await emit({...same, releaseNotes});
    assert.equal(await window.webContents.executeJavaScript('!!document.querySelector(".update-notes")'), false);
  }
  await emit({...same, releaseNotes:'## 更新说明\n- 修复 A\n- 优化 B\n\n' + '\x60\x60\x60lx-update\n' + claim + '\n\x60\x60\x60'});
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".update-notes li").length'), 2);
  await emit({...same, releaseNotes:'<p onclick="window.compromised=true">安全正文</p><script>window.compromised=true</script><img src=x onerror="window.compromised=true"><a href="javascript:alert(1)">危险链接</a>'});
  const security = await window.webContents.executeJavaScript('({ compromised:!!window.compromised, unsafe:!!document.querySelector(".update-notes script, .update-notes img, .update-notes [onclick], .update-notes a[href]") })');
  assert.equal(security.compromised, false);
  assert.equal(security.unsafe, false);
  for (const rejectReason of ['拒绝降级: 目标 0.0.2 < 当前 0.0.3', '更新清单签名校验失败']) {
    await emit({...same, rejectReason});
    const classes = await window.webContents.executeJavaScript(`[...document.querySelectorAll('span')].find(node => node.textContent.trim() === ${JSON.stringify(rejectReason)})?.className`);
    assert.match(classes, /text-red-500/);
  }
  for (const [state, label, action] of [['available','下载更新','download'], ['downloading','下载中 42%'], ['downloaded','安装并重启','install'], ['checking','检查中…'], ['error','检查更新','check']]) {
    await emit({state, availableVersion:'0.0.4', installable:true, percent:42, error:state==='error' ? '网络中断' : ''});
    const result = await window.webContents.executeJavaScript('({ label:document.querySelector("button").textContent.trim(), disabled:document.querySelector("button").disabled })');
    assert.equal(result.label, label);
    assert.equal(result.disabled, ['downloading','checking'].includes(state));
    if (action) {
      await window.webContents.executeJavaScript('document.querySelector("button").click()');
      assert.equal(await window.webContents.executeJavaScript(`window.actions.${action}`), 1);
    }
  }
  console.log('更新界面验证通过：明暗主题、正文与签名过滤、安全渲染、版本提示、下载/安装/重试。截图: ' + output);
  clearTimeout(deadline);
  window.destroy();
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); if(window) window.destroy(); app.exit(1); });
