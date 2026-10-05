const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { registerFilePreview } = require('../electron/file-preview.cjs');

const output = path.resolve(__dirname, '../node_modules/.tmp/file-preview-smoke');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
let server;
let stop;
const deadline = setTimeout(() => { console.error('文件预览界面验证超时'); app.exit(1); }, 120000);

async function waitFor(expression) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('界面未达到预期状态: ' + expression);
}

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  const workspace = path.join(output, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const content = await fs.readFile(path.resolve(__dirname, '../../src/main/java/com/summit/dp/shared/config/MybatisPlusConfig.java'), 'utf8');
  await fs.writeFile(path.join(workspace, 'MybatisPlusConfig.java'), content);
  await fs.writeFile(path.join(workspace, 'docker-compose.yml'), 'services:\n  app:\n    image: lingxi:latest\n');
  server = http.createServer((request, response) => {
    const data = request.url === '/config/current' ? { type: 'LOCAL' }
      : request.url.startsWith('/session/') ? { workspaceId: '100' }
        : { hostDir: workspace };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 1, data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const source = `<script setup>
import { provide, ref } from 'vue';
import { loader } from '@guolao/vue-monaco-editor';
import FilePreviewPanel from '../../../src/components/chat/FilePreviewPanel.vue';
import ChatMessageItem from '../../../src/components/chat/ChatMessageItem.vue';
import { useFilePreview } from '../../../src/composables/useFilePreview';
import { FILE_PREVIEW_KEY } from '../../../src/types/filePreview';
import { AgentToolName } from '../../../src/utils/toolNames';
import '../../../src/style.css';
localStorage.setItem('lingxi_api_base_url', ${JSON.stringify(base)});
const dark = ref(false);
const state = useFilePreview();
const { fileTabs, activeFileId, filePreviewOpen, closeFileTab, refreshFile, runFileAction } = state;
provide(FILE_PREVIEW_KEY, state.openFilePreview);
window.previewDemo = { ...state, setDark: value => dark.value = value };
window.previewMonaco = () => loader.__getMonacoInstance();
window.previewEditor = () => window.previewMonaco()?.editor.getEditors()[0];
const message = { id: 'demo-message', role: 'assistant', content: '', timestamp: Date.now(), isComplete: false, toolCalls: [{ id: 'demo-tool', toolName: AgentToolName.ReadFile, args: { path: 'MybatisPlusConfig.java' }, status: 'success', timestamp: Date.now() }] };
</script>
<template>
  <main :class="{ dark }" style="display:flex;height:100vh;background:#f7f7f9">
    <section style="flex:1;min-width:0;padding:48px 32px">
      <h1 style="font-size:22px;margin-bottom:28px;color:#6366f1">LX · 文件预览</h1>
      <ChatMessageItem :message="message" sessionId="101" :isDark="dark" />
    </section>
    <FilePreviewPanel v-if="fileTabs.length" v-show="filePreviewOpen" :tabs="fileTabs" :activeId="activeFileId" :isDark="dark"
      @activate="activeFileId = $event" @closeTab="closeFileTab" @close="filePreviewOpen = false"
      @refresh="refreshFile" @open="runFileAction('open')" @reveal="runFileAction('reveal')" />
  </main>
</template>`;
  await fs.writeFile(path.join(output, 'App.vue'), source);
  await fs.writeFile(path.join(output, 'entry.js'), "import { createApp } from 'vue'; import App from './App.vue'; createApp(App).mount('#app');");
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error', build: { outDir: path.join(output, 'dist'), emptyOutDir: true } });
  window = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { preload: path.resolve(__dirname, '../electron/preload.cjs'), nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  window.webContents.on('console-message', event => { if (event.level === 'error') console.error('预览页面:', event.message); });
  const remoteRequests = [];
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const remote = !details.url.startsWith(base + '/');
    if (remote) remoteRequests.push(details.url);
    callback({ cancel: remote });
  });
  stop = registerFilePreview({ ipcMain, shell, getWindow: () => window });
  ipcMain.handle('window:set-titlebar-theme', () => {});
  await window.loadFile(path.join(output, 'dist/index.html'));
  await waitFor('!!document.querySelector(\'button[title="预览文件"]\')');
  await window.webContents.executeJavaScript('document.querySelector(\'button[title="预览文件"]\').click()');
  await waitFor('window.previewEditor()?.getValue().includes("MybatisPlusConfig")');
  await waitFor('!!document.querySelector(".monaco-editor .line-numbers")');
  const initial = await window.webContents.executeJavaScript('({ tabs: document.querySelectorAll("[role=tab]").length, code: window.previewEditor().getValue(), language: window.previewEditor().getModel().getLanguageId(), readonly: window.previewEditor().getOption(window.previewMonaco().editor.EditorOption.readOnly), gutter: !!document.querySelector(".monaco-editor .line-numbers"), find: !!window.previewEditor().getAction("actions.find"), folding: !!window.previewEditor().getAction("editor.fold") })');
  assert.equal(initial.tabs, 1);
  assert.match(initial.code, /MybatisPlusConfig/);
  assert.equal(initial.gutter, true);
  assert.equal(initial.language, 'java');
  assert.equal(initial.readonly, true);
  assert.equal(initial.find, true);
  assert.equal(initial.folding, true);
  await window.webContents.executeJavaScript('window.previewDemo.openFilePreview("101", "MybatisPlusConfig.java")');
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("[role=tab]").length'), 1);
  await window.webContents.executeJavaScript('window.previewDemo.openFilePreview("101", "docker-compose.yml")');
  await waitFor('window.previewEditor()?.getValue().includes("services:")');
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("[role=tab]").length'), 2);
  await fs.writeFile(path.join(workspace, 'docker-compose.yml'), 'services:\n  refreshed:\n    image: lingxi:updated\n');
  await waitFor('window.previewEditor()?.getValue().includes("lingxi:updated")');
  await window.webContents.executeJavaScript('document.querySelector("[role=tab]").click()');
  await waitFor('window.previewEditor()?.getValue().includes("MybatisPlusConfig")');
  await new Promise(resolve => setTimeout(resolve, 200));
  await waitFor('document.querySelector(".monaco-editor .view-lines")?.textContent.includes("MybatisPlusConfig")');
  assert.equal(await window.webContents.executeJavaScript('window.previewEditor().getLayoutInfo().height > 300'), true);
  await fs.writeFile(path.join(output, 'light.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript('window.previewDemo.setDark(true)');
  await waitFor('!!document.querySelector(".file-preview-panel.is-dark")');
  await waitFor('!!document.querySelector(".monaco-editor.vs-dark")');
  assert.equal(await window.webContents.executeJavaScript('getComputedStyle(document.querySelector(".file-preview-panel")).backgroundColor'), 'rgb(12, 14, 19)');
  await new Promise(resolve => setTimeout(resolve, 200));
  await fs.writeFile(path.join(output, 'dark.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript('document.querySelector(\'button[aria-label="最大化预览"]\').click()');
  await waitFor('!!document.querySelector(".file-preview-panel.is-maximized")');
  await window.webContents.executeJavaScript('document.querySelector(\'button[aria-label="关闭 MybatisPlusConfig.java"]\').click()');
  await waitFor('document.querySelectorAll("[role=tab]").length === 1');
  await waitFor('window.previewMonaco().editor.getModels().length === 1');
  await fs.unlink(path.join(workspace, 'docker-compose.yml'));
  await waitFor('document.querySelector("[role=alert]")?.textContent.includes("文件不存在")');
  await window.webContents.executeJavaScript('document.querySelector(\'button[aria-label="关闭 docker-compose.yml"]\').click()');
  await waitFor('window.previewMonaco().editor.getModels().length === 0');
  assert.deepEqual(remoteRequests, []);
  console.log('Monaco 预览验证通过: 离线加载、只读、行号、查找、折叠、多标签、自动刷新、主题、模型释放');
  console.log('预览截图: ' + output);
}).then(() => {
  clearTimeout(deadline);
  stop?.();
  server?.close();
  window?.destroy();
  app.exit(0);
}).catch(async error => {
  console.error(error);
  if (window && !window.isDestroyed()) console.log(await window.webContents.executeJavaScript('document.body.innerText.slice(0, 1500)'));
  stop?.();
  server?.close();
  app.exit(1);
});
