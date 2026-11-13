/**
 * 窄窗口下「右侧面板不许压扁对话列」的真渲染验证。
 *
 * 四个用例钉的都是同一件事：右侧面板（文件预览 / 子代理轨迹）宽度必须受
 * 「行宽 − 对话列最小可用宽度」约束，且约束在**挂载时、拖拽时、行宽变化时**都生效。
 *
 *   1. 存储宽度 2000（大屏拖宽后面板回到 1024 窗口）→ 面板被夹紧，对话列 ≥ 400；
 *   2. 拖拽分割条到极限 → 照样夹紧；
 *   3. 夹紧后的 400px 对话列里，输入卡片内容不溢出（nowrap 会把卡片撑到 450px）；
 *   4. 侧边栏展开使行宽缩小（不是窗口 resize）→ 面板重新夹紧，对话列仍 ≥ 400。
 *
 * 运行：`cd frontend && npx electron tests/chatNarrowColumn.smoke.cjs`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const frontendRoot = path.resolve(__dirname, '..');
const output = path.resolve(frontendRoot, 'node_modules/.tmp/chat-narrow-column');
const MIN_COLUMN = 400;

app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => {
  console.error('窄窗口对话列验证超时');
  app.exit(1);
}, 180000);

/** 生成相对 output 目录的 import 说明符（正斜杠，vite 可解析）。 */
function specifierFor(absolutePath) {
  const relative = path.relative(output, absolutePath).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : './' + relative;
}

const SUB_ITEMS = [
  { id: 's1', agentName: '工程师', status: 'completed', task: '修复布局' }
];

async function writeHarness() {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'entry.js'), `import { createApp, h, nextTick } from 'vue';
import ChatInputArea from '${specifierFor(path.resolve(frontendRoot, 'src/components/chat/ChatInputArea.vue'))}';
import SubAgentSidePanel from '${specifierFor(path.resolve(frontendRoot, 'src/components/chat/SubAgentSidePanel.vue'))}';
import '${specifierFor(path.resolve(frontendRoot, 'src/style.css'))}';

localStorage.setItem('lingxi-locale', 'zh-CN');

const MODELS = [{ id: 'm1', name: 'GPT-Test', modelName: 'gpt-test', providerName: 'OpenAI' }];
const SUB_ITEMS = ${JSON.stringify(SUB_ITEMS)};

/* 侧栏宽度与存储的面板宽度都由用例给：复刻 ChatView 的「侧栏 + 弹性行（对话列 + 右侧面板）」 */
window.__render = async (options) => {
  localStorage.setItem('lingxi-sub-panel-width', String(options.storedWidth));
  if (window.__app) { window.__app.unmount(); window.__app = null; }
  const root = document.getElementById('app');
  root.innerHTML = '';
  const host = document.createElement('div');
  root.appendChild(host);
  const sidebar = h('aside', { id: 'sidebar', class: 'shrink-0', style: { width: options.sidebarWidth + 'px' } }, 'sidebar');
  const app = createApp({
    render: () => h('div', { class: 'relative flex h-screen w-screen overflow-hidden' }, [
      sidebar,
      h('div', { id: 'row', class: 'relative flex-1 min-w-0 flex h-full overflow-hidden' }, [
        h('div', { id: 'main-column', class: 'relative flex-1 min-w-0 h-full flex flex-col overflow-hidden' }, [
          h('header', { class: 'shrink-0 flex h-11 items-center px-4 border-b' }, 'header'),
          h('div', { class: 'w-full shrink-0 flex flex-col items-center' }, [
            h(ChatInputArea, {
              isDark: false,
              models: MODELS,
              selectedModelId: 'm1',
              contextUsage: { usedTokens: 24600, maxTokens: 200000 },
              onSendMessage: () => {}
            })
          ])
        ]),
        h(SubAgentSidePanel, {
          isOpen: true,
          items: SUB_ITEMS,
          activeSubId: 's1',
          isDark: false
        })
      ])
    ])
  });
  app.mount(host);
  window.__app = app;
  window.__sidebar = sidebar;
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, 300));
  return true;
};

window.__setSidebarWidth = async (width) => {
  window.__sidebar.el.style.width = width + 'px';
  await new Promise(resolve => setTimeout(resolve, 260));
  return true;
};

const round = value => Math.round(value);

window.__overflowers = () => {
  const card = document.querySelector('.max-w-lx-chat');
  if (!card) return [];
  const limit = card.getBoundingClientRect().right;
  return [...card.querySelectorAll('*')]
    .map(el => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: typeof el.className === 'string' ? el.className.slice(0, 90) : '',
        w: Math.round(rect.width),
        over: Math.round(rect.right - limit)
      };
    })
    .filter(item => item.over > 1)
    .slice(0, 12);
};

window.__geometry = () => {
  const box = selector => document.querySelector(selector);
  const row = box('#row');
  const main = box('#main-column');
  const shell = box('.sub-panel-shell');
  const panel = shell ? shell.querySelector('aside') : null;
  const card = box('.max-w-lx-chat');
  const toolbar = card ? [...card.querySelectorAll('div')].find(el => typeof el.className === 'string'
    && /justify-between/.test(el.className) && /flex-wrap/.test(el.className)) : null;
  return {
    row: row ? round(row.getBoundingClientRect().width) : 0,
    main: main ? round(main.getBoundingClientRect().width) : 0,
    panel: panel ? round(panel.getBoundingClientRect().width) : 0,
    card: card ? { client: card.clientWidth, scroll: card.scrollWidth } : null,
    toolbar: toolbar ? { client: toolbar.clientWidth, scroll: toolbar.scrollWidth, height: round(toolbar.getBoundingClientRect().height) } : null
  };
};

/** 拖分割条：mousedown 在 handle 上，再甩到 clientX，最后由 mouseup 收尾。 */
window.__dragPanelTo = async (clientX) => {
  const handle = document.querySelector('.sub-panel-shell .cursor-col-resize');
  if (!handle) throw new Error('未找到面板分割条');
  const rect = document.querySelector('.sub-panel-shell aside').getBoundingClientRect();
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: Math.round(rect.left) }));
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX }));
  await new Promise(resolve => setTimeout(resolve, 120));
  return true;
};

window.ready = true;
`);
  await fs.writeFile(path.join(output, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">'
    + '<div id="app"></div><script type="module" src="./entry.js"></script></body></html>');
}

