/**
 * 用量审计面板「工具来源」小节的**真实布局**冒烟测试（offscreen Electron + 真实 DOM）。
 *
 * <p>几何量、可见文本和推送更新需要在真实 DOM 中验证。</p>
 * <ol>
 *   <li>逐项工具列表真的被限高成可滚动容器（`scrollHeight > clientHeight` 且能滚到底）；
 *       只断言 class 里有 `overflow-y-auto` 证明不了「工具多了不会把面板顶穿」。</li>
 *   <li>MCP / Skill 合计与逐项列表之间真的有间距（拿两个 `getBoundingClientRect()` 相减），
 *       且它们**不在**滚动容器里（否则滚动时合计会被滚出视野）。</li>
 *   <li>token 单位文案是 `token` 不是 `tok`（`\btok\b` 不会误伤 `token`，用词边界精确判定）。</li>
 *   <li>系统消息的归因明细（记忆正文）是「系统消息」下拉框里的项：默认展开、可折叠、与下方工具框左右对齐、
 *       展开走 collapse-transition 过渡；0 与未知时整块不渲染。</li>
 *   <li>滚动条出现/消失不得改变内容可用宽度（`scrollbar-gutter: stable`），否则展开下拉时整块结构横向抖一下。</li>
 * </ol>
 *
 * <p>通过流推送和 HTTP 适配器验证同一面板的展示，并守住「只读、不重算」这条边界：
 * 面板不得出现刷新重算入口，错误重试也只允许重新 GET。</p>
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
let server;
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
        ...(index === 0 ? {argumentTokens: '120', outputTokens: '360'} : {}),
        ...(index === 2 ? {argumentTokens: '0', outputTokens: '40'} : {}),
      })),
    },
  },
  requestOverhead: {
    itemCount: 2,
    // 父项 = 内核 + MCP + 残差：残差故意给负数，守住「其它」行不能让子项大过父项
    tokens: 5250,
    ratio: 0.02625,
    toolDefinition: {tokens: 3200, ratio: 0.021},
    mcpToolDefinition: {tokens: 2100, ratio: 0.014},
    framingResidualTokens: -50,
  },
  // 归因明细：记忆正文已含在 SYSTEM 的 20,000 里，只做说明、不参与合计
  contextAttribution: {memoryTokens: 6400},
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
import http from '../../../src/services/interceptor';
import {recordTokenAuditSnapshot} from '../../../src/views/chat/tokenAuditStream';

window.__requests = [];
window.__getResult = {code: 1, data: null};
http.defaults.adapter = async config => {
  window.__requests.push([config.method, config.url]);
  return {config, data: window.__getResult, status: 200, statusText: 'OK', headers: {}};
};

const open = ref(true);
const executing = ref(false);
window.__inject = payload => recordTokenAuditSnapshot(payload, 's1');
window.__setOpen = value => { open.value = value; };
window.__setExecuting = value => { executing.value = value; };
</script>
<template>
  <div style="position:relative;width:520px;height:720px">
    <TokenAuditPanel v-model:open="open" session-id="s1" :executing="executing" />
  </div>
</template>`);

  await fs.writeFile(path.join(fixture, 'entry.js'), `import { createApp, nextTick } from 'vue';
import App from './App.vue';
createApp(App).mount('#app');
window.flush = async () => { await nextTick(); await new Promise(r => setTimeout(r, 380)); };
window.nextTickOnly = async () => { await nextTick(); };
window.clickSelector = selector => {
  const el = document.querySelector(selector);
  if (!el) throw new Error('元素缺失: ' + selector);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
window.ready = true;`);

  await fs.writeFile(path.join(fixture, 'index.html'),
    '<html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module" src="./entry.js"></script></body></html>');

  const { build, preview } = await import('vite');
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
  // 用回环 HTTP 加载构建产物，避免 Chromium 拦截 file 协议下的模块脚本。
  server = await preview({configFile: false, root: fixture, preview: {host: '127.0.0.1', port: 0}});
  await window.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/`);

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
  assert(await evaluate(`!!document.querySelector('[data-testid="token-audit-panel"]')`), '面板未渲染: ' + consoleErrors.join(' | '));
  await run(`window.__inject(${JSON.stringify(SNAPSHOT)})`);
  assert(await evaluate(`!!document.querySelector('[data-testid="token-audit-tool-row"]')`), '工具返回消息行未渲染（快照未生效？）');
  await run(`window.clickSelector('[data-testid="token-audit-tool-row"]')`);
  assert(await evaluate(`!!document.querySelector('[data-testid="token-audit-tool-sources"]')`), '工具来源小节未展开');

  const readToolItem = index => evaluate(`(() => {
    const item = document.querySelectorAll('[data-testid="token-audit-tool-item"]')[${index}];
    const bar = item.querySelector('[data-testid="token-audit-tool-io-bar"]');
    const parts = bar ? Array.from(bar.children) : [];
    return {
      text: item.innerText,
      colors: parts.map(part => getComputedStyle(part).backgroundColor),
      widths: parts.map(part => part.getBoundingClientRect().width),
    };
  })()`);
  await run('window.__setExecuting(true)');
  const sourceLine = '[data-testid="token-audit-source"]';
  const sourceText = () => evaluate(`document.querySelector('${sourceLine}')?.innerText`);
  assert(await sourceText() === '执行中，明细仍来自最近一次审计快照',
    '执行中应声明明细来自最近一次审计快照');
  const first = await readToolItem(0);
  assert(/入参\s+120/.test(first.text) && /输出\s+360/.test(first.text) && first.text.includes('1,000'),
    '入参、输出与框架总量应分别展示');
  assert(first.colors.length === 2 && first.colors[0] !== first.colors[1], '色条应有两种颜色');
  assert(Math.abs(first.widths[0] / first.widths[1] - 1 / 3) < 0.02, '参数与输出宽度应为 1:3');
  assert((await readToolItem(1)).widths.length === 0, '旧快照缺少拆分时不画色条');
  const zero = await readToolItem(2);
  assert(zero.widths[0] === 0 && zero.widths[1] > 0 && /入参\s+0/.test(zero.text), '显式零值应保留');

  const next = structuredClone(SNAPSHOT);
  next.displayState = 'CAPTURING';
  next.liveTotalTokens = next.totalTokens + 80;
  next.driftTokens = 80;
  next.tools.ordinary.items[0].argumentTokens = 800;
  next.tools.ordinary.items[0].outputTokens = 200;
  await run(`window.__inject(${JSON.stringify(next)})`);
  assert(!(await evaluate(`document.querySelector('[data-testid="token-audit-panel"]').innerText.includes('当前比快照')`)),
    '不再展示「当前比快照多/少」这类差额提醒');
  const updated = await readToolItem(0);
  assert(/入参\s+800/.test(updated.text) && /输出\s+200/.test(updated.text), '推送应更新已展开行');
  assert(Math.abs(updated.widths[0] / updated.widths[1] - 4) < 0.05, '色条应随推送更新为 4:1');
  await run('window.__setExecuting(false)');
  assert(await sourceText() === '明细来自最近一次审计快照', '非执行中仍常显来源说明');

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

  // ④' 其他消息：父项必须有金额，展开后子项 + 「其它」残差必须等于父项
  const overheadTotal = await evaluate(`document.querySelector('[data-testid="token-audit-overhead-total"]')?.innerText || ''`);
  assert(/5,250/.test(overheadTotal), '其他消息父项必须显示金额，实际: ' + JSON.stringify(overheadTotal));
  assert(/2\.6%/.test(overheadTotal), '其他消息父项应显示占比，实际: ' + JSON.stringify(overheadTotal));
  await run(`window.clickSelector('[data-testid="token-audit-overhead"] button')`);
  const framing = await evaluate(`(() => {
    const root = document.querySelector('[data-testid="token-audit-definitions"]');
    const hint = document.querySelector('[data-testid="token-audit-framing-hint"]');
    return {
      text: root ? root.innerText : '',
      rows: root ? root.children.length : 0,
      title: hint ? hint.getAttribute('title') : null,
    };
  })()`);
  assert(framing.rows === 4, '定义小节省略表头后应有内核 / MCP / 其它三行，实际行数: ' + framing.rows);
  assert(/其它/.test(framing.text) && /-50/.test(framing.text),
    '残差应显示为「其它」并保留负号，实际: ' + JSON.stringify(framing.text));
  assert(!!framing.title && /分词/.test(framing.title),
    '「其它」旁应有感叹号提示，hover 说明是分词偏差，实际: ' + JSON.stringify(framing.title));

  // ④'' 占比分母口径必须写出来：框架 ratio 一律除上下文上限，不标就永远「加不起来」
  const ratioScope = await evaluate(`document.querySelector('[data-testid="token-audit-ratio-scope"]')?.innerText || ''`);
  assert(/占上下文上限/.test(ratioScope),
    '「消息构成」旁应标明占比分母是上下文上限，实际: ' + JSON.stringify(ratioScope));

  // ④''' 系统消息的归因明细（记忆正文）：挂在系统消息下方，且不新增一个消息分项
  const attribution = await evaluate(`(() => {
    const root = document.querySelector('[data-testid="token-audit-system-attribution"]');
    const hint = document.querySelector('[data-testid="token-audit-attribution-hint"]');
    const systemRow = document.querySelector('[data-testid="token-audit-message-row"][data-category="SYSTEM"]');
    const toolSources = document.querySelector('[data-testid="token-audit-tool-sources"]');
    return {
      text: root ? root.innerText : null,
      title: hint ? hint.getAttribute('title') : null,
      rowCount: document.querySelectorAll('[data-testid="token-audit-message-row"]').length,
      insideSystemRow: !!(root && systemRow && systemRow.contains(root)),
      insideToolSources: !!(root && toolSources && toolSources.contains(root)),
    };
  })()`);
  assert(attribution.text !== null, '系统消息下方应渲染记忆正文归因行');
  assert(/记忆正文/.test(attribution.text) && /6,400/.test(attribution.text),
    '记忆归因行应显示「记忆正文」与金额，实际: ' + JSON.stringify(attribution.text));
  assert(!/%/.test(attribution.text), '记忆归因行不得出现百分比（后端不给占比，前端不许补算）');
  assert(attribution.insideSystemRow, '记忆归因行必须挂在系统消息行内');
  assert(attribution.insideToolSources === false, '记忆归因行不得混进工具来源小节');
  assert(attribution.rowCount === 4,
    '记忆归因不得新增消息分项（应仍是系统/用户/模型/工具返回四行），实际: ' + attribution.rowCount);
  assert(!!attribution.title && /系统消息/.test(attribution.title),
    '记忆归因旁应有提示，说明已含在系统消息内，实际: ' + JSON.stringify(attribution.title));

  // ④'''' 记忆项是「系统消息」下拉框里的项：可折叠、默认展开、容器与下方工具框左右对齐
  const alignment = await evaluate(`(() => {
    const button = document.querySelector('[data-testid="token-audit-system-row"]');
    const attr = document.querySelector('[data-testid="token-audit-system-attribution"]');
    const sources = document.querySelector('[data-testid="token-audit-tool-sources"]');
    const rect = el => { const r = el.getBoundingClientRect(); return {left: Math.round(r.left), right: Math.round(r.right)}; };
    return {
      hasButton: !!button,
      expanded: button ? button.getAttribute('aria-expanded') : null,
      attr: attr ? rect(attr) : null,
      sources: sources ? rect(sources) : null,
      header: attr ? (attr.firstElementChild ? attr.firstElementChild.innerText.replace(/\\s+/g, ' ').trim() : '') : '',
    };
  })()`);
  assert(alignment.hasButton, '系统消息行应变成可展开按钮（记忆项是下拉框里的项）');
  assert(alignment.expanded === 'true', '记忆明细默认展开（否则等于又看不到记忆用量）');
  assert(alignment.attr !== null, '默认展开时记忆项应在 DOM 中');
  assert(/系统消息构成/.test(alignment.header) && /token/.test(alignment.header),
    '记忆下拉框应有与工具来源同款的表头，实际: ' + JSON.stringify(alignment.header));
  assert(alignment.attr.left === alignment.sources.left && alignment.attr.right === alignment.sources.right,
    '记忆下拉框必须与下方工具来源框左右对齐，实测 ' + JSON.stringify([alignment.attr, alignment.sources]));

  // 折叠：点一次收起（记忆块消失、aria-expanded 翻转），再点恢复
  await run(`window.clickSelector('[data-testid="token-audit-system-row"]')`);
  const collapsed = await evaluate(`(() => {
    const button = document.querySelector('[data-testid="token-audit-system-row"]');
    return {
      expanded: button ? button.getAttribute('aria-expanded') : null,
      attr: !!document.querySelector('[data-testid="token-audit-system-attribution"]'),
    };
  })()`);
  assert(collapsed.expanded === 'false', '点击后 aria-expanded 应为 false');
  assert(collapsed.attr === false, '收起后记忆块应离开 DOM（不是只改高度）');
  // 展开第一帧就取样：run() 会等到动画结束，那时 Transition 的 enter class 已经摘掉
  await evaluate(`window.clickSelector('[data-testid="token-audit-system-row"]')`);
  await evaluate('window.nextTickOnly()');
  const entering = await evaluate(`(() => {
    const el = document.querySelector('[data-testid="token-audit-system-attribution"]');
    return el ? el.className : null;
  })()`);
  await evaluate('window.flush()');
  assert(await evaluate(`!!document.querySelector('[data-testid="token-audit-system-attribution"]')`),
    '再次点击应重新展开记忆块');
  assert(entering !== null && /collapse-transition-enter-active/.test(entering),
    '记忆下拉框展开应有折叠过渡（缺少 collapse-transition-enter-active），实际 class: ' + JSON.stringify(entering));

  // 记忆为 0（这一轮没注入记忆正文）或未知时整行不渲染：0 是噪声、null 是不知道
  await run(`window.__inject(${JSON.stringify({...SNAPSHOT, contextAttribution: {memoryTokens: 0}})})`);
  assert(await evaluate(`document.querySelector('[data-testid="token-audit-system-attribution"]') === null`),
    '记忆为 0 时不应渲染归因行');
  await run(`window.__inject(${JSON.stringify({...SNAPSHOT, contextAttribution: null})})`);
  assert(await evaluate(`document.querySelector('[data-testid="token-audit-system-attribution"]') === null`),
    '后端未给归因明细时不应渲染归因行（不得猜 0）');
  await run(`window.__inject(${JSON.stringify(SNAPSHOT)})`);
  assert(await evaluate(`!!document.querySelector('[data-testid="token-audit-system-attribution"]')`),
    '恢复完整快照后归因行应重新出现');

  // ④''''' 滚动条不得挤窄内容：展开下拉让内容变高、滚动条出现时，整块不能横向抖一下
  const widthGap = () => evaluate(`(() => {
    const box = document.querySelector('[data-testid="token-audit-scroll"]');
    return box ? box.offsetWidth - box.clientWidth : null;
  })()`);
  const isScrolling = () => evaluate(`(() => {
    const box = document.querySelector('[data-testid="token-audit-scroll"]');
    return box ? box.scrollHeight > box.clientHeight : null;
  })()`);
  const shortSnapshot = {
    ...SNAPSHOT,
    tools: null,
    requestOverhead: null,
    contextAttribution: null,
    messages: [{type: 'SYSTEM', tokens: 9953, ratio: 0.039, expandable: false}],
  };
  await run(`window.__inject(${JSON.stringify(shortSnapshot)})`);
  const gapNoScroll = await widthGap();
  assert(await isScrolling() === false, '短快照用例前提不成立：此时内容不应产生滚动');
  await run(`window.__inject(${JSON.stringify(SNAPSHOT)})`);
  const gapScrolled = await widthGap();
  assert(await isScrolling() === true, '长快照用例前提不成立：此时内容应产生滚动');
  assert(gapScrolled > 0,
    '滚动条在本次环境里不占宽度（实测 ' + gapScrolled + 'px），本条守卫会变成空转，需改用可测量的滚动条形态');
  assert(gapNoScroll === gapScrolled,
    '滚动条出现改变了内容可用宽度（缺 scrollbar-gutter:stable），不滚动时 ' + gapNoScroll + 'px / 滚动时 ' + gapScrolled + 'px');

  // ⑤ 刷新重算已移除：按钮不存在，且任何交互都不得再打 POST
  assert(await evaluate(`document.querySelector('[data-testid="token-audit-refresh"]') === null`),
    '刷新按钮应已移除（后端重算与终态采集同源，结果必然相同）');

  const error = '[data-testid="token-audit-error"]';
  const contextText = () => evaluate(`document.querySelector('[data-testid="token-audit-context"]').innerText`);
  const previousContext = await contextText();
  // 收起重开触发一次 GET 失败（错误卡片），已展示的快照必须留住
  await run(`window.__getResult = {code: 0}; window.__setOpen(false);`);
  await run(`window.__setOpen(true);`);
  assert(await evaluate(`!!document.querySelector('${error}')`), '加载失败时应显示错误');
  assert(await contextText() === previousContext, '加载失败时应保留上次审计');

  // 重试重新走 GET（不再是重算），返回值成为展示源
  const reloaded = {...SNAPSHOT, liveTotalTokens: 92000, remainingTokens: 108000, totalTokens: 92000};
  await run(`window.__getResult = {code: 1, data: ${JSON.stringify(reloaded)}};
    window.clickSelector('${error} button');`);
  assert((await contextText()).includes('92,000'), '重试结果应替换上一条推送');
  assert(await evaluate(`document.querySelector('${error}') === null`), '重试成功应清除错误');

  // 之后到来的推送仍然优先，且面板不做任何写操作
  const pushed = {...SNAPSHOT, liveTotalTokens: 96000, remainingTokens: 104000, totalTokens: 96000};
  await run(`window.__inject(${JSON.stringify(pushed)});`);
  assert((await contextText()).includes('96,000'), '推送应继续覆盖 GET 结果');
  assert(JSON.stringify(await evaluate('window.__requests')) === JSON.stringify([
    ['get', '/session/s1/token-audit'],
    ['get', '/session/s1/token-audit'],
    ['get', '/session/s1/token-audit'],
  ]), '打开与重试都只发 GET，不得出现 POST 重算');

  const realErrors = consoleErrors.filter(message => !message.startsWith('[Vue warn]'));
  assert(realErrors.length === 0, '渲染进程存在控制台错误: ' + realErrors.join(' | '));

  console.log('用量审计面板冒烟测试通过（只读快照、双色条和滚动布局）');
  await server.close();
  clearTimeout(deadline);
  app.exit(0);
}).catch(async error => {
  console.error(error && error.message ? error.message : error);
  await server?.close();
  clearTimeout(deadline);
  app.exit(1);
});
