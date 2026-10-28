const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const frontendRoot = path.resolve(__dirname, '..');
const output = path.join(frontendRoot, '.run/sub-session-task-progress');
const specifier = relative => path.relative(output, path.join(frontendRoot, relative)).split(path.sep).join('/');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('子会话任务胶囊验证超时'); app.exit(1); }, 120000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { computed, ref, onScopeDispose } from 'vue';
import SubAgentSidePanel from '${specifier('src/components/chat/SubAgentSidePanel.vue')}';
import TaskProgressDock from '${specifier('src/components/chat/TaskProgressDock.vue')}';
import { useSubSessionTaskProgress } from '${specifier('src/views/chat/useSubSessionTaskProgress.ts')}';
import { useBackgroundTasks } from '${specifier('src/views/chat/useBackgroundTasks.ts')}';
import { useChecklist } from '${specifier('src/views/chat/useChecklist.ts')}';
import { SessionEventStream } from '${specifier('src/views/chat/sessionEventStream.ts')}';
import { toSubItemStatus } from '${specifier('src/utils/subSessionStatus.ts')}';
import { useTheme } from '${specifier('src/composables/useTheme.ts')}';
import '${specifier('src/style.css')}';
const theme = useTheme(); theme.setTheme('light');
localStorage.setItem('lingxi-sub-panel-width', '460');
const root = ref('9007199254740993'); const selected = ref('9007199254740995'); const open = ref(true);
const sessions = ref([selected.value, '9007199254740997'].map((id, index) => ({id, rootSessionId:root.value,
  name:index ? '另一成员' : '子会话工程师', runStatus:'RUNNING', messages:[{id:'m-'+id, role:'assistant',
  content:'子会话执行记录与验证结果。'.repeat(100), timestamp:1}]})));
const sub = computed(() => sessions.value.find(session => session.id === selected.value) ?? null);
const items = computed(() => sessions.value.map(session => ({id:session.id, agentName:session.name,
  task:session.name, status:toSubItemStatus(session.runStatus,session.lastOutcome), subSession:session})));
const progress = useSubSessionTaskProgress(sub, open);
const background = useBackgroundTasks(root); const checklist = useChecklist(root);
const stream = new SessionEventStream({onEvent:event => {checklist.onEvent(event);progress.onEvent(event);},
  onBackgroundTaskChanged:event => {background.onTaskChanged(event);progress.onTaskChanged(event);},
  onConnectionClosed:() => progress.refresh(), onResubscribed:() => progress.refresh()});
stream.acquire(root.value); onScopeDispose(() => stream.close());
window.select = id => {selected.value=id;}; window.toggleOpen = () => {open.value=!open.value;};
window.dark = value => theme.setTheme(value?'dark':'light');
window.pause = () => {sub.value.runStatus='IDLE';sub.value.lastOutcome='COMPLETED';};
window.reconnect = () => stream.reconnect();
</script><template><div style="height:100vh;display:flex;min-width:0">
<main style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:end" data-testid="main-session">
<TaskProgressDock :background="background" :checklist="checklist" :executing="true" :isDark="theme.isDark.value" />
</main>
<SubAgentSidePanel :items="items" :activeSubId="selected" :activeSubSession="sub" :subMessages="sub?.messages"
  :taskProgress="progress" :isOpen="open" :isDark="theme.isDark.value" @selectOption="selected=$event" @toggleOpen="open=!open" />
</div></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp,nextTick} from 'vue';
import {createPinia} from 'pinia';
import http from '${specifier('src/services/interceptor.ts')}';
import {setPreference} from '${specifier('src/i18n/index.ts')}';
import {AgentToolName} from '${specifier('src/utils/toolNames.ts')}';
import App from './App.vue';
setPreference('zh-CN');
const root='9007199254740993',sub='9007199254740995',other='9007199254740997';
window.requests=[];window.controllers=[];window.runtimeErrors=[];
window.addEventListener('error',event=>window.runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.runtimeErrors.push(String(event.reason)));
const task=owner=>({id:owner,sessionId:owner,turnId:'21',command:'npm test',intention:owner===root?'主会话任务':'子会话后台测试',
  status:'RUNNING',createAt:new Date().toISOString(),output:'子会话测试输出',truncated:false});
window.tasks={[root]:[task(root)],[sub]:[task(sub)],[other]:[]};
const snapshot=owner=>({checklistId:owner,sessionId:owner,title:owner===root?'主会话清单':'子会话清单',status:'ACTIVE',
  steps:[{stepId:'22',seq:1,content:'验证任务胶囊',status:'IN_PROGRESS'}]});
