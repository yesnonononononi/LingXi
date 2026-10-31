const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {app, BrowserWindow} = require('electron');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'node_modules/.tmp/await-model-response');
const mutation = process.env.LX_AWAIT_MODEL_MUTATION || '';
app.setPath('userData', path.join(output, `profile-${mutation || 'normal'}`));
app.on('window-all-closed', () => {});
let window;
let server;
const deadline = setTimeout(() => { console.error('等待占位验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  const component = await fs.readFile(path.join(root, 'src/components/chat/ChatProcessSegment.vue'), 'utf8');
  const script = component.match(/<script setup[^>]*>([\s\S]*?)<\/script>/)[1];
  const deferred = /\b(?:setTimeout|setInterval|requestAnimationFrame|watch|onMounted|onUnmounted)\s*\(/;
  assert.ok(deferred.test('setTimeout(() => {}, 800)'), '扫描器须命中正对照');
  assert.doesNotMatch(script, deferred, '展示延迟不得引入调度回调');
  await fs.mkdir(output, {recursive: true});
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import {reactive, computed, nextTick} from 'vue';
import ChatProcessSegment from '../../../src/components/chat/ChatProcessSegment.vue';
import {setPreference} from '../../../src/i18n';
import {useTheme} from '../../../src/composables/useTheme';
import '../../../src/style.css';
setPreference('zh-CN');
const {setTheme} = useTheme();
const state = reactive({sessionId:'11', messageId:'100', turnId:'10', segmentId:'segment',
  awaitModel:false, isDark:false, open:true, mounted:true, title:'执行命令', previewKind:'value', status:'', preview:'当前消息甲的内容'});
const message = computed(() => ({id:state.messageId, turnId:state.turnId, role:'assistant',
  timestamp:0, content:'', isThinking:true, isComplete:false, toolCalls:[]}));
const view = computed(() => ({kind:'segment', mode:'live', sweep:true,
  segment:{id:state.segmentId, items:[], detailItems:[], closed:false},
  summary:{toolNames:[], targets:[], runningCount:0, pendingCount:0, unknownCount:0},
  headline:{title:state.title, preview:state.preview, previewKind:state.previewKind, status:state.status}}));
window.patch = async patch => { Object.assign(state,patch); setTheme(state.isDark?'dark':'light'); await nextTick(); };
window.ready = true;
</script><template><main class="max-w-lx-chat mx-auto p-8"><div v-show="state.open">
<ChatProcessSegment v-if="state.mounted" :view="view" :message="message" :await-model="state.awaitModel"
  :is-dark="state.isDark" :session-id="state.sessionId" :visible="state.open" :sweep="view.sweep" />
</div></main></template>`);
  await fs.writeFile(path.join(output, 'entry.js'), "import {createApp} from 'vue';import App from './App.vue';createApp(App).mount('#app');");
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><meta charset="utf-8"><div id="app"></div><script type="module" src="./entry.js"></script></html>');
  const {createServer} = await import('vite');
  const {default: vue} = await import('@vitejs/plugin-vue');
  let mutationApplied = false;
  server = await createServer({configFile:false, root, cacheDir:path.join(output,`vite-${mutation || 'normal'}`), logLevel:'error', plugins:[{
    name:'await-model-mutations', enforce:'pre',
    async transform(source, id) {
      const file = id.replaceAll('\\', '/').split('?')[0];
      // CSS 的 @import 由 PostCSS 读取，必须在入口替换，才能真正注入变异。
      if (file.endsWith('/src/style.css') && ['delay','overlap'].includes(mutation)) {
        const imported = '@import "./styles/process-headline.css";';
        assert.ok(source.includes(imported));
        let styles = await fs.readFile(path.join(root,'src/styles/process-headline.css'),'utf8');
        if (mutation === 'delay') {
          assert.ok(styles.includes('--lx-await-model-delay: 800ms;'));
          styles = styles.replace('--lx-await-model-delay: 800ms;', '--lx-await-model-delay: 0ms;');
        }
        if (mutation === 'overlap') {
          const anchor = 'animation: lx-process-summary-yield 0s var(--lx-await-model-delay) forwards;';
          assert.ok(styles.includes(anchor));
          styles = styles.replace(anchor, 'animation: none;');
        }
        mutationApplied = true;
        return source.replace(imported,'')+'\n'+styles;
      }
      if (file.endsWith('/src/components/chat/ChatProcessSegment.vue') && mutation === 'identity') {
        const anchor = ':key="JSON.stringify([sessionId, message.id, message.turnId, segment.id])"';
        assert.ok(source.includes(anchor));
        mutationApplied = true;
        return source.replace(anchor, '');
      }
      if (file.endsWith('/src/components/chat/ChatProcessSegment.vue') && mutation === 'parent-sweep') {
        const binding = ':class="{ \'lx-sweep-text\': sweep }"';
        const anchor = 'data-testid="process-segment-headline">';
        assert.ok(source.includes(binding) && source.includes(anchor));
        mutationApplied = true;
        return source.replace(binding,'').replace(anchor,`data-testid="process-segment-headline" ${binding}>`);
      }
    },
  },vue()], server:{host:'127.0.0.1',port:0}});
  await server.listen();
  window = new BrowserWindow({show:false,width:1000,height:360,
    webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  const errors = [];
  window.webContents.on('console-message', event => {if (event.level === 'error') errors.push(event.message);});
  await window.loadURL(server.resolvedUrls.local[0]+'node_modules/.tmp/await-model-response/index.html');
  const evaluate = source => window.webContents.executeJavaScript(source);
  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
  const end = Date.now()+30000;
  while (!await evaluate('window.ready === true')) {
    assert.ok(Date.now()<end,'组件页面未就绪');
    await sleep(50);
  }
  await evaluate('console.error("lx-await-console-canary")');
  assert.equal(errors.filter(message => message === 'lx-await-console-canary').length,1,'控制台采集器须命中正对照');
  errors.splice(errors.indexOf('lx-await-console-canary'),1);
  if (mutation) assert.equal(mutationApplied,true,'变异未实际注入，自检无效');
  const patch = value => evaluate(`window.patch(${JSON.stringify(value)})`);
  const query = '[data-testid=process-segment-await]';
  const visibility = () => evaluate(`getComputedStyle(document.querySelector('${query}')).visibility`);
  const seek = time => evaluate(`(() => {
    for (const el of document.querySelectorAll('.lx-process-summary,.lx-process-waiting')) {
      for (const animation of el.getAnimations()) { animation.pause(); animation.currentTime=${time}; }
    }
  })()`);
  const paint = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const select = name => `[data-testid=process-segment-${name}]`;
  const measure = name => evaluate(`(() => {
    const el=document.querySelector(${JSON.stringify(select(name))});
    if(!el)return null;
    const rect=el.getBoundingClientRect();
    return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,scrollWidth:el.scrollWidth};
  })()`);
  const capture = async rect => (await window.webContents.capturePage({x:Math.floor(rect.x),y:Math.floor(rect.y),
    width:Math.max(1,Math.ceil(rect.width)),height:Math.max(1,Math.ceil(rect.height))})).toBitmap();
  const hide = (name,value) => evaluate(`document.querySelector(${JSON.stringify(select(name))}).style.visibility=${JSON.stringify(value)}`);
  const freezeSweep = () => evaluate('document.querySelectorAll(".lx-sweep-text").forEach(el=>el.getAnimations().forEach(animation=>{animation.pause();animation.currentTime=900;}))');

  // 正对照：故意让预览子节点盖住标题，证明截图差分确实能检出覆盖。
  await freezeSweep();
  const canaryRect = await measure('title');
  await evaluate(`(() => {
    const probe=document.createElement('span');probe.dataset.paintProbe='true';
    Object.assign(probe.style,{position:'fixed',left:'${canaryRect.x}px',top:'${canaryRect.y}px',
      width:'${canaryRect.width}px',height:'${canaryRect.height}px',background:'red',zIndex:'999'});
    document.querySelector('[data-testid=process-segment-preview]').append(probe);
  })()`);
  await paint();const covered = await capture(canaryRect);
  await hide('preview','hidden');await paint();
  assert.equal(covered.equals(await capture(canaryRect)),false,'像素扫描须命中故意覆盖的正对照');
  await evaluate('document.querySelector("[data-paint-probe]").remove()');
  await hide('preview','');

  const thought = '所以不唤醒是对的——根本就不该挂起，或者已经挂起的话……若根已挂起（isActive=false）→ accept 直接 QUEUED 派发，不走 pendingWakes。';
  const layouts = [
    {name:'empty-thought',title:'思考',previewKind:'none',preview:'',status:''},
    {name:'short-thought',title:'思考',previewKind:'text',preview:'正在核对配置',status:''},
    {name:'long-thought',title:'思考',previewKind:'text',preview:thought.repeat(6).slice(-320),status:''},
    {name:'tool-value',title:'执行命令',previewKind:'value',preview:'mcp.json',status:''},
    {name:'long-tool-value',title:'执行命令',previewKind:'value',preview:'长文件路径'.repeat(70)+'.json',status:''},
    {name:'long-title-status',title:'很长的远端工具显示名称'.repeat(20),previewKind:'value',preview:'ApplicationContextAssemblyTest.java',status:'1 项状态未知'},
  ];
  for(const width of [1000,360]) {
    window.setContentSize(width,360);
    for(const isDark of [false,true]) {
      for(const layout of layouts) {
        await patch({...layout,isDark});await freezeSweep();await paint();
        const title=await measure('title'),preview=await measure('preview'),status=await measure('status');
        const label=`${layout.name}, width=${width}, dark=${isDark}`;
        assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'摘要不能撑宽页面: '+label);
        assert.ok((await measure('toggle')).height<=28,'摘要必须保持单行: '+label);
        if(layout.title.length<6)assert.ok(title.width>=title.scrollWidth,'短标题不能被挤掉: '+label);
        if(preview) {
          assert.ok(preview.x>=title.right+7,'预览与标题必须保留间距: '+label);
          const titlePixels=await capture(title),previewPixels=await capture(preview);
          const statusPixels=status?await capture(status):null;
          await hide('preview','hidden');await paint();
          assert.ok(titlePixels.equals(await capture(title)),'预览不得绘制到标题区域: '+label);
          if(status)assert.ok(statusPixels.equals(await capture(status)),'预览不得覆盖状态计数: '+label);
          await hide('preview','');await hide('title','hidden');await paint();
          assert.ok(previewPixels.equals(await capture(preview)),'截断的标题不得绘制到预览区域: '+label);
          await hide('title','');await paint();
        }
        if(layout.name==='long-thought') {
          await fs.writeFile(path.join(output,`thought-${width}-${isDark?'dark':'light'}.png`),(await window.webContents.capturePage()).toPNG());
        }
      }
    }
  }
  window.setContentSize(1000,360);
  await patch({title:'执行命令',previewKind:'value',preview:'当前消息甲的内容',status:'',isDark:false});
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Accessibility.enable');
  const accessibleWait = async () => {
    const {nodes} = await window.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
    return nodes.some(node => !node.ignored && node.role?.value === 'StaticText' && node.name?.value === '正在等待模型响应');
  };
  await evaluate('window.savedTitle=document.querySelector("[data-testid=process-segment-title]");window.savedHeadline=document.querySelector("[data-testid=process-segment-headline]");window.savedSweep=window.savedTitle.getAnimations()[0];window.savedHeight=document.querySelector("button").getBoundingClientRect().height');

  // 多次短等待不累计，也不能让已取消的窗口在之后冒出来。
  for (let index=0;index<3;index++) {
    await patch({awaitModel:true});
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".lx-process-headline")).getPropertyValue("--lx-await-model-delay").trim()'),
      mutation === 'delay' ? '0ms' : '800ms','变异不得改变预期外的等待阈值');
    await seek(120);
    assert.equal(await visibility(),'hidden','短空窗不得显示等待');
    assert.equal(await accessibleWait(),false,'延迟中的等待不能进入可访问性树');
    await patch({awaitModel:false});
    assert.equal(await evaluate(`document.querySelector('${query}') === null`),true);
  }
  await sleep(900);
  assert.equal(await evaluate(`document.querySelector('${query}') === null`),true,'旧等待窗口不能复活');

  for (const isDark of [false,true]) {
    await patch({awaitModel:true,isDark});
    const delays = await evaluate('[...document.querySelectorAll(".lx-process-summary,.lx-process-waiting")].flatMap(el=>el.getAnimations().map(animation=>animation.effect.getTiming().delay))');
    assert.ok(delays.length>0,'必须创建延迟显示动画');
    assert.ok(delays.every(delay => delay===800),'摘要与占位必须在同一延迟后交接');
    await seek(799);
    assert.equal(await visibility(),'hidden');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".lx-process-summary")).visibility'),'visible');
    await seek(800);
    assert.equal(await visibility(),'visible');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".lx-process-summary")).visibility'),'hidden','长等待必须替代摘要而非并列');
    await seek(920);
    assert.equal(await accessibleWait(),true,'正对照：已显示的等待须进入可访问性树');
    const {nodes} = await window.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
    const buttonNames = nodes.filter(node => !node.ignored && node.role?.value === 'button').map(node => node.name?.value?.trim());
    assert.deepEqual(buttonNames,['执行过程'],'按钮只描述展开对象，不缓存动态摘要');
    assert.equal(await evaluate('document.querySelector("[data-testid=process-segment-title]")===window.savedTitle'),true);
    assert.equal(await evaluate('document.querySelector("[data-testid=process-segment-headline]")===window.savedHeadline'),true);
    assert.equal(await evaluate('window.savedTitle.getAnimations()[0]===window.savedSweep'),true,'切换文案不能重启标题扫光');
    assert.equal(await evaluate('document.querySelector("button").getBoundingClientRect().height===window.savedHeight'),true,'占位不得撑高原行');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-testid=process-segment-await] .lx-sweep-text")).animationName'),
      'lx-sweep-text-shift','延迟显隐不能覆盖等待文字的扫光动画');
    assert.equal(await evaluate('[...document.querySelectorAll(".lx-sweep-text")].filter(el => getComputedStyle(el).visibility === "visible").length'),1,
      '同一回答只允许一处可见扫光');
    assert.match(await evaluate('document.body.innerText'),/正在等待模型响应/);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await fs.writeFile(path.join(output,isDark?'dark.png':'light.png'),(await window.webContents.capturePage()).toPNG());
    await patch({awaitModel:false});
  }

  await patch({awaitModel:true});await seek(920);
  await evaluate('document.querySelector("[data-testid=process-segment-toggle]").click()');
  await patch({open:false});await sleep(50);await patch({open:true});
  assert.equal(await visibility(),'hidden','重新展开从头过滤短等待');
  assert.equal(await evaluate('document.querySelector("button").getAttribute("aria-expanded")'),'true','整轮折叠不丢段的展开选择');
  await seek(920);assert.equal(await visibility(),'visible');

  for (const change of [{messageId:'101',preview:'当前消息乙的内容'},{sessionId:'12'},{turnId:'20'},{segmentId:'new-segment'}]) {
    await evaluate('window.previousHeadline=document.querySelector("[data-testid=process-segment-headline]")');
    await patch(change);
    assert.equal(await visibility(),'hidden','新身份不能继承旧等待进度');
    assert.equal(await evaluate('document.querySelector("[data-testid=process-segment-headline]")!==window.previousHeadline'),true);
    assert.equal(await evaluate('document.body.textContent.includes("当前消息甲的内容")'),false,'切换消息必须移除旧摘要');
    await seek(920);
  }
  // 无障碍偏好只去掉运动，延迟仍然生效。
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await patch({awaitModel:false});await patch({awaitModel:true});
  assert.equal(await visibility(),'hidden');
  const reduced = await evaluate('document.querySelector(".lx-process-waiting").getAnimations()[0].effect.getTiming()');
  assert.equal(reduced.delay,800);assert.equal(reduced.duration,0);
  await seek(800);assert.equal(await visibility(),'visible');
  await patch({mounted:false});await sleep(900);
  assert.equal(await evaluate('document.querySelectorAll("[data-testid=process-segment]").length'),0,'卸载后不能恢复旧消息');
  assert.deepEqual(errors,[]);
  console.log('等待占位真实组件验证通过：短等待过滤、800 ms 边界、即时撤销、节点与扫光复用、折叠重入、身份隔离、深浅主题、可访问性树及减少动态效果。');
  clearTimeout(deadline);window.destroy();await server.close();app.exit(0);
}).catch(async error => {
  console.error(error);clearTimeout(deadline);
  if(window)window.destroy();if(server)await server.close();app.exit(1);
});
