/**
 * 交互态（hover）运行时验证。
 *
 * 为什么需要它：静态等价门禁只能证明「类名改写前后等价」，证明不了「悬停时浏览器算出来的
 * 颜色确实是某个令牌值」。而 hover 折叠恰恰是把 `hover:text-gray-700 dark:hover:text-gray-200`
 * 这类相邻对折成 `hover:text-lx-secondary`——一旦折叠写错（例如把 secondary 写成 tertiary、
 * 或 hover 变体丢了），静态门禁的原子计数启发式可能放过，只有真的进入 hover 状态才能抓到。
 *
 * 做法：挂载**真实组件**（不是复制类名的假元素），用生产 CSS，通过 CDP 的
 * `CSS.forcePseudoState` 强制 hover（offscreen 下鼠标命中测试不可靠，不能用 sendInputEvent），
 * 采集「基色 → hover 色 → 期望令牌色」三方对照，并对每个目标在明暗两态各截一张图。
 *
 * 三条断言，缺一条就会退化成「拍张图自我安慰」：
 *  1) 目标元素存在且可见（否则是空图基线）；
 *  2) hover 后颜色 ≠ 未 hover 基色（证明 hover 规则真的命中）；
 *  3) hover 后颜色 == 令牌在当前主题下的值（证明折叠无视觉漂移）。
 *
 * 主题沿用 `useTheme` 的生产切换路径（而不是测试自造的 setDark），并用 kit 的
 * `assertThemeApplied` 断言主题真的翻转，避免「拿亮色当暗色基线」的假基线。
 *
 * 用法（frontend 目录）：
 *   npx electron scripts/visual/hover-states.cjs --mode baseline
 *   npx electron scripts/visual/hover-states.cjs --mode check
 *   npx electron scripts/visual/hover-states.cjs --selfcheck
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const kit = require('./scene-kit.cjs');

const WORK = kit.sceneDir('hover-states');
const OUT_ROOT = path.join(kit.ARTIFACT_ROOT, 'hover');
const BASE_DIR = path.join(OUT_ROOT, 'baseline');
const CUR_DIR = path.join(OUT_ROOT, 'current');
const DIFF_DIR = path.join(OUT_ROOT, 'diff');
const TOKENS = kit.readTokenValues();

const argv = process.argv.slice(2);
const argOf = (key, fb) => { const i = argv.indexOf(`--${key}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fb; };
const MODE = argOf('mode', 'baseline');
const SELFCHECK = argv.includes('--selfcheck');
/** 诊断模式：打印各场景渲染出的按钮清单，用于定位「目标元素找不到」。 */
const DUMP = argv.includes('--dump');

/** selfcheck 用的错误期望色：故意让「期望 == 令牌值」这条断言不可能成立。 */
const BROKEN_EXPECT = 'rgb(255, 0, 255)';
/** hover 过渡（transition-colors）要走完，否则取到的是动画中间值。 */
const TRANSITION_SETTLE_MS = 380;

/**
 * 场景稳定性样式：只注入到隔离场景，不动生产 CSS。
 * 为什么要它：PlanCard 的 Tip 输入框有闪烁光标、卡片有入场过渡，这些都会让同一份代码
 * 两次截图的像素不一致（实测会出现「代码没改却红了」的假红）。采色前就必须是终态，
 * 因此统一关掉光标闪烁/动画/过渡——这不改变任何目标色值，只消除时间维度的噪声。
 */
const STABILIZE_CSS = '*, *::before, *::after { caret-color: transparent !important;'
  + ' animation: none !important; transition: none !important; }';

/**
 * 五个已折叠的 hover 目标。
 * `find` 是渲染器里执行的定位表达式：按结构/文案定位到**真实组件渲染出来的那个元素**，
 * 定位后临时打 `data-hover-probe` 标记，供 CDP 的 DOM.querySelector 拿到 nodeId。
 */
