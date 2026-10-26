const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '../node_modules/.tmp/mermaid');
const root = path.resolve(__dirname, '..');
const mutation = process.env.LX_MERMAID_MUTATION || '';
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
let server;
const deadline = setTimeout(() => { console.error('Mermaid 验证超时'); app.exit(1); }, 150000);

app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'race-renderer.js'), `
window.renders = [];
export const renderMermaid = (source, dark) => new Promise((resolve, reject) => window.renders.push({ source, dark, resolve, reject }));`);
  await fs.writeFile(path.join(output, 'App.vue'), `<script setup>
import { ref, nextTick } from 'vue';
import MarkdownRenderer from '../../../src/components/chat/MarkdownRenderer.vue';
import RaceBlock from 'virtual:mermaid-race.vue';
import { renderMarkdownDocument } from '../../../src/utils/markdown';
import { useI18n } from '../../../src/i18n';
import { useTheme } from '../../../src/composables/useTheme';
import '../../../src/style.css';
const content = ref(''); const streaming = ref(false); const dark = ref(false);
const raceSource = ref('first'); const raceComplete = ref(false); const raceVisible = ref(true);
useI18n().locale.value = 'zh-CN';
const { setTheme } = useTheme();
window.setContent = async (text, running = false, isDark = false) => {
  content.value = text; streaming.value = running; dark.value = isDark;
  setTheme(isDark ? 'dark' : 'light'); await nextTick();
};
window.setRace = async (text, complete = true, visible = true) => {
  raceSource.value = text; raceComplete.value = complete; raceVisible.value = visible; await nextTick();
};
window.parseDocument = renderMarkdownDocument;
</script><template><main style="max-width:700px;margin:auto">
<div id="actual"><MarkdownRenderer :content="content" :is-thinking="streaming" :is-dark="dark" /></div>
<div id="race"><RaceBlock v-if="raceVisible" :source="raceSource" :complete="raceComplete" :is-dark="dark" /></div>
</main></template>`);
  await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
  await fs.writeFile(path.join(output, 'entry.js'), "import { createApp } from 'vue'; import App from './App.vue'; createApp(App).mount('#app'); window.library = () => import('mermaid'); window.ready = true;");
  const { createServer } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  server = await createServer({ configFile: false, root, plugins: [{
    name: 'mermaid-race-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:mermaid-race.vue') return path.join(output, 'RaceBlock.vue'); },
    async load(id) {
      if (id === path.join(output, 'RaceBlock.vue').replaceAll('\\', '/') || id === path.join(output, 'RaceBlock.vue')) {
        let source = await fs.readFile(path.join(root, 'src/components/chat/MermaidBlock.vue'), 'utf8');
        source = source.replace("'../../utils/mermaid'", "'/node_modules/.tmp/mermaid/race-renderer.js'")
          .replaceAll("'../../composables/", "'/src/composables/").replace("'../../i18n'", "'/src/i18n'");
        if (mutation === 'stale') source = source.replaceAll('if (current)', 'if (true)');
        return source;
      }
    },
    transform(source, id) {
      if (mutation === 'closure' && id.replaceAll('\\', '/').endsWith('/src/utils/markdown.ts')) {
        return source.replace('complete: closed || !env.streaming', 'complete: true');
      }
      if (mutation === 'preserve' && id.replaceAll('\\', '/').endsWith('/src/components/chat/MarkdownContent.ts')) {
        return source.replace('key: `mermaid-${index}`', 'key: props.document.html');
      }
      if (mutation === 'sanitize' && id.replaceAll('\\', '/').endsWith('/src/utils/mermaid.ts')) {
        return source.replace('DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })', 'svg');
      }
      if (mutation === 'queue' && id.replaceAll('\\', '/').endsWith('/src/utils/mermaid.ts')) {
        return source.replace('const task = queue.then(', 'const task = Promise.resolve().then(');
      }
      if (mutation === 'background' && id.replaceAll('\\', '/').endsWith('/src/style.css')) {
        return source + '\nhtml.light .markdown-body .mermaid-block { background: #181d28; }';
      }
    },
  }, vue()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  window = new BrowserWindow({ width: 900, height: 800, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  await window.loadURL(server.resolvedUrls.local[0] + 'node_modules/.tmp/mermaid/index.html');
  const evaluate = source => window.webContents.executeJavaScript(source);
  const waitFor = async (expression, message) => {
    const end = Date.now() + 30000;
    while (!(await evaluate(expression))) {
      if (Date.now() > end) throw new Error(message + ': ' + await evaluate('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await waitFor('window.ready === true', '页面未就绪');
  const setContent = (text, streaming = false, dark = false) => evaluate(`window.setContent(${JSON.stringify(text)}, ${streaming}, ${dark})`);
  const fence = source => '```mermaid\n' + source + '\n```';
  const first = fence('flowchart LR\n A[开始] --> B[结束]');
  assert.equal(await evaluate('window.parseDocument("### Mermaid", false).diagrams.length'), 0);
  assert.equal(await evaluate('window.parseDocument("~~~~markdown\\n```mermaid\\nflowchart LR; A-->B\\n```\\n~~~~", false).diagrams.length'), 0, '示例代码中的围栏不能变成图表');
  assert.equal(await evaluate('window.parseDocument("~~~mermaid\\nflowchart LR; A-->B\\n~~~", true).diagrams[0].complete'), true);
  assert.equal(await evaluate('window.parseDocument("```mermaid\\nflowchart LR; A-->B", false).diagrams[0].complete'), true, '已结束的历史正文沿用 Markdown 的隐式闭合规则');

  await setContent('```mermaid\nflowchart LR\n A --> B', true);
  assert.equal(await evaluate('document.querySelectorAll("#actual .mermaid-diagram svg").length'), 0, '未闭合的流式围栏不能提前画图');
  assert.match(await evaluate('document.querySelector("#actual pre").textContent'), /A --> B/);
  assert.equal(await evaluate('window.parseDocument("```mermaid\\nflowchart LR\\n A --> B", true).diagrams[0].complete'), false, '未闭合的流式围栏不能提前画图');
  await setContent(first, true);
  await waitFor('document.querySelector("#actual .mermaid-diagram svg") !== null', '闭合后未成图');
  assert.match(await evaluate('document.querySelector("#actual svg").textContent'), /开始/);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#actual .mermaid-block")).backgroundColor'), 'rgb(255, 255, 255)', '浅色图表背景必须与文字主题一致');
  // 图表不是代码块：不能继承代码块的深色标题栏与语言徽标（回归锁）。
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#actual .mermaid-block .block-toolbar")).backgroundColor'), 'rgba(0, 0, 0, 0)', '图表工具栏不能有深色标题栏背景');
  assert.equal(await evaluate('document.querySelector("#actual .mermaid-block .lang-badge") === null'), true, '图表结构里根本不该有语言徽标');
  await evaluate('window.savedSvg = document.querySelector("#actual .mermaid-diagram svg")');
  await setContent(first + '\n\n后续文字正在追加', true);
  assert.equal(await evaluate('document.querySelector("#actual .mermaid-diagram svg") === window.savedSvg'), true, '追加正文必须保留 SVG 节点');
  await setContent(first + '\n\n后续文字正在追加', false);
  assert.equal(await evaluate('document.querySelector("#actual .mermaid-diagram svg") === window.savedSvg'), true, '流式结束不能重画已有图');

  await evaluate('Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.copiedText = text; } } }); document.querySelector("#actual .copy-code-btn").click()');
  assert.equal(await evaluate('window.copiedText'), 'flowchart LR\n A[开始] --> B[结束]\n');
  const lightStyle = await evaluate('document.querySelector("#actual .mermaid-diagram svg style").textContent');
  await setContent(first, false, true);
  await waitFor('document.querySelector("#actual .mermaid-diagram svg") && document.querySelector("#actual .mermaid-diagram svg") !== window.savedSvg', '主题切换没有重画');
  assert.notEqual(await evaluate('document.querySelector("#actual .mermaid-diagram svg style").textContent'), lightStyle);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#actual .mermaid-block")).backgroundColor'), 'rgb(24, 24, 27)');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#actual .mermaid-block .block-toolbar")).backgroundColor'), 'rgba(0, 0, 0, 0)', '深色图表工具栏同样不能有标题栏背景');
  await fs.writeFile(path.join(output, 'dark.png'), (await window.webContents.capturePage()).toPNG());

  const nested = '> ' + first.replaceAll('\n', '\n> ');
  await setContent(nested + '\n\n' + fence('sequenceDiagram\n Alice->>Bob: 你好') + '\n\n- 列表内容\n\n  ' + first.replaceAll('\n', '\n  '), true);
  await waitFor('document.querySelectorAll("#actual .mermaid-diagram svg").length === 3', '引用、列表和多图未正确渲染');
  assert.equal(await evaluate('document.querySelectorAll("#actual blockquote .mermaid-block, #actual li .mermaid-block").length'), 2);
  assert.equal(await evaluate('new Set([...document.querySelectorAll("#actual .mermaid-diagram svg")].map(node => node.id)).size'), 3);
  await fs.writeFile(path.join(output, 'light.png'), (await window.webContents.capturePage()).toPNG());

  await setContent(fence('这不是有效的图表') + '\n\n' + first);
  await waitFor('document.querySelector("#actual [role=status]")?.textContent.includes("渲染失败") && document.querySelector("#actual .mermaid-diagram svg")', '错误图表阻断了后续图表');
  assert.match(await evaluate('document.querySelector("#actual pre").textContent'), /这不是有效的图表/);
  await setContent('```javascript\nconst x = 1;\n```\n\n[文档](https://example.com)\n\n<img src=x onerror="window.injected=true">');
  assert.equal(await evaluate('document.querySelector("#actual .copy-code-btn").dataset.code'), encodeURIComponent('const x = 1;\n'));
  assert.equal(await evaluate('document.querySelector("#actual a").rel'), 'noopener noreferrer');
  assert.equal(await evaluate('document.querySelector("#actual img")'), null);

  // 正对照先证明危险标签在浏览器中存在，再验证真实图表路径会净化它。
  const unsafe = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.injected=true</script><text onload="window.injected=true">示例</text></svg>';
  await evaluate(`window.unsafeSvg = ${JSON.stringify(unsafe)}; window.template = document.createElement('template'); window.template.innerHTML = window.unsafeSvg`);
  assert.equal(await evaluate('window.template.content.querySelectorAll("script, [onload]").length'), 2);
  // 使用与生产相同的工具模块，替换 Mermaid 库的输出，避免依赖库先行过滤掩盖净化回归。
  const cleanSvg = await evaluate(`(async () => {
    const mermaid = (await window.library()).default;
    const original = mermaid.render;
    mermaid.render = async () => ({ svg: window.unsafeSvg });
    try { return await (await import('/src/utils/mermaid.ts')).renderMermaid('flowchart LR; A-->B', false); }
    finally { mermaid.render = original; }
  })()`);
  assert.doesNotMatch(cleanSvg, /<script|onload=/);
  const concurrentThemes = await evaluate(`(async () => {
    const mermaid = (await window.library()).default;
    const originalInit = mermaid.initialize; const originalRender = mermaid.render;
    let theme;
    mermaid.initialize = config => { theme = config.theme; };
    mermaid.render = async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>' + theme + '</text></svg>' };
    };
    try {
      const { renderMermaid } = await import('/src/utils/mermaid.ts');
      return await Promise.all([renderMermaid('dark diagram', true), renderMermaid('light diagram', false)]);
    } finally { mermaid.initialize = originalInit; mermaid.render = originalRender; }
  })()`);
  assert.match(concurrentThemes[0], />dark</, '并发图表不能串用后一个主题');
  assert.match(concurrentThemes[1], />default</);

  await evaluate('window.setRace("first")');
  await waitFor('window.renders.length === 1', '未启动第一个异步请求');
  await evaluate('window.setRace("second")');
  await waitFor('window.renders.length === 2', '未启动第二个异步请求');
  await evaluate('window.renders[1].resolve("<svg><text>新结果</text></svg>")');
  await waitFor('document.querySelector("#race svg")?.textContent === "新结果"', '新结果未显示');
  await evaluate('window.renders[0].resolve("<svg><text>旧结果</text></svg>")');
  assert.equal(await evaluate('document.querySelector("#race svg")?.textContent'), '新结果', '旧异步结果覆盖了新结果');
  await evaluate('window.setRace("third")');
  await evaluate('window.setRace("partial", false)');
  await evaluate('window.renders[2].reject(new Error("旧错误"))');
  assert.equal(await evaluate('document.querySelector("#race [role=status]")'), null, '旧请求失败污染了流式源码状态');
  await evaluate('window.setRace("unmount")');
  await evaluate('window.setRace("unmount", true, false)');
  await evaluate('window.renders[3].resolve("<svg><text>卸载结果</text></svg>")');
  assert.equal(await evaluate('document.querySelector("#race svg")'), null);

  console.log('Mermaid 真实组件验证通过：流式闭合、SVG 保留、多图嵌套、主题、复制、错误恢复、安全与异步隔离。');
  clearTimeout(deadline); window.destroy(); await server.close(); app.exit(0);
}).catch(async error => {
  console.error(error); clearTimeout(deadline);
  if (window) window.destroy(); if (server) await server.close(); app.exit(1);
});
