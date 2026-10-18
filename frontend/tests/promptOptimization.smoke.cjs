const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/prompt-optimization');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('提示词优化组件验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref } from 'vue';
import ChatInputArea from '../../../src/components/chat/ChatInputArea.vue';
import ConfirmModal from '../../../src/components/common/ConfirmModal.vue';
import '../../../src/style.css';
const input = ref(null);
const mounted = ref(true);
window.setText = text => input.value.setInputText(text);
window.unmountInput = () => { mounted.value = false; };
window.sent = [];
window.events = [];
const onSend = (...args) => window.sent.push(args);
const onMode = mode => window.events.push(mode);
</script><template><main style="max-width:800px;margin:100px auto;padding:24px">
<ChatInputArea v-if="mounted" ref="input" :is-dark="false" selected-model-id="9007199254740993"
  @send-message="onSend" @update-mode="onMode" />
<ConfirmModal />
</main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp, nextTick } from 'vue';
import http from '../../../src/services/interceptor';
import { useI18n } from '../../../src/i18n';
useI18n().setPreference('zh-CN');
window.runtimeErrors=[]; window.requests=[]; window.reply='# 清晰的任务目标\\n保留用户指定的 Agent、团队与权限约束。\\n\\n<script>这是原样文本</script>';
window.addEventListener('error', event => window.runtimeErrors.push(event.error?.stack || event.message));
window.addEventListener('unhandledrejection', event => window.runtimeErrors.push(event.reason?.stack || String(event.reason)));
http.defaults.adapter = async config => {
  let data;
  if(config.url === '/model/optimize-prompt') {
    window.requests.push(JSON.parse(config.data));
    if(window.hold) await new Promise(resolve => { window.release=resolve; });
    data=window.fail ? {code:0,errMsg:'模拟失败'} : {code:1,data:window.reply};
  } else if(config.url.includes('/limits')) data={code:1,data:{maxImages:3}};
  else data={code:1,data:{records:[],total:0,current:1,size:50}};
  return {config,status:200,statusText:'OK',headers:{},data};
};
const {default:App}=await import('./App.vue');
createApp(App).mount('#app');
window.flush=async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve,40)); };
window.chooseOptimize=async () => {
  document.querySelector('button[aria-label="快捷指令 (/)"]').click(); await window.flush();
  [...document.querySelectorAll('button')].find(button => button.textContent.includes('optimize-prompt')).click(); await window.flush();
};
window.enter=() => document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
await window.flush(); window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  window = new BrowserWindow({ width: 1000, height: 850, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = async source => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { console.error('组件步骤失败: ' + source); throw error; }
  };
  for (let attempt=0; attempt<100 && !await evaluate('window.ready === true'); attempt++) {
    await new Promise(resolve => setTimeout(resolve,50));
  }
  assert.equal(await evaluate('window.ready'), true);
  await evaluate('window.setText("先修复问题，再设计方案，不实施方案"); window.flush()');
  await evaluate('window.chooseOptimize()');
  assert.equal(await evaluate('document.querySelector("[role=dialog]") !== null'), true);
  assert.equal(await evaluate('document.querySelector("textarea").value'), '先修复问题，再设计方案，不实施方案');
  assert.equal(await evaluate('window.requests[0].modelId'), '9007199254740993');
  assert.equal(await evaluate('window.requests[0].prompt'), '先修复问题，再设计方案，不实施方案');
  assert.equal(await evaluate('document.querySelector("[data-testid=confirm-preview]").textContent'), await evaluate('window.reply'));
  assert.equal(await evaluate('document.querySelector("[data-testid=confirm-preview] script") === null'), true);
  await new Promise(resolve => setTimeout(resolve, 350));
  await fs.writeFile(path.join(output, 'confirm.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate('[...document.querySelectorAll("[role=dialog] button")].find(button=>button.textContent.includes("保留原文")).click(); window.flush()');
  assert.equal(await evaluate('document.querySelector("textarea").value'), '先修复问题，再设计方案，不实施方案');
  assert.deepEqual(await evaluate('window.sent'), []);

  await evaluate('window.setText("/optimize-prompt 改写这段提示词"); window.flush()');
  await evaluate('window.enter(); window.flush()');
  assert.equal(await evaluate('window.requests.at(-1).prompt'), '改写这段提示词');
  await evaluate('[...document.querySelectorAll("[role=dialog] button")].find(button=>button.textContent.includes("替换输入")).click(); window.flush()');
  assert.equal(await evaluate('document.querySelector("textarea").value'), await evaluate('window.reply'));
  assert.deepEqual(await evaluate('window.sent'), []);

  await evaluate('window.reply="/plan 这是一段字面量，不触发计划模式"; window.chooseOptimize()');
  await evaluate('[...document.querySelectorAll("[role=dialog] button")].find(button=>button.textContent.includes("替换输入")).click(); window.flush()');
  assert.equal(await evaluate('document.querySelector("textarea").value'), '/plan 这是一段字面量，不触发计划模式');
  assert.deepEqual(await evaluate('window.events'), []);

  await evaluate('window.fail=true; window.setText("失败时保留这段话"); window.flush(); window.chooseOptimize()');
  assert.equal(await evaluate('document.querySelector("textarea").value'), '失败时保留这段话');
  assert.match(await evaluate('document.querySelector("[role=alert]")?.textContent'), /优化失败/);
  assert.equal(await evaluate('document.querySelector("[role=dialog]")'), null);

  await evaluate('window.fail=false; window.hold=true; window.setText("等待期间原文"); window.flush(); window.chooseOptimize()');
  await evaluate('window.setText("等待期间的新草稿"); window.flush(); window.release(); window.flush()');
  assert.equal(await evaluate('document.querySelector("textarea").value'), '等待期间的新草稿');
  assert.equal(await evaluate('document.querySelector("[role=dialog]")'), null);
  assert.match(await evaluate('document.querySelector("[role=alert]")?.textContent'), /草稿已发生变化/);

  await evaluate('window.hold=false; window.setText("/plan 计划模式回归"); window.flush()');
  assert.equal(await evaluate('document.querySelector("textarea").value'), '计划模式回归');
  assert.deepEqual(await evaluate('window.events'), ['plan']);
  await evaluate('window.setText("正常发送回归"); window.flush()');
  await evaluate('window.enter(); window.flush()');
  assert.equal(await evaluate('window.sent.length'), 1);
  assert.equal(await evaluate('window.sent[0][0]'), '正常发送回归');
  assert.equal(await evaluate('window.sent[0][1]'), true);

  await evaluate('window.setText("/optimize-prompt"); window.flush()');
  await evaluate('window.enter(); window.flush()');
  assert.match(await evaluate('document.querySelector("[role=alert]")?.textContent'), /请先输入/);
  assert.equal(await evaluate('window.sent.length'), 1);
  const requestsBeforePartialCommand = await evaluate('window.requests.length');
  await evaluate('window.setText("/op"); window.flush()');
  await evaluate('window.enter(); window.flush()');
  assert.equal(await evaluate('window.requests.length'), requestsBeforePartialCommand);
  assert.match(await evaluate('document.querySelector("[role=alert]")?.textContent'), /请先输入/);
  assert.deepEqual(await evaluate('window.runtimeErrors'), []);
  console.log('实际组件验证通过：菜单/斜杠命令、纯文本预览、取消/替换、失败/过期保护、计划模式与正常发送。');
  console.log('预览截图: ' + path.join(output, 'confirm.png'));
  clearTimeout(deadline);
  window.destroy();
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); if(window) window.destroy(); app.exit(1); });
