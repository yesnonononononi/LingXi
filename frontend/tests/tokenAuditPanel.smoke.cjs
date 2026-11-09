/**
 * 用量审计面板「工具来源」小节的**真实布局**冒烟测试（offscreen Electron + 真实 DOM）。
 *
 * <p>为什么不用静态断言：这次要钉的三件事全是**几何量与可见文本**——</p>
 * <ol>
 *   <li>逐项工具列表真的被限高成可滚动容器（`scrollHeight > clientHeight` 且能滚到底）；
 *       只断言 class 里有 `overflow-y-auto` 证明不了「工具多了不会把面板顶穿」。</li>
 *   <li>MCP / Skill 合计与逐项列表之间真的有间距（拿两个 `getBoundingClientRect()` 相减），
 *       且它们**不在**滚动容器里（否则滚动时合计会被滚出视野）。</li>
 *   <li>token 单位文案是 `token` 不是 `tok`（`\btok\b` 不会误伤 `token`，用词边界精确判定）。</li>
 * </ol>
 *
 * <p>数据走「流推送」通道注入（`recordTokenAuditSnapshot`）：面板的 GET 被桩成成功但无数据，
 * 所以这里不需要后端，也不需要等网络超时。</p>
 *
 * 运行：`cd frontend && npx electron tests/tokenAuditPanel.smoke.cjs`
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const fixture = path.resolve(__dirname, '../node_modules/.tmp/token-audit-panel');
app.setPath('userData', path.join(fixture, 'profile'));
app.on('window-all-closed', () => {});
let window;
const deadline = setTimeout(() => { console.error('用量审计面板冒烟超时'); app.exit(1); }, 120000);

const fail = message => { throw new Error(message); };

/** 12 个普通工具（远超限高能容纳的行数）+ MCP + Skill 分组。 */
const SNAPSHOT = {
  sessionId: 's1',
  displayState: 'COLLECTED',
  liveTotalTokens: 148200,
  liveMaxTokens: 200000,
  remainingTokens: 51800,
  totalTokens: 148200,
  capturedAt: '2026-11-09T12:00:00Z',
  messages: [
    {type: 'SYSTEM', tokens: 20000, ratio: 0.135, expandable: false},
    {type: 'USER', tokens: 12000, ratio: 0.081, expandable: false},
    {type: 'AI', tokens: 11000, ratio: 0.074, expandable: false},
    {type: 'TOOL', tokens: 105200, ratio: 0.71, expandable: true},
  ],
  tools: {
    tokens: 105200,
    ratio: 0.71,
    mcp: {groupKind: 'MCP', tokens: 4000, ratio: 0.038},
    skill: {groupKind: 'SKILL', tokens: 6000, ratio: 0.057},
    ordinary: {
      items: Array.from({length: 12}, (_, index) => ({
        toolName: 'tool_' + String(index + 1).padStart(2, '0'),
        tokens: 1000 * (index + 1),
      })),
    },
  },
  requestOverhead: {itemCount: 2, toolDefinition: {tokens: 3200, ratio: 0.021}, mcpToolDefinition: {tokens: 2100, ratio: 0.014}},
};

