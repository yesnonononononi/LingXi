const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const output = path.resolve(__dirname, '../node_modules/.tmp/model-vision');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => app.exit(1), 90000);
app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref } from 'vue';
import { RouterView } from 'vue-router';
import ModelsTab from '../../../src/views/settings/tabs/ModelsTab.vue';
import '../../../src/style.css';
const mode=ref('settings'), dark=ref(false);
window.setMode=value=>mode.value=value;
window.setDark=value=>dark.value=value;
</script><template><main :style="{maxWidth:'680px',margin:'32px auto',padding:'24px',background:dark?'#111':'white'}">
<ModelsTab v-if="mode==='settings'" :is-dark="dark"/><RouterView v-else/></main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp,nextTick} from 'vue';
import {createRouter,createMemoryHistory} from 'vue-router';
import {createPinia} from 'pinia';
import ModelFormView from '../../../src/views/model/ModelFormView.vue';
import http from '../../../src/services/interceptor';
import {setPreference} from '../../../src/i18n';
setPreference('zh-CN');
// 会话级权威模型：id 走雪花号，验证不会被 Number() 改号。
const snowflake='9007199254740993', providerId='9007199254740991';
window.errors=[];window.writes=[];window.providerWrites=[];
window.models=[{id:snowflake,modelName:'existing-model',baseUrl:'https://example.invalid/v1',
  apiKey:'***',credentialConfigured:true,vision:false,useProvider:true,provider:'',providerConfigId:providerId}];