const TARGETS = [
  {
    key: 'chat-copy',
    desc: 'ChatMessageItem 工具详情区「复制」按钮（需先展开工具行）',
    token: '--lx-text-secondary',
    prep: 'expandChatTool',
    find: `(() => { const s = document.querySelector('[data-scene="chat"]'); if (!s) return null;
      return [...s.querySelectorAll('button')].find((b) => b.textContent.trim() === '复制') || null; })()`,
  },
  {
    key: 'plan-collapse',
    desc: 'PlanCard 提示块「收起」按钮（需先点「增加 Tip」进入输入态）',
    token: '--lx-text-secondary',
    prep: 'planAddTip',
    find: `(() => { const s = document.querySelector('[data-scene="plan"]'); if (!s) return null;
      return [...s.querySelectorAll('button')].find((b) => b.textContent.trim() === '收起') || null; })()`,
  },
  {
    key: 'sidebar-workspace',
    desc: 'Sidebar 折叠态工作区入口',
    token: '--lx-text-secondary',
    prep: null,
    find: `document.querySelector('[data-scene="sidebar"] div[title="ws-alpha"]')`,
  },
  {
    key: 'choice-collapse',
    desc: 'RequireChoiceCard 已决态「折叠」按钮',
    token: '--lx-text-tertiary',
    prep: null,
    find: `document.querySelectorAll('[data-scene="choice"] button[aria-label]')[0] || null`,
  },
  {
    key: 'choice-close',
    desc: 'RequireChoiceCard 已决态「关闭」按钮',
    token: '--lx-text-tertiary',
    prep: null,
    find: `document.querySelectorAll('[data-scene="choice"] button[aria-label]')[1] || null`,
  },
];

const imp = (rel) => kit.relFrom(WORK, path.join(kit.FRONTEND_ROOT, rel));

const APP_VUE = `<script setup>
import { nextTick } from 'vue';
import ChatMessageItem from '${imp('src/components/chat/ChatMessageItem.vue')}';
import PlanCard from '${imp('src/components/chat/PlanCard.vue')}';
import Sidebar from '${imp('src/components/chat/Sidebar.vue')}';
import RequireChoiceCard from '${imp('src/components/chat/RequireChoiceCard.vue')}';
import { useTheme } from '${imp('src/composables/useTheme')}';
import '${imp('src/style.css')}';

// 走生产切换路径：主题状态是模块级单例，useTheme 会把 class/data-theme 双写到根节点。
const { isDark, setTheme } = useTheme();

const chatMessage = {
  id: 'm1', role: 'assistant', content: '', timestamp: 0,
  toolCalls: [{
    id: 't1', toolName: 'write_file', status: 'success', order: 1,
    arguments: '{"path":"/tmp/a.txt"}', result: 'ok', workDir: '/workspace'
  }]
};
const planCard = {
  kind: 'PLAN', toolCallId: 'plan-0', conversationId: '42', version: '2',
  title: '计划标题', content: '计划正文', status: 'pending', pending: true, allowedActions: ['APPROVE']
};
// pending:false = 已决态，才会渲染折叠/关闭两个按钮（见 RequireChoiceCard isResolved）
const choiceCard = {
  kind: 'CHOICE', toolCallId: 'choice-0', conversationId: '42', version: '2',
  title: '选择交付方式？', content: '选择交付方式？', options: ['源码', '安装包'],
  status: 'completed', pending: false, allowedActions: ['ANSWER']
};
const workspaces = [{ id: 1, name: 'ws-alpha', workDir: '/ws-alpha' }];

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
window.setDark = async (value) => { setTheme(value === 'dark' ? 'dark' : 'light'); await nextTick(); await settle(90); };
window.expandChatTool = async () => {
  // 两级展开：先展开「已调用 N 个工具」的过程折叠区，再展开具体工具行，
  // 工具详情卡片里的「复制」按钮才会被渲染出来（见 ChatMessageItem 模板）。
  // 幂等：切主题不会重置组件内部展开态，重复点击会把区域又收起来，所以先探测再点。
  const s = document.querySelector('[data-scene="chat"]');
  if (!s) return;
  if (!s.querySelector('button[aria-expanded]')) {
    const group = [...s.querySelectorAll('button')]
      .find((b) => (b.textContent || '').includes('个工具'));
    if (group) group.click();
    await settle(300);
  }
  const row = [...s.querySelectorAll('button[aria-expanded]')]
    .find((b) => b.getAttribute('aria-expanded') !== 'true');
  if (row) row.click();
  await settle(320);
};
window.planAddTip = async () => {
  const s = document.querySelector('[data-scene="plan"]');
  if (!s) return;
  // 幂等：已经处于输入态（出现「收起」）时不要再点「增加 Tip」，否则会退回按钮态。
  const hasCollapse = [...s.querySelectorAll('button')].some((x) => x.textContent.trim() === '收起');
  if (!hasCollapse) {
    const b = [...s.querySelectorAll('button')].find((x) => x.textContent.trim() === '增加 Tip');
    if (b) b.click();
    await settle(320);
  }
};
</script>
<template>
  <main style="width:720px;margin:0 auto;padding:20px;font-family:system-ui,sans-serif">
    <section data-scene="chat" style="padding:6px 0">
      <ChatMessageItem :message="chatMessage" :is-dark="isDark" session-id="42" />
    </section>
    <section data-scene="plan" style="padding:6px 0">
      <PlanCard :prompt-card="planCard" :is-dark="isDark" session-id="42" />
    </section>
    <section data-scene="sidebar" style="height:200px;padding:6px 0">
      <Sidebar :sessions="[]" :active-session-id="null" :workspaces="workspaces"
               :is-collapsed="true" :is-dark="isDark" />
    </section>
    <section data-scene="choice" style="padding:6px 0">
      <RequireChoiceCard :prompt-card="choiceCard" :is-dark="isDark" />
    </section>
  </main>
</template>`;

