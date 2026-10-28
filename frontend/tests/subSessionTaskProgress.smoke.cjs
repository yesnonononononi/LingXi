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
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,220));};
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
    if (process.env.SUB_TASK_PROGRESS_MUTATION === 'animation' && id.endsWith('/taskProgress.css')) {
      assert.ok(source.includes('transition: opacity 160ms ease'));
      return source.replace('transition: opacity 160ms ease, transform 160ms cubic-bezier(.22, 1, .36, 1)', 'transition: none');
    }
    if (process.env.SUB_TASK_PROGRESS_MUTATION === 'bulk' && id.endsWith('/BackgroundTaskPanel.vue')) {
      assert.ok(source.includes('@click="removeFinished()"'));
      return source.replace('@click="removeFinished()"','@click="refresh()"');
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
  /**
   * 采样一次过渡的「真实中间帧」。
   *
   * <p><b>为什么不能固定等待后单点取样：</b>这两个过渡只有 160ms，而旧实现是
   * `2×rAF + 40ms` 固定等待后**只取一个点**。机器一忙，这个点就可能落在过渡开始之前
   * （opacity=0，还是 enter-from 初态）或结束之后（opacity=1），于是同一条断言随机红
   * （实测负载下 红/绿/绿）。单点取样的结论取决于运气，与「实现里到底有没有动画」无关。</p>
   *
   * <p><b>改成确定性取样：真实时钟轮询。</b>从第一帧起每帧采一次、最长 250ms，
   * 只要观察到 `0 < opacity < 1` 就立刻返回该帧并记录用了几帧、用了多久。160ms 的过渡
   * 在 60fps 下有约 10 个可观测帧、本实现给了 250ms 预算（≈15 帧），要做到「一次都扫不到」
   * 需要单个帧间隔超过 160ms（即比正常慢 10 倍以上）。</p>
   * <p><b>为什么不用 `getAnimations()` 冻结再步进：</b>实测本机（Electron/Chromium，
   * 五轮带负载复跑）该元素在过渡刚触发时 `getAnimations()` 恒返回空数组 —— 过渡对象要等
   * enter-to 那一帧应用后才诞生，而我们恰恰需要在那一刻之前就开始观察；冻结路径从未命中，
   * 却会额外消耗一帧延迟，属于「看起来更严谨、实际不起作用」的复杂度，故不采用。</p>
   * <p>超时返回最后一次观察值（而不是 undefined），让断言把真实状态（opacity 是 0 还是 1）
   * 打印出来，便于区分「取样错过」与「本来就没有过渡」。若连续三帧都读到
   * `transition-duration: 0s`，说明该元素本来就没有过渡（reduced-motion 分支），直接返回，
   * 不必空转到超时。</p>
   * <p><b>判据不变</b>（`0 < opacity < 1`，时长 `0.16s`，退场 `pointer-events:none`）：
   * 只是把「赌一个时刻」换成「必然扫到中间帧」，没有放宽任何一条。</p>
   */
  const sampleTransition = async (trigger,selector) => {
    const frame = await evaluate(`(async()=>{
    ${trigger};
    await Promise.resolve();await Promise.resolve();
    const TOTAL_MS=250;
    const pick=()=>document.querySelector('${selector}');
    const read=element=>{const style=getComputedStyle(element);return {opacity:Number(style.opacity),
      transform:style.transform,duration:style.transitionDuration,pointerEvents:style.pointerEvents};};
    const isMid=frame=>frame.opacity>0&&frame.opacity<1;
    const startedAt=performance.now();
    // 阶段 A：等元素出现（Vue 可能还要拉数据后才渲染）。判据只用「元素存在」，不预设时间点。
    let element=pick();
    while(!element&&performance.now()-startedAt<TOTAL_MS){
      await new Promise(resolve=>requestAnimationFrame(resolve));
      element=pick();
    }
    if(!element)return null;
    // 阶段 B：按真实时钟逐帧轮询。每帧采一次，命中中间帧立刻返回；
    // 超时（TOTAL_MS）返回最后一次观察值，让断言打印真实状态而不是含糊的 undefined。
    let last=null,samples=0,quiet=0;
    do{
      const frame=read(element);samples+=1;last=frame;
      if(isMid(frame))return {...frame,waitedMs:Math.round(performance.now()-startedAt),samples,mode:'poll'};
      // transition-duration 是静态声明，与过渡是否在跑无关：连续三帧都读到 0s 说明
      // 该元素根本没有过渡（例如 prefers-reduced-motion 关掉了动画），不必空转到超时。
      // 留三帧余量是为了容忍元素刚插入、样式尚未提交的那一两帧。
      quiet=frame.duration==='0s'?quiet+1:0;
      if(quiet>=3)return {...frame,waitedMs:Math.round(performance.now()-startedAt),samples,mode:'no-transition'};
      if(performance.now()-startedAt>=TOTAL_MS)break;
      await new Promise(resolve=>requestAnimationFrame(resolve));
      element=pick()||element;
    }while(true);
    return {...last,waitedMs:Math.round(performance.now()-startedAt),samples,mode:'timeout'};
  })()`);
    // 诊断开关：只打印不判断。排查 flake 时看 mode= 就知道是采到中间帧（poll）还是超时（timeout）。
    if (process.env.SUB_TASK_PROGRESS_TRACE) console.log('[transition]',selector,JSON.stringify(frame));
    return frame;
  };
  const entering = await sampleTransition('document.querySelector("aside [data-testid=background-task-toggle]").click()', 'aside .task-popup-enter-active');
  assert.ok(entering && entering.opacity>0 && entering.opacity<1,`展开必须有真实的中间帧: ${JSON.stringify(entering)}`);
  assert.match(entering.duration,/0\.16s/);
  await step('');
  const leaving = await sampleTransition('document.querySelector("aside [data-testid=background-task-toggle]").click()', 'aside .task-popup-leave-active');
  assert.ok(leaving && leaving.opacity>0 && leaving.opacity<1,'收起必须保留淡出中间帧');
  assert.equal(leaving.pointerEvents,'none','退场面板不能继续响应操作');
  await step('');
  await step('window.savedTasks=window.tasks["9007199254740995"]');
  const capsuleLeaving = await sampleTransition('window.tasks["9007199254740995"]=[];window.emitTask()', 'aside .task-capsule-leave-active');
  assert.ok(capsuleLeaving && capsuleLeaving.opacity>0 && capsuleLeaving.opacity<1,'单个胶囊移除也必须淡出');
  await step('window.tasks["9007199254740995"]=window.savedTasks;window.emitTask()');
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
  await step('');
  const dockEntering = await sampleTransition('window.tasks["9007199254740995"]=[{id:"9007199254740995",sessionId:"9007199254740995",turnId:"21",command:"npm test",status:"RUNNING",createAt:new Date().toISOString(),truncated:false}];window.emitTask()', 'aside .task-dock-enter-active');
  assert.ok(dockEntering && dockEntering.opacity>0 && dockEntering.opacity<1,'首次出现的胶囊必须淡入');
  await step('');
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const reduced = await sampleTransition('document.querySelector("aside [data-testid=background-task-toggle]").click()', 'aside [data-testid=background-task-panel]');
  assert.ok(reduced);
  assert.equal(reduced.duration,'0s','减少动态效果时关闭过渡');
  assert.equal(reduced.opacity,1);
  window.webContents.debugger.detach();
  await step(`window.tasks['9007199254740993']=Array.from({length:33},(_,index)=>({id:String(10000+index),sessionId:'9007199254740993',
    turnId:'21',command:'npm test '+index,status:index<31?'SUCCESS':index===31?'RUNNING':'PENDING',createAt:new Date().toISOString(),truncated:false}));
    window.tasks['9007199254740995']=Array.from({length:3},(_,index)=>({id:String(20000+index),sessionId:'9007199254740995',
    turnId:'21',command:'子会话测试 '+index,status:index<2?'SUCCESS':'RUNNING',createAt:new Date().toISOString(),truncated:false}));
    window.emitTask();window.emit('BACKGROUND_TASK_CHANGED',{rootSessionId:'9007199254740993',sessionId:'9007199254740993',taskId:'10000',status:'SUCCESS'});
    const mainToggle=document.querySelector('main [data-testid=background-task-toggle]');if(mainToggle.getAttribute('aria-expanded')!=='true')mainToggle.click()`);
  await until('document.querySelectorAll("main .task-row").length===33 && document.querySelectorAll("aside .task-row").length===3');
  await fs.writeFile(path.join(output,'bulk-delete.png'),(await window.webContents.capturePage()).toPNG());
  const beforeDeletes=await evaluate('window.requests.filter(request=>request.method==="delete").length');
  await click('background-task-delete-finished','main');
  await until('document.querySelectorAll("main .task-row").length===2');
  assert.equal(await evaluate('document.querySelectorAll("main [data-testid=background-task-delete-finished]").length'),0);
  assert.equal(await evaluate('document.querySelectorAll("aside .task-row").length'),3,'主会话批量删除不能影响子会话');
  assert.equal(await evaluate('window.requests.filter(request=>request.method==="delete").length'),beforeDeletes+31);
  await click('background-task-delete-finished');
  await until('document.querySelectorAll("aside .task-row").length===1');
  assert.equal(await evaluate('document.querySelector("aside .task-row").dataset.status'),'RUNNING');
  assert.deepEqual(await evaluate('window.runtimeErrors'),[]);
  console.log('任务胶囊通过：主/子会话批量删除、活跃任务保留、布局、主题、输出、事件隔离、重连与动画');
  window.destroy(); clearTimeout(deadline); app.quit();
}).catch(error => {console.error(error);clearTimeout(deadline);app.exit(1);});
