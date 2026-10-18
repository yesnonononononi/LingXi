const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const output = path.resolve(__dirname, '../node_modules/.tmp/background-tasks');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('后台任务界面验证超时'); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { computed, onScopeDispose, ref, watch } from 'vue';
import BackgroundTaskPanel from '../../../src/components/chat/BackgroundTaskPanel.vue';
import ChatInputArea from '../../../src/components/chat/ChatInputArea.vue';
import { useBackgroundTasks } from '../../../src/views/chat/useBackgroundTasks';
import { SessionEventStream } from '../../../src/views/chat/sessionEventStream';
import '../../../src/style.css';
const root = ref('9007199254740993'); const dark = ref(false);
const feed = useBackgroundTasks(computed(() => root.value));
const stream = new SessionEventStream({ onEvent: () => {}, onConnectionClosed: () => feed.refresh(),
  onResubscribed: () => feed.refresh(), onBackgroundTaskChanged: feed.onTaskChanged });
watch(root, (id, old) => { if (old) stream.release(old); if (id) stream.acquire(id); }, { immediate: true });
watch(dark, value => { document.documentElement.className = value ? 'dark' : 'light'; document.body.className = value ? 'dark' : 'light'; }, { immediate: true });
onScopeDispose(() => stream.close());
window.switchSession = id => { root.value = id; };
window.changeTheme = value => { dark.value = value; };
window.state = () => ({ count: feed.runningCount.value, tasks: feed.tasks.value, error: feed.error.value,
  stopError: feed.stopError.value, selectedId: feed.selectedId.value });