const ENTRY_JS = `import { createApp, nextTick } from 'vue';
localStorage.setItem('lingxi-locale', 'zh-CN');
window.flush = async () => { await nextTick(); await new Promise((r) => setTimeout(r, 120)); };
const { default: App } = await import('./App.vue');
createApp(App).mount('#app');
window.ready = true;`;

/** CDP：把某个探针节点强制置为 hover（或用 [] 取消）。 */
async function forceHover(dbg, key, on) {
  const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 1 });
  const { nodeId } = await dbg.sendCommand('DOM.querySelector', {
    nodeId: root.nodeId, selector: `[data-hover-probe="${key}"]`,
  });
  if (!nodeId) throw new Error(`CDP 未找到探针节点：${key}`);
  await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: on ? ['hover'] : [] });
}

/** 在目标元素上打探针标记并读基色；返回 found/visible/baseColor。 */
function markExpr(target) {
  return `(() => {
    document.querySelectorAll('[data-hover-probe]').forEach((n) => n.removeAttribute('data-hover-probe'));
    const el = (${target.find});
    if (!el) return { found: false };
    el.setAttribute('data-hover-probe', '${target.key}');
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    return { found: true, visible, baseColor: cs.color, text: (el.textContent || '').trim().slice(0, 24) };
  })()`;
}

async function captureTheme(scene, theme, outDir, { breakExpect = false } = {}) {
  const { win, evaluate } = scene;
  await evaluate(`window.setDark('${theme}')`);
  await evaluate('window.flush()');
  await kit.assertThemeApplied(evaluate, theme, TOKENS);

  const results = {};
  for (const t of TARGETS) {
    if (t.prep) {
      await evaluate(`window.${t.prep}()`);
      await evaluate('window.flush()');
    }
    const info = await evaluate(markExpr(t));
    if (!info.found) throw new Error(`[${theme}] ${t.key} 目标不存在（${t.desc}）`);
    if (!info.visible) throw new Error(`[${theme}] ${t.key} 目标不可见（${t.desc}），截图会是空图`);

    await forceHover(win.webContents.debugger, t.key, true);
    await new Promise((r) => setTimeout(r, TRANSITION_SETTLE_MS));
    const hovered = await evaluate(
      `getComputedStyle(document.querySelector('[data-hover-probe="${t.key}"]')).color`);
    await fsp.mkdir(outDir, { recursive: true });
    const png = await win.webContents.capturePage();
    await fsp.writeFile(path.join(outDir, `${theme}-${t.key}.png`), png.toPNG());
    await forceHover(win.webContents.debugger, t.key, false);

    const expected = breakExpect ? BROKEN_EXPECT : kit.toCssRgb(TOKENS[theme][t.token]);
    const problems = [];
    if (hovered === info.baseColor) {
      problems.push(`${t.key}: hover 后颜色与基色相同（${hovered}）——hover 规则未命中或折叠丢失了 hover`);
    }
    if (hovered !== expected) {
      problems.push(`${t.key}: hover 计算色=${hovered}，期望 ${t.token}=${expected}`);
    }
    if (problems.length) throw new Error(`[${theme}] hover 断言失败：\n  - ${problems.join('\n  - ')}`);

    results[t.key] = {
      desc: t.desc, token: t.token, text: info.text,
      baseColor: info.baseColor, hoverColor: hovered, expected,
    };
  }
  return results;
}