app.whenReady().then(async () => {
  await fs.mkdir(fixture, { recursive: true });

  // 真实 Tailwind 工具类必须进产物：本用例断的是 `max-h-32` / `overflow-y-auto` 的**实际效果**，
  // 少了这一步页面只有无样式的 div，滚动条与限高都不会出现（假绿）。`@source` 兜住自动扫描
  // 到不了 fixture（它在 node_modules 里，被默认忽略）的情况。
  await fs.writeFile(path.join(fixture, 'app.css'),
    '@import "../../../src/style.css";\n@source "../../../src";\n');

  await fs.writeFile(path.join(fixture, 'App.vue'), `<script setup>
import {ref} from 'vue';
import './app.css';
import TokenAuditPanel from '../../../src/components/chat/TokenAuditPanel.vue';
import {TokenAuditAPI} from '../../../src/services/tokenAudit';
import {recordTokenAuditSnapshot} from '../../../src/views/chat/tokenAuditStream';

// 面板打开时会 GET 一次：桩成「成功但无数据」，让用例不依赖后端、也不产生网络错误噪音。
TokenAuditAPI.tokenAudit = async () => ({code: 1, data: null});

const open = ref(true);
window.__inject = payload => recordTokenAuditSnapshot(payload, 's1');
window.__setOpen = value => { open.value = value; };
</script>
<template>
  <div style="position:relative;width:520px;height:720px">
    <TokenAuditPanel v-model:open="open" session-id="s1" />
  </div>
</template>`);

  await fs.writeFile(path.join(fixture, 'entry.js'), `import { createApp, nextTick } from 'vue';
import App from './App.vue';
createApp(App).mount('#app');
window.flush = async () => { await nextTick(); await new Promise(r => setTimeout(r, 80)); };
window.clickSelector = selector => {
  const el = document.querySelector(selector);
  if (!el) throw new Error('元素缺失: ' + selector);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
window.ready = true;`);

  await fs.writeFile(path.join(fixture, 'index.html'),
    '<html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');

  const { build } = await import('vite');
  const { default: vue } = await import('@vitejs/plugin-vue');
  const tailwind = (await import('@tailwindcss/postcss')).default;
  const autoprefixer = (await import('autoprefixer')).default;
  await build({
    configFile: false, root: fixture, base: './', plugins: [vue()], logLevel: 'error',
    // fixture 在 node_modules/.tmp 下，PostCSS 配置发现找不到 frontend/postcss.config.js，
    // 必须显式给插件，否则 Tailwind v4 完全不参与（`@import "tailwindcss"` 变成空产物）。
    css: {postcss: {plugins: [tailwind(), autoprefixer()]}},
    build: { target: 'esnext', outDir: path.join(fixture, 'dist'), emptyOutDir: true },
  });

  window = new BrowserWindow({
    width: 640, height: 800, show: false,
    webPreferences: { contextIsolation: true, offscreen: true, backgroundThrottling: false },
  });
  const consoleErrors = [];
  window.webContents.on('console-message', event => {
    if (event.level === 'error') consoleErrors.push(event.message);
  });
  await window.loadFile(path.join(fixture, 'dist/index.html'));

  const evaluate = async source => {
    try { return await window.webContents.executeJavaScript(source); }
    catch (error) { throw new Error('渲染进程求值失败: ' + source, { cause: error }); }
  };
  const run = async source => { await evaluate(source); await evaluate('window.flush()'); };

  for (let i = 0; i < 200 && !(await evaluate('window.ready === true')); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  const assert = (condition, message) => { if (!condition) fail(message); };

  // 挂载 → 注入快照 → 展开「工具返回消息」二级拆解
  assert(await evaluate(`!!document.querySelector('[data-testid="token-audit-panel"]')`), '面板未渲染');
  await run(`window.__inject(${JSON.stringify(SNAPSHOT)})`);
  assert(await evaluate(`!!document.querySelector('[data-testid="token-audit-tool-row"]')`), '工具返回消息行未渲染（快照未生效？）');
  await run(`window.clickSelector('[data-testid="token-audit-tool-row"]')`);
  assert(await evaluate(`!!document.querySelector('[data-testid="token-audit-tool-sources"]')`), '工具来源小节未展开');

  const data = await evaluate(`(() => {
    const panel = document.querySelector('[data-testid="token-audit-panel"]');
    const box = document.querySelector('[data-testid="token-audit-tool-items"]');
    const groups = document.querySelector('[data-testid="token-audit-tool-groups"]');
    const text = panel ? panel.innerText : '';
    const style = box ? getComputedStyle(box) : null;
    const boxRect = box ? box.getBoundingClientRect() : null;
    const groupsRect = groups ? groups.getBoundingClientRect() : null;
    const scrollable = box ? box.scrollHeight > box.clientHeight + 2 : false;
    const scrolledTo = box ? (box.scrollTop = 1e6, box.scrollTop) : 0;
    return {
      unitTok: /\\btok\\b/.test(text),
      unitToken: /\\btoken\\b/.test(text),
      itemCount: box ? box.children.length : 0,
      overflowY: style ? style.overflowY : null,
      clientHeight: box ? box.clientHeight : null,
      scrollHeight: box ? box.scrollHeight : null,
      scrollable,
      scrolledTo,
      gap: boxRect && groupsRect ? Math.round(groupsRect.top - boxRect.bottom) : null,
      groupsText: groups ? groups.innerText : '',
      groupsInsideItems: !!(box && groups && box.contains(groups)),
      panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : null,
    };
  })()`);

  // ① 单位文案：token，不再是 tok（\\btok\\b 用词边界，不会被 token 误命中）
  assert(data.unitTok === false, '面板仍在用缩写 tok（应统一为 token）');
  assert(data.unitToken === true, '面板未渲染 token 单位文案');

  // ② 逐项工具：12 项全在 DOM，但容器限高且真的可滚
  assert(data.itemCount === 12, '逐项工具应渲染 12 条，实际 ' + data.itemCount);
  assert(data.overflowY === 'auto', '逐项工具容器必须是 overflow-y:auto，实际 ' + data.overflowY);
  assert(data.clientHeight !== null && data.clientHeight <= 132,
    '逐项工具容器必须被限高（max-h-32=128px），实际 clientHeight=' + data.clientHeight);
  assert(data.scrollable, '逐项工具容器未形成滚动（scrollHeight=' + data.scrollHeight + ' clientHeight=' + data.clientHeight + '）');
  assert(data.scrolledTo > 0, '逐项工具容器无法滚动到下方内容（scrollTop 恒 0）');

  // ③ 与 MCP / Skill 的间距：有留白，且合计不在滚动容器内
  assert(data.gap !== null && data.gap >= 6,
    'MCP / Skill 与逐项工具之间缺少间距（实测 ' + data.gap + 'px，要求 ≥6px）');
  assert(data.groupsInsideItems === false, 'MCP / Skill 合计被放进了滚动容器（滚动时会跟着滚走）');
  assert(data.groupsText.includes('MCP') && data.groupsText.includes('Skill'),
    'MCP / Skill 分组合计缺失，实际文本: ' + JSON.stringify(data.groupsText));

  // ④ 面板整体仍受控：12 个工具 + 3 个分组也没把浮层顶穿
  assert(data.panelHeight !== null && data.panelHeight <= 720,
    '面板高度超出可视区（' + data.panelHeight + 'px），说明限高没生效');

  const realErrors = consoleErrors.filter(message => !message.startsWith('[Vue warn]'));
  assert(realErrors.length === 0, '渲染进程存在控制台错误: ' + realErrors.join(' | '));

  console.log('用量审计面板工具来源小节冒烟测试全部通过（单位文案 / 滚动限高 / 间距 / 面板高度）');
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => {
  console.error(error && error.message ? error.message : error);
  clearTimeout(deadline);
  app.exit(1);
});