window.providers=[{id:providerId,name:'自建中转',baseUrl:'https://example.invalid/v1',icon:null,apiKey:'***'}];
window.addEventListener('error',e=>window.errors.push(e.message));
window.addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));
http.defaults.adapter=async config=>{
 const payload=typeof config.data==='string'?JSON.parse(config.data):config.data;
 let data={code:1};
 if(config.url.startsWith('/model/catalog')) data.data=[{providerConfigId:providerId,providerName:'自建中转',providerIcon:null,
   modelCount:window.models.length,models:window.models.slice()}];
 else if(config.url.startsWith('/provider/list')) data.data=window.providers;
 else if(config.url.startsWith('/model/find/')) {
  const selected={...window.models[0]};
  if(window.holdDetails) await new Promise(resolve=>window.releaseDetails=resolve);
  data.data=selected;
 }
 else if(['/model/add','/model/update'].includes(config.url)){
  window.writes.push({url:config.url,payload});
  window.models=[{...window.models[0],...payload,id:snowflake,apiKey:'***',credentialConfigured:true}];
 }
 else if(config.url==='/provider/add'){
  window.providerWrites.push(payload);
  window.providers=[...window.providers,{id:'9007199254740995',...payload,apiKey:'***'}];
  data.data='9007199254740995';
 }
 else if(config.url.startsWith('/provider/models/discover')) data.data=[];
 else if(config.url.includes('/limits')) data.data={maxImages:3};
 return {config,status:200,statusText:'OK',headers:{},data};
};
const router=createRouter({history:createMemoryHistory(),routes:[{path:'/models',component:{template:'<div>models</div>'}},{path:'/models/add',component:ModelFormView},{path:'/models/:id',component:ModelFormView}]});
await router.push('/models');
window.go=async route=>{window.setMode('route');await router.push(route);};
const {default:App}=await import('./App.vue');createApp(App).use(createPinia()).use(router).mount('#app');
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,90));};
window.clickText=label=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);if(!button)throw new Error('button missing: '+label+' 现有按钮: '+[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).join(' | '));button.click();};
// 表单里能填的只有文本输入：下拉（LxSelect）是按钮，不进这个列表。
window.fill=values=>{const inputs=[...document.querySelectorAll('input')].filter(i=>i.type!=='checkbox');values.forEach((value,index)=>{if(!inputs[index])throw new Error('input missing: '+index);inputs[index].value=value;inputs[index].dispatchEvent(new Event('input',{bubbles:true}));});};
window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  window = new BrowserWindow({ width: 1000, height: 950, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadFile(path.join(output, 'dist/index.html'));
  // executeJavaScript 抛错时 Electron 只给一句「Script failed to execute」，
  // 把渲染进程的异常原文带回来，否则失败原因全靠猜。
  const evaluate = async source => {
    const result = await window.webContents.executeJavaScript(
      `(async()=>{try{return {ok:await eval(${JSON.stringify(source)})};}catch(e){return {err:String((e&&e.stack)||e)};}})()`);
    if (result.err) throw new Error(`渲染进程脚本失败: ${result.err}\n脚本: ${source}`);
    return result.ok;
  };
  for (let i = 0; i < 100 && !await evaluate('window.ready===true'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  // 识图开关在「高级选项」details 里：查不到时把面板正文带出来，别只丢一句 null。
  const visionChecked = async () => {
    const state = await evaluate(`(()=>{const box=document.querySelector('[data-testid=model-vision]');return box?{checked:box.checked}:{missing:document.body.textContent.replace(/\\s+/g,' ').slice(0,300)};})()`);
    if (state.missing !== undefined) throw new Error('识图开关不存在，当前面板: ' + state.missing);
    return state.checked;
  };

  await evaluate('window.flush()');

  // 1. 列表页「添加模型」进表单：默认关闭识图，并给出后果说明
  await evaluate(`window.clickText('添加模型');window.flush()`);
  assert.equal(await visionChecked(), false);
  assert.match(await evaluate(`document.querySelector('[role=note]').textContent`), /整轮执行失败/);
  await evaluate(`window.fill(['arbitrary-model','https://example.invalid/v1','key']);document.querySelector('[data-testid=model-vision]').click();window.flush()`);
  await fs.writeFile(path.join(output, 'vision-light.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(`window.clickText('保存');window.flush()`);
  assert.equal(await evaluate('window.writes.at(-1).payload.vision'), true);
  assert.equal(await evaluate('window.writes.at(-1).url'), '/model/add');

  // 2. 编辑回填：识图开关跟着后端值，雪花 ID 原样回传。
  // 走模型行的编辑按钮（分组头的「编辑」改的是提供商连接，两回事）。
  await evaluate(`document.querySelector('[data-testid=model-edit-9007199254740993]').click();window.flush()`);
  assert.equal(await visionChecked(), true);
  await evaluate(`window.setDark(true);window.flush()`);
  await fs.writeFile(path.join(output, 'vision-dark.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('[data-testid=model-vision]').click();window.clickText('保存');window.flush()`);
  assert.equal(await evaluate('window.writes.at(-1).payload.vision'), false);
  assert.equal(await evaluate('window.writes.at(-1).payload.id'), '9007199254740993');

  // 3. 再次新增：表单复用不得串入上一条的能力声明
  await evaluate(`window.clickText('添加模型');window.flush()`);
  assert.equal(await visionChecked(), false);
  await evaluate(`window.clickText('取消');window.flush()`);

  // 4. 提供商表单是连接配置，不该出现模型能力字段
  await evaluate(`window.clickText('添加提供方');window.flush()`);
  assert.equal(await evaluate(`document.querySelector('[data-testid=model-vision]')`), null);
  await evaluate(`(()=>{
    const set=(selector,value)=>{const input=document.querySelector(selector);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
    set('[data-testid=provider-name]','中转二');
    set('#provider-base-url','https://example.invalid/v2');
    set('[data-testid=provider-api-key]','provider-key');
  })()`);
  await evaluate(`window.clickText('保存并添加模型');window.flush()`);
  assert.equal(await evaluate('window.providerWrites.at(-1).name'), '中转二');
  assert.equal(await evaluate('window.providerWrites.at(-1).baseUrl'), 'https://example.invalid/v2');
  // 保存提供商后进入「批量添加模型」（新增提供方的下一步），用返回箭头回清单
  await evaluate(`document.querySelector('[data-testid=batch-models] .import-back').click();window.flush()`);

  // 5. 独立路由表单：新增默认关闭识图，提交携带显式 true
  await evaluate(`window.go('/models/add');window.flush()`);
  assert.equal(await visionChecked(), false);
  // 独立表单默认「复用提供方密钥」，未选提供方时校验不通过：这里改成模型自带密钥
  await evaluate(`window.fill(['another-custom-model','https://example.invalid/v1','key']);document.querySelector('[data-testid=model-use-provider]').click();document.querySelector('[data-testid=model-vision]').click();window.clickText('确认新增');window.flush()`);
  assert.equal(await evaluate('window.writes.at(-1).url'), '/model/add');
  assert.equal(await evaluate('window.writes.at(-1).payload.vision'), true);

  // 6. 路由复用：详情响应晚到时不得覆盖用户刚打开的新增表单
  await evaluate(`window.holdDetails=true;window.go('/models/9007199254740993');window.flush()`);
  await evaluate(`window.go('/models/add');window.flush()`);
  await evaluate(`window.holdDetails=false;window.releaseDetails();window.flush()`);
  assert.equal(await visionChecked(), false);
  assert.equal(await evaluate(`document.querySelector('input:not([type=checkbox])').value`), '');
  assert.deepEqual(await evaluate('window.errors'), []);
  console.log('PASS: settings/自定义/提供商表单/独立路由新增与编辑，显式 true/false 载荷、雪花 ID、警告与深浅色预览。');
  console.log(output);
  clearTimeout(deadline); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); if (window) window.destroy(); app.exit(1); });