async function main() {
  await kit.buildMiniApp({ id: 'hover-states', appVue: APP_VUE, entryJs: ENTRY_JS });
  const scene = await kit.openScene(WORK, { width: 760, height: 1180 });
  await scene.evaluate(`(() => { const s = document.createElement('style'); s.id = 'lx-scene-stabilize';
    s.textContent = ${JSON.stringify(STABILIZE_CSS)}; document.head.appendChild(s); })()`);
  const dbg = scene.win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('DOM.enable');
  await dbg.sendCommand('CSS.enable');

  try {
    if (DUMP) {
      await scene.evaluate(`window.setDark('dark')`);
      await scene.evaluate('window.flush()');
      for (const prep of [null, 'expandChatTool', 'planAddTip']) {
        if (prep) { await scene.evaluate(`window.${prep}()`); await scene.evaluate('window.flush()'); }
        const dump = await scene.evaluate(`(() => {
          const out = {};
          for (const s of document.querySelectorAll('[data-scene]')) {
            const b = [...s.querySelectorAll('button')].map((el) => ({
              text: (el.textContent || '').trim().slice(0, 18),
              ariaExpanded: el.getAttribute('aria-expanded'),
              ariaLabel: el.getAttribute('aria-label'),
              title: el.getAttribute('title'),
            }));
            out[s.getAttribute('data-scene')] = {
              buttons: b, chars: s.textContent.trim().length,
              htmlLen: s.innerHTML.length,
              head: s.innerHTML.slice(0, 3200),
            };
          }
          return out;
        })()`);
        console.log(JSON.stringify({ stage: prep || 'initial', dump }, null, 2));
      }
      app.exit(0);
      return;
    }

    if (SELFCHECK) {
      // 变异：把期望值故意写错，harness 必须报红；报绿说明它根本没在验证。
      let caught = null;
      try {
        await captureTheme(scene, 'dark', path.join(OUT_ROOT, '_selfcheck'), { breakExpect: true });
      } catch (e) {
        caught = e && e.message ? e.message : String(e);
      }
      console.log(JSON.stringify({ selfcheck: caught ? 'PASS' : 'BLIND', caught }, null, 2));
      app.exit(caught ? 0 : 1);
      return;
    }

    const outDir = MODE === 'baseline' ? BASE_DIR : CUR_DIR;
    const light = await captureTheme(scene, 'light', outDir);
    const dark = await captureTheme(scene, 'dark', outDir);
    const collected = { light, dark };
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(path.join(outDir, 'styles.json'), JSON.stringify(collected, null, 2));

    if (MODE === 'baseline') {
      console.log(JSON.stringify({ mode: 'baseline', outDir, collected }, null, 2));
      app.exit(0);
      return;
    }

    const basePath = path.join(BASE_DIR, 'styles.json');
    if (!fs.existsSync(basePath)) {
      console.error(`基线不存在：${basePath}（先跑 --mode baseline）`);
      app.exit(2);
      return;
    }
    const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    const styleDiffs = [];
    for (const theme of ['light', 'dark']) {
      for (const key of Object.keys(base[theme] || {})) {
        const a = base[theme][key];
        const b = (collected[theme] || {})[key];
        if (!b) { styleDiffs.push(`${theme}/${key}: 新采集缺失`); continue; }
        for (const p of ['baseColor', 'hoverColor', 'expected']) {
          if (a[p] !== b[p]) styleDiffs.push(`${theme}/${key}.${p}: ${a[p]} -> ${b[p]}`);
        }
      }
    }

    const { compareDirectories, DEFAULT_OPTIONS } = await import('./compare.mjs');
    // 组件图很小，收紧阈值，避免「小面积文字色变化」被整图比例吞掉。
    const options = { ...DEFAULT_OPTIONS, threshold: 0.0002, strongPixels: 12 };
    const px = compareDirectories({ baselineDir: BASE_DIR, currentDir: CUR_DIR, diffDir: DIFF_DIR, options });
    const failed = styleDiffs.length > 0 || px.failed > 0;
    console.log(JSON.stringify({
      mode: 'check', styleDiffs,
      pixel: { images: px.images, failed: px.failed, failures: px.failures },
      collected,
    }, null, 2));
    app.exit(failed ? 1 : 0);
  } finally {
    try { dbg.detach(); } catch { /* 忽略：窗口可能已销毁 */ }
    scene.close();
  }
}

app.setPath('userData', path.join(WORK, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('hover 交互态验证超时'); app.exit(1); }, 240000);
app.whenReady().then(async () => {
  try { await main(); } catch (e) { console.error(e && e.stack ? e.stack : e); app.exit(1); } finally { clearTimeout(deadline); }
}).catch((e) => { console.error(e); app.exit(1); });
