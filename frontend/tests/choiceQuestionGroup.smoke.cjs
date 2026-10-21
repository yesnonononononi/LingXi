const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/choice-question-group');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('选择组验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import {ref,provide} from 'vue';
import ChatMessageItem from '../../../src/components/chat/ChatMessageItem.vue';
import {ANSWER_CHOICES_KEY,DECIDE_TOOL_CALL_KEY} from '../../../src/types/toolDecision';
import {AgentToolName} from '../../../src/utils/toolNames';
import '../../../src/style.css';
const dark=ref(false),mount=ref(0);
const questions=['选择交付方式？\\n\\n可以在提交前返回修改。','选择部署环境？','选择验证方式？','还有哪些补充要求？'];
const options=[['源码','安装包'],['Windows','Linux'],['单元测试','完整回归'],[]];
const card=index=>({id:'choice-'+index,conversationId:'42',executionId:'100',type:'PROMISE',status:'pending',version:'2',allowedActions:['ANSWER'],content:{kind:'CHOICE',question:questions[index],options:options[index]}});
const message=ref({id:'answer',turnId:'43',role:'assistant',timestamp:0,content:'请确认以下四个问题。',isComplete:false,isSuspended:true,
toolCalls:Array.from({length:4},(_,index)=>({id:'choice-'+index,toolName:AgentToolName.RequireChoice,status:'pending',order:index+2,responseId:'200'})),
promptCards:Array.from({length:3},(_,index)=>card(index))});
window.submissions=[];window.singleSubmissions=[];
provide(DECIDE_TOOL_CALL_KEY,async payload=>{window.singleSubmissions.push(payload);throw new Error('不能逐卡提交');});
provide(ANSWER_CHOICES_KEY,payload=>{
  window.submissions.push(JSON.parse(JSON.stringify(payload)));
  return new Promise((resolve,reject)=>{
    window.failBatch=()=>reject(new Error('模拟网络中断，请重试'));
    window.finishBatch=()=>{for(const answer of payload.answers){const current=message.value.promptCards.find(item=>item.id===answer.toolCallId);Object.assign(current,{status:'completed',version:'3',allowedActions:[],rawOutput:{outcome:'ANSWERED',answer:answer.text}});}resolve({commandId:payload.commandId,decisionApplied:true,toolCalls:message.value.promptCards,resumeDisposition:'QUEUED'});};
  });
});
window.addLastQuestion=()=>message.value.promptCards.push(card(3));
window.remount=()=>mount.value++;
window.setDark=value=>{dark.value=value;document.documentElement.classList.toggle('dark',value);document.body.style.background=value?'#18181b':'white';};
</script><template><main style="max-width:720px;margin:24px auto;padding:0 12px" :class="dark?'text-gray-100':'text-gray-900'"><ChatMessageItem :key="mount" :message="message" session-id="42" :is-dark="dark" /></main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp,nextTick} from 'vue';
localStorage.setItem('lingxi-locale','zh-CN');window.runtimeErrors=[];
window.addEventListener('error',event=>window.runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection',event=>window.runtimeErrors.push(String(event.reason)));
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,100));};
const {default:App}=await import('./App.vue');createApp(App).mount('#app');window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile:false,root:output,base:'./',plugins:[vue()],logLevel:'error',build:{target:'esnext',outDir:path.join(output,'dist'),emptyOutDir:true} });
  window = new BrowserWindow({width:860,height:720,show:false,webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  for(let attempt=0;attempt<100;attempt++){if(await evaluate('window.ready===true'))break;await new Promise(resolve=>setTimeout(resolve,50));}
  const click = async selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click();window.flush()`);
  await evaluate('window.flush()');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=choice-question-group]").length'),1);
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-submit-all]").disabled'),true);
  for(let index=0;index<3;index++){
    await click('[data-choice-option="1"]');
    if(index<2)await click('[data-testid=choice-next]');
  }
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-submit-all]").disabled'),true,'缺少第四张卡片时不能提交');
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-dismiss]")'),null,'待答题时不得提供关闭入口，否则等于藏掉唯一的作答口');
  assert.equal(await evaluate('document.querySelector("[data-choice-option=\\"1\\"]").className.includes("bg-blue-50")'),true,'选中项必须带浅蓝高亮');
  await evaluate('window.addLastQuestion();window.flush()');
  await click('[data-testid=choice-next]');
  await click('[data-testid=choice-custom-toggle]');
  await evaluate(`(()=>{const input=document.querySelector('[data-testid=choice-custom-input]');input.value='  保留原始输入\\n以及换行  ';input.dispatchEvent(new Event('input',{bubbles:true}));})();window.flush()`);
  await click('[data-testid=choice-previous]');
  assert.equal(await evaluate('document.querySelector("[data-choice-option=\\"1\\"]").getAttribute("aria-checked")'),'true','切卡不能丢失预设答案');
  await click('[data-testid=choice-next]');
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-custom-input]").value'),'  保留原始输入\n以及换行  ');
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-submit-all]").disabled'),false);
  await fs.writeFile(path.join(output,'light.png'),(await window.webContents.capturePage()).toPNG());
  await evaluate('window.setDark(true);window.flush()');
  await fs.writeFile(path.join(output,'dark.png'),(await window.webContents.capturePage()).toPNG());
  await window.setSize(360,720);
  await evaluate('window.flush()');
  assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true,'窄屏不能横向溢出');
  await fs.writeFile(path.join(output,'narrow.png'),(await window.webContents.capturePage()).toPNG());
  await click('[data-testid=choice-submit-all]');
  assert.equal(await evaluate('window.submissions.length'),1);
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-submit-all]").disabled'),true);
  assert.equal(await evaluate('[...document.querySelectorAll("[data-choice-option]")].every(button=>button.disabled)'),true);
  const first = await evaluate('window.submissions[0]');
  assert.equal(first.responseId,'200');assert.equal(first.answers.length,4);
  assert.deepEqual(first.answers.map(answer=>answer.text),['安装包','Linux','完整回归','  保留原始输入\n以及换行  ']);
  await evaluate('window.failBatch();window.flush()');
  assert.equal(await evaluate('document.querySelector("[role=alert]").textContent.includes("模拟网络中断")'),true);
  await click('[data-testid=choice-submit-all]');
  assert.deepEqual(await evaluate('window.submissions[1]'),first,'未修改答案的重试必须沿用命令身份');
  await evaluate('window.finishBatch();window.flush()');
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-submit-all]")'),null);
  await evaluate('document.querySelector("[data-testid=choice-dismiss]").click();window.flush()');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=choice-question-group]").length'),0,'全部答完后允许整卡关闭');
  await evaluate('window.remount();window.flush()');
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-confirmed-answer]").textContent.includes("安装包")'),true,'重新挂载使用权威已答结果');
  assert.deepEqual(await evaluate('window.singleSubmissions'),[]);
  assert.deepEqual(await evaluate('window.runtimeErrors'),[]);
  console.log('选择组真实组件通过：四卡分组、缺题禁交、前后切换、答案保留、自定义原文、统一提交、重试幂等、防重复操作、历史已答回显、深浅主题和360px窄屏。');
  clearTimeout(deadline);window.destroy();app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);if(window)window.destroy();app.exit(1);});
