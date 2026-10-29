const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const fixture = path.resolve(__dirname, '../node_modules/.tmp/provider-model-import');
const output = path.resolve(__dirname, '../../.lingxi/provider-model-import');
app.setPath('userData', path.join(fixture, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => app.exit(1), 90000);

app.whenReady().then(async () => {
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(fixture, 'App.vue'), `<script setup>
import {ref} from 'vue';
import {RouterView} from 'vue-router';
import ModelsTab from '../../../src/views/settings/tabs/ModelsTab.vue';
import SettingsModal from '../../../src/views/settings/SettingsModal.vue';
import {useTheme} from '../../../src/composables/useTheme';
import '../../../src/style.css';
const dark=ref(false), modal=ref(false), standalone=ref(false);
window.showStandalone=()=>{standalone.value=true;};
const {setTheme}=useTheme(); setTheme('light');
window.setDark=value=>{dark.value=value;setTheme(value?'dark':'light');};
window.showModal=()=>modal.value=true;
</script><template>
<RouterView v-if="standalone"/><div v-else-if="modal"><SettingsModal initial-tab="models"/></div>
<main v-else class="font-sans" :style="{width:'640px',maxWidth:'calc(100vw - 32px)',margin:'28px auto',padding:'28px',border:'1px solid '+(dark?'#303035':'#e4e4e7'),borderRadius:'20px',background:dark?'#050505':'white'}">
<div style="font-size:11px;color:#71717a;margin-bottom:20px;letter-spacing:.3px">设置 / 模型 · 界面预览（示例数据）</div>
<ModelsTab :is-dark="dark"/></main></template>`);
  await fs.writeFile(path.join(fixture, 'entry.js'), `import {createApp,nextTick} from 'vue';
import {createRouter,createMemoryHistory} from 'vue-router';
import ModelFormView from '../../../src/views/model/ModelFormView.vue';
import http from '../../../src/services/interceptor';
import {setPreference} from '../../../src/i18n';
setPreference('zh-CN');window.setLanguage=setPreference;
window.errors=[];window.requests=[];window.providers=[];window.models=[];
window.addEventListener('error',e=>window.errors.push(e.message));
window.addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));
http.defaults.adapter=async config=>{
 const payload=typeof config.data==='string'?JSON.parse(config.data):config.data;
 window.requests.push({url:config.url,payload});let data={code:1};
 if(config.url==='/provider/list') data.data=window.providers;
 else if(config.url==='/model/catalog') data.data=window.providers.map(p=>({providerConfigId:p.id,providerName:p.name,providerIcon:p.icon,baseUrl:p.baseUrl,modelCount:window.models.length,models:window.models}));
 else if(config.url.startsWith('/model/find/')) data.data=window.singleModel;
 else if(['/model/add','/model/update'].includes(config.url)) window.singleModel={id:'9007199254740995',...payload,credentialConfigured:true};
 else if(config.url==='/provider/add') {
   window.providers=[{...payload,id:'9007199254740993',apiKey:'***',credentialConfigured:true}];
   data.data='9007199254740993';
 } else if(config.url==='/provider/update') window.providers=window.providers.map(p=>({...p,...payload,apiKey:'***'}));
 else if(config.url==='/provider/models/discover') {
   if(window.failDiscovery) data={code:0,errMsg:'模拟不支持列表接口'};
   else data.data=['chat-standard','chat-reasoning','vision-chat','code-assistant','chat-standard-preview'].map(id=>({id}));
 } else if(config.url==='/model/batch/add') {
   if(window.failBatch) throw new Error('模拟写入失败');
   const skippedNames=payload.modelNames.filter(name=>window.models.some(m=>m.modelName===name));
   const added=payload.modelNames.filter(name=>!skippedNames.includes(name));
   window.models.push(...added.map((modelName,i)=>({id:'9007199254741'+(window.models.length+i),modelName,baseUrl:window.providers[0].baseUrl,providerConfigId:payload.providerConfigId,vision:payload.vision,credentialConfigured:true})));
   data.data={addedCount:added.length,skippedNames};
 }
 return {config,status:200,statusText:'OK',headers:{},data};
};
const router=createRouter({history:createMemoryHistory(),routes:[{path:'/models',component:{template:'<div>models</div>'}},{path:'/models/add',component:ModelFormView},{path:'/models/:id',component:ModelFormView}]});
await router.push('/models');window.go=async route=>{window.showStandalone();await router.push(route);};
const {default:App}=await import('./App.vue');createApp(App).use(router).mount('#app');
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,100));};
window.clickText=label=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);if(!button)throw new Error('button missing: '+label);if(button.disabled)throw new Error('button disabled: '+label);button.click();};
window.fill=(selector,value)=>{const input=document.querySelector(selector);if(!input)throw new Error('input missing: '+selector);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
window.ready=true;`);
  await fs.writeFile(path.join(fixture, 'index.html'), '<html><head><meta charset="utf-8"><title>模型提供商 · 批量添加预览</title></head><body style="margin:0;background:#f4f4f5"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: fixture, base: './', plugins: [vue()], logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(fixture, 'dist'), emptyOutDir: true } });
  window = new BrowserWindow({ width: 760, height: 1050, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => { if (event.level === 'error') console.log('[renderer]', event.message); });
  await window.loadFile(path.join(fixture, 'dist/index.html'));
  const evaluate = async source => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { throw new Error('Renderer evaluation failed: ' + source, { cause: error }); }
  };
  const run = async source => { await evaluate(source); await evaluate('window.flush()'); };
  const capture = async name => {
    const bounds = await evaluate(`(()=>{const element=document.querySelector('main');if(!element)return undefined;const r=element.getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-14),y:Math.max(0,Math.floor(r.y)-14),width:Math.ceil(r.width)+28,height:Math.ceil(r.height)+28};})()`);
    await fs.writeFile(path.join(output, name), (await window.webContents.capturePage(bounds)).toPNG());
  };
  for (let i = 0; i < 100 && !await evaluate('window.ready===true'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  await run(`window.clickText('添加提供方')`);
  await run(`window.fill('[data-testid=provider-name]','自定义中转');window.fill('#provider-base-url','https://api.example.com/v1');window.fill('[data-testid=provider-api-key]','test-only-secret')`);
  await capture('01-provider-connection.png');
  await run(`window.clickText('保存并添加模型')`);
  assert.equal(await evaluate(`!!document.querySelector('[data-testid=batch-models]')`), true);
  assert.equal(await evaluate(`window.requests.find(r=>r.url==='/provider/add').payload.baseUrl`), 'https://api.example.com/v1');
  assert.equal(await evaluate(`document.querySelector('[data-testid=model-vision]').checked`), false);
  await run(`window.clickText('获取模型列表')`);
  assert.deepEqual(await evaluate(`window.requests.find(r=>r.url==='/provider/models/discover').payload`), { providerConfigId: '9007199254740993' });
  await run(`window.clickText('全选当前结果')`);
  await capture('02-select-models.png');
  await run(`window.setDark(true)`);
  await capture('03-select-models-dark.png');
  await run(`window.clickText('添加 5 个模型')`);
  assert.equal(await evaluate(`window.requests.at(-3).url`), '/model/batch/add');
  const firstBatch = await evaluate(`window.requests.find(r=>r.url==='/model/batch/add').payload`);
  assert.equal(firstBatch.providerConfigId, '9007199254740993');
  assert.equal(firstBatch.modelNames.length, 5);
  assert.equal(firstBatch.vision, false);
  assert.equal(await evaluate(`document.querySelector('[role=status]').textContent.includes('已添加 5')`), true);
  await run(`window.clickText('继续添加')`);
  await run(`window.failDiscovery=true;window.clickText('重新获取')`);
  assert.equal(await evaluate(`document.querySelector('[role=alert]').textContent.includes('暂时无法获取')`), true);
  await capture('04-discovery-failure.png');
  await run(`window.clickText('手动输入 →')`);
  await run(`window.fill('textarea',['manual-model-a','manual-model-b,manual-model-a，chat-standard'].join(String.fromCharCode(10)))`);
  assert.equal(await evaluate(`document.querySelector('textarea').value.includes('manual-model-a')`), true);
  await run(`window.setDark(false)`);
  await capture('05-manual-models.png');
  await run(`window.failBatch=true;window.clickText('添加 2 个模型')`);
  assert.equal(await evaluate(`document.querySelector('textarea').value.includes('manual-model-b')`), true);
  assert.equal(await evaluate(`document.querySelector('[role=alert]').textContent.includes('批量添加失败')`), true);
  await run(`window.failBatch=false;document.querySelector('[data-testid=model-vision]').click();window.clickText('添加 2 个模型')`);
  const lastBatch = await evaluate(`window.requests.filter(r=>r.url==='/model/batch/add').at(-1).payload`);
  assert.deepEqual(lastBatch.modelNames, ['manual-model-a', 'manual-model-b', 'chat-standard']);
  assert.equal(lastBatch.vision, true);
  await run(`window.clickText('返回列表')`);
  await run(`window.clickText('批量添加模型')`);
  await run(`window.failDiscovery=false;window.clickText('获取模型列表')`);
  assert.equal(await evaluate(`document.querySelectorAll('.import-list input:disabled').length`), 5);
  await run(`window.clickText('手动输入')`);
  await run(`window.fill('textarea',Array.from({length:201},(_,i)=>'model-'+i).join(String.fromCharCode(10)))`);
  assert.equal(await evaluate(`document.querySelector('.import-actions .primary').disabled`), true);
  await run(`window.setLanguage('en-US')`);
  assert.equal(await evaluate(`document.querySelector('h4').textContent`), 'Add models in bulk');
  await run(`window.setLanguage('zh-CN');window.fill('textarea','long-name-test');window.showModal()`);
  await run(`window.clickText('批量添加模型')`);
  await run(`window.clickText('获取模型列表')`);
  await capture('06-settings-modal.png');
  await run(`window.clickText('返回列表')`);
  await run(`window.clickText('添加模型')`);
  assert.equal(await evaluate(`document.querySelector('[data-testid=model-use-provider]').checked`), true);
  await run(`window.clickText('获取模型列表')`);
  assert.equal(await evaluate(`window.requests.filter(r=>r.url==='/provider/models/discover').at(-1).payload.providerConfigId`), '9007199254740993');
  window.setSize(420, 850);
  await run(`window.flush()`);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  await run(`window.go('/models/add')`);
  assert.equal(await evaluate(`document.querySelector('[data-testid=model-use-provider]').checked`), true);
  assert.equal(await evaluate(`document.querySelector('input[autocomplete=off]').disabled`), true);
  await run(`const select=document.querySelector('[data-testid=model-provider]');select.value='9007199254740993';select.dispatchEvent(new Event('change',{bubbles:true}));window.fill('input:not([type=checkbox])','single-model')`);
  await run(`window.clickText('获取模型列表')`);
  assert.equal(await evaluate(`window.requests.filter(r=>r.url==='/provider/models/discover').at(-1).payload.providerConfigId`), '9007199254740993');
  await run(`window.clickText('确认新增')`);
  const singleAdd=await evaluate(`window.requests.filter(r=>r.url==='/model/add').at(-1).payload`);
  assert.equal(singleAdd.useProvider, true);
  assert.equal(singleAdd.providerConfigId, '9007199254740993');
  assert.equal(Object.hasOwn(singleAdd,'apiKey'), false);
  await run(`new Promise(resolve=>setTimeout(resolve,700))`);
  await run(`window.go('/models/9007199254740995')`);
  assert.equal(await evaluate(`document.querySelector('[data-testid=model-use-provider]').checked`), true);
  await run(`document.querySelector('[data-testid=model-use-provider]').click();window.fill('input[autocomplete=off]','own-key');window.clickText('保存修改')`);
  const singleEdit=await evaluate(`window.requests.filter(r=>r.url==='/model/update').at(-1).payload`);
  assert.equal(singleEdit.useProvider, false);
  assert.equal(singleEdit.apiKey, 'own-key');
  assert.deepEqual(await evaluate('window.errors'), []);
  console.log('PASS: provider Base URL, authoritative ID, server discovery, remote/manual batches, deduplication, failure recovery, explicit vision, 200 limit, locale, narrow viewport, provider credential defaults and explicit independent-key edits.');
  console.log(output);
  clearTimeout(deadline); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); if (window) window.destroy(); app.exit(1); });
