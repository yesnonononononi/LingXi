const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const output = path.resolve(__dirname, '../node_modules/.tmp/chat-controls');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('聊天控制组件验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { computed, ref } from 'vue';
import ChatInputArea from '../../../src/components/chat/ChatInputArea.vue';
import ChatMessageList from '../../../src/components/chat/ChatMessageList.vue';
import ChatExecutionControls from '../../../src/components/chat/ChatExecutionControls.vue';
import ChatResendDialog from '../../../src/components/chat/ChatResendDialog.vue';
import { useChatExecutionControls } from '../../../src/views/chat/useChatExecutionControls';
import { SessionAPI } from '../../../src/services/session';
import { upsertTurnViewIntoMessages } from '../../../src/views/chat/blockProjection';
import '../../../src/style.css';
const session = ref({ id:'500', title:'控制验证', runStatus:'RUNNING', modelId:'7', createdAt:1, updatedAt:1, activeTools:[],
  messages:[{id:'user-display',serverMessageId:'9007199254740993',role:'user',turnId:'101',content:'先分析问题，再给出修改方案。',timestamp:1},
    {id:'answer',role:'assistant',turnId:'101',content:'已完成第一轮分析。',timestamp:2},
    {id:'second-user',serverMessageId:'9007199254740995',role:'user',turnId:'102',content:'补充第二轮问题。',timestamp:3}] });
async function reconcile(id) {
  const tree = await SessionAPI.tree(id);
  session.value.runStatus = tree.data.sessions[0].runStatus;
  if(window.newView) upsertTurnViewIntoMessages(session.value.messages, window.newView, session.value.turnViewVersions ?? new Map());
}
window.refreshSession=()=>reconcile('500');
const controls=useChatExecutionControls({session:computed(()=>session.value),isSubmitting:computed(()=>false),
  ensureSubscribed:async()=>true,reconcile,buildCommand:input=>({input,modelId:'7',workspaceId:0,agentId:0,workDir:'',requirePlan:false}),
  onResendAccepted:()=>{} });
window.visibleMessages=()=>session.value.messages;
</script><template><main class="mx-auto flex max-w-3xl flex-col gap-3 p-6 h-screen">
<ChatMessageList :messages="session.messages" session-id="500" :is-dark="false" :is-sending="session.runStatus!=='IDLE'"
  :allow-resend="controls.canResend.value" @edit-resend="controls.edit" />
<ChatExecutionControls :status="session.runStatus" :can-pause="controls.canPause.value" :can-resume="controls.canResume.value"
  :pausing="controls.isPausing.value" :resuming="controls.isResuming.value" :has-unresolved="controls.hasUnresolved.value"
  :error="controls.error.value" @pause="controls.pause" @resume="controls.resume" />
<ChatInputArea :is-dark="false" :is-sending="session.runStatus!=='IDLE'" />
<ChatResendDialog :open="!!controls.editTarget.value" v-model="controls.draft.value" :busy="controls.resending.value"
  :error="controls.error.value" :image-count="0" @cancel="controls.cancelEdit" @submit="controls.resend" />
</main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp, nextTick } from 'vue';
import http from '../../../src/services/interceptor';
import { useI18n } from '../../../src/i18n';
useI18n().setPreference('zh-CN');
window.backendStatus='RUNNING'; window.requests=[]; window.resends=[]; window.runtimeErrors=[];
window.addEventListener('error',event=>window.runtimeErrors.push(event.error?.stack||event.message));
window.addEventListener('unhandledrejection',event=>window.runtimeErrors.push(event.reason?.stack||String(event.reason)));
http.defaults.adapter=async config=>{
  window.requests.push(config.url);
  let data={code:1,data:{records:[],total:0,current:1,size:50}};
  if(config.url.endsWith('/suspend')){window.backendStatus='SUSPENDED';data='';}
  else if(config.url.endsWith('/resume')){window.backendStatus='RUNNING';data={code:1,data:'不可作为聊天正文展示'};}
  else if(config.url.endsWith('/tree')) data={code:1,data:{rootSessionId:'500',sessions:[{id:'500',runStatus:window.backendStatus}]}};
  else if(config.url.includes('/limits')) data={code:1,data:{maxImages:9}};
  return {config,status:200,statusText:'OK',headers:{},data};
};
window.fetch=async(url,options)=>{
  if(!url.endsWith('/a/completion/resend')) throw new Error('意外请求: '+url);
  const input=options.body.get('input');window.resends.push({input,messageId:options.body.get('messageId'),sessionId:options.body.get('sessionId')});
  if(window.hold) await new Promise(resolve=>{window.release=resolve;});
  if(window.fail) return Response.json({code:0,errMsg:'模拟重发失败'});
  window.backendStatus='IDLE';window.newView={sessionId:'500',turnId:'103',viewVersion:'1',status:'COMPLETED',userMessage:input,
    userMessageId:'9007199254740997',blocks:[]};
  return Response.json({code:1,data:{sessionId:'500',turnId:'103',historyRevision:'2',invalidatedTurnIds:['101','102'],invalidatedExecutionIds:['901','902']}});
};
const {default:App}=await import('./App.vue');createApp(App).mount('#app');
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,60));};
await window.flush();window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile:false, root:output, base:'./', plugins:[vue()], logLevel:'error',
    build:{target:'esnext',outDir:path.join(output,'dist'),emptyOutDir:true} });
  window=new BrowserWindow({width:1000,height:850,show:false,webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  await window.loadFile(path.join(output,'dist/index.html'));
  const evaluate=async source=>{try{return await window.webContents.executeJavaScript(source);}catch(error){console.error('组件步骤失败: '+source);throw error;}};
  for(let attempt=0;attempt<100&&!await evaluate('window.ready===true');attempt++) await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(await evaluate('window.ready'),true);
  assert.equal(await evaluate('document.querySelector("[data-testid=edit-resend]")'),null);
  await evaluate('document.querySelector("[data-testid=pause-generation]").click();window.flush()');
  assert.equal(await evaluate('document.querySelector("[data-testid=resume-generation]")!==null'),true);
  assert.ok((await evaluate('window.requests')).includes('/a/completion/500/suspend'));
  await new Promise(resolve=>setTimeout(resolve,250));
  await fs.writeFile(path.join(output,'paused.png'),(await window.webContents.capturePage()).toPNG());
  await evaluate('document.querySelector("[data-testid=resume-generation]").click();window.flush()');
  assert.equal(await evaluate('document.querySelector("[data-testid=pause-generation]")!==null'),true);
  assert.equal(await evaluate('document.body.textContent.includes("不可作为聊天正文展示")'),false);
  await evaluate('window.backendStatus="IDLE";window.refreshSession();window.flush()');
  await evaluate('document.querySelector("[data-testid=edit-resend]").click();window.flush()');
  assert.equal(await evaluate('document.querySelector("[role=dialog] textarea").value'),'先分析问题，再给出修改方案。');
  await new Promise(resolve=>setTimeout(resolve,250));
  await fs.writeFile(path.join(output,'edit-resend.png'),(await window.webContents.capturePage()).toPNG());
  await evaluate('[...document.querySelectorAll("[role=dialog] button")].find(button=>button.textContent.includes("取消")).click();window.flush()');
  assert.equal(await evaluate('window.resends.length'),0);
  assert.equal(await evaluate('window.visibleMessages().length'),3);
  await evaluate('document.querySelector("[data-testid=edit-resend]").click();window.flush()');
  await evaluate('const editor=document.querySelector("[role=dialog] textarea");editor.value="先修复问题，再给方案，不实施方案。";editor.dispatchEvent(new Event("input",{bubbles:true}));window.hold=true;window.flush()');
  await evaluate('document.querySelector("[data-testid=confirm-resend]").click();window.flush()');
  assert.equal(await evaluate('document.querySelector("[data-testid=confirm-resend]").disabled'),true);
  assert.equal(await evaluate('window.visibleMessages().length'),3);
  await evaluate('document.querySelector("[data-testid=confirm-resend]").click();window.release();window.flush()');
  assert.equal(await evaluate('window.resends.length'),1);
  assert.equal(await evaluate('window.resends[0].messageId'),'9007199254740993');
  assert.equal(await evaluate('document.querySelector("[role=dialog]")'),null);
  assert.equal(await evaluate('window.visibleMessages().filter(message=>["101","102"].includes(message.turnId)).length'),0);
  assert.equal(await evaluate('document.querySelector("[data-testid=user-message-text]").textContent.trim()'),'先修复问题，再给方案，不实施方案。');
  await evaluate('window.hold=false;window.fail=true;document.querySelector("[data-testid=edit-resend]").click();window.flush()');
  await evaluate('document.querySelector("[data-testid=confirm-resend]").click();window.flush()');
  assert.equal(await evaluate('document.querySelector("[role=dialog]")!==null'),true);
  assert.match(await evaluate('document.querySelector("[role=dialog] [role=alert]").textContent'),/模拟重发失败/);
  assert.deepEqual(await evaluate('window.runtimeErrors'),[]);
  console.log('实际组件验证通过：运行/暂停/恢复、历史编辑确认/取消、真实消息 ID、失败保留、作废历史清理。');
  clearTimeout(deadline);window.destroy();app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);if(window)window.destroy();app.exit(1);});
