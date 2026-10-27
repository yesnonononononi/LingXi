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
const options=[['源码','安装包','Docker 镜像','离线安装包','源码 + Docker 镜像一起给','只给说明文档，不要产物'],['Windows','Linux'],['单元测试','完整回归'],[]];
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
window.reopenPartial=()=>{message.value={...message.value,promptCards:[0,1,2,3].map(index=>index<2
?{...card(index),status:'completed',version:'3',allowedActions:[],rawOutput:{outcome:'ANSWERED',answer:'已答'+index}}
:card(index))};mount.value++;};
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
  // 卡片尺寸契约：选项框高度恒定，选项超量只滚动（六选项不许把卡片撑大）
  assert.deepEqual(
    await evaluate('(()=>{const box=document.querySelector("[role=radiogroup]");return [box.clientHeight, box.scrollHeight>box.clientHeight];})()'),
    [200,true],
    '选项框必须固定 200px 且超出时内部滚动'
  );
  // 「其他补充」是选项行本身的输入：不得在行外再挂一块独立输入框
  assert.equal(
    await evaluate('document.querySelector("[data-testid=choice-custom-toggle]").contains(document.querySelector("[data-testid=choice-custom-input]"))'),
    true,
    '其他补充输入框必须在选项行内'
  );
  await click('[data-testid=choice-custom-toggle]');
  assert.equal(
    await evaluate('document.activeElement===document.querySelector("[data-testid=choice-custom-input]")'),
    true,
    '点「其他补充」整行后光标必须直接落进行内输入'
  );
  // 单选即进位：点一次选项自动跳下一题，不必再点「下一题」；最后一题不再进位
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-question]").textContent.includes("选择交付方式")'),true,'首题必须是第一问');
  await click('[data-choice-option="1"]');
  assert.equal(await evaluate('document.querySelector("[role=status]").textContent.trim()'),'2 / 4','选中后必须自动跳到下一题');
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-question]").textContent.includes("选择部署环境")'),true,'第二题必须已就位');
  await click('[data-choice-option="1"]');
  await click('[data-choice-option="1"]');
  assert.equal(await evaluate('document.querySelector("[role=status]").textContent.trim()'),'3 / 4','最后一题不该再进位（没有下一题）');
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
  // 回到首题（有选项）验证暗色契约：纯黑底 + 发光文字
  for(let index=0;index<3;index++)await click('[data-testid=choice-previous]');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-testid=choice-question-group]")).backgroundColor'),'rgb(0, 0, 0)','暗色卡片底必须是纯黑');
  assert.notEqual(await evaluate('getComputedStyle(document.querySelector("[data-testid=choice-question]")).textShadow'),'none','暗色题干必须带发光');
  assert.notEqual(await evaluate('getComputedStyle(document.querySelector("[data-choice-option] [class*=text-glow]")).textShadow'),'none','暗色选项文字必须带发光');
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
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=choice-question-group]").length'),0,'全部已决后自动收起整张卡');
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-summary-toggle]").getAttribute("aria-expanded")'),'false');
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-summary-toggle]").textContent.includes("4 个问题")'),true);
  await fs.writeFile(path.join(output,'resolved-collapsed.png'),(await window.webContents.capturePage()).toPNG());
  await click('[data-testid=choice-summary-toggle]');
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-confirmed-answer]").textContent.includes("安装包")'),true);
  await evaluate('document.querySelector("[data-testid=choice-dismiss]").click();window.flush()');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=choice-question-group]").length'),0,'关闭详情后收回摘要');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=choice-summary-toggle]").length'),1,'已决问题不能关闭后消失');
  await evaluate('window.remount();window.flush()');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=choice-question-group]").length'),0,'历史重进默认显示摘要');
  await click('[data-testid=choice-summary-toggle]');
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-confirmed-answer]").textContent.includes("安装包")'),true,'重新挂载使用权威已答结果');
  // 默认落点契约：前面已答过的题不再是落点，落点必须是第一道未答的题（曾经停在哪张全靠数组顺序）
  await evaluate('window.reopenPartial();window.flush()');
  assert.equal(await evaluate('document.querySelector("[role=status]").textContent.trim()'),'3 / 4',
    '落点必须是第一道未答的题，不能停在已答的题上，也不能一上来就跳到最后一题');
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-question]").textContent.includes("选择验证方式")'),true,
    '第三问题干必须已就位');
  // 顺序往后作答：第三题答完进第四题；第四题（无预设选项）填完不再进位
  await click('[data-choice-option="0"]');
  assert.equal(await evaluate('document.querySelector("[role=status]").textContent.trim()'),'4 / 4','答完第三题必须进到第四题');
  await click('[data-testid=choice-custom-toggle]');
  await evaluate(`(()=>{const input=document.querySelector('[data-testid=choice-custom-input]');input.value='补充说明';input.dispatchEvent(new Event('input',{bubbles:true}));})();window.flush()`);
  assert.equal(await evaluate('document.querySelector("[role=status]").textContent.trim()'),'4 / 4','末题填完不位移、不回绕');
  assert.equal(await evaluate('document.querySelector("[data-testid=choice-submit-all]").disabled'),false,'四题都有答案后必须可提交');
  assert.deepEqual(await evaluate('window.singleSubmissions'),[]);
  assert.deepEqual(await evaluate('window.runtimeErrors'),[]);
  console.log('选择组真实组件通过：四卡分组、选中即进位、缺题禁交、前后切换、答案保留、自定义原文、统一提交、重试幂等、防重复操作、全部已决自动收敛、历史摘要与答案回看、深浅主题和360px窄屏。');
  clearTimeout(deadline);window.destroy();app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);if(window)window.destroy();app.exit(1);});
