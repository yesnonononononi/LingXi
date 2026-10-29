const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/plan-preview');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('计划书预览验证超时'); app.exit(1); }, 120000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  const content = '## 设计与验证\n\n完整阅读计划，再决定是否执行。\n\n'
    + '| 常量 | 路径 | 生命周期 | 是否入仓 |\n| --- | --- | --- | --- |\n'
    + '| ARTIFACT_ROOT | `<repo>/.lingxi/tmp/visual` | 可再生运行时产物 | 否 |\n\n'
    + '```sh\nnpm run build\n```\n\n'
    + Array.from({ length: 30 }, (_, index) => `### 步骤 ${index + 1}\n\n验证执行结果并记录关键依据。\n\n`).join('')
    + '计划末尾校验标记';
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref, provide } from 'vue';
import PlanCard from '../../../src/components/chat/PlanCard.vue';
import { DECIDE_TOOL_CALL_KEY } from '../../../src/types/toolDecision';
import { setPreference } from '../../../src/i18n';
import '../../../src/style.css';
const dark = ref(false);
const card = ref({kind:'PLAN',toolCallId:'plan-1',conversationId:'42',title:'交付计划与产物管理',content:${JSON.stringify(content)},pending:true,status:'pending',version:'7',allowedActions:['APPROVE','REJECT']});
window.decisions = [];
provide(DECIDE_TOOL_CALL_KEY, async payload => window.decisions.push(payload));
window.setDark = value => { dark.value = value; document.documentElement.classList.toggle('dark', value); };
window.completePlan = () => Object.assign(card.value, {pending:false,status:'completed',outcome:'APPROVED',allowedActions:[]});
window.emptyPlan = () => { card.value.content = ''; };
window.updatePlan = () => { card.value.content += '\\n\\n权威正文已更新'; };
window.setEnglish = () => setPreference('en-US');
</script>
<template><main style="max-width:720px;max-height:640px;overflow:hidden;margin:20px auto;transform:translateZ(0)"><PlanCard :prompt-card="card" :is-dark="dark" /></main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp,nextTick} from 'vue';
localStorage.setItem('lingxi-locale','zh-CN');
window.runtimeErrors=[];
window.addEventListener('error', event => window.runtimeErrors.push(event.message));
window.addEventListener('unhandledrejection', event => window.runtimeErrors.push(String(event.reason)));
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,80));};
const {default:App}=await import('./App.vue');createApp(App).mount('#app');window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const mutation = process.argv.find(argument => argument.startsWith('--mutation='))?.split('=')[1];
  const mutationPlugin = {
    name:'plan-preview-mutation', enforce:'pre',
    transform(source, id) {
      if (mutation === 'disable-open' && id.endsWith('/PlanCard.vue')) {
        assert.ok(source.includes('@click="isPreviewOpen = true"'));
        return source.replace('@click="isPreviewOpen = true"','@click="isPreviewOpen = false"');
      }
      if (mutation === 'constrain-size' && id.endsWith('/PlanPreviewModal.vue')) {
        assert.ok(source.includes('h-[90dvh]'));
        return source.replace('h-[90dvh]','h-[420px]').replace('max-w-6xl','max-w-sm');
      }
    },
  };
  await build({ configFile:false,root:output,base:'./',plugins:[mutationPlugin,vue()],logLevel:'error',build:{target:'esnext',outDir:path.join(output,'dist'),emptyOutDir:true} });
  const window = new BrowserWindow({width:1280,height:900,show:false,webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate('window.ready===true')) break;
    await new Promise(resolve => setTimeout(resolve,50));
  }
  const run = async source => { await evaluate(source); await evaluate('window.flush()'); };
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const open = async () => {
    await run('document.querySelector("[data-testid=plan-preview-open]").focus()');
    await click('[data-testid=plan-preview-open]');
    assert.equal(await evaluate('!!document.querySelector("[role=dialog]")'),true,'点击预览必须打开独立阅读框');
  };
  const assertClosed = async () => {
    assert.equal(await evaluate('document.querySelector("[role=dialog]")===null'),true);
    assert.equal(await evaluate('document.activeElement===document.querySelector("[data-testid=plan-preview-open]")'),true,'关闭后焦点返回预览入口');
  };
  await evaluate('window.flush()');
  await open();
  assert.equal(await evaluate('document.querySelector("[role=dialog]").getAttribute("aria-label")'),'计划书预览');
  assert.equal(await evaluate('document.activeElement===document.querySelector("[data-testid=plan-preview-close]")'),true);
  assert.equal(await evaluate('document.querySelector("[role=dialog] h2").textContent'),'交付计划与产物管理');
  assert.equal(await evaluate('!!document.querySelector("[data-testid=plan-preview-content] table") && !!document.querySelector("[data-testid=plan-preview-content] pre")'),true,'表格和代码块必须保留 Markdown 排版');
  assert.equal(await evaluate('document.querySelector("[data-testid=plan-preview-content]").textContent.includes("计划末尾校验标记")'),true,'长文不能截断');
  assert.equal(await evaluate(`(() => {
    const panel=document.querySelector('[role=dialog]'), body=document.querySelector('[data-testid=plan-preview-content]');
    const bounds=panel.getBoundingClientRect(), viewport=body.getBoundingClientRect();
    return bounds.width>1000 && bounds.height>700 && bounds.top>=0 && bounds.bottom<=innerHeight
      && viewport.bottom<=bounds.bottom && body.scrollHeight>body.clientHeight && getComputedStyle(body).overflowY==='auto'
      && !document.querySelector('main').contains(panel);
  })()`),true,'预览须突破卡片裁剪，使用大尺寸且正文独立滚动');
  await run('document.querySelector("[data-testid=plan-preview-close]").dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",shiftKey:true,bubbles:true,cancelable:true}))');
  assert.equal(await evaluate('document.activeElement===document.querySelector("[data-testid=plan-preview-content] .copy-code-btn")'),true,'反向 Tab 应循环到正文内最后一个操作');
  await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}))');
  assert.equal(await evaluate('document.activeElement===document.querySelector("[data-testid=plan-preview-close]")'),true,'Tab 不应落入背景审批按钮');
  await fs.writeFile(path.join(output,'light.png'),(await window.webContents.capturePage()).toPNG());
  await run('window.updatePlan()');
  assert.equal(await evaluate('document.querySelector("[data-testid=plan-preview-content]").textContent.includes("权威正文已更新")'),true);
  await click('[data-testid=plan-preview-close]');
  await assertClosed();
  await open();
  await run('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))');
  await assertClosed();
  await open();
  await run('document.querySelector("[role=dialog]").parentElement.click()');
  await assertClosed();
  assert.deepEqual(await evaluate('window.decisions'),[],'打开或关闭预览不能提交审批');
  await run('window.completePlan();window.setDark(true)');
  await open();
  assert.equal(await evaluate(`(() => {
    const context=document.createElement('canvas').getContext('2d');
    context.fillStyle=getComputedStyle(document.querySelector('[role=dialog]')).backgroundColor;
    context.fillRect(0,0,1,1);
    return [...context.getImageData(0,0,1,1).data].slice(0,3).every(channel=>channel<40);
  })()`),true,'已审批计划也可在深色主题下预览');
  await fs.writeFile(path.join(output,'dark.png'),(await window.webContents.capturePage()).toPNG());
  window.setSize(430,740);
  await evaluate('window.flush()');
  assert.equal(await evaluate(`(() => {
    const panel=document.querySelector('[role=dialog]').getBoundingClientRect();
    const close=document.querySelector('[data-testid=plan-preview-close]').getBoundingClientRect();
    return panel.left>=0 && panel.right<=innerWidth && panel.top>=0 && panel.bottom<=innerHeight && close.right<=innerWidth;
  })()`),true,'窄屏预览与关闭按钮不能溢出视口');
  await fs.writeFile(path.join(output,'narrow.png'),(await window.webContents.capturePage()).toPNG());
  await run('window.setEnglish()');
  assert.equal(await evaluate('document.querySelector("[role=dialog]").getAttribute("aria-label")'),'Plan preview');
  await click('[data-testid=plan-preview-close]');
  await run('window.emptyPlan()');
  assert.equal(await evaluate('document.querySelector("[data-testid=plan-preview-open]")===null'),true,'空正文不提供空预览入口');
  assert.deepEqual(await evaluate('window.runtimeErrors'),[]);
  console.log('计划书预览验证通过：完整正文、布局、关闭、焦点、主题、窄屏、状态与语言');
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