window.snapshots={[root]:snapshot(root),[sub]:snapshot(sub),[other]:null};
http.defaults.adapter=async config=>{
  const owner=config.params?.sessionId;window.requests.push({url:config.url,owner,method:config.method});let data;
  if(config.url==='/checklist/latest')data=window.snapshots[owner];
  else if(config.url==='/task/runtime/list')data=window.tasks[owner];
  else if(config.url.startsWith('/task/runtime/')){
    const id=config.url.split('/')[3];const task=window.tasks[owner].find(task=>task.id===id);
    if(config.method==='delete'){window.tasks[owner]=window.tasks[owner].filter(task=>task.id!==id);data=null;}
    else {if(config.url.endsWith('/stop'))task.status='CANCELLED';data=task;}
  }else throw new Error('意外请求: '+config.url);
  return {config,status:200,statusText:'OK',headers:{},data:{code:1,data:structuredClone(data)}};
};
window.fetch=async url=>{
  if(!String(url).includes('/'+root+'/events'))throw new Error('胶囊不应另建子会话连接: '+url);
  return new Response(new ReadableStream({start(controller){window.controllers.push(controller);
    controller.enqueue(new TextEncoder().encode('event: READY\\ndata: '+JSON.stringify({rootSessionId:root})+'\\n\\n'));}}));
};
window.emit=(name,data)=>window.controllers.at(-1).enqueue(new TextEncoder().encode('event: '+name+'\\ndata: '+JSON.stringify(data)+'\\n\\n'));
window.emitChecklist=()=>window.emit('TOOL_COMPLETED',{type:'TOOL_COMPLETED',executionId:'23',timestamp:'',
  toolName:AgentToolName.UpdateChecklistStep,metaData:{rootSessionId:root,sessionId:sub}});
