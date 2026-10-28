// 本轮（过程区技术债）未执行：用户要求绕过 Electron。本脚本只挂 ChatMessageItem / 列表，
// 不触碰过程段内部与 ProcessDetails，与本轮改动无交集；断言一行未改。
// 未验证面登记见 docs/qa/process-debt-verification.md §4。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const output = path.resolve(__dirname, '../node_modules/.tmp/task-progress');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('任务胶囊验证超时'); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref, watch, onScopeDispose } from 'vue';
import TaskProgressDock from '../../../src/components/chat/TaskProgressDock.vue';
import { useBackgroundTasks } from '../../../src/views/chat/useBackgroundTasks';
import { useChecklist } from '../../../src/views/chat/useChecklist';
import { SessionEventStream } from '../../../src/views/chat/sessionEventStream';
import '../../../src/style.css';
const root = ref('9007199254740993'); const dark = ref(false); const executing = ref(true);
const background = useBackgroundTasks(root); const checklist = useChecklist(root);
const stream = new SessionEventStream({onEvent: event => checklist.onEvent(event),
  onConnectionClosed: () => checklist.refresh(), onBackgroundTaskChanged: background.onTaskChanged});
watch(root, (id, previous) => { if(previous) stream.release(previous); if(id) stream.acquire(id); }, {immediate:true});
watch(dark, value => { document.documentElement.className = value ? 'dark' : 'light'; }, {immediate:true});
onScopeDispose(() => stream.close());
window.changeTheme = value => {dark.value = value;}; window.switchSession = id => {root.value = id;};
window.changeExecuting = value => {executing.value = value;};
window.refreshBackground = () => background.refresh(); window.refreshChecklist = () => checklist.refresh();
window.state = () => ({snapshot:checklist.snapshot.value, error:checklist.error.value, tasks:background.tasks.value, selected:background.selectedId.value});
</script><template><main :style="{padding:'350px 12px 36px', minHeight:'900px', background:dark?'#000':'#fff'}">
<TaskProgressDock :background="background" :checklist="checklist" :is-dark="dark" :executing="executing" />
<div class="w-full max-w-lx-chat mx-auto px-4"><textarea id="draft" placeholder="描述你想要构建的内容" :style="{width:'100%',height:'110px',borderRadius:'18px',border:dark?'1px solid #303034':'1px solid #e4e4e7',padding:'18px',background:dark?'#000':'#fff',color:dark?'#fff':'#27272a'}" /></div>
<button id="outside">外部区域</button>
</main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp,nextTick} from 'vue';
import http from '../../../src/services/interceptor';
import {useI18n} from '../../../src/i18n';
import {AgentToolName} from '../../../src/utils/toolNames';
useI18n().setPreference('zh-CN');
const root='9007199254740993';const other='9007199254740995';
window.runtimeErrors=[];window.controllers={};window.requests=[];
window.addEventListener('error',event=>window.runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.runtimeErrors.push(String(event.reason)));
window.snapshots={[root]:{checklistId:'9007199254741001',sessionId:root,title:'回归验证',status:'ACTIVE',steps:[
{stepId:'9007199254741011',seq:1,content:'梳理现有实现',status:'COMPLETED'},
{stepId:'9007199254741013',seq:2,content:'调整进度展示',status:'COMPLETED'},
{stepId:'9007199254741015',seq:3,content:'补充回归用例',status:'COMPLETED'},
{stepId:'9007199254741017',seq:4,content:'运行回归测试',status:'IN_PROGRESS'},
{stepId:'9007199254741019',seq:5,content:'整理交付结果',status:'PENDING'}]},[other]:null};
window.taskData={[root]:[],[other]:[]};
window.makeTask=owner=>({id:'9007199254741021',sessionId:owner,turnId:'9007199254741023',command:'mvn verify',intention:'运行后端回归测试',status:'RUNNING',createAt:new Date().toISOString(),output:'<script>window.injected=true</script>',truncated:false});
http.defaults.adapter=async config=>{window.requests.push(config.url);const owner=config.params?.sessionId;
let data=null;
if(config.url==='/checklist/current')data=window.snapshots[owner]??null;
else if(config.url==='/task/runtime/list')data=window.taskData[owner]??[];
else if(config.url.startsWith('/task/runtime/'))data=(window.taskData[owner]??[]).find(task=>task.id===config.url.split('/')[3]);
else throw new Error('意外请求: '+config.url);
return {config,status:200,statusText:'OK',headers:{},data:{code:1,data:JSON.parse(JSON.stringify(data))}};};
window.fetch=async url=>{const id=String(url).match(/completion\\/(\\d+)\\/events/)?.[1];
if(!id)throw new Error('意外事件请求: '+url);
return new Response(new ReadableStream({start(controller){window.controllers[id]=controller;controller.enqueue(new TextEncoder().encode('event: READY\\ndata: '+JSON.stringify({rootSessionId:id})+'\\n\\n'));}}),{headers:{'Content-Type':'text/event-stream'}});};
window.emitChecklist=()=>window.controllers[root].enqueue(new TextEncoder().encode('event: TOOL_COMPLETED\\ndata: '+JSON.stringify({type:'TOOL_COMPLETED',executionId:'81',timestamp:new Date().toISOString(),toolName:AgentToolName.UpdateChecklistStep,metaData:{rootSessionId:root,sessionId:root}})+'\\n\\n'));
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,60));};
const {default:App}=await import('./App.vue');createApp(App).mount('#app');await window.flush();window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite'); const { default: vue } = await import('@vitejs/plugin-vue');
  const mutation = process.env.TASK_PROGRESS_MUTATION;
  const mutationPlugin = { name: 'task-progress-mutation', enforce: 'pre', transform(source, id) {
    if (mutation === 'exclusive' && id.endsWith('/TaskProgressDock.vue')) {
      const needle = ':expanded="activePanel === \'background\'"'; assert.ok(source.includes(needle));
      return source.replace(needle, ':expanded="activePanel !== null"');
    }
    if (mutation === 'loading' && id.endsWith('/ChecklistPanel.vue')) {
      const needle = 'animation: checklist-spin .9s steps(8) infinite'; assert.ok(source.includes(needle));
      return source.replace(needle, 'animation: none');
    }
  } };
  await build({configFile:false,root:output,base:'./',plugins:[mutationPlugin,vue()],logLevel:'error',build:{target:'esnext',outDir:path.join(output,'dist'),emptyOutDir:true}});
  window = new BrowserWindow({width:1100,height:900,show:false,webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  await window.loadFile(path.join(output,'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  const until = async source => { for(let attempt=0;attempt<100;attempt++){if(await evaluate(source))return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('界面条件未满足: '+source);};
  const click = async id => evaluate(`document.querySelector('[data-testid="${id}"]').click();window.flush()`);
  const screenshot = async name => fs.writeFile(path.join(output,name),(await window.webContents.capturePage()).toPNG());
  const pillOrder = () => evaluate('Array.from(document.querySelectorAll(".task-pill"),button=>button.dataset.testid)');
  await until('window.ready && window.state().snapshot && window.controllers["9007199254740993"]');
  assert.deepEqual(await pillOrder(),['checklist-toggle']);
  assert.match(await evaluate('document.querySelector("[data-testid=checklist-toggle]").textContent'),/任务清单\s*3\/5/);
  const left = await evaluate('document.querySelector("[data-testid=checklist-toggle]").getBoundingClientRect().left');
  const composerTop = await evaluate('document.querySelector("#draft").getBoundingClientRect().top');
  await evaluate('document.querySelector("#draft").value="保留草稿"');
  await click('checklist-toggle');
  assert.equal(await evaluate('document.querySelectorAll(".checklist-step").length'),5);
  const geometry = await evaluate('(()=>{const panel=document.querySelector("[data-testid=checklist-panel]").getBoundingClientRect();const pill=document.querySelector("[data-testid=checklist-toggle]").getBoundingClientRect();return {bottom:panel.bottom,top:pill.top,left:panel.left,right:panel.right};})()');
  assert.ok(geometry.bottom<geometry.top); assert.equal(await evaluate('document.querySelector("#draft").getBoundingClientRect().top'),composerTop);
  const animation = await evaluate('(()=>{const s=getComputedStyle(document.querySelector("[data-testid=checklist-loading]"));return {name:s.animationName,duration:s.animationDuration,iteration:s.animationIterationCount};})()');
  assert.match(animation.name,/checklist-spin/); assert.equal(animation.duration,'0.9s'); assert.equal(animation.iteration,'infinite');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=checklist-loading]").length'),1);
  const firstFrame = await evaluate('getComputedStyle(document.querySelector("[data-testid=checklist-loading]")).transform');
  await new Promise(resolve => setTimeout(resolve,180));
  assert.notEqual(await evaluate('getComputedStyle(document.querySelector("[data-testid=checklist-loading]")).transform'),firstFrame);
  await evaluate('window.changeExecuting(false);window.flush()');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=checklist-loading]").length'),0);
  assert.match(await evaluate('document.querySelector(".checklist-steps").textContent'),/等待继续/);
  await evaluate('window.changeExecuting(true);window.flush()');
  await screenshot('light-checklist.png');
  await evaluate('window.taskData["9007199254740993"]=[window.makeTask("9007199254740993")];window.refreshBackground();window.flush()');
  await until('document.querySelector("[data-testid=background-task-toggle]")');
  assert.deepEqual(await pillOrder(),['checklist-toggle','background-task-toggle']);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=background-task-panel]").length'),0);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=checklist-panel]").length'),1);
  assert.equal(await evaluate('document.querySelector("[data-testid=checklist-toggle]").getBoundingClientRect().left'),left);
  await click('background-task-toggle');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=checklist-panel]").length'),0);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=background-task-panel]").length'),1);
  await evaluate('document.querySelector(".task-open").click();window.flush()');
  await until('document.querySelector(".task-output pre")');
  assert.match(await evaluate('document.querySelector(".task-output pre").textContent'),/<script>/);
  assert.equal(await evaluate('window.injected'),undefined);
  await click('checklist-toggle');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=background-task-panel]").length'),0);
  assert.equal(await evaluate('window.state().selected'),null);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=checklist-panel]").length'),1);
  await evaluate('window.changeTheme(true);window.flush()');
  const colors = await evaluate('Array.from(document.querySelectorAll(".task-pill, .task-panel"),element=>{const s=getComputedStyle(element);return {bg:s.backgroundColor,ink:s.color,shadow:s.textShadow};})');
  assert.ok(colors.length>=3); for(const color of colors){assert.equal(color.bg,'rgb(0, 0, 0)');assert.notEqual(color.shadow,'none');}
  await screenshot('dark-checklist.png');
  await click('background-task-toggle'); await screenshot('dark-background.png');
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));window.flush()');
  assert.equal(await evaluate('document.querySelectorAll(".task-panel").length'),0);
  assert.equal(await evaluate('document.activeElement.dataset.testid'),'background-task-toggle');
  await click('checklist-toggle');
  await evaluate('document.querySelector("#outside").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));window.flush()');
  assert.equal(await evaluate('document.querySelectorAll(".task-panel").length'),0);
  await click('checklist-toggle');
  await evaluate('window.changeTheme(false);window.taskData["9007199254740993"]=[];window.refreshBackground();window.flush()');
  await until('document.querySelectorAll(".task-pill").length===1');
  assert.equal(await evaluate('document.querySelector("[data-testid=checklist-toggle]").getBoundingClientRect().left'),left);
  await evaluate('window.snapshots["9007199254740993"].steps[3].status="FAILED";window.snapshots["9007199254740993"].steps[4].status="SKIPPED";window.snapshots["9007199254740993"].status="COMPLETED";window.emitChecklist();window.flush()');
  await until('window.state().snapshot.status==="COMPLETED"');
  assert.match(await evaluate('document.querySelector("[data-testid=checklist-toggle]").textContent'),/5\/5/);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=checklist-panel]").length'),0);
  await click('checklist-toggle');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=checklist-loading]").length'),0);
  assert.match(await evaluate('document.querySelector(".checklist-steps").textContent'),/失败/);
  assert.match(await evaluate('document.querySelector(".checklist-steps").textContent'),/已跳过/);
  window.setSize(390,900); await evaluate('window.flush()');
  const mobile = await evaluate('(()=>{const r=document.querySelector(".task-panel").getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth};})()');
  assert.ok(mobile.left>=0&&mobile.right<=mobile.width); await screenshot('mobile.png');
  window.setSize(1100,900); await evaluate('window.flush()');
  await evaluate('window.snapshots["9007199254740993"]=null;window.refreshChecklist();window.flush()');
  await until('document.querySelector("[data-testid=task-progress-dock]")===null');
  assert.equal(await evaluate('document.querySelector("#draft").value'),'保留草稿');
  await evaluate('window.taskData["9007199254740995"]=[window.makeTask("9007199254740995")];window.switchSession("9007199254740995");window.flush()');
  await until('document.querySelector("[data-testid=background-task-toggle]")');
  assert.deepEqual(await pillOrder(),['background-task-toggle']);
  await evaluate('window.snapshots["9007199254740995"]={checklistId:"9007199254741101",sessionId:"9007199254740995",title:"另一份",status:"ACTIVE",steps:[{stepId:"9007199254741103",seq:1,content:"等待确认",status:"PENDING"}]};window.refreshChecklist();window.flush()');
  await until('document.querySelector("[data-testid=checklist-toggle]")');
  assert.deepEqual(await pillOrder(),['background-task-toggle','checklist-toggle']);
  await click('checklist-toggle');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=checklist-loading]").length'),0);
  assert.deepEqual(await evaluate('window.runtimeErrors'),[]);
  console.log('实际组件通过：胶囊追加顺序、空态隐藏、双向互斥、向上展开、输入框固定、真实 SSE 更新、loading 动画、明暗主题、窄屏、草稿与输出转义。');
  clearTimeout(deadline); window.destroy(); app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);if(window)window.destroy();app.exit(1);});
