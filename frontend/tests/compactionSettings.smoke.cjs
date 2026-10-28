const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.run/compaction-settings');
const source = file => path.relative(output, path.join(root, file)).split(path.sep).join('/');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('压缩设置验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref, nextTick } from 'vue';
import CompactionTab from '${source('src/views/settings/tabs/CompactionTab.vue')}';
import { UserConfigAPI } from '${source('src/services/userConfig.ts')}';
import { ModelAPI } from '${source('src/services/model.ts')}';
import { CompactionSettingsAPI } from '${source('src/services/compaction.ts')}';
import { setPreference } from '${source('src/i18n/index.ts')}';
import { useTheme } from '${source('src/composables/useTheme.ts')}';
import '${source('src/style.css')}';
setPreference('zh-CN');
const theme = useTheme();
window.setDark = value => theme.setTheme(value ? 'dark' : 'light');
const key = ref(0);
let scenario = 'deleted';
let selected = '9';
window.writes = [];
UserConfigAPI.current = async () => ({ code: 1, data: { compactModelId: selected } });
UserConfigAPI.updateCurrent = async payload => { window.writes.push(payload); selected = payload.compactModelId; return { code: 1 }; };
ModelAPI.catalog = async () => ({ code: 1, data: scenario === 'deleted' ? [] : [{ providerName: '测试提供商', models: [
  { id: '9', modelName: 'summary', baseUrl: 'https://compact.invalid/v1', credentialConfigured: scenario !== 'no-key' }
] }] });
CompactionSettingsAPI.params = async () => {
  if (scenario === 'params-error') throw new Error('HTTP 500');
  return { code: 1, data: { modelThreshold: 0.85, maxSummaryAttempts: 2, compactMaxTokens: 4096 } };
};
window.flush = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 100)); };
window.showScenario = async value => { scenario = value; selected = '9'; window.writes = []; key.value++; await window.flush(); };
</script><template><main style="max-width:600px;margin:20px auto;padding:16px"><CompactionTab :key="key" /></main></template>`);
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
  const window = new BrowserWindow({ width: 760, height: 760, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = code => window.webContents.executeJavaScript(code);
  await evaluate('window.flush()');
  const switchSelector = '[data-testid=compaction-switch]';
  for (const scenario of ['deleted', 'no-key']) {
    await evaluate(`window.showScenario('${scenario}')`);
    assert.equal(await evaluate(`document.querySelector('${switchSelector}').disabled`), false,
      `${scenario}：已启用时必须允许关闭`);
    await evaluate(`document.querySelector('${switchSelector}').click(); window.flush()`);
    assert.deepEqual(await evaluate('window.writes'), [{ compactModelId: null }]);
    assert.equal(await evaluate(`document.querySelector('${switchSelector}').getAttribute('aria-checked')`), 'false');
    assert.equal(await evaluate(`document.querySelector('${switchSelector}').disabled`), true,
      `${scenario}：关闭后不能重新启用不可用的模型`);
  }
  await evaluate("window.showScenario('params-error')");
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=compaction-model-select]").length'), 1);
  assert.match(await evaluate('document.querySelector("[data-testid=compaction-advanced-card]").textContent'), /压缩参数读取失败/);
  await evaluate(`document.querySelector('${switchSelector}').click(); window.flush()`);
  assert.deepEqual(await evaluate('window.writes'), [{ compactModelId: null }]);
  await evaluate(`document.querySelector('${switchSelector}').click(); window.flush()`);
  assert.deepEqual(await evaluate('window.writes'), [{ compactModelId: null }, { compactModelId: '9' }]);

  await evaluate("window.showScenario('ready')");
  assert.match(await evaluate('document.querySelector("[data-testid=compaction-advanced-card]").textContent'), /4096/);
  for (const dark of [false, true]) {
    await evaluate(`window.setDark(${dark}); window.flush()`);
    assert.equal(await evaluate('document.documentElement.dataset.theme'), dark ? 'dark' : 'light');
    await fs.writeFile(path.join(output, `fixture-${dark ? 'dark' : 'light'}.png`),
      (await window.webContents.capturePage()).toPNG());
  }
  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  clearTimeout(deadline);
  console.log('PASS 压缩设置组件：失效模型可取消、无模型不可启用、参数异常局部展示、完整表单浅深截图');
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
