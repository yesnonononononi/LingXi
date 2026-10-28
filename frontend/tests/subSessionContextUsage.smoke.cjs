const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const frontendRoot = path.resolve(__dirname, '..');
// 放在工作树自身，避免共享 node_modules 时误测另一份源码。
const output = path.join(frontendRoot, '.run/sub-session-context-usage');
const specifier = relative => path.relative(output, path.join(frontendRoot, relative)).split(path.sep).join('/');
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('子会话上下文用量验证超时'); app.exit(1); }, 120000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { computed, reactive, ref, nextTick } from 'vue';
import { useChatSessionStore } from '${specifier('src/stores/chatSessionStore.ts')}';
import { StreamSessionRouter } from '${specifier('src/views/chat/streamSessionRouter.ts')}';
import { resolveContextUsageText, resolveContextRingDash } from '${specifier('src/views/chat/contextUsagePresentation.ts')}';
import SubAgentSidePanel from '${specifier('src/components/chat/SubAgentSidePanel.vue')}';
import SubSessionDetailDrawer from '${specifier('src/components/chat/SubSessionDetailDrawer.vue')}';
import ChatInputContextUsage from '${specifier('src/components/chat/ChatInputContextUsage.vue')}';
import { chatApi } from '${specifier('src/services/chat.ts')}';
import { setPreference } from '${specifier('src/i18n/index.ts')}';
import { useTheme } from '${specifier('src/composables/useTheme.ts')}';
import '${specifier('src/style.css')}';
setPreference('zh-CN'); localStorage.setItem('lingxi-sub-panel-width', '320');
const theme = useTheme(); theme.setTheme('light');
const root = reactive({ id:'7', title:'主会话', messages:[], subSessions:[
  { id:'8', rootSessionId:'7', name:'寇豆码 · 工程师', agentName:'寇豆码 · 工程师', messages:[],
    contextTokenCount:203200, contextMaxTokens:258000, contextRatio:203200/258000 },
  { id:'9', rootSessionId:'7', name:'另一位工程师', agentName:'另一位工程师', messages:[],
    contextTokenCount:32000, contextMaxTokens:128000, contextRatio:0.25 },
  { id:'10', rootSessionId:'7', name:'尚未采集的成员', messages:[] },
] });
const selectedId = ref('8');
const sub = computed(() => root.subSessions.find(item => item.id === selectedId.value));
const items = computed(() => root.subSessions.map(item => ({ id:item.id, agentName:item.name, task:item.name, status:'running', subSession:item })));
const drawerOpen = ref(false);
const store = useChatSessionStore();
const router = new StreamSessionRouter({ onContextUsageUpdate: (id, usage) => store.setContextUsage(id, usage) });
router.bindRootSession(root);
chatApi.fetchSessionMessages = async () => ({ ok:true, data:{ messages:[], records:[], turns:{}, turnViews:{}, hasMore:false, nextCursor:null } });
const reference = { usedTokens:203200, maxTokens:258000 };
window.flush = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve,220)); };
window.select = id => { selectedId.value=id; };
window.dark = value => { theme.setTheme(value ? 'dark' : 'light'); };
window.longName = () => { sub.value.name='寇豆码 · 工程师 / 很长的多语言成员名称 '.repeat(8); };
window.drawer = value => { drawerOpen.value=value; };
window.sendUsage = (id, count, max, phase='UPDATE', band) => router.dispatch({ type:'CONTEXT_UPDATE', executionId:'e-'+id,
  timestamp:'', metaData:{ rootSessionId:'7', sessionId:id, turnId:id+'00' }, phase, band,
  usage:{ tokenCount:count, maxTokens:max, ratio: max ? count/max : undefined } });
