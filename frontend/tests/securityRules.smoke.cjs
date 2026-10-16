const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
const output = path.resolve(__dirname, '../node_modules/.tmp/security-rules');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('安全中心验证超时'); app.exit(1); }, 180000);
app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import SettingsModal from '../../../src/views/settings/SettingsModal.vue';
import { SecurityRulesAPI } from '../../../src/services/securityRules';
import { SandboxAPI } from '../../../src/services/sandbox';
import { UserConfigAPI } from '../../../src/services/userConfig';
import { useTheme } from '../../../src/composables/useTheme';
import '../../../src/style.css';
const file = {pattern:'%USERPROFILE%/.ssh', matchType:'PATH', read:'DENY', write:'DENY', delete:'DENY', action:null, enabled:true, preset:'.ssh'};
const terminal = {pattern:'reg', matchType:'PROGRAM', read:null, write:null, delete:null, action:'DENY', enabled:true, preset:'reg'};
const backend = {
 files:{activation:'NATIVE_NEXT_WORKSPACE',category:'files',revision:'4',rules:[file],supportedActions:['ALLOW','DENY'],defaultAction:'ALLOW'},
 terminal:{activation:'IMMEDIATE',category:'terminal',revision:'2',rules:[terminal],supportedActions:['ALLOW','ASK','DENY'],defaultAction:'ASK'},
 net:{activation:'OUTBOUND_OPEN',category:'net',revision:'0',rules:[{pattern:'**',matchType:'ANY',action:'ALLOW',enabled:true,preset:'default-allow'}],supportedActions:['ALLOW'],defaultAction:'ALLOW'}
};
window.fixture = { fail:false, saves:[], patches:[], checks:0, backend };
SecurityRulesAPI.current = async category => ({code:1,data:structuredClone(backend[category])});
SecurityRulesAPI.defaults = async category => ({code:1,data:structuredClone(category === 'files' ? [file] : [terminal])});
SecurityRulesAPI.save = async (category,revision,rules) => {
 window.fixture.saves.push({category,revision,rules:structuredClone(rules.map(r=>({...r})))});
 if(window.fixture.fail) throw new Error('fixture failure');
 backend[category] = {...backend[category],revision:String(BigInt(revision)+1n),rules:rules.map(r=>({...r}))};
 return {code:1,data:structuredClone(backend[category])};
};
// 沙箱级设置会打真实接口：不桩掉的话失败请求会在控制台留下 error，污染「零控制台错误」断言
SandboxAPI.status = async () => ({code:1,data:{configured:true,ready:true,backend:'windows',message:'沙箱基础能力可用'}});
SandboxAPI.check = async () => { window.fixture.checks += 1; return {code:1,data:{configured:true,ready:true,backend:'windows',message:'沙箱基础能力检查通过'}}; };
UserConfigAPI.current = async () => ({code:1,data:{type:'sandbox',accessMode:'IN_WORKSPACE',commandApprovalPolicy:'DANGEROUS_BLOCK',renderTheme:'LIGHT',modelId:'m-1',planMaxReminders:3}});
UserConfigAPI.updateCurrent = async payload => { window.fixture.patches.push(structuredClone(payload)); return {code:1,data:null}; };
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
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ruleCount = () => evaluate('document.querySelectorAll("[data-testid=security-rule]").length');
  const textOf = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  // 下拉选项按 data-value（动作码）读，而不是读本地化文案
  const dropdownOptions = () => evaluate('[...document.querySelectorAll(".settings-select-option")].map(o=>o.getAttribute("data-value"))');
  await settle();

  await fs.writeFile(path.join(output,'01-list.png'),(await window.webContents.capturePage()).toPNG());
  // 首层是策略清单：沙箱总开关 + 三条入口，规则编辑器不在这里
  assert.equal(await ruleCount(),0,'清单页不应出现规则行');
  assert.equal(await evaluate('document.querySelectorAll("[data-testid^=security-tab-]").length'),3);
  assert.equal(await textOf('[data-testid=security-sandbox-state]'),'已启用');
  assert.ok(await evaluate('document.querySelector("[data-testid=security-center]").textContent.includes("沙箱基础能力可用")'),'沙箱服务状态应随沙箱设置一起迁入');
  assert.ok(await evaluate('document.querySelector("[data-testid=security-center]").textContent.includes("按优先级控制文件路径")'),'入口行应有说明');
  await click('.sec-info');
  assert.ok(await evaluate('document.querySelector("[data-testid=security-center]").textContent.includes("保护范围与限制")'));

  // 总开关落库：key 用 store 字段名 envType，请求体才用后端字段名 type
  await click('[data-testid=security-sandbox-toggle]');
  assert.deepEqual(await evaluate('window.fixture.patches[0]'),{type:'local'},'关闭沙箱应提交 type=local');
  assert.equal(await textOf('[data-testid=security-sandbox-state]'),'已关闭');
  await click('[data-testid=security-sandbox-toggle]');
  assert.deepEqual(await evaluate('window.fixture.patches[1]'),{type:'sandbox'});
  await click('[data-testid=security-check-service]');
  assert.equal(await evaluate('window.fixture.checks'),1);
  assert.ok(await evaluate('document.querySelector("[data-testid=security-center]").textContent.includes("沙箱基础能力检查通过")'));

  // 进第二层：文件安全的规则编辑器
  await click('[data-testid=security-tab-files]');
  assert.equal(await ruleCount(),1);
  assert.ok(await evaluate('!!document.querySelector("[data-testid=security-back]")'),'详情页应有返回');
  assert.ok(await evaluate('!!document.querySelector("[data-testid=security-access-mode]")'),'工作空间权限应从通用页搬进文件安全');
  // 文件表只有允许/禁止：打开下拉按动作码断言，绝不出现 ASK
  await click('[data-testid=security-access]');
  assert.deepEqual(await dropdownOptions(),['ALLOW','DENY']);
  await click('[data-testid=security-access]');
  await evaluate('(()=>{const field=document.querySelector("[data-testid=security-pattern]");field.value="D:/private/"+"very-long-path-".repeat(10);field.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
  await click('[data-testid=security-add]');
  assert.equal(await ruleCount(),2);
  assert.ok(await evaluate('document.querySelector("[data-testid=security-rule]").className.includes("sec-flash")'),'新增行应有入列高亮');
  await fs.writeFile(path.join(output,'02-detail-draft.png'),(await window.webContents.capturePage()).toPNG());

  // 未保存的草稿必须跨导航保留：带着 2 条草稿离开再回来
  await click('[data-testid=security-back]');
  assert.equal(await ruleCount(),0,'返回应回到清单');
  await click('[data-testid=security-tab-terminal]');
  assert.ok(await evaluate('!!document.querySelector("[data-testid=security-command-policy]")'),'工具权限应从通用页搬进命令安全');
  assert.ok(await evaluate('!!document.querySelector("[data-testid=security-match-type]")'),'终端应有匹配方式下拉');
  await click('[data-testid=security-action]');
  assert.ok((await dropdownOptions()).includes('ASK'),'命令表必须提供询问');
  await click('[data-testid=security-action]');
  await click('[data-testid=security-back]');
  await click('[data-testid=security-tab-files]');
  assert.equal(await ruleCount(),2,'切页保留未保存草稿');

  // 选允许：文件表读写删必须统一
  await click('[data-testid=security-access]');
  await click('.settings-select-option[data-value="ALLOW"]');
  assert.equal(await textOf('[data-testid=security-access]'),'允许');
  assert.equal(await evaluate('document.querySelector("[data-testid=security-save]").disabled'),false);
  await evaluate('window.fixture.fail=true'); await click('[data-testid=security-save]');
  assert.ok(await evaluate('!!document.querySelector("[data-testid=security-error]")'));
  assert.equal(await ruleCount(),2);
  assert.equal(await evaluate('window.fixture.saves[0].revision'),'4');
  assert.equal(await evaluate('JSON.stringify([window.fixture.saves[0].rules[0].read,window.fixture.saves[0].rules[0].write,window.fixture.saves[0].rules[0].delete])'),'["ALLOW","ALLOW","ALLOW"]','原生访问动作必须统一保存读写删除');
  await evaluate('window.fixture.fail=false'); await click('[data-testid=security-save]');
  assert.equal(await evaluate('window.fixture.backend.files.revision'),'5');
  assert.equal(await evaluate('document.querySelector("[data-testid=security-save]").disabled'),true);
  // 恢复默认只生成草稿：后端版本号与规则条数都不许动
  const revisionBeforeReset = await evaluate('window.fixture.backend.files.revision');
  await click('[data-testid=security-reset]');
  assert.equal(await ruleCount(),1);
  assert.equal(await evaluate('window.fixture.backend.files.revision'),revisionBeforeReset,'恢复默认不应写后端');
  assert.equal(await evaluate('window.fixture.backend.files.rules.length'),2);

  // 深浅色与窄屏：两档都不许横向溢出
  for(const [name,width,dark] of [['light',1000,false],['dark',1000,true],['compact',400,false],['compact-dark',400,true]]) {
    // DOM 帧完成不代表离屏窗口已完成缩放，立即截图会触发 UnknownVizError。
    window.setContentSize(width,800);await evaluate(`window.setDark(${dark})`);await settle();await wait(300);
    assert.equal(await evaluate('innerWidth'),width,'截图前渲染视口必须完成尺寸切换');
    const bounds=await evaluate('({width:document.documentElement.scrollWidth,viewport:innerWidth,center:document.querySelector("[data-testid=security-center]").getBoundingClientRect().width})');
    assert.ok(bounds.width<=bounds.viewport+1,JSON.stringify(bounds));assert.ok(bounds.center>200,JSON.stringify(bounds));
    await fs.writeFile(path.join(output,name+'.png'),(await window.webContents.capturePage()).toPNG());
  }
  // 滚动时保存条必须仍粘在底部（入场动画若留下 transform 残影，sticky 会立刻失效）
  for(let index=0;index<5;index+=1){await evaluate(`(()=>{const field=document.querySelector("[data-testid=security-pattern]");field.value="D:/pad-${index}/";field.dispatchEvent(new Event("input",{bubbles:true}));return true;})()`);await click('[data-testid=security-add]');}
  const pinned=await evaluate(`(()=>{const scroller=document.querySelector(".overflow-y-auto");scroller.scrollTop=Math.round((scroller.scrollHeight-scroller.clientHeight)/2);const bar=document.querySelector("[data-testid=security-save]").parentElement;const sr=scroller.getBoundingClientRect();const br=bar.getBoundingClientRect();const rows=document.querySelectorAll("[data-testid=security-rule]");return {gap:Math.round(sr.bottom-br.bottom),scrollable:scroller.scrollHeight>scroller.clientHeight,transform:getComputedStyle(rows[rows.length-1]).transform};})()`);
  assert.ok(pinned.scrollable,'内容应已超出一屏');assert.ok(Math.abs(pinned.gap)<=10,'保存条未粘底: '+JSON.stringify(pinned));
  assert.equal(pinned.transform,'none','入场动画不应在规则行上留下 transform 残影');
  await fs.writeFile(path.join(output,'03-scrolled.png'),(await window.webContents.capturePage()).toPNG());

  // 网络页：只读说明，没有编辑器
  await click('[data-testid=security-back]');
  await click('[data-testid=security-tab-net]');
  assert.ok(await evaluate('document.querySelector("[data-testid=security-net-allow]").textContent.includes("MCP") || document.querySelector("[data-testid=security-center]").textContent.includes("MCP")'));
  assert.equal(await evaluate('document.querySelector("[data-testid=security-add]")'),null);
  assert.equal(await evaluate('document.querySelector("[data-testid=security-save]")'),null);
  await fs.writeFile(path.join(output,'04-net.png'),(await window.webContents.capturePage()).toPNG());

  // 通用页交出了沙箱设置：搬走了，不是丢了
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("通用设置")).click()');
  await settle(); await wait(300);
  const general=await evaluate('document.body.textContent');
  for(const gone of ['执行环境','沙箱服务','工作空间权限','工具权限']) assert.ok(!general.includes(gone),'通用页不应再出现 '+gone);
  for(const kept of ['主题','语言','后端服务地址']) assert.ok(general.includes(kept),'通用页应保留 '+kept);
  await fs.writeFile(path.join(output,'05-general.png'),(await window.webContents.capturePage()).toPNG());

  assert.deepEqual(failures,[],'浏览器控制台没有渲染错误');
  console.log('安全中心：两级导航、总开关落库、沙箱设置迁入、下拉按动作码、草稿保留、保存失败、版本、重置、深浅色与窄屏、粘底、通用页交权全部通过。截图：'+output);
  clearTimeout(deadline);window.destroy();app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);if(window)window.destroy();app.exit(1)});
