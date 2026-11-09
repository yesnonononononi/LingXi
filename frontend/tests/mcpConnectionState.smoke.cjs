const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// MCP 设置页：运行连接状态徽标、失败原因与「重新连接」按钮；顺带输出浅深主题截图。
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.run/mcp-connection-state');
const source = file => path.relative(output, path.join(root, file)).split(path.sep).join('/');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('MCP 连接状态验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { nextTick } from 'vue';
import McpTab from '${source('src/views/settings/tabs/McpTab.vue')}';
import { McpAPI } from '${source('src/services/mcp.ts')}';
import { setPreference } from '${source('src/i18n/index.ts')}';
import { useTheme } from '${source('src/composables/useTheme.ts')}';
import '${source('src/style.css')}';
setPreference('zh-CN');
const theme = useTheme();
window.setDark = value => theme.setTheme(value ? 'dark' : 'light');
const base = { headers: {}, initializationTimeout: 30000, executionTimeout: 60000, maxOutput: 20000 };
const records = [
  { ...base, id: '1', name: 'github', transport: 'streamable-http', url: 'https://mcp.example.test/github', description: '代码仓库检索', status: 1 },
  { ...base, id: '2', name: 'filesystem', transport: 'stdio', command: ['npx', '-y', '@modelcontextprotocol/server-filesystem'], status: 1 },
  { ...base, id: '3', name: 'jira', transport: 'streamable-http', url: 'https://mcp.example.test/jira', status: 1 },
  { ...base, id: '4', name: 'legacy', transport: 'streamable-http', url: 'https://mcp.example.test/legacy', status: 0 },
];
const states = {
  '1': { id: '1', state: 'CONNECTED', toolCount: 12, error: null },
  '2': { id: '2', state: 'FAILED', toolCount: null, error: 'ConnectException' },
  '3': { id: '3', state: 'DISCONNECTED', toolCount: null, error: null },
  '4': { id: '4', state: 'DISABLED', toolCount: null, error: null },
};
window.statusQueries = [];
window.reconnects = [];
McpAPI.list = async () => ({ code: 1, data: { current: 1, size: 100, total: records.length, records } });
McpAPI.listStates = async ids => { window.statusQueries.push(ids.map(String)); return { code: 1, data: ids.map(id => states[String(id)]) }; };
McpAPI.reconnect = async item => {
  window.reconnects.push(String(item.id));
  states[String(item.id)] = { id: String(item.id), state: 'CONNECTED', toolCount: 3, error: null };
  return { code: 1, data: states[String(item.id)] };
};
window.flush = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 100)); };
</script><template><main style="max-width:720px;margin:20px auto;padding:16px"><McpTab :is-dark="theme.isDark.value" /></main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp} from 'vue';import {createPinia} from 'pinia';
import App from './App.vue';window.runtimeErrors=[];
window.addEventListener('error',event=>window.runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.runtimeErrors.push(String(event.reason)));
document.body.style.background = 'var(--lx-surface)';
createApp(App).use(createPinia()).mount('#app');`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const { default: tailwind } = await import('@tailwindcss/postcss');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error',
    resolve: { dedupe: ['vue', 'pinia'] }, css: { postcss: { plugins: [tailwind()] } },
    build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  const window = new BrowserWindow({ width: 820, height: 760, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = code => window.webContents.executeJavaScript(code);
  await evaluate('window.flush()');

  assert.deepEqual(await evaluate('window.statusQueries'), [['1', '2', '3', '4']], '列表加载后必须按全部 id 批量查一次状态');
  const badges = () => evaluate('[...document.querySelectorAll("[data-testid=mcp-connection-state]")].map(e => e.textContent.trim().replace(/\\s+/g, " "))');
  assert.deepEqual(await badges(), ['运行中 · 12 个工具', '连接失败', '未连接'], '停用的服务不显示运行状态');
  assert.match(await evaluate('document.body.textContent'), /连接失败原因：ConnectException/);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=mcp-reconnect]").length'), 3, '停用的服务不提供重新连接');

  for (const dark of [false, true]) {
    await evaluate(`window.setDark(${dark}); window.flush()`);
    await fs.writeFile(path.join(output, `before-${dark ? 'dark' : 'light'}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await evaluate('window.setDark(false); window.flush()');

  await evaluate('document.querySelectorAll("[data-testid=mcp-reconnect]")[1].click(); window.flush()');
  await evaluate('window.flush()');
  assert.deepEqual(await evaluate('window.reconnects'), ['2']);
  assert.deepEqual(await badges(), ['运行中 · 12 个工具', '运行中 · 3 个工具', '未连接'], '重连成功后徽标必须刷新');
  assert.doesNotMatch(await evaluate('document.body.textContent'), /连接失败原因/);
  await fs.writeFile(path.join(output, 'after-reconnect-light.png'), (await window.webContents.capturePage()).toPNG());

  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  clearTimeout(deadline);
  console.log('PASS MCP 设置页：连接状态徽标、失败原因、重新连接后刷新、浅深主题');
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
