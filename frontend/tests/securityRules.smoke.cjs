const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
const output = path.resolve(__dirname, '../node_modules/.tmp/security-rules');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('安全中心验证超时'); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import SettingsModal from '../../../src/views/settings/SettingsModal.vue';
import { SecurityRulesAPI } from '../../../src/services/securityRules';
import { useTheme } from '../../../src/composables/useTheme';
import '../../../src/style.css';
const file = {pattern:'%USERPROFILE%/.ssh', matchType:'PATH', read:'DENY', write:'DENY', delete:'DENY', action:null, enabled:true, preset:'.ssh'};
const terminal = {pattern:'reg', matchType:'PROGRAM', read:null, write:null, delete:null, action:'DENY', enabled:true, preset:'reg'};
const backend = {
 files:{activation:'NATIVE_NEXT_WORKSPACE',category:'files',revision:'4',rules:[file],supportedActions:['ALLOW','DENY'],defaultAction:'ALLOW'},
 terminal:{activation:'IMMEDIATE',category:'terminal',revision:'2',rules:[terminal],supportedActions:['ALLOW','ASK','DENY'],defaultAction:'ASK'},
 net:{activation:'OUTBOUND_OPEN',category:'net',revision:'0',rules:[{pattern:'**',matchType:'ANY',action:'ALLOW',enabled:true,preset:'default-allow'}],supportedActions:['ALLOW'],defaultAction:'ALLOW'}
};
window.fixture = { fail:false, saves:[], backend };
SecurityRulesAPI.current = async category => ({code:1,data:structuredClone(backend[category])});
SecurityRulesAPI.defaults = async category => ({code:1,data:structuredClone(category === 'files' ? [file] : [terminal])});
SecurityRulesAPI.save = async (category,revision,rules) => {
 window.fixture.saves.push({category,revision,rules:structuredClone(rules.map(r=>({...r})))});
 if(window.fixture.fail) throw new Error('fixture failure');
 backend[category] = {...backend[category],revision:String(BigInt(revision)+1n),rules:rules.map(r=>({...r}))};
 return {code:1,data:structuredClone(backend[category])};
};
const {setTheme} = useTheme(); window.setDark = value => setTheme(value ? 'dark' : 'light');
setTheme('light');
</script><template><SettingsModal initial-tab="security" /></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp} from 'vue';import {createPinia} from 'pinia';import App from './App.vue';createApp(App).use(createPinia()).mount('#app');window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const {build} = await import('vite'); const {default:vue} = await import('@vitejs/plugin-vue');
  await build({configFile:false,root:output,base:'./',plugins:[vue()],logLevel:'error',build:{target:'esnext',outDir:path.join(output,'dist'),emptyOutDir:true}});
  window = new BrowserWindow({width:1000,height:800,show:false,webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  const failures=[]; window.webContents.on('console-message', details => { if(details.level==='error') failures.push(details.message); });
  await window.loadFile(path.join(output,'dist/index.html'));
  const evaluate = source => window.webContents.executeJavaScript(source);
  const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const click = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); };
  await settle();
  await fs.writeFile(path.join(output,'initial.png'),(await window.webContents.capturePage()).toPNG());
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=security-rule]").length'),1);
  assert.equal(await evaluate('[...document.querySelectorAll("[data-testid=security-rule] select option")].some(o=>o.value==="ASK")'),false);
  await evaluate('const input=document.querySelector("[data-testid=security-pattern]");input.value="D:/private/"+"very-long-path-".repeat(10);input.dispatchEvent(new Event("input",{bubbles:true}))');
  await click('[data-testid=security-add]');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=security-rule]").length'),2);
  await click('[data-testid=security-tab-terminal]');
  assert.equal(await evaluate('[...document.querySelectorAll("[data-testid=security-rule] select option")].some(o=>o.value==="ASK")'),true);
  await click('[data-testid=security-tab-files]');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=security-rule]").length'),2,'切页保留未保存草稿');
  await evaluate('const select=document.querySelector("[data-testid=security-rule] select");select.value="ALLOW";select.dispatchEvent(new Event("change",{bubbles:true}))');
  await settle();
  await evaluate('window.fixture.fail=true'); await click('[data-testid=security-save]');
  assert.ok(await evaluate('!!document.querySelector("[data-testid=security-error]")'));
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=security-rule]").length'),2);
  assert.equal(await evaluate('window.fixture.saves[0].revision'),'4');
  assert.equal(await evaluate('JSON.stringify([window.fixture.saves[0].rules[0].read,window.fixture.saves[0].rules[0].write,window.fixture.saves[0].rules[0].delete])'),'["ALLOW","ALLOW","ALLOW"]','原生访问动作必须统一保存读写删除');
  await evaluate('window.fixture.fail=false'); await click('[data-testid=security-save]');
  assert.equal(await evaluate('window.fixture.backend.files.revision'),'5');
  assert.equal(await evaluate('document.querySelector("[data-testid=security-save]").disabled'),true);
  await click('[data-testid=security-reset]');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=security-rule]").length'),1);
  assert.equal(await evaluate('window.fixture.backend.files.rules.length'),2,'恢复默认只生成草稿');
  for(const [name,width,dark] of [['light',1000,false],['dark',1000,true],['compact',400,false]]) {
    window.setContentSize(width,800);await evaluate(`window.setDark(${dark})`);await settle();
    const bounds=await evaluate('({width:document.documentElement.scrollWidth,viewport:innerWidth,center:document.querySelector("[data-testid=security-center]").getBoundingClientRect().width})');
    assert.ok(bounds.width<=bounds.viewport+1,JSON.stringify(bounds));assert.ok(bounds.center>200);
    await fs.writeFile(path.join(output,name+'.png'),(await window.webContents.capturePage()).toPNG());
  }
  await click('[data-testid=security-tab-net]');
  assert.ok(await evaluate('document.querySelector("[data-testid=security-net-allow]").textContent.includes("MCP") || document.querySelector("[data-testid=security-center]").textContent.includes("MCP")'));
  assert.equal(await evaluate('document.querySelector("[data-testid=security-add]")'),null);
  assert.equal(await evaluate('document.querySelector("[data-testid=security-save]")'),null);
  assert.deepEqual(failures,[],'浏览器控制台没有渲染错误');
  console.log('安全中心真实设置弹窗：预设、自定义、草稿保留、保存失败、版本、重置、网络说明、深浅色和窄屏通过。截图：'+output);
  clearTimeout(deadline);window.destroy();app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);if(window)window.destroy();app.exit(1)});