async function buildHarness() {
  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  await build({
    configFile: false,
    root: output,
    base: './',
    plugins: [vue()],
    logLevel: 'error',
    build: { target: 'esnext', outDir: path.join(output, 'dist'), emptyOutDir: true }
  });
}

app.whenReady().then(async () => {
  const results = [];
  const runCase = async (name, body) => {
    try {
      await body();
      results.push({ name, ok: true });
      console.log(`[PASS] ${name}`);
    } catch (error) {
      results.push({ name, ok: false });
      console.log(`[FAIL] ${name}`);
      console.log('       ' + String((error && error.message) || error).split('\n').join('\n       '));
    }
  };

  try {
    await writeHarness();
    await buildHarness();
    window = new BrowserWindow({
      width: 1024, height: 720, show: false,
      webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false }
    });
    // 应用窗口最小宽度就是 1024（electron/main.cjs），窄窗口场景一律按这个宽度取证据。
    await window.loadFile(path.join(output, 'dist/index.html'));
    const evaluate = source => window.webContents.executeJavaScript(source);
    assert.equal(await evaluate('window.ready'), true, '宿主未就绪');

    await runCase('用例1 存储宽度 2000：面板被夹紧，对话列不小于 400', async () => {
      await evaluate('window.__render({ sidebarWidth: 256, storedWidth: 2000 })');
      const geo = await evaluate('window.__geometry()');
      assert.ok(geo.row > 0, '弹性行未渲染');
      assert.ok(geo.panel <= geo.row - MIN_COLUMN, `面板 ${geo.panel}px 吃掉了对话列（行宽 ${geo.row}px）`);
      assert.ok(geo.main >= MIN_COLUMN, `对话列只有 ${geo.main}px，低于最小值 ${MIN_COLUMN}px`);
    });

    await runCase('用例2 拖分割条到极限：仍夹紧在行宽减最小值', async () => {
      await evaluate('window.__dragPanelTo(0)');
      const geo = await evaluate('window.__geometry()');
      assert.ok(geo.panel <= geo.row - MIN_COLUMN, `拖拽后 ${geo.panel}px 面板压掉了对话列（行宽 ${geo.row}px）`);
      assert.ok(geo.main >= MIN_COLUMN, `拖拽后对话列只有 ${geo.main}px`);
    });

    await runCase('用例3 夹紧后的对话列里，输入卡片内容不溢出', async () => {
      const geo = await evaluate('window.__geometry()');
      assert.ok(geo.card, '输入卡片未渲染');
      if (geo.card.scroll > geo.card.client + 1) {
        console.log('       溢出元素：', JSON.stringify(await evaluate('window.__overflowers()'), null, 1));
      }
      assert.ok(geo.card.scroll <= geo.card.client + 1,
        `输入卡片内容溢出：scrollWidth ${geo.card.scroll} > clientWidth ${geo.card.client}`);
      assert.ok(geo.toolbar, '未找到底部工具栏行');
      assert.ok(geo.toolbar.scroll <= geo.toolbar.client + 1,
        `底部工具栏溢出：scrollWidth ${geo.toolbar.scroll} > clientWidth ${geo.toolbar.client}`);
    });

    await runCase('用例4 侧边栏展开（行宽缩小）后重新夹紧', async () => {
      await evaluate('window.__render({ sidebarWidth: 64, storedWidth: 2000 })');
      await evaluate('window.__setSidebarWidth(256)');
      const geo = await evaluate('window.__geometry()');
      assert.ok(geo.panel <= geo.row - MIN_COLUMN, `行宽缩小后面板 ${geo.panel}px 仍压着对话列（行宽 ${geo.row}px）`);
      assert.ok(geo.main >= MIN_COLUMN, `行宽缩小后对话列只有 ${geo.main}px`);
    });
  } catch (error) {
    console.error('窄窗口对话列验证失败:', String((error && error.message) || error));
    results.push({ name: '基础设施', ok: false });
  }

  clearTimeout(deadline);
  const failed = results.filter(item => !item.ok);
  console.log(`\n窄窗口对话列验证：${results.length - failed.length}/${results.length} 通过`);
  app.exit(failed.length === 0 ? 0 : 1);
});
