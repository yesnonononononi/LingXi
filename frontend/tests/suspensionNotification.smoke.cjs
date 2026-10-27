const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.run/suspension-notification');
const specifier = relative => path.relative(output, path.join(root, relative)).split(path.sep).join('/');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('挂起通知验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'entry.js'), `import {effectScope,nextTick} from 'vue';
import {createPinia,setActivePinia} from 'pinia';
import {useChatView} from '${specifier('src/views/chat/useChatView.ts')}';
import {chatApi} from '${specifier('src/services/chat.ts')}';
import http from '${specifier('src/services/interceptor.ts')}';
import {AgentToolName} from '${specifier('src/utils/toolNames.ts')}';
import {setPreference} from '${specifier('src/i18n/index.ts')}';
const ROOT='2107364703088017408', SUB='2107364703088017409', TURN='2107364703113183232';
setPreference('zh-CN');setActivePinia(createPinia());
window.notifications=[];window.runtimeErrors=[];
window.addEventListener('error',event=>window.runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.runtimeErrors.push(String(event.reason)));
window.electronAPI={notify:async payload=>{window.notifications.push(payload);return true;}};
let controller, state='RUNNING', hold=false, hasCard=false, release;
window.historyWaiting=false;
http.defaults.adapter=async config=>({config,status:200,statusText:'OK',headers:{},data:{code:1,data:{records:[],total:0}}});
window.fetch=async url=>{
  if(!url.includes('/events')) throw new Error('未预期的请求: '+url);
  return new Response(new ReadableStream({start(value){controller=value;send('READY',{});}}));
};
function send(type,metaData){controller.enqueue(new TextEncoder().encode('event:'+type+'\\ndata:'+JSON.stringify({type,executionId:'901',timestamp:'',metaData})+'\\n\\n'));}
chatApi.fetchSessionTree=async()=>({ok:true,data:{rootSessionId:ROOT,
  root:{id:ROOT,name:'协作任务',runStatus:state},subSessions:[{id:SUB,rootSessionId:ROOT,name:'工程师',runStatus:'RUNNING'}]}});
chatApi.fetchSessionMessages=async()=>{
  if(hold) await new Promise(resolve=>{release=resolve;window.historyWaiting=true;});
  const card={id:'401',type:'PROMISE',status:'pending',allowedActions:['ANSWER'],content:{kind:'CHOICE',question:'请选择'}};
  return {ok:true,data:{records:hasCard?[{toolCall:card}]:[],messages:[],turns:{},nextCursor:null,hasMore:false,
    turnViews:hasCard?{[TURN]:{sessionId:ROOT,turnId:TURN,viewVersion:'5',status:'WAITING',blocks:[{
      blockId:'tool:401',toolCallId:'401',responseId:'700',type:'TOOL',toolName:AgentToolName.RequireChoice,
      arguments:'{}',order:2,status:'PROMISED'}]}}:{}}};
};
const scope=effectScope();const view=scope.run(()=>useChatView());
view.localSessions.value=[{id:ROOT,title:'协作任务',messages:[],createdAt:0,updatedAt:0,modelId:'1',activeTools:[],runStatus:'RUNNING',
  subSessions:[{id:SUB,rootSessionId:ROOT,name:'工程师',runStatus:'RUNNING',messages:[]}]}];
view.localActiveId.value=ROOT;
const meta={sessionId:ROOT,rootSessionId:ROOT,turnId:TURN};
window.autoWait=()=>{send('EXECUTION_STARTED',meta);send('EXECUTION_STARTED',{...meta,sessionId:SUB,turnId:'2107364703113183999'});
  state='SUSPENDED';hold=true;send('EXECUTION_SUSPENDED',meta);};
window.releaseCard=()=>{hasCard=true;hold=false;release();};
window.getRunStatus=()=>view.currentActiveSession.value.runStatus;
window.cleanup=()=>{controller.close();scope.stop();};
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,50));};
await window.flush();window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({configFile:false,root:output,base:'./',plugins:[vue()],logLevel:'error',resolve:{dedupe:['vue','pinia']},
    build:{target:'esnext',outDir:path.join(output,'dist'),emptyOutDir:true}});
  const window = new BrowserWindow({show:false,webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  window.webContents.on('console-message',event=>{if(event.level===3) console.error(event.message);});
  await window.loadFile(path.join(output,'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  for(let index=0;index<100&&!await evaluate('window.ready');index++) await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(await evaluate('window.ready'),true);
  await evaluate('window.autoWait();window.flush()');
  for(let index=0;index<30&&!await evaluate('window.historyWaiting');index++) await evaluate('window.flush()');
  assert.equal(await evaluate('window.historyWaiting'),true,'真实视图确实发起了挂起后的历史回查');
  assert.equal(await evaluate('window.getRunStatus()'),'SUSPENDED');
  assert.deepEqual(await evaluate('window.notifications'),[],'等待子代理结果不能弹等待确认');
  await evaluate('window.releaseCard();window.flush()');
  for(let index=0;index<30&&!await evaluate('window.notifications.length');index++) await evaluate('window.flush()');
  const notices=await evaluate('window.notifications');
  assert.equal(notices.length,1,'正对照：同一视图收到真实可操作卡片后必须通知');
  assert.equal(notices[0].kind,'suspended');
  assert.equal(notices[0].body,'等待你的确认');
  assert.equal(notices[0].sessionId,'2107364703088017408');
  assert.deepEqual(await evaluate('window.runtimeErrors'),[]);
  await evaluate('window.cleanup()');
  console.log('PASS: 真实视图 SSE 挂起等待子代理不误报，历史卡片就绪后桌面桥收到一次确认通知');
  clearTimeout(deadline);app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
