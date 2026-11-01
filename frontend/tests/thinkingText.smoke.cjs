const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {app, BrowserWindow} = require('electron');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'node_modules/.tmp/thinking-text');
const mutation = process.env.LX_THINKING_TEXT_MUTATION || '';
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let browser;
let server;
const deadline = setTimeout(() => { console.error('思考文字调度验证超时'); app.exit(1); }, 100000);

app.whenReady().then(async () => {
  await fs.mkdir(output, {recursive: true});
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import {computed, ref, nextTick} from 'vue';
import MarkdownRenderer from '../../../src/components/chat/MarkdownRenderer.vue';
import ThoughtStepRenderer from '../../../src/components/chat/process/ThoughtStepRenderer.vue';
import {useStreamStickyScroll} from '../../../src/composables/useStreamStickyScroll';
import '../../../src/theme/tokens.css';
import '../../../src/styles/markdown.css';
import '../../../src/styles/stream-animation.css';
const source = ref(''); const running = ref(true); const thinking = ref(true); const visible = ref(true);
const version = ref(0); const scrollScene = ref(false);
const scroll = useStreamStickyScroll({streamSignature: () => source.value, boxIds: () => ['thought-live']});
const item = computed(() => ({id:'thought-live',type:'thought',step:{id:'thought-live',title:'思考',content:source.value,status:running.value?'running':'success'}}));
window.setContent = async (text, live = true) => { source.value = text; running.value = live; await nextTick(); };
window.remount = async (text = '', live = true, thought = true, withScroll = false) => { source.value = text; running.value = live; thinking.value = thought; scrollScene.value = withScroll; visible.value = true; version.value++; await nextTick(); };
window.unmount = async () => { visible.value = false; await nextTick(); };
window.getSource = () => source.value;
window.follows = () => scroll.isFollowing('thought-live');
window.copied = ''; Object.defineProperty(navigator,'clipboard',{value:{writeText:async text => { window.copied = text; }}});
</script><template><main style="max-width:700px;margin:24px auto;font:14px/1.9 sans-serif">
<div id="live"><MarkdownRenderer v-if="visible" :key="version" :content="source" :streaming="running" :thinking-text="thinking" /></div>
<div id="thought"><ThoughtStepRenderer v-if="visible && scrollScene" :key="version" :item="item" :is-dark="false" :is-running-turn="running" :is-message-complete="false" :message-is-suspended="false" :scroll="scroll" /></div>
</main></template><style>.thinking-content {max-height:160px;overflow-y:auto}</style>`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  await fs.writeFile(path.join(output, 'entry.js'), `
window.probe = {frames:[],parses:[],alive:0};
const raf = window.requestAnimationFrame.bind(window); const cancel = window.cancelAnimationFrame.bind(window); const handles = new Set();
window.requestAnimationFrame = callback => {const id = raf(now => {handles.delete(id); callback(now);}); handles.add(id); return id;};
window.cancelAnimationFrame = id => {handles.delete(id); cancel(id);}; window.pendingFrames = () => handles.size;
import {createApp} from 'vue'; import App from './App.vue'; createApp(App).mount('#app'); window.ready = true;`);
  const {createServer} = await import('vite');
  const {default: vue} = await import('@vitejs/plugin-vue');
  server = await createServer({root,configFile:false,plugins:[{
    name:'thinking-scheduler-probe',enforce:'pre',
    transform(source,id) {
      const file = id.replaceAll('\\','/');
      if (file.endsWith('/src/utils/markdown.ts')) return source
        .replace('const env: DiagramEnvironment =', 'window.probe.parses.push({time:performance.now(),length:content.length}); const env: DiagramEnvironment =');
      if (file.endsWith('/src/components/chat/MarkdownRenderer.vue')) {
        if (mutation === 'bypass') return source.replace('renderMarkdownDocument(displayedContent.value, streaming.value)', "renderMarkdownDocument(props.content || '', streaming.value)");
        if (mutation === 'copy') return source.replace('if (props.thinkingText && displayedContent.value !== props.content)', 'if (false)');
      }
      if (mutation === 'scroll' && file.endsWith('/src/components/chat/process/ThoughtStepRenderer.vue')) {
        return source.replace('@content-rendered="scroll.isFollowing(step.id) && scroll.scrollToBottom(step.id)"', '');
      }
    },
  },vue()],css:{postcss:{plugins:[]}},optimizeDeps:{entries:[path.join(output,'index.html')]},server:{host:'127.0.0.1',port:0},logLevel:'error'});
  await server.listen();
  browser = new BrowserWindow({width:900,height:1000,show:false,webPreferences:{contextIsolation:true,offscreen:true,backgroundThrottling:false}});
  await browser.loadURL(server.resolvedUrls.local[0] + 'node_modules/.tmp/thinking-text/index.html');
  const evaluate = source => browser.webContents.executeJavaScript(source);
  const waitFor = async (expression,label,timeout=4000) => {
    const end = Date.now()+timeout;
    while (!(await evaluate(expression))) {
      if (Date.now()>end) throw new Error(label);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  };
  await waitFor('window.ready', '诊断组件未就绪');
  const text = '中文 English 连续思考，平滑显示。'.repeat(35);
  const burst = await evaluate(`(async () => {
    await window.remount(); window.probe.parses = [];
    const text = ${JSON.stringify(text)}; await window.setContent(text);
    const initial = document.querySelector('#live .markdown-body')?.textContent || '';
    const source = window.getSource(); const frames = []; const start = performance.now();
    await new Promise(resolve => {
      const sample = now => {
        const length = (document.querySelector('#live .markdown-body')?.textContent || '').trim().length;
        frames.push({time:now-start,length});
        if (length === text.length) resolve(); else requestAnimationFrame(sample);
      }; requestAnimationFrame(sample);
    });
    return {initial,source,frames,parses:window.probe.parses};
  })()`);
  assert.equal(burst.source, text, '接收真值不能被显示游标截断');
  assert.ok(burst.initial.length < text.length / 3, '突发思考不能同一帧整段出现');
  const lengths = [...new Set(burst.frames.map(frame => frame.length))];
  assert.ok(lengths.length >= 5, '突发思考需要经过多个展示阶段');
  assert.ok(burst.frames.at(-1).time < 600, '正常帧调度不能产生长时间积压');
  assert.ok(burst.parses.length <= 11, 'Markdown 解析次数应受展示频率约束');
  assert.ok(burst.parses.every((entry,index,entries) => !index || entry.time-entries[index-1].time >= 20), '不能每个 Token 或每个 60Hz 帧都重解析');
  console.log('PASS 思考突发分帧:', JSON.stringify({stages:lengths.length,parses:burst.parses.length,lag:burst.frames.at(-1).time}));

  for (const label of ['完成','取消','失败','挂起']) {
    await evaluate('window.remount()');
    await evaluate(`window.setContent(${JSON.stringify(text)})`);
    await evaluate(`window.setContent(${JSON.stringify(text+label)}, false)`);
    assert.equal(await evaluate('document.querySelector("#live .markdown-body").textContent.trim()'), text+label);
    await evaluate('window.setContent("重试新内容", true)');
    assert.equal(await evaluate('document.querySelector("#live .markdown-body").textContent.trim()'), '重试新内容');
  }
  await evaluate(`window.remount(${JSON.stringify(text)}, true, true)`);
  assert.equal(await evaluate('document.querySelector("#live .markdown-body").textContent.trim()'), text, '历史快照必须立即展示');
  await evaluate('window.remount("", true, false)');
  await evaluate(`window.setContent(${JSON.stringify(text)})`);
  assert.equal(await evaluate('document.querySelector("#live .markdown-body").textContent.trim()'), text, '普通正文不能受思考调度影响');

  await evaluate('window.remount()');
  const code = Array.from({length:35},(_,index)=>`const value${index} = ${index};`).join('\n')+'\n';
  const copied = await evaluate(`(async () => {
    await window.setContent(${JSON.stringify('```js\n'+code+'```')});
    return new Promise(resolve => {
      const sample = () => {
        const button = document.querySelector('#live .copy-code-btn');
        if (!button) { requestAnimationFrame(sample); return; }
        const shown = document.querySelector('#live code.hljs').textContent;
        button.click(); Promise.resolve().then(() => resolve({shown,copied:window.copied}));
      }; requestAnimationFrame(sample);
    });
  })()`);
  assert.ok(copied.shown.length < code.length, '复制守卫必须在代码仍有积压时执行');
  assert.equal(copied.copied, code, '复制必须取已收到的完整代码');
  await waitFor(`document.querySelector('#live code.hljs').textContent === ${JSON.stringify(code)}`,'代码最终内容不完整');
  assert.ok(await evaluate('document.querySelectorAll("#live .hljs-keyword").length') > 0);

  const lines = Array.from({length:45},(_,index)=>`第 ${index} 行连续思考内容`).join('\n');
  await evaluate(`window.remount(${JSON.stringify(lines)}, true, true, true)`);
  await waitFor('!!document.querySelector(".thinking-content") && document.querySelector(".thinking-content").scrollTop > 0','思考框初次挂载未跟随');
  await evaluate(`window.setContent(${JSON.stringify(lines+'\n'+lines)})`);
  await waitFor('Math.abs(document.querySelector(".thinking-content").scrollHeight-document.querySelector(".thinking-content").scrollTop-document.querySelector(".thinking-content").clientHeight) < 4','视觉分帧推进后必须继续自动贴底');
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.ok(await evaluate('Math.abs(document.querySelector(".thinking-content").scrollHeight-document.querySelector(".thinking-content").scrollTop-document.querySelector(".thinking-content").clientHeight) < 4'), '最后一批展示文字必须贴底');
  await evaluate(`const box = document.querySelector('.thinking-content'); box.scrollTop=40; box.dispatchEvent(new Event('scroll'));`);
  assert.equal(await evaluate('window.follows()'),false);
  await evaluate(`window.setContent(${JSON.stringify(lines+'\n'+lines+'\n'+lines)})`);
  await new Promise(resolve=>setTimeout(resolve,350));
  assert.equal(await evaluate('document.querySelector(".thinking-content").scrollTop'),40,'手动上翻后视觉推进不能抢位置');

  browser.webContents.debugger.attach('1.3');
  await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await waitFor('matchMedia("(prefers-reduced-motion: reduce)").matches','减少动态效果设置未生效');
  await new Promise(resolve=>setTimeout(resolve,40));
  await evaluate('window.remount()');
  await evaluate(`window.setContent(${JSON.stringify(text)})`);
  assert.equal(await evaluate('document.querySelector("#live .markdown-body").textContent.trim()'),text,'减少动态效果应直接显示全文');
  await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await new Promise(resolve=>setTimeout(resolve,40));
  await evaluate('window.remount()');
  await evaluate(`window.setContent(${JSON.stringify(text)})`);
  await evaluate('window.unmount()');
  await new Promise(resolve=>setTimeout(resolve,600));
  assert.equal(await evaluate('window.pendingFrames()'),0,'卸载必须取消调度帧和原有动画帧');
  console.log('PASS 思考生命周期、历史、正文隔离、高亮复制、跟随滚动、减少动态效果与卸载');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  clearTimeout(deadline);browser?.destroy();await server?.close();app.exit(process.exitCode||0);
});