</script><template><main :style="{ minHeight: '620px', padding: '160px 12px 35px', background: dark ? '#080d09' : '#f5f8f4' }">
<BackgroundTaskPanel :feed="feed" :is-dark="dark" />
<ChatInputArea :is-dark="dark" :has-active-session="true" />
</main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp, nextTick } from 'vue';
import http from '../../../src/services/interceptor';
import { useI18n } from '../../../src/i18n';
useI18n().setPreference('zh-CN');
const root = '9007199254740993';
window.taskRequests = []; window.stopRequests = []; window.runtimeErrors = []; window.controllers = {};
window.addEventListener('error', event => window.runtimeErrors.push(event.error?.stack || event.message));
window.addEventListener('unhandledrejection', event => window.runtimeErrors.push(event.reason?.stack || String(event.reason)));
const created = new Date(Date.now() - 6000).toISOString();
window.taskData = { [root]: [
  { id:'9007199254740997',sessionId:root,turnId:'9007199254741005',command:'mvn verify',intention:'后台执行全量编译',status:'RUNNING',createAt:created,output:'编译输出\\n<script>window.injected=true</script>',truncated:false },
  { id:'9007199254740999',sessionId:root,turnId:'9007199254741005',command:'git ls-files',intention:'后台统计各模块源码规模',status:'RUNNING',createAt:created,output:'统计中',truncated:false },
  { id:'9007199254741001',sessionId:root,turnId:'9007199254741005',command:'git status',intention:'后台采集环境与仓库状态',status:'SUCCESS',createAt:created,completeAt:created,output:'已完成',exitCode:0,truncated:false }
], '9007199254740995': [] };
http.defaults.adapter = async config => {
  const owner = config.params?.sessionId;
  let data = { code:1, data:{ records:[], total:0 } };
  if(config.url.startsWith('/task/runtime')) {
    window.taskRequests.push({ url:config.url, sessionId:owner });
    if(config.url.endsWith('/list')) data = { code:1, data:window.taskData[owner] || [] };
    else {
      const id = config.url.split('/')[3];
      const task = (window.taskData[owner] || []).find(item => item.id === id);
      if(config.url.endsWith('/stop')) {
        window.stopRequests.push({ sessionId:owner, taskId:id });
        if(window.holdStop) await new Promise(resolve => { window.releaseStop = resolve; });
        if(window.failStop) throw new Error('未能确认任务已停止');
        if(task.status === 'RUNNING') { task.status = 'CANCELLED'; task.completeAt = new Date().toISOString(); task.exitCode = 137; }
      }
      data = { code:1, data:task };
    }
    data = JSON.parse(JSON.stringify(data));
  } else if(config.url.includes('/limits')) data = { code:1, data:{ maxImages:9 } };
  return { config, status:200, statusText:'OK', headers:{}, data };
};
window.fetch = async url => {
  const id = String(url).match(/completion\\/(\\d+)\\/events/)?.[1];
  if(!id) throw new Error('意外请求: '+url);
  const stream = new ReadableStream({ start(controller) {
    window.controllers[id] = controller;
    controller.enqueue(new TextEncoder().encode('event: READY\\ndata: '+JSON.stringify({rootSessionId:id})+'\\n\\n'));
  }});
  return new Response(stream, { headers:{ 'Content-Type':'text/event-stream' } });
};
window.completeTask = id => {
  const task = window.taskData[root].find(task => task.id === id); task.status = 'SUCCESS'; task.completeAt = new Date().toISOString(); task.exitCode = 0;
  window.controllers[root].enqueue(new TextEncoder().encode('event: BACKGROUND_TASK_CHANGED\\ndata: '+JSON.stringify({rootSessionId:root,sessionId:root,taskId:id,status:task.status})+'\\n\\n'));
};
const {default:App} = await import('./App.vue'); createApp(App).mount('#app');
window.flush = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve,80)); };
await window.flush(); window.ready = true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite'); const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile:false, root:output, base:'./', plugins:[vue()], logLevel:'error', build:{target:'esnext',outDir:path.join(output,'dist'),emptyOutDir:true} });
  window = new BrowserWindow({ width:1000, height:650, show:false, webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false} });
  await window.loadFile(path.join(output,'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  const until = async source => { for(let attempt=0;attempt<100;attempt++){ if(await evaluate(source))return; await new Promise(resolve=>setTimeout(resolve,40)); } throw new Error('界面条件未满足: '+source); };
  const screenshot = async name => { await new Promise(resolve=>setTimeout(resolve,220)); await fs.writeFile(path.join(output,name),(await window.webContents.capturePage()).toPNG()); };
  await until('window.ready && window.state().tasks.length===3 && window.controllers["9007199254740993"]');
  assert.match(await evaluate('document.querySelector("[data-testid=background-task-toggle]").textContent'), /2 个后台任务运行中/);
  await screenshot('collapsed.png');
  await evaluate('document.querySelector("[data-testid=background-task-toggle]").click();window.flush()');
  assert.equal(await evaluate('document.querySelectorAll(".task-row").length'),3);
  assert.equal(await evaluate('document.querySelectorAll("[data-status=SUCCESS]").length'),1);
  assert.match(await evaluate('document.querySelector(".task-state").textContent'),/已运行 \d+s/);
  const bounds = await evaluate('(()=>{const panel=document.querySelector(".task-panel").getBoundingClientRect();const input=document.querySelector("textarea").getBoundingClientRect();return {bottom:panel.bottom,input:input.top,width:panel.width};})()');
  assert.ok(bounds.bottom < bounds.input); assert.ok(bounds.width>650);
  await screenshot('expanded.png');
  await evaluate('const input=document.querySelector("textarea");input.value="保留当前草稿";input.dispatchEvent(new Event("input",{bubbles:true}));window.flush()');
  await evaluate('document.querySelector(".task-open").click();window.flush()');
  await until('document.querySelector(".task-output pre")!==null');
  assert.match(await evaluate('document.querySelector(".task-output pre").textContent'), /<script>window.injected=true<\/script>/);
  assert.equal(await evaluate('window.injected'),undefined);
  await evaluate('document.querySelector(".task-output-header button:last-child").click();window.flush()');
  await evaluate('window.holdStop=true;window.failStop=true;document.querySelector("[data-testid=background-task-stop]").click();window.flush()');
  assert.equal(await evaluate('window.state().count'),2);
  assert.equal(await evaluate('document.querySelector("[data-testid=background-task-stop]").disabled'),true);
  await evaluate('document.querySelector("[data-testid=background-task-stop]").click();window.releaseStop();window.flush()');
  await until('window.state().stopError.length>0');
  assert.equal(await evaluate('window.stopRequests.length'),1); assert.equal(await evaluate('window.state().count'),2);
  await evaluate('window.holdStop=false;window.failStop=false;document.querySelector("[data-testid=background-task-stop]").click();window.flush()');
  await until('window.state().count===1');
  assert.deepEqual(await evaluate('window.stopRequests[1]'),{sessionId:'9007199254740993',taskId:'9007199254740997'});
  await evaluate('window.changeTheme(true);window.flush()'); await screenshot('dark.png');
  await evaluate('window.changeTheme(false);window.flush()');
  window.setSize(400,680); await evaluate('window.flush()');
  const mobile = await evaluate('(()=>{const box=document.querySelector(".task-panel").getBoundingClientRect();return {left:box.left,right:box.right,screen:window.innerWidth};})()');
  assert.ok(mobile.left>=0 && mobile.right<=mobile.screen); await screenshot('mobile.png');
  window.setSize(1000,650);
  await evaluate('window.completeTask("9007199254740999");window.flush()'); await until('window.state().count===0');
  assert.match(await evaluate('document.querySelector(".task-panel-header").textContent'), /3 个后台任务已结束/);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=background-task-stop]").length'),0);
  assert.equal(await evaluate('document.querySelector("textarea").value'),'保留当前草稿');
  await evaluate('window.switchSession("9007199254740995");window.flush()');
  await until('window.state().tasks.length===0'); assert.equal(await evaluate('document.querySelector(".background-tasks")'),null);
  assert.equal(await evaluate('document.querySelector("textarea").value'),'保留当前草稿');
  assert.deepEqual(await evaluate('window.runtimeErrors'),[]);
  console.log('实际组件验证通过：折叠/展开、真实状态与耗时、输出转义、停止失败与确认、SSE 完成、跨会话清理、草稿保留、明暗主题与窄屏。');
  clearTimeout(deadline); window.destroy(); app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);if(window)window.destroy();app.exit(1);});