window.emitTask=()=>window.emit('BACKGROUND_TASK_CHANGED',{rootSessionId:root,sessionId:sub,taskId:sub,status:'SUCCESS'});
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,40));};
createApp(App).use(createPinia()).mount('#app');window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const mutationPlugin = { name:'sub-task-progress-mutation', enforce:'pre', transform(source,id) {
    if (process.env.SUB_TASK_PROGRESS_MUTATION === 'dock' && id.endsWith('/SubAgentSidePanel.vue')) {
      assert.ok(source.includes('<TaskProgressDock v-if="taskProgress"'));
      return source.replace('<TaskProgressDock v-if="taskProgress"','<TaskProgressDock v-if="false"');
    }
    if (process.env.SUB_TASK_PROGRESS_MUTATION === 'owner' && id.endsWith('/useSubSessionTaskProgress.ts')) {
      assert.ok(source.includes('toServerId(session.value?.id)'));
      return source.replace('toServerId(session.value?.id)','toServerId(session.value?.rootSessionId)');
    }
  } };
  await build({configFile:false,root:output,base:'./',plugins:[mutationPlugin,vue()],logLevel:'error',
    resolve:{dedupe:['vue','pinia']},build:{target:'esnext',outDir:path.join(output,'dist'),emptyOutDir:true}});
  const window = new BrowserWindow({width:1100,height:720,show:false,
    webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  await window.loadFile(path.join(output,'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  const until = async source => {for(let attempt=0;attempt<100;attempt++){
    if(await evaluate(source))return;await new Promise(resolve=>setTimeout(resolve,40));
  }throw new Error('界面条件未满足: '+source);};
  const step = source => evaluate(`(async()=>{${source};await window.flush();})()`);
  const click = (id,scope='aside') => step(`document.querySelector('${scope} [data-testid=${id}]').click()`);
  await until('window.ready && document.querySelectorAll("aside .task-pill").length===2');
  assert.equal(await evaluate('window.controllers.length'),1,'复用一条根会话连接');
  await click('background-task-toggle');
  assert.match(await evaluate('document.querySelector("aside .task-list").textContent'),/子会话后台测试/);
  assert.doesNotMatch(await evaluate('document.querySelector("aside .task-list").textContent'),/主会话任务/);
  await step('document.querySelector("aside .task-open").click()');
  await until('document.querySelector("aside .task-output pre")');
  assert.match(await evaluate('document.querySelector("aside .task-output pre").textContent'),/子会话测试输出/);
  await click('background-task-toggle','main');
  assert.equal(await evaluate('new Set([...document.querySelectorAll(".task-panel")].map(panel=>panel.id)).size'),2,'两个面板各自有唯一 ID');
  assert.equal(await evaluate('[...document.querySelectorAll("[aria-expanded=true][aria-controls]")].every(button=>button.closest(".task-progress-dock").contains(document.getElementById(button.getAttribute("aria-controls"))))'),true);
  await click('checklist-toggle');
  assert.equal(await evaluate('document.querySelectorAll("aside [data-testid=background-task-panel]").length'),0);
  assert.equal(await evaluate('document.querySelectorAll("aside [data-testid=checklist-loading]").length'),1);
  await click('checklist-toggle','main');
  assert.equal(await evaluate('new Set([...document.querySelectorAll(".task-panel")].map(panel=>panel.id)).size'),2,'两份清单面板也必须各有唯一 ID');
  await click('checklist-toggle','main');
  await step('window.pause()');
  assert.equal(await evaluate('document.querySelectorAll("aside [data-testid=checklist-loading]").length'),0);
  assert.match(await evaluate('document.querySelector("aside .checklist-steps").textContent'),/等待继续/);
  for(const dark of [false,true]) {
    for(const width of [460,320]) {
      await step(`window.dark(${dark})`);
      // 面板宽度由拖拽更新，直接发送真实拖拽事件以覆盖最小宽度。
      await step(`const currentWidth=document.querySelector('aside').getBoundingClientRect().width;
        document.querySelector('aside .cursor-col-resize').dispatchEvent(new MouseEvent('mousedown',{clientX:600,bubbles:true}));
        window.dispatchEvent(new MouseEvent('mousemove',{clientX:600+currentWidth-${width},bubbles:true}));window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))`);
      await step('await new Promise(resolve=>setTimeout(resolve,240))');
      const box = await evaluate(`(()=>{const aside=document.querySelector('aside').getBoundingClientRect();
        const dock=document.querySelector('aside .task-progress-dock').getBoundingClientRect();
        const messages=document.querySelector('[data-testid=sub-session-messages]').getBoundingClientRect();
        const panel=document.querySelector('aside .task-panel').getBoundingClientRect();
        return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,
          aside:{left:aside.left,right:aside.right,bottom:aside.bottom,width:aside.width},dock:{top:dock.top,bottom:dock.bottom},
          pillTop:document.querySelector('aside .task-pill').getBoundingClientRect().top,
          messagesBottom:messages.bottom,panel:{left:panel.left,right:panel.right,top:panel.top,bottom:panel.bottom}};})()`);
      assert.ok(box.dock.top>=box.messagesBottom-1,'胶囊固定在消息区下方');
      assert.equal(box.aside.width,width,'拖拽后的面板宽度必须生效');
      assert.ok(box.pageWidth<=box.viewport && box.panel.right<=box.viewport,'面板与胶囊不能挤出视口');
      assert.ok(box.aside.bottom-box.dock.bottom<=16,'胶囊贴近子会话底部');
      assert.ok(box.panel.left>=box.aside.left && box.panel.right<=box.aside.right && box.panel.top>=0,'展开面板不被裁切');
      assert.ok(box.panel.bottom<box.pillTop,'展开面板向上浮出');
      await fs.writeFile(path.join(output,`${dark?'dark':'light'}-${width}.png`),(await window.webContents.capturePage()).toPNG());
    }
  }
  await step('window.snapshots["9007199254740995"].steps[0].status="COMPLETED";window.snapshots["9007199254740995"].status="COMPLETED";window.emitChecklist()');
  await until('document.querySelector("aside [data-testid=checklist-toggle]").textContent.includes("1/1")');
  assert.match(await evaluate('document.querySelector("main [data-testid=checklist-toggle]").textContent'),/0\/1/,'子会话进度不会覆盖主会话清单');
  assert.equal(await evaluate('document.querySelectorAll("aside .task-panel").length'),0,'清单收口后自动折叠');
  await step('window.tasks["9007199254740995"][0].status="SUCCESS";window.emitTask()');
  await until('document.querySelector("aside [data-testid=background-task-toggle]").textContent.includes("已结束")');
  await click('background-task-toggle');
  await click('background-task-delete');
  await until('!document.querySelector("aside [data-testid=background-task-toggle]")');
  await step('window.tasks["9007199254740995"]=[{id:"9007199254740995",sessionId:"9007199254740995",turnId:"21",command:"npm test",status:"RUNNING",createAt:new Date().toISOString(),truncated:false}];window.emitTask()');
  await until('document.querySelector("aside [data-testid=background-task-toggle]")');
  await click('background-task-toggle'); await click('background-task-stop');
  await until('document.querySelector("aside .task-row")?.dataset.status==="CANCELLED"');
  assert.equal(await evaluate('window.requests.filter(request=>request.method==="post"||request.method==="delete").every(request=>request.owner==="9007199254740995")'),true);
  await step('window.select("9007199254740997")');
  await until('document.querySelectorAll("aside .task-pill").length===0');
  await step('window.select("9007199254740995")');
  await until('document.querySelectorAll("aside .task-pill").length===2');
  assert.equal(await evaluate('document.querySelectorAll("aside .task-panel").length'),0);
  await step('window.toggleOpen()');
  await until('!document.querySelector("aside")');
  await step('window.toggleOpen()');
  await until('document.querySelectorAll("aside .task-pill").length===2');
  await step('window.tasks["9007199254740995"]=[];window.snapshots["9007199254740995"]=null;window.reconnect()');
  await until('window.controllers.length===2 && document.querySelectorAll("aside .task-pill").length===0');
  assert.deepEqual(await evaluate('window.runtimeErrors'),[]);
  console.log('子会话任务胶囊通过：底部布局、主题、输出、停止/删除、实时事件、成员隔离、收起重开和重连');
  window.destroy(); clearTimeout(deadline); app.quit();
}).catch(error => {console.error(error);clearTimeout(deadline);app.exit(1);});