</script><template><div style="height:100vh;display:flex;min-width:0">
<main style="flex:1;min-width:0"><div data-testid="reference" style="width:28px;height:28px">
<ChatInputContextUsage :isDark="theme.isDark.value" :contextUsageText="resolveContextUsageText(reference)" :contextRingDash="resolveContextRingDash(reference)" :tooltipVisible="false" />
</div></main>
<SubAgentSidePanel :items="items" :activeSubId="selectedId" :activeSubSession="sub" :subMessages="sub.messages" :isOpen="true" :isDark="theme.isDark.value" />
<SubSessionDetailDrawer :isOpen="drawerOpen" :subSession="sub" :isDark="theme.isDark.value" />
</div></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), `import {createApp} from 'vue'; import {createPinia} from 'pinia';
import App from './App.vue';window.runtimeErrors=[];window.addEventListener('error',event=>window.runtimeErrors.push(event.message));
createApp(App).use(createPinia()).mount('#app');window.ready=true;`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({ configFile:false, root:output, base:'./', plugins:[vue()], logLevel:'error',
    resolve:{dedupe:['vue','pinia']}, build:{target:'esnext',outDir:path.join(output,'dist'),emptyOutDir:true} });
  const window = new BrowserWindow({ width:1100,height:680,show:false,
    webPreferences:{ contextIsolation:true,offscreen:true,backgroundThrottling:false } });
  window.webContents.on('console-message', event => { if (event.level >= 2) console.error(event.message); });
  await window.loadFile(path.join(output,'dist/index.html'));
  const evaluate = async source => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { throw new Error('页面断言执行失败: ' + source, { cause: error }); }
  };
  const step = source => evaluate(`(async()=>{${source};await window.flush();})()`);
  const panel = '[data-testid=sub-session-heading] [data-testid=session-context-usage]';
  const label = () => evaluate(`document.querySelector('${panel}')?.getAttribute('aria-label') ?? null`);
  const hover = async (selector = panel) => {
    await step(`document.querySelector('${selector}').dispatchEvent(new MouseEvent('mouseenter'))`);
    return evaluate(`document.querySelector('[role=tooltip]')?.textContent.trim() ?? null`);
  };
  assert.equal(await evaluate('window.ready'),true);
  assert.equal(await label(),'78.8% · 203.2K / 258.0K 上下文已使用','首次进入直接使用子会话历史快照');
  assert.equal(await hover(),await label());
  const records=[];
  for (const dark of [false,true]) {
    for (const width of [1100,360]) {
      window.setContentSize(width,680);
      await step(`window.dark(${dark})`);
      await hover();
      const geometry=await evaluate(`(()=>{
        const row=document.querySelector('[data-testid=sub-session-heading]');
        const title=row.querySelector('h3').getBoundingClientRect(); const button=row.querySelector('button').getBoundingClientRect();
        const tooltip=document.querySelector('[role=tooltip]'); const box=tooltip.getBoundingClientRect();
        const ring=row.querySelector('svg'); const reference=document.querySelector('[data-testid=reference] svg');
        const paint=svg=>({width:svg.getBoundingClientRect().width,height:svg.getBoundingClientRect().height,
          color:getComputedStyle(svg.querySelector('circle:last-child')).stroke,dash:svg.querySelector('circle:last-child').getAttribute('stroke-dasharray')});
        const ringBox=ring.getBoundingClientRect();
        return {nameRight:title.right,nameCenterY:title.top+title.height/2,ringCenterY:ringBox.top+ringBox.height/2,
          ringLeft:button.left,ringRight:button.right,rowRight:row.getBoundingClientRect().right,
          left:box.left,right:box.right,top:box.top,bottom:box.bottom,tooltipHeight:box.height,viewport:innerWidth,height:innerHeight,
          parent:tooltip.parentElement.tagName,ring:paint(ring),reference:paint(reference),pageWidth:document.documentElement.scrollWidth};
      })()`);
      assert.ok(geometry.ringLeft>=geometry.nameRight+4,'圆环必须位于名称右侧');
      assert.ok(Math.abs(geometry.ringCenterY-geometry.nameCenterY)<=0.1,
        `圆环中心线必须与名称文字居中对齐：${JSON.stringify(geometry)}`);
      assert.ok(geometry.ringRight<=geometry.rowRight+1,'圆环不能挤出标题行');
      assert.deepEqual(geometry.ring,geometry.reference,'与现有圆环的尺寸、颜色和占比一致');
      assert.ok(geometry.tooltipHeight<=32,'标准用量文案应保持现有单行样式');
      assert.equal(geometry.parent,'BODY','浮层必须越过标题裁剪容器');
      assert.ok(geometry.left>=0 && geometry.right<=width+1 && geometry.top>=0 && geometry.bottom<=680,'浮层不能被屏幕裁掉');
      assert.ok(geometry.pageWidth<=width+1,'页面不能横向溢出');
      records.push({dark,width,...geometry});
      await fs.writeFile(path.join(output,`context-${dark?'dark':'light'}-${width}.png`),(await window.webContents.capturePage()).toPNG());
      if (!dark && width===1100) await fs.writeFile(path.join(output,'preview.png'),(await window.webContents.capturePage({x:780,y:0,width:320,height:120})).toPNG());
    }
  }
  await step('window.longName()');
  await hover();
  const longName=await evaluate(`(()=>{const row=document.querySelector('[data-testid=sub-session-heading]');const name=row.querySelector('h3');const trigger=row.querySelector('button');
    return {truncated:name.scrollWidth>name.clientWidth,ringRight:trigger.getBoundingClientRect().right,rowRight:row.getBoundingClientRect().right};})()`);
  assert.equal(longName.truncated,true,'长名称应截断');
  assert.ok(longName.ringRight<=longName.rowRight+1,'长名称不能挤掉圆环');
  await step("window.sendUsage('7',90000,100000)");
  assert.match(await label(),/^78.8%/,'根会话更新不能覆盖子会话用量');
  await step("window.sendUsage('8',129000,258000)");
  assert.equal(await label(),'50.0% · 129.0K / 258.0K 上下文已使用','子会话实时事件更新名称旁的圆环');
  assert.equal(await hover(),await label());
  await step("window.sendUsage('8',129000,258000,'SQUEEZE_STARTED','SUMMARY')");
  assert.match(await label(),/压缩/);
  await step("window.sendUsage('8',64000,258000,'SQUEEZE_COMPLETED','SUMMARY')");
  assert.doesNotMatch(await label(),/压缩/);
  await step("window.select('9')");
  assert.equal(await evaluate("document.querySelectorAll('[role=tooltip]').length"),0,'切换目标时旧浮层必须关闭');
  assert.equal(await label(),'25.0% · 32.0K / 128.0K 上下文已使用');
  await step("window.select('10')");
  assert.equal(await label(),null,'未采集时不显示假 0 或沿用上一成员');
  await step("window.select('8');window.drawer(true)");
  const drawerSelector='aside.fixed [data-testid=session-context-usage]';
  assert.equal(await evaluate(`document.querySelector('${drawerSelector}').getAttribute('aria-label')`),await label(),'抽屉也按当前子会话取值');
  const drawerAlignment=await evaluate(`(()=>{
    const trigger=document.querySelector('${drawerSelector}');
    const title=trigger.previousElementSibling.getBoundingClientRect();
    const ring=trigger.querySelector('svg').getBoundingClientRect();
    return {nameCenterY:title.top+title.height/2,ringCenterY:ring.top+ring.height/2};
  })()`);
  assert.ok(Math.abs(drawerAlignment.ringCenterY-drawerAlignment.nameCenterY)<=0.1,
    `抽屉圆环中心线必须与名称文字居中对齐：${JSON.stringify(drawerAlignment)}`);
  // 离屏窗口没有系统焦点，显式派发与键盘聚焦同源的 DOM 事件。
  await step(`document.querySelector('${drawerSelector}').focus({ preventScroll: true });
    document.querySelector('${drawerSelector}').dispatchEvent(new FocusEvent('focus'))`);
  assert.equal(await evaluate("document.querySelector('[role=tooltip]')?.textContent.trim() ?? null"),await label(),'键盘聚焦也可查看完整用量');
  assert.equal(await evaluate(`Number(getComputedStyle(document.querySelector('[role=tooltip]')).zIndex) > Number(getComputedStyle(document.querySelector('aside.fixed')).zIndex)`),true,'浮层必须显示在抽屉上方');
  await step(`document.querySelector('${drawerSelector}').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  assert.equal(await evaluate("document.querySelectorAll('[role=tooltip]').length"),0);
  await step('window.drawer(false)');
  await fs.writeFile(path.join(output,'measurements.json'),JSON.stringify(records,null,2));
  assert.deepEqual(await evaluate('window.runtimeErrors'),[]);
  console.log('PASS: 名称右侧圆环、原样式复用、历史与实时用量、会话隔离、压缩状态、长名称、明暗和窄屏、浮层边界及键盘交互');
  clearTimeout(deadline);app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
