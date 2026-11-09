const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'node_modules/.tmp/codex-text-arrival');
const mutation = process.env.LX_PROGRESSIVE_FADE_MUTATION || '';
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
let server;
const deadline = setTimeout(() => { console.error('渐进淡入验证超时'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref, nextTick } from 'vue';
import MarkdownRenderer from '../../../src/components/chat/MarkdownRenderer.vue';
import { useStreamStickyScroll } from '../../../src/composables/useStreamStickyScroll';
import '../../../src/theme/tokens.css';
import '../../../src/styles/markdown.css';
import '../../../src/styles/stream-animation.css';
const content = ref(''); const streaming = ref(true); const visible = ref(true); const generation = ref(0);
const scroll = useStreamStickyScroll({ streamSignature: () => content.value, boxIds: () => ['live'] });
window.follows = () => scroll.isFollowing('live');
window.setContent = async (text, running = true) => { content.value = text; streaming.value = running; await nextTick(); };
window.remount = async (text, running) => { content.value = text; streaming.value = running; generation.value++; visible.value = true; await nextTick(); };
window.unmount = async () => { visible.value = false; await nextTick(); };
window.copied = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; } } });
</script><template><main style="max-width:680px;margin:40px auto;font:14px/1.9 sans-serif"><div id="scrollbox" style="max-height:560px;overflow:auto" :ref="el => scroll.setBoxRef('live', el)" @scroll="scroll.handleScroll('live', $event)"><MarkdownRenderer v-if="visible" :key="generation" :content="content" :is-thinking="streaming" /></div></main></template>`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  await fs.writeFile(path.join(output, 'entry.js'), "import { createApp } from 'vue'; import App from './App.vue'; createApp(App).mount('#app'); window.ready = true;");
  const { createServer } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  server = await createServer({ configFile: false, root, plugins: [{
    name: 'codex-text-arrival-mutation', enforce: 'pre',
    transform(source, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/utils/progressiveFade.ts')) {
        if (mutation === 'disabled') return source.replace('this.ranges.push({ id:', 'false && this.ranges.push({ id:');
        if (mutation === 'restart') return source.replace('this.expire(now);', 'this.ranges.forEach(range => { range.started = now; }); this.expire(now);');
        if (mutation === 'history') return source.replace('(this.initialized || revealInitial)', 'true');
        if (mutation === 'burst') return source.replace('const count = Math.ceil(starts.length / CHUNK_GRAPHEMES);', 'const count = 1; starts.splice(0, starts.length, prefix);');
      }
      if (mutation === 'cleanup' && id.replaceAll('\\', '/').endsWith('/src/components/chat/MarkdownContent.ts')) {
        return source.replace('reveal.expire(performance.now());', 'void 0;');
      }
      if (id.replaceAll('\\', '/').endsWith('/src/utils/markdown.ts')) {
        return source.replace(
          'highlighted = hljs.highlight(str, { language: validLang, ignoreIllegals: true }).value;',
          'window.hljsCalls = (window.hljsCalls || 0) + 1; highlighted = hljs.highlight(str, { language: validLang, ignoreIllegals: true }).value;'
        );
      }
    },
  }, vue()], optimizeDeps: { entries: [path.join(output, 'index.html')] },
    css: { postcss: { plugins: [] } }, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  window = new BrowserWindow({ width: 900, height: 900, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadURL(server.resolvedUrls.local[0] + 'node_modules/.tmp/codex-text-arrival/index.html');
  console.log('渐进淡入验证: 页面已加载');
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
  console.log('渐进淡入验证: 组件已挂载');
  // 同一浏览器任务中检查，避免机器速度影响 480ms 的动画窗口。
  for (const chunks of [['你好', '，世界', '，继续生成'], ['Hello', ', world', ', streaming continues']]) {
    await evaluate(`window.remount('', true)`);
    const result = await evaluate(`(async () => {
      const chunks = ${JSON.stringify(chunks)}; let text = '';
      await window.setContent(text += chunks[0]);
      const first = document.querySelector('.codex-text-arrival');
      if (!first) throw new Error('首批新文字缺少动画');
      const animation = first.getAnimations()[0];
      const started = animation.startTime;
      await window.setContent(text += chunks[1]);
      const retained = first.isConnected && first.getAnimations()[0] === animation && animation.startTime === started;
      await window.setContent(text += chunks[2]);
      const timing = animation.effect.getTiming();
      return { retained, text: document.querySelector('.markdown-body p').textContent,
        chunks: document.querySelectorAll('.codex-text-arrival').length, duration: timing.duration,
        easing: getComputedStyle(first).animationTimingFunction, frames: animation.effect.getKeyframes().map(f => [f.opacity, f.filter, f.transform]) };
    })()`);
    assert.equal(result.retained, true, '新增 Token 必须保留旧节点及动画实例');
    assert.equal(result.text, chunks.join(''), '不等待动画就立即呈现全部真实文字');
    assert.ok(result.chunks >= 3, '多个短片段应同时播放');
    assert.equal(result.duration, 480);
    assert.equal(result.easing, 'ease-out');
    assert.deepEqual(result.frames.map(frame => frame[0]), ['0.2', '1']);
    assert.ok(result.frames.every(frame => (!frame[1] || frame[1] === 'none') && (!frame[2] || frame[2] === 'none')));
  }
  await waitFor('document.querySelectorAll(".codex-text-arrival").length === 0', '动画结束后应移除包装', 2000);
  console.log('渐进淡入验证: 中英文与节点稳定已通过');
  const stable = await evaluate(`(async () => {
    const p = document.querySelector('.markdown-body p'); const first = p.firstChild;
    await window.setContent(p.textContent + ' 新增');
    return { same: first === p.firstChild, count: p.querySelectorAll('.codex-text-arrival').length };
  })()`);
  assert.deepEqual(stable, { same: true, count: 1 }, '已完成文字保持静止，只新增一个片段');

  const packet = await evaluate(`(async () => {
    await window.remount('', true);
    const text = '传输方式可以再优化，新文字应当自然呈现，已有文字保持稳定。'.repeat(25);
    await window.setContent(text);
    const p = document.querySelector('.markdown-body p');
    const spans = [...p.querySelectorAll('.codex-text-arrival')];
    return { fullText: p.textContent === text, nodes: spans.length,
      maxChunk: Math.max(...spans.map(span => span.textContent.length)),
      plainPrefix: p.firstChild.textContent.length,
      opacities: spans.map(span => Number(getComputedStyle(span).opacity)),
      filter: getComputedStyle(spans[0]).filter,
      containerOpacity: getComputedStyle(document.querySelector('.markdown-body')).opacity,
      cursor: getComputedStyle(p, '::after').content };
  })()`);
  assert.equal(packet.fullText, true, '大包内容必须立即完整进入 DOM');
  assert.ok(packet.nodes > 1 && packet.nodes <= 32 && packet.maxChunk <= 3, '大包不能变成一整片动画');
  assert.ok(packet.plainPrefix > 600, '大包头部应直接定型，只有有界尾迹变浅');
  assert.ok(packet.opacities[0] - packet.opacities.at(-1) > 0.3, '同一大包必须形成头深尾浅的空间尾迹');
  assert.equal(packet.filter, 'none');
  assert.equal(packet.containerOpacity, '1');
  assert.ok(['none', 'normal'].includes(packet.cursor), '不应显示打字光标');
  console.log('渐进淡入验证: 725 字突发输出全文立即显示，尾迹节点=' + packet.nodes);
  await fs.writeFile(path.join(output, 'burst.png'), (await window.webContents.capturePage()).toPNG());

  const text = '一整段突发输出也应保持滚动位置与文字布局稳定。'.repeat(160);
  await setContent(text);
  await waitFor('document.querySelector("#scrollbox").scrollTop > 0 && window.follows()', '现有自动跟随应保持正常');
  const geometry = await evaluate(`(() => {
    const box = document.querySelector('#scrollbox');
    box.scrollTop = 40; box.dispatchEvent(new Event('scroll'));
    return { height: box.scrollHeight, top: box.scrollTop };
  })()`);
  await setContent(text + '追加新文字，仍然保持用户的阅读位置。');
  await waitFor('document.querySelectorAll(".codex-text-arrival").length === 0', '尾迹回收超时', 2000);
  assert.equal(await evaluate('document.querySelector("#scrollbox").scrollTop'), geometry.top, '用户上翻后追加和回收不能抢滚动');
  assert.equal(await evaluate('window.follows()'), false);
  assert.ok(Math.abs(await evaluate('document.querySelector("#scrollbox").scrollHeight') - geometry.height) <= 30, '移除临时包装不能引入额外布局高度');

  await evaluate(`window.remount('', true)`);
  const resumedProgress = await evaluate(`(async () => {
    await window.setContent('**淡入');
    await new Promise(resolve => setTimeout(resolve, 100));
    await window.setContent('**淡入**');
    return document.querySelector('strong .codex-text-arrival').getAnimations()[0].currentTime;
  })()`);
  assert.ok(resumedProgress >= 90, 'Markdown 换父节点后应从原动画进度接续');
  await setContent('**淡入** 与 `inline`\n\n- 列表\n\n| 列 |\n| --- |\n| 内容 |\n\n```js\nconst answer = ');
  const code = "const answer = 42;\n";
  await setContent('**淡入** 与 `inline`\n\n- 列表\n\n| 列 |\n| --- |\n| 内容 |\n\n```js\n' + code + '```');
  assert.equal(await evaluate('document.querySelector("strong").textContent'), '淡入');
  for (const selector of ['li', 'table', 'p > code']) {
    assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`), 1);
  }
  assert.equal(await evaluate('document.querySelector("code.hljs").textContent'), code);
  assert.ok(await evaluate('document.querySelectorAll(".hljs-keyword, .hljs-number").length') > 0);
  assert.equal(await evaluate('document.querySelectorAll(".block-toolbar .codex-text-arrival").length'), 0);
  await evaluate('document.querySelector(".copy-code-btn").click()');
  await waitFor(`window.copied === ${JSON.stringify(code)}`, '复制内容必须保持原始代码');
  await waitFor('document.querySelectorAll(".codex-text-arrival").length === 0', '代码块淡入结束后应回收包装', 2000);
  const blockReuse = await evaluate(`(async () => {
    const base = '**淡入** 与 \`inline\`\\n\\n- 列表\\n\\n| 列 |\\n| --- |\\n| 内容 |\\n\\n\`\`\`js\\n' + ${JSON.stringify(code)} + '\`\`\`\\n\\n后续段落';
    await window.setContent(base);
    await new Promise(resolve => setTimeout(resolve, 550));
    const prevStrong = document.querySelector('strong');
    const prevTable = document.querySelector('table');
    const prevCode = document.querySelector('code.hljs');
    const hljsBefore = window.hljsCalls || 0;
    let current = base;
    for (const chunk of ['，继续', '流式', '追加', '文字']) {
      current += chunk;
      await window.setContent(current);
    }
    return {
      sameStrong: document.querySelector('strong') === prevStrong,
      sameTable: document.querySelector('table') === prevTable,
      sameCode: document.querySelector('code.hljs') === prevCode,
      extraHljsCalls: (window.hljsCalls || 0) - hljsBefore,
    };
  })()`);
  assert.deepEqual(blockReuse, {
    sameStrong: true,
    sameTable: true,
    sameCode: true,
    extraHljsCalls: 0,
  }, '已定型顶层块与代码块在后续段落流式追加时必须复用节点与高亮结果');
  await fs.writeFile(path.join(output, 'markdown.png'), (await window.webContents.capturePage()).toPNG());

  const burst = await evaluate(`(async () => {
    await window.remount('', true);
    for (let i = 1; i <= 120; i++) await window.setContent('字'.repeat(i));
    return document.querySelector('.markdown-body').textContent;
  })()`);
  assert.equal(burst.trim(), '字'.repeat(120));
  await waitFor('document.querySelectorAll(".codex-text-arrival").length === 0', '高频输出停止后不能残留大量 span', 2000);
  assert.equal(await evaluate('document.querySelector(".markdown-body p").childNodes.length'), 1);

  for (const terminal of ['完成', '取消', '失败']) {
    await evaluate('window.remount("", true)');
    await setContent('生成中');
    await setContent('生成中' + terminal, false);
    assert.equal(await evaluate('document.querySelectorAll(".codex-text-arrival").length'), 0, terminal + '必须立即恢复静态文本');
    await setContent('生成中' + terminal, true);
    assert.equal(await evaluate('document.querySelectorAll(".codex-text-arrival").length'), 0, '重试不能重播已有内容');
    await setContent('生成中' + terminal + '后续', true);
    assert.ok(await evaluate('document.querySelectorAll(".codex-text-arrival").length') > 0, '重试后的新增内容继续淡入');
  }
  for (const streaming of [false, true]) {
    await evaluate(`window.remount('历史内容 **粗体**', ${streaming})`);
    assert.equal(await evaluate('document.querySelectorAll(".codex-text-arrival").length'), 0, '重新加载已有快照不能重播');
  }
  await evaluate('window.remount("", true)');
  await setContent('动画中的文字');
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await waitFor('matchMedia("(prefers-reduced-motion: reduce)").matches', '系统减少动态效果未生效');
  await waitFor('document.querySelectorAll(".codex-text-arrival").length === 0', '偏好变更应立即清理动画');
  await setContent('动画中的文字 新增');
  assert.equal(await evaluate('document.querySelectorAll(".codex-text-arrival").length'), 0);
  await evaluate(`window.motionChanged = new Promise(resolve => matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => resolve(true), { once: true })); true`);
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await evaluate('window.motionChanged');
  await waitFor('!matchMedia("(prefers-reduced-motion: reduce)").matches', '恢复动画偏好未生效');
  await setContent('动画中的文字 新增 再新增');
  assert.ok(await evaluate('document.querySelectorAll(".codex-text-arrival").length') > 0);
  await evaluate('window.unmount()');
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(await evaluate('document.getAnimations().filter(a => a.animationName === "codex-text-arrival").length'), 0);
  console.log('PASS 渐进淡入：中英文、节点稳定、Markdown、高亮复制、高频、终态、历史、动态偏好与卸载');
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearTimeout(deadline);
  window?.destroy();
  await server?.close();
  app.exit(process.exitCode || 0);
});
