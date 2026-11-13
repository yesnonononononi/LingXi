/**
 * 用量审计面板「折叠明细」样式守卫（offscreen Electron + 真实 DOM/真实 Tailwind）。
 *
 * <p>守的是什么：`CollapseTransition` 用元素的 `scrollHeight` 当动画目标高度，而 `scrollHeight`
 * <b>不含元素自身的 margin 与 border</b>，且组件会先把 padding 清零再过渡。所以被它度量的元素
 * 一旦自带 `mt-1.5` / `border` / `p-2`，动画目标就比稳态高度小（实测少 9.5px）：
 * 展开走到头会「突然再补高一截」，收起末尾又会「塌掉残留」——用户看到的卡顿其实是这个弹跳。</p>
 *
 * <p>修法把「被度量元素」做成纯容器（无 margin/border/padding），间距改成容器内固定高度的占位，
 * 让间距与内容一起参与高度动画。本用例就守这条不变式：</p>
 * <ol>
 *   <li>被度量外壳的 margin / border / padding 全为 0 —— 缺陷回退（把盒装饰加回外壳）立刻红；</li>
 *   <li>外壳的 `scrollHeight` 与真实 `offsetHeight` 一致（≤1px）—— 度量口径与稳态高度同一；</li>
 *   <li>展开动画最后一帧高度 = 动画结束后的稳态高度（≤1px）—— 没有「末尾补高」；</li>
 *   <li>收起时元素移除前的最后一帧高度 ≤1px、下方基准回到展开前的位置（≤1px）—— 没有「末帧塌残留」。</li>
 * </ol>
 *
 * <p>三处折叠明细（动态上下文归因 / 工具来源 / 其他消息定义）逐个验证。取样一律在渲染进程内
 * 逐帧轮询（不是固定延时单点取样），避免负载下取到动画之前或之后的帧。</p>
 *
 * 运行：`cd frontend && npx electron tests/tokenAuditPanelCollapse.smoke.cjs`
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const fixture = path.resolve(__dirname, '../node_modules/.tmp/token-audit-panel-collapse');
app.setPath('userData', path.join(fixture, 'profile'));
app.on('window-all-closed', () => {});
let window;
let server;
const deadline = setTimeout(() => { console.error('用量审计面板折叠样式守卫超时'); app.exit(1); }, 180000);

const fail = message => { throw new Error(message); };

/** 含归因明细、工具分组与其他消息定义的最小快照。 */
const SNAPSHOT = {
  sessionId: 's1',
  displayState: 'COLLECTED',
  liveTotalTokens: 148200,
  liveMaxTokens: 200000,
  remainingTokens: 51800,
  totalTokens: 148200,
  capturedAt: '2026-11-09T12:00:00Z',
  messages: [
    {type: 'SYSTEM', tokens: 8000, ratio: 0.054, expandable: false},
    {type: 'DYNAMIC_CONTEXT', tokens: 12000, ratio: 0.081, expandable: false},
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
      items: Array.from({length: 6}, (_, index) => ({
        toolName: 'tool_' + String(index + 1).padStart(2, '0'),
        tokens: 1000 * (index + 1),
        ...(index === 0 ? {argumentTokens: '120', outputTokens: '360'} : {}),
      })),
    },
  },
  requestOverhead: {
    itemCount: 2,
    tokens: 5250,
    ratio: 0.02625,
    toolDefinition: {tokens: 3200, ratio: 0.021},
    mcpToolDefinition: {tokens: 2100, ratio: 0.014},
    framingResidualTokens: -50,
  },
  contextAttribution: {memoryTokens: 6400},
};
app.whenReady().then(async () => {
  await fs.mkdir(fixture, { recursive: true });

  // fixture 落在 node_modules 下，PostCSS 配置发现找不到 frontend/postcss.config.js：
  // 必须显式给插件 + `@source`，否则 Tailwind v4 不参与，`mt-1.5` / `border` / `p-2` 全都不生效，
  // 度量口径断言会变成「什么都没测」的假绿。
  await fs.writeFile(path.join(fixture, 'app.css'),
    '@import "../../../src/style.css";\n@source "../../../src";\n');

  await fs.writeFile(path.join(fixture, 'App.vue'), `<script setup>
import {ref} from 'vue';
import './app.css';
import TokenAuditPanel from '../../../src/components/chat/TokenAuditPanel.vue';
import http from '../../../src/services/interceptor';
import {recordTokenAuditSnapshot} from '../../../src/views/chat/tokenAuditStream';

http.defaults.adapter = async config => ({config, data: {code: 1, data: null}, status: 200, statusText: 'OK', headers: {}});

const open = ref(true);
window.__inject = payload => recordTokenAuditSnapshot(payload, 's1');
</script>
<template>
  <div style="position:relative;width:520px;height:420px;overflow:hidden">
    <TokenAuditPanel v-model:open="open" session-id="s1" />
  </div>
</template>`);

  await fs.writeFile(path.join(fixture, 'entry.js'), `import { createApp, nextTick } from 'vue';
import App from './App.vue';
createApp(App).mount('#app');

window.flush = async () => { await nextTick(); await new Promise(r => setTimeout(r, 520)); };
window.click = selector => {
  const el = document.querySelector(selector);
  if (!el) throw new Error('元素缺失: ' + selector);
  el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
};

/** 逐帧采样：折叠外壳高度 + 目标是否还在 DOM + 基准元素位置。 */
window.sample = (targetSelector, baseSelector, useBottom, durationMs) => new Promise(resolve => {
  const out = [];
  const start = performance.now();
  const tick = () => {
    const target = document.querySelector(targetSelector);
    const wrap = target ? target.parentElement : null;
    const base = document.querySelector(baseSelector);
    const wrapRect = wrap ? wrap.getBoundingClientRect() : null;
    const baseRect = base ? base.getBoundingClientRect() : null;
    out.push({
      present: !!target,
      wrapH: wrapRect ? Number(wrapRect.height.toFixed(2)) : null,
      base: baseRect ? Number((useBottom ? baseRect.bottom : baseRect.top).toFixed(2)) : null,
    });
    if (performance.now() - start < durationMs) requestAnimationFrame(tick);
    else resolve(out);
  };
  requestAnimationFrame(tick);
});

window.clickThenSample = (clickSelector, targetSelector, baseSelector, useBottom, durationMs) => {
  window.click(clickSelector);
  return window.sample(targetSelector, baseSelector, useBottom, durationMs);
};

/** 稳态读数：外壳盒装饰、度量口径、真实高度。 */
window.readSteady = (targetSelector, baseSelector, useBottom) => {
  const target = document.querySelector(targetSelector);
  if (!target) return null;
  const wrap = target.parentElement;
  const style = getComputedStyle(wrap);
  const base = document.querySelector(baseSelector);
  const baseRect = base ? base.getBoundingClientRect() : null;
  return {
    offsetHeight: wrap.offsetHeight,
    scrollHeight: wrap.scrollHeight,
    marginTop: style.marginTop,
    marginBottom: style.marginBottom,
    borderTopWidth: style.borderTopWidth,
    borderBottomWidth: style.borderBottomWidth,
    borderLeftWidth: style.borderLeftWidth,
    borderRightWidth: style.borderRightWidth,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    base: baseRect ? Number((useBottom ? baseRect.bottom : baseRect.top).toFixed(2)) : null,
  };
};

window.readBase = (baseSelector, useBottom) => {
  const base = document.querySelector(baseSelector);
  if (!base) return null;
  const rect = base.getBoundingClientRect();
  return Number((useBottom ? rect.bottom : rect.top).toFixed(2));
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
    css: { postcss: { plugins: [tailwind(), autoprefixer()] } },
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
  server = await preview({ configFile: false, root: fixture, preview: { host: '127.0.0.1', port: 0 } });
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

  assert(await evaluate(`!!document.querySelector('[data-testid="token-audit-panel"]')`),
    '面板未渲染: ' + consoleErrors.join(' | '));
  await run(`window.__inject(${JSON.stringify(SNAPSHOT)})`);
  /**
   * 三处折叠明细：点击入口 selector / 明细块 selector / 下方基准 selector（用 bottom 还是 top）。
   * 基准必须是「明细块之后的元素」—— 折叠让它位移，位移量就是折叠块的实际占位。
   */
  const CASES = [
    {
      name: '动态上下文归因',
      toggle: '[data-testid="token-audit-dynamic-context-row"]',
      target: '[data-testid="token-audit-dynamic-context-attribution"]',
      base: '[data-testid="token-audit-message-row"][data-category="USER"]',
      useBottom: false,
    },
    {
      name: '工具来源',
      toggle: '[data-testid="token-audit-tool-row"]',
      target: '[data-testid="token-audit-tool-sources"]',
      // TOOL 是最后一行，明细块下方没有兄弟行：用「其他消息」小节的顶边当基准
      base: '[data-testid="token-audit-overhead"]',
      useBottom: false,
    },
    {
      name: '其他消息定义',
      toggle: '[data-testid="token-audit-overhead"] button',
      target: '[data-testid="token-audit-definitions"]',
      base: '[data-testid="token-audit-overhead"]',
      useBottom: true,
    },
  ];

  const check = (condition, message) => { if (!condition) fail(message); };

  for (const item of CASES) {
    const label = '【' + item.name + '】';
    const baseline = await evaluate(`window.readBase('${item.base}', ${item.useBottom})`);
    check(baseline !== null, label + '基准元素缺失，用例无法测量位移');
    // 折叠不得把内部滚动位置顶走/吸底（面板内容变高变矮时视口要待在原处）
    const scrollBefore = await evaluate(`document.querySelector('[data-testid="token-audit-scroll"]').scrollTop`);

    // —— 展开：逐帧采样，然后读稳态 ——
    const expandSamples = await evaluate(
      `window.clickThenSample('${item.toggle}', '${item.target}', '${item.base}', ${item.useBottom}, 460)`);
    await evaluate('window.flush()');
    const steady = await evaluate(`window.readSteady('${item.target}', '${item.base}', ${item.useBottom})`);
    check(steady !== null, label + '点击后明细块未出现在 DOM 中');
    check(expandSamples.length >= 8,
      label + '展开采样帧数过少（' + expandSamples.length + ' 帧），取样逻辑失效');

    // ① 被度量外壳不得自带盒装饰（margin / border / padding 都是 scrollHeight 量不到的部分）
    const decorations = ['marginTop', 'marginBottom', 'borderTopWidth', 'borderBottomWidth',
      'borderLeftWidth', 'borderRightWidth', 'paddingTop', 'paddingBottom']
      .map(key => [key, steady[key]])
      .filter(([, value]) => Number.parseFloat(value) !== 0);
    check(decorations.length === 0,
      label + '折叠外壳自带 margin / border / padding（scrollHeight 量不到，动画目标会偏小）：'
        + JSON.stringify(decorations));

    // ② 度量口径必须与真实高度一致：scrollHeight（动画目标来源）== offsetHeight（稳态高度）
    check(Math.abs(steady.scrollHeight - steady.offsetHeight) <= 1,
      label + '折叠外壳的 scrollHeight(' + steady.scrollHeight + ') 与 offsetHeight(' + steady.offsetHeight
        + ') 不一致：动画目标高度必然与稳态高度不同');

    // ③ 展开动画最后一帧的高度 == 稳态高度（差 0，容差 1px 只吸收小数像素）
    const presentSamples = expandSamples.filter(sample => sample.present && sample.wrapH !== null);
    check(presentSamples.length >= 8, label + '展开动画期间外壳存在帧过少（' + presentSamples.length + ' 帧）');
    const lastHeight = presentSamples[presentSamples.length - 1].wrapH;
    check(Math.abs(lastHeight - steady.offsetHeight) <= 1,
      label + '展开动画结束时高度 ' + lastHeight + 'px 与稳态高度 ' + steady.offsetHeight
        + 'px 不一致（差 ' + Math.abs(lastHeight - steady.offsetHeight).toFixed(2) + 'px）'
        + '：动画走到头还会再补高一截，就是那个「弹一下」');

    // ④ 下方基准的位移必须正好等于外壳稳态高度（折叠块没有制造额外占位/跳变）
    const expandedBase = steady.base;
    check(Math.abs((expandedBase - baseline) - steady.offsetHeight) <= 1,
      label + '下方内容位移 ' + (expandedBase - baseline).toFixed(2) + 'px 与折叠块高度 '
        + steady.offsetHeight + 'px 不一致：折叠块制造了额外占位');

    // —— 收起：逐帧采样，看末帧残留与回位 ——
    const collapseSamples = await evaluate(
      `window.clickThenSample('${item.toggle}', '${item.target}', '${item.base}', ${item.useBottom}, 460)`);
    await evaluate('window.flush()');
    const collapsePresent = collapseSamples.filter(sample => sample.present && sample.wrapH !== null);
    check(collapsePresent.length >= 8,
      label + '收起动画期间外壳存在帧过少（' + collapsePresent.length + ' 帧）');
    const residual = collapsePresent[collapsePresent.length - 1].wrapH;
    check(residual <= 1,
      label + '收起动画移除元素前仍残留 ' + residual + 'px 高度：末帧会「塌一下」');
    const afterBase = await evaluate(`window.readBase('${item.base}', ${item.useBottom})`);
    check(Math.abs(afterBase - baseline) <= 1,
      label + '收起后下方内容没有回到原位（收起前 ' + baseline + 'px / 收起后 ' + afterBase
        + 'px）：收起末尾有多余占位被一次性塌掉');
    check(await evaluate(`document.querySelector('${item.target}') === null`),
      label + '收起后明细块应离开 DOM');
    const scrollAfter = await evaluate(`document.querySelector('[data-testid="token-audit-scroll"]').scrollTop`);
    check(Math.abs(scrollAfter - scrollBefore) <= 1,
      label + '展开/收起把内部滚动位置顶走了（折叠前 ' + scrollBefore + 'px / 折叠后 ' + scrollAfter + 'px）');
  }

  const realErrors = consoleErrors.filter(message => !message.startsWith('[Vue warn]'));
  assert(realErrors.length === 0, '渲染进程存在控制台错误: ' + realErrors.join(' | '));

  console.log('用量审计面板折叠样式守卫通过（三处明细：外壳无盒装饰、度量口径一致、展开末帧与稳态同高、收起无残留）');
  await server.close();
  clearTimeout(deadline);
  app.exit(0);
}).catch(async error => {
  console.error(error && error.message ? error.message : error);
  await server?.close();
  clearTimeout(deadline);
  app.exit(1);
});