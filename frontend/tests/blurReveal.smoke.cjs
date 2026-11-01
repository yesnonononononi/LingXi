const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'node_modules/.tmp/blur-reveal');
const mutation = process.env.LX_BLUR_REVEAL_MUTATION || '';
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
let server;
const deadline = setTimeout(() => { console.error('柔焦显现验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref, nextTick } from 'vue';
import MarkdownRenderer from '../../../src/components/chat/MarkdownRenderer.vue';
import '../../../src/theme/tokens.css';
import '../../../src/styles/markdown.css';
import '../../../src/styles/stream-animation.css';
const content = ref(''); const streaming = ref(true); const visible = ref(true); const generation = ref(0);
window.setContent = async (text, running = true) => { content.value = text; streaming.value = running; await nextTick(); };
window.remount = async (text, running) => { content.value = text; streaming.value = running; generation.value++; visible.value = true; await nextTick(); };
window.unmount = async () => { visible.value = false; await nextTick(); };
window.copied = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; } } });
</script><template><main style="max-width:680px;margin:40px auto"><MarkdownRenderer v-if="visible" :key="generation" :content="content" :is-thinking="streaming" /></main></template>`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  await fs.writeFile(path.join(output, 'entry.js'), "import { createApp } from 'vue'; import App from './App.vue'; createApp(App).mount('#app'); window.ready = true;");
  const { createServer } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  server = await createServer({ configFile: false, root, plugins: [{
    name: 'blur-reveal-mutation', enforce: 'pre',
    transform(source, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/utils/blurReveal.ts')) {
        if (mutation === 'disabled') return source.replace('this.ranges.push({ id:', 'false && this.ranges.push({ id:');
        if (mutation === 'restart') return source.replace('this.expire(now);', 'this.ranges.forEach(range => { range.started = now; }); this.expire(now);');
        if (mutation === 'history') return source.replace('(this.initialized || revealInitial)', 'true');
      }
      if (mutation === 'cleanup' && id.replaceAll('\\', '/').endsWith('/src/components/chat/MarkdownContent.ts')) {
        return source.replace('reveal.expire(performance.now());', 'void 0;');
      }
    },
  }, vue()], optimizeDeps: { entries: [path.join(output, 'index.html')] },
    css: { postcss: { plugins: [] } }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  window = new BrowserWindow({ width: 900, height: 900, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadURL(server.resolvedUrls.local[0] + 'node_modules/.tmp/blur-reveal/index.html');
  console.log('柔焦显现验证: 页面已加载');
  const evaluate = source => window.webContents.executeJavaScript(source);
  const waitFor = async (expression, label, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (!(await evaluate(expression))) {
      if (Date.now() > end) throw new Error(label);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  const setContent = (text, streaming = true) => evaluate(`window.setContent(${JSON.stringify(text)}, ${streaming})`);
  await waitFor('window.ready', '页面未就绪');
  console.log('柔焦显现验证: 组件已挂载');

  // 同一浏览器任务中检查，避免机器速度影响 290ms 的动画窗口。
  for (const chunks of [['你好', '，世界', '，继续生成'], ['Hello', ', world', ', streaming continues']]) {
    await evaluate(`window.remount('', true)`);
    const result = await evaluate(`(async () => {
      const chunks = ${JSON.stringify(chunks)}; let text = '';
      await window.setContent(text += chunks[0]);
      const first = document.querySelector('.blur-reveal');
      if (!first) throw new Error('首批新文字缺少动画');
      const animation = first.getAnimations()[0];
      const started = animation.startTime;
      await window.setContent(text += chunks[1]);
      const retained = first.isConnected && first.getAnimations()[0] === animation && animation.startTime === started;
      await window.setContent(text += chunks[2]);
      const timing = animation.effect.getTiming();
      return { retained, text: document.querySelector('.markdown-body p').textContent,
        chunks: document.querySelectorAll('.blur-reveal').length, duration: timing.duration,
        easing: getComputedStyle(first).animationTimingFunction, frames: animation.effect.getKeyframes().map(f => [f.opacity, f.filter, f.transform]) };
    })()`);
    assert.equal(result.retained, true, '新增 Token 必须保留旧节点及动画实例');
    assert.equal(result.text, chunks.join(''), '不等待动画就立即呈现全部真实文字');
    assert.equal(result.chunks, 3, '多个片段应同时播放');
    assert.equal(result.duration, 290);
    assert.equal(result.easing, 'ease-out');
    assert.deepEqual(result.frames.map(frame => frame.slice(0, 2)), [['0', 'blur(4px)'], ['1', 'blur(0px)']]);
    assert.ok(result.frames.every(frame => !frame[2] || frame[2] === 'none'));
  }
  await waitFor('document.querySelectorAll(".blur-reveal").length === 0', '动画结束后应移除包装', 2000);
  console.log('柔焦显现验证: 中英文与节点稳定已通过');
  const stable = await evaluate(`(async () => {
    const p = document.querySelector('.markdown-body p'); const first = p.firstChild;
    await window.setContent(p.textContent + ' 新增');
    return { same: first === p.firstChild, count: p.querySelectorAll('.blur-reveal').length };
  })()`);
  assert.deepEqual(stable, { same: true, count: 1 }, '已完成文字保持静止，只新增一个片段');

  await evaluate(`window.remount('', true)`);
  const resumedProgress = await evaluate(`(async () => {
    await window.setContent('**柔焦');
    await new Promise(resolve => setTimeout(resolve, 100));
    await window.setContent('**柔焦**');
    return document.querySelector('strong .blur-reveal').getAnimations()[0].currentTime;
  })()`);
  assert.ok(resumedProgress >= 90, 'Markdown 换父节点后应从原动画进度接续');
  await setContent('**柔焦** 与 `inline`\n\n- 列表\n\n| 列 |\n| --- |\n| 内容 |\n\n```js\nconst answer = ');
  const code = "const answer = 42;\n";
  await setContent('**柔焦** 与 `inline`\n\n- 列表\n\n| 列 |\n| --- |\n| 内容 |\n\n```js\n' + code + '```');
  assert.equal(await evaluate('document.querySelector("strong").textContent'), '柔焦');
  for (const selector of ['li', 'table', 'p > code']) {
    assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`), 1);
  }
  assert.equal(await evaluate('document.querySelector("code.hljs").textContent'), code);
  assert.ok(await evaluate('document.querySelectorAll(".hljs-keyword, .hljs-number").length') > 0);
  assert.equal(await evaluate('document.querySelectorAll(".block-toolbar .blur-reveal").length'), 0);
  await evaluate('document.querySelector(".copy-code-btn").click()');
  await waitFor(`window.copied === ${JSON.stringify(code)}`, '复制内容必须保持原始代码');
  await fs.writeFile(path.join(output, 'markdown.png'), (await window.webContents.capturePage()).toPNG());

  const burst = await evaluate(`(async () => {
    await window.remount('', true);
    for (let i = 1; i <= 120; i++) await window.setContent('字'.repeat(i));
    return document.querySelector('.markdown-body').textContent;
  })()`);
  assert.equal(burst.trim(), '字'.repeat(120));
  await waitFor('document.querySelectorAll(".blur-reveal").length === 0', '高频输出停止后不能残留大量 span', 2000);
  assert.equal(await evaluate('document.querySelector(".markdown-body p").childNodes.length'), 1);

  for (const terminal of ['完成', '取消', '失败']) {
    await evaluate('window.remount("", true)');
    await setContent('生成中');
    await setContent('生成中' + terminal, false);
    assert.equal(await evaluate('document.querySelectorAll(".blur-reveal").length'), 0, terminal + '必须立即恢复静态文本');
  }
  for (const streaming of [false, true]) {
    await evaluate(`window.remount('历史内容 **粗体**', ${streaming})`);
    assert.equal(await evaluate('document.querySelectorAll(".blur-reveal").length'), 0, '重新加载已有快照不能重播');
  }
  await evaluate('window.remount("", true)');
  await setContent('动画中的文字');
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await waitFor('matchMedia("(prefers-reduced-motion: reduce)").matches', '系统减少动态效果未生效');
  await waitFor('document.querySelectorAll(".blur-reveal").length === 0', '偏好变更应立即清理动画');
  await setContent('动画中的文字 新增');
  assert.equal(await evaluate('document.querySelectorAll(".blur-reveal").length'), 0);
  await evaluate(`window.motionChanged = new Promise(resolve => matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => resolve(true), { once: true })); true`);
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await evaluate('window.motionChanged');
  await waitFor('!matchMedia("(prefers-reduced-motion: reduce)").matches', '恢复动画偏好未生效');
  await setContent('动画中的文字 新增 再新增');
  assert.ok(await evaluate('document.querySelectorAll(".blur-reveal").length') > 0);
  await evaluate('window.unmount()');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await evaluate('document.getAnimations().filter(a => a.animationName === "blur-reveal").length'), 0);
  console.log('PASS 柔焦显现：中英文、节点稳定、Markdown、高亮复制、高频、终态、历史、动态偏好与卸载');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(deadline);
  window?.destroy();
  await server?.close();
  app.exit(process.exitCode || 0);
});
