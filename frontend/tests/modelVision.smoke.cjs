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
import ModelFormView from '../../../src/views/model/ModelFormView.vue';
import http from '../../../src/services/interceptor';
import {setPreference} from '../../../src/i18n';
setPreference('zh-CN');
window.errors=[];window.writes=[];window.models=[];
window.addEventListener('error',e=>window.errors.push(e.message));
window.addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));
http.defaults.adapter=async config=>{
 const payload=typeof config.data==='string'?JSON.parse(config.data):config.data;
 let data={code:1};
 if(config.url.startsWith('/model/list')) data.data={records:window.models};
 else if(config.url.startsWith('/model/find/')) {
  const selected={...window.models[0]};
  if(window.holdDetails) await new Promise(resolve=>window.releaseDetails=resolve);
  data.data=selected;
 }
 else if(['/model/add','/model/update'].includes(config.url)){
  window.writes.push({url:config.url,payload});
  window.models=[{id:'9007199254740993',...payload,apiKey:'***',credentialConfigured:true}];
 }
 return {config,status:200,statusText:'OK',headers:{},data};
};
const router=createRouter({history:createMemoryHistory(),routes:[{path:'/models',component:{template:'<div>models</div>'}},{path:'/models/add',component:ModelFormView},{path:'/models/:id',component:ModelFormView}]});
await router.push('/models');
window.go=async route=>{window.setMode('route');await router.push(route);};
const {default:App}=await import('./App.vue');createApp(App).use(router).mount('#app');
window.flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,70));};
window.clickText=label=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);if(!button)throw new Error('button missing: '+label);button.click();};
window.fill=values=>{const inputs=[...document.querySelectorAll('input')].filter(i=>i.type!=='checkbox');values.forEach((value,index)=>{inputs[index].value=value;inputs[index].dispatchEvent(new Event('input',{bubbles:true}));});};
window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile: false, root: output, base: './', plugins: [vue()], logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true } });
  window = new BrowserWindow({ width: 1000, height: 950, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadFile(path.join(output, 'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  for (let i = 0; i < 100 && !await evaluate('window.ready===true'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  await evaluate(`window.flush();window.clickText('添加自定义提供方');window.flush()`);
  assert.equal(await evaluate(`document.querySelector('[data-testid=model-vision]').checked`), false);
  assert.match(await evaluate(`document.querySelector('[role=note]').textContent`), /整轮执行失败/);
  await evaluate(`window.fill(['arbitrary-model','https://example.invalid','key']);document.querySelector('[data-testid=model-vision]').click();window.flush()`);
  await fs.writeFile(path.join(output, 'vision-light.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(`window.clickText('保存');window.flush()`);
  assert.equal(await evaluate('window.writes.at(-1).payload.vision'), true);
  await evaluate(`window.clickText('编辑');window.flush()`);
  assert.equal(await evaluate(`document.querySelector('[data-testid=model-vision]').checked`), true);
  await evaluate(`window.setDark(true);window.flush()`);
  await fs.writeFile(path.join(output, 'vision-dark.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('[data-testid=model-vision]').click();window.clickText('保存');window.flush()`);
  assert.equal(await evaluate('window.writes.at(-1).payload.vision'), false);
  assert.equal(await evaluate('window.writes.at(-1).payload.id'), '9007199254740993');
  await evaluate(`window.clickText('添加提供方');window.flush()`);
  assert.equal(await evaluate(`document.querySelector('[data-testid=model-vision]').checked`), false);
  await evaluate(`window.go('/models/9007199254740993');window.flush()`);
  assert.equal(await evaluate(`document.querySelector('[data-testid=model-vision]').checked`), false);
  await evaluate(`document.querySelector('[data-testid=model-vision]').click();window.clickText('保存修改');window.flush()`);
  assert.equal(await evaluate('window.writes.at(-1).payload.vision'), true);
  await evaluate(`window.setMode('settings');window.flush()`);
  await evaluate(`window.go('/models/add');window.flush()`);
  assert.equal(await evaluate(`document.querySelector('[data-testid=model-vision]').checked`), false);
  await evaluate(`window.fill(['another-custom-model','https://example.invalid','key']);document.querySelector('[data-testid=model-vision]').click();window.clickText('确认新增');window.flush()`);
  assert.equal(await evaluate('window.writes.at(-1).url'), '/model/add');
  assert.equal(await evaluate('window.writes.at(-1).payload.vision'), true);
  await evaluate(`new Promise(resolve=>setTimeout(resolve,700))`);
  await evaluate(`window.holdDetails=true;window.go('/models/9007199254740993');window.flush()`);
  await evaluate(`window.go('/models/add');window.flush()`);
  await evaluate(`window.holdDetails=false;window.releaseDetails();window.flush()`);
  assert.equal(await evaluate(`document.querySelector('[data-testid=model-vision]').checked`), false);
  assert.equal(await evaluate(`document.querySelector('input:not([type=checkbox])').value`), '');
  assert.deepEqual(await evaluate('window.errors'), []);
  console.log('PASS: settings/custom/preset/edit/standalone, explicit true/false payloads, snowflake ID, warning and light/dark previews.');
  console.log(output);
  clearTimeout(deadline); window.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); if (window) window.destroy(); app.exit(1); });
