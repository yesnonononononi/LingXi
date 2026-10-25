/**
 * 组件级视觉验证：真实组件 + 生产样式 + Electron offscreen 渲染，
 * 为「设置页之外」的被改组件（CardHeader / RequireChoiceCard / DropUpSelect）建立
 * 明暗两态的可比对基线，并在截图前断言目标元素存在/可见/状态正确 + 记录 computed style。
 *
 * 设计要点：
 *  - 沿用 tests/choiceQuestionGroup.smoke.cjs 的 bootstrap（vite build 迷你 App + Electron offscreen）；
 *  - 只挂三个目标组件，确定性数据，避免整应用路由/会话状态依赖；
 *  - 每个主题：先断言再截图，避免「白拍一张空图当基线」；
 *  - 记录目标元素 computed style，作为面积无关的强信号（小面积文字色变化不会被整图阈值放过）；
 *  - --selfcheck：对标题注入一个非法色，证明「比对确实会红」（防验证本身是瞎子）。
 *
 * 用法（在 frontend 目录）：
 *   node scripts/visual/component-scenes.cjs --mode baseline
 *   node scripts/visual/component-scenes.cjs --mode check
 *   node scripts/visual/component-scenes.cjs --selfcheck
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app } = require('electron');
const kit = require('./scene-kit.cjs');

const FRONTEND_ROOT = kit.FRONTEND_ROOT;
const COMP_ROOT = path.join(kit.ARTIFACT_ROOT, 'components');
const BASE_DIR = path.join(COMP_ROOT, 'baseline');
const CUR_DIR = path.join(COMP_ROOT, 'current');
const DIFF_DIR = path.join(COMP_ROOT, 'diff');
const WORK = kit.sceneDir('component-scenes');
const TOKENS = kit.readTokenValues();

const argv = process.argv.slice(2);
const argOf = (key, fb) => { const i = argv.indexOf(`--${key}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : fb; };
const MODE = argOf('mode', 'baseline'); // baseline | check
const SELFCHECK = argv.includes('--selfcheck');
/** 故意破坏主题切换，验证「主题未翻转」这条护栏真的会红（防假基线）。 */
const SELFCHECK_THEME = argv.includes('--selfcheck-theme');

/**
 * 场景稳定性样式（只注入隔离场景，不动生产 CSS）。
 *
 * <p><b>为什么这是验收前提而不是可选项：</b>本批新增的 Sidebar 场景里，`BranchedMenu` 有
 * `--bm-draw: 400ms` 展开 / `--bm-fold: 300ms` 折叠动画，`<aside>` 又有
 * `transition-all duration-300`。不锁时间维度，同一份代码两次截图的像素就会不同 ——
 * 那种基线是**假基线**，会让「零差异」结论不可信（也会让后续回归判定随机变红）。</p>
 *
 * <p>作用范围：全场景统一关掉光标闪烁 / 动画 / 过渡。它不改变任何**终态**色值，只消除
 * 时间维度噪声，因此既有 4 个场景的形状与配色不变（基线会因新增 section 而整图刷新，
 * 这是预期行为，见设计文档 §6.5-③）。</p>
 */
const STABILIZE_CSS = '*, *::before, *::after { caret-color: transparent !important;'
  + ' animation: none !important; transition: none !important; }';

/**
 * 场景视口尺寸。
 *
 * <p>为什么不是默认的 780×760：本批把 Sidebar 的 4 个场景追加在页面下方，整体高度约 2.9k px。
 * 若沿用默认视口，`capturePage()` 只截到前 760 px ⇒ 侧栏根本不在基线图里（"有场景没覆盖"的假绿）。</p>
 */
const SCENE_VIEWPORT = { width: 800, height: 3100 };

/** 三个目标场景的 computed-style 采集选择器（函数体在渲染器里执行）。 */
const TARGETS = [
  { key: 'cardHeaderTitle', desc: 'CardHeader 标题文字（折 text-lx-primary-soft 目标）',
    sel: `document.querySelector('[data-scene="card-header"] span[title]')` },
  { key: 'choiceCustomInput', desc: 'RequireChoiceCard 自定义输入框（折 text-lx-primary-soft 目标）',
    sel: `document.querySelector('[data-scene="choice"] input[type="text"]')` },
  { key: 'dropdownMenuTitle', desc: 'DropUpSelect 展开后菜单标题（折 text-faint 目标）',
    sel: `(()=>{const p=document.querySelector('[role="listbox"]');if(!p)return null;return [...p.querySelectorAll('div')].find(el=>el.textContent.trim()==='下拉菜单标题')||null;})()` },
  { key: 'chatInputTextarea', desc: 'ChatInputArea 输入框（插件化试点 B 档：插槽化前后必须逐字节等价）',
    sel: `document.querySelector('[data-scene="chat-input"] textarea')` },
  // ── Sidebar 插槽化（B 档第三组件）的 5 个探针 ──────────────────────────────
  // 全部用「现有结构 + 文案」定位，零源码改动（设计文档 §6.4 推荐做法 a）。
  // 注意：这些选择器在 S0 抓基线时就必须可用，且 S3 改组件后 DOM 结构不变 ⇒ 前后可比。
  { key: 'sidebarWorkspaceLabel', desc: 'Sidebar 工作区名（暗色走 BranchedMenu header-label / 亮色走自绘列表）',
    sel: `(()=>{const root=document.querySelector('[data-scene="sidebar-open"]');if(!root)return null;return [...root.querySelectorAll('span,div')].find(el=>el.children.length===0&&el.textContent.trim()==='ws-alpha')||null;})()` },
  { key: 'sidebarSessionTitle', desc: 'Sidebar 会话标题（会话行文字色）',
    sel: `(()=>{const root=document.querySelector('[data-scene="sidebar-open"]');if(!root)return null;return [...root.querySelectorAll('span,div')].find(el=>el.children.length===0&&el.textContent.trim()==='会话一')||null;})()` },
  { key: 'sidebarFooterButton', desc: 'Sidebar 底部设置按钮（footer 容器内唯一带 title 的按钮）',
    sel: `(()=>{const root=document.querySelector('[data-scene="sidebar-open"]');if(!root)return null;const list=[...root.querySelectorAll('button[title]')];return list.length?list[list.length-1]:null;})()` },
  { key: 'sidebarEmptyState', desc: 'Sidebar 空态文案（无工作区无会话 → 「暂未指定工作区」）',
    sel: `(()=>{const root=document.querySelector('[data-scene="sidebar-empty"]');if(!root)return null;return [...root.querySelectorAll('div,span,p')].find(el=>el.children.length===0&&el.textContent.trim()==='暂未指定工作区')||null;})()` },
  { key: 'sidebarHistoryTitle', desc: 'Sidebar「历史对话」分组标题（未归属会话分区）',
    sel: `(()=>{const root=document.querySelector('[data-scene="sidebar-history"]');if(!root)return null;return [...root.querySelectorAll('div,span')].find(el=>el.children.length===0&&el.textContent.trim()==='历史对话')||null;})()` },
];


const STYLE_PROPS = ['color', 'backgroundColor', 'borderTopColor', 'outlineColor', 'textShadow', 'opacity', 'fontSize', 'fontWeight'];

const APP_VUE = `<script setup>
import {ref} from 'vue';
import CardHeader from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/CardHeader.vue'))}';
import RequireChoiceCard from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/RequireChoiceCard.vue'))}';
import DropUpSelect from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/common/DropUpSelect.vue'))}';
import ChatInputArea from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/ChatInputArea.vue'))}';
import Sidebar from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/Sidebar.vue'))}';
import { useTheme } from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/composables/useTheme.ts'))}';
import '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/style.css'))}';
const dark=ref(false);
/**
 * Sidebar 的暗色分支读的是 useTheme 的模块单例（不是 isDark prop），
 * 因此场景切主题时必须同时驱动 useTheme —— 否则侧栏永远停在初始主题上，
 * 暗色 BranchedMenu 分支根本不会被渲染（假基线）。
 */
const { setTheme } = useTheme();
const choiceCard={kind:'CHOICE',toolCallId:'choice-0',conversationId:'42',title:'选择交付方式？',content:'选择交付方式？',options:['源码','安装包','Docker 镜像'],status:'pending',pending:true,version:'2',allowedActions:['ANSWER']};
const sel=ref('a');
const opts=[{value:'a',label:'选项一'},{value:'b',label:'选项二'},{value:'c',label:'选项三'}];
const inputUsage={usedTokens:24600,maxTokens:200000,ratio:0.123};
const inputModels=[{id:'m1',name:'GPT-Test',modelName:'gpt-test'}];
const inputAgents=[{id:'a1',name:'代码助手',modelId:'m1'}];
/**
 * Sidebar 场景数据（确定性：固定 id / 固定时间戳 / 固定标题，避免基线随当前时间漂移）。
 * 只提供渲染必需字段；messages 为空数组（侧栏不用消息内容）。
 */
const sbWorkspaces=[{id:1,name:'ws-alpha',workDir:'/ws-alpha'},{id:2,name:'ws-beta',workDir:'/ws-beta'}];
const mkSession=(id,title,workspaceId,offset)=>({id,title,createdAt:1704067200000+offset,updatedAt:1704067200000+offset,modelId:'m1',activeTools:[],messages:[],workspaceId});
const sbSessions=[mkSession('s1','会话一',1,1000),mkSession('s2','会话二',1,2000),mkSession('s3','会话三',2,3000)];
/** 历史分组：7 条未归属会话（> SESSION_VISIBLE_LIMIT=5 ⇒ 触发「展开显示」按钮）。 */
const sbHistorySessions=Array.from({length:7},(_,i)=>mkSession('h'+(i+1),'历史会话'+(i+1),null,10000+i*1000));
window.setDark=value=>{dark.value=value;setTheme(value?'dark':'light');const el=document.documentElement;el.classList.toggle('dark',value);el.classList.toggle('light',!value);el.setAttribute('data-theme',value?'dark':'light');document.body.style.background=value?'#18181b':'#ffffff';};
window.openDropdown=()=>{const trigger=document.querySelector('[data-scene="dropdown"] button');if(trigger&&trigger.getAttribute('aria-expanded')!=='true')trigger.click();};
window.showCustomInput=()=>{};
window.focusCustomInput=()=>{const input=document.querySelector('[data-scene="choice"] input[type="text"]');if(input)input.focus();};
</script>
<template>
  <main style="width:720px;margin:0 auto;padding:20px;font-family:system-ui,sans-serif" :class="dark?'text-gray-100':'text-gray-900'">
    <section data-scene="card-header" style="padding:10px 8px">
      <CardHeader tone="pending" type-label="计划" title="卡片标题可见性探针" :is-dark="dark" />
    </section>
    <section data-scene="choice" style="padding:10px 8px">
      <RequireChoiceCard :prompt-card="choiceCard" :is-dark="dark" />
    </section>
    <section data-scene="dropdown" style="padding:10px 8px;min-height:260px">
      <DropUpSelect v-model="sel" :options="opts" :is-dark="dark" menu-title="下拉菜单标题" />
    </section>
    <section data-scene="chat-input" style="padding:10px 8px;min-height:220px">
      <ChatInputArea :is-dark="dark" :context-usage="inputUsage" :models="inputModels" />
    </section>
    <section data-scene="chat-input-driven" style="padding:10px 8px;min-height:220px">
      <ChatInputArea :is-dark="dark" :models="inputModels" :agents="inputAgents" selected-agent-id="a1" />
    </section>
    <!-- 以下 4 个 Sidebar 场景：固定尺寸 + 固定数据，明暗两态由 runner 切换。
         一个 section × 两主题即可同时覆盖「暗色 BranchedMenu 分支」与「亮色自绘列表」。 -->
    <section data-scene="sidebar-open" style="width:264px;height:520px;overflow:hidden;border:1px solid #8884">
      <Sidebar :sessions="sbSessions" active-session-id="s1" :workspaces="sbWorkspaces" :active-workspace-id="1" :is-collapsed="false" :is-dark="dark" />
    </section>
    <section data-scene="sidebar-empty" style="width:264px;height:520px;overflow:hidden;border:1px solid #8884">
      <Sidebar :sessions="[]" :active-session-id="null" :workspaces="[]" :is-collapsed="false" :is-dark="dark" />
    </section>
    <section data-scene="sidebar-collapsed" style="width:80px;height:520px;overflow:hidden;border:1px solid #8884">
      <Sidebar :sessions="[]" :active-session-id="null" :workspaces="sbWorkspaces" :is-collapsed="true" :is-dark="dark" />
    </section>
    <section data-scene="sidebar-history" style="width:264px;height:640px;overflow:hidden;border:1px solid #8884">
      <Sidebar :sessions="sbHistorySessions" :active-session-id="null" :workspaces="[]" :is-collapsed="false" :is-dark="dark" />
    </section>
  </main>
</template>
<style>${STABILIZE_CSS}</style>`;

const ENTRY_JS = `import {createApp,nextTick} from 'vue';
localStorage.setItem('lingxi-locale','zh-CN');
window.flush=async()=>{await nextTick();await new Promise(r=>setTimeout(r,120));};
const {default:App}=await import('./App.vue');
createApp(App).mount('#app');
window.ready=true;`;

/** 构建迷你 App（bootstrap 已下沉到 scene-kit，避免两套 suite 各写一份主题语义）。 */
async function buildApp() {
  await kit.buildMiniApp({ id: 'component-scenes', appVue: APP_VUE, entryJs: ENTRY_JS });
}

/** 在渲染器里读取某选择器目标的 computed style 与可见性。 */
function readStylesExpr() {
  return `(() => {
    const props = ${JSON.stringify(STYLE_PROPS)};
    const out = {};
    const defs = ${JSON.stringify(TARGETS.map(t => ({ key: t.key, sel: t.sel })))};
    for (const d of defs) {
      const el = eval(d.sel);
      if (!el) { out[d.key] = { found: false }; continue; }
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const style = {};
      for (const p of props) style[p] = cs[p];
      out[d.key] = { found: true, visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none', rect: [Math.round(r.width), Math.round(r.height)], text: (el.textContent || '').trim().slice(0, 40), style };
    }
    return out;
  })()`;
}

/** 故意破坏主题切换，验证「主题未翻转」护栏会红。两种破坏各打一条断言路径。 */
const BREAK_THEME_JS = {
  // 只切 class 不写 data-theme：等价于「主题标记位没落到根节点」。
  marker: `(() => { if (window.__themeBroken) return; window.__themeBroken = true; const orig = window.setDark;
    window.setDark = (v) => { orig(v); const el = document.documentElement; el.removeAttribute('data-theme'); el.classList.remove('light', 'dark'); }; })()`,
  // 标记位正确但令牌覆盖失效：亮色下仍拿到暗色令牌值。
  token: `(() => { if (window.__themeBroken) return; window.__themeBroken = true; const orig = window.setDark;
    window.setDark = (v) => { orig(v); const el = document.documentElement;
      if (v) el.style.removeProperty('--lx-text-secondary'); else el.style.setProperty('--lx-text-secondary', '#e4e4e7'); }; })()`,
};

async function captureTheme(win, theme, outDir, mutate = false, breakTheme = null) {
  const evaluate = s => win.webContents.executeJavaScript(s);
  if (breakTheme) {
    await evaluate(BREAK_THEME_JS[breakTheme]);
    await evaluate('window.flush()');
  }
  await evaluate(`window.setDark(${theme === 'dark'})`);
  await evaluate('window.flush()');
  // 护栏：主题必须真的翻转（根标记位 + 令牌变量 + Tailwind 映射后的计算色）。
  const themeProbe = await kit.assertThemeApplied(evaluate, theme, TOKENS);

  // 先开下拉（点按钮会 blur），再聚焦自定义输入框，最后统一等待过渡完成。
  await evaluate('window.openDropdown()');
  await evaluate('window.flush()');
  await new Promise(r => setTimeout(r, 400));
  await evaluate('window.focusCustomInput()');
  await evaluate('window.flush()');
  await new Promise(r => setTimeout(r, 120));

  if (mutate) {
    // 只改「标题」颜色，制造一个极小面积差异，验证比对/样式采集不会漏。
    await evaluate(`(() => { const el = document.querySelector('[data-scene="card-header"] span[title]'); if (el) el.style.setProperty('color', 'rgb(255, 0, 255)', 'important'); })()`);
    await evaluate('window.flush()');
  }

  const styles = await evaluate(readStylesExpr());
  // 断言：目标都在、都可见、输入框确实获得焦点、下拉菜单标题已展开。
  const problems = [];
  for (const t of TARGETS) {
    const s = styles[t.key];
    if (!s || !s.found) problems.push(`${t.key}: 目标不存在（${t.desc}）`);
    else if (!s.visible) problems.push(`${t.key}: 目标不可见`);
  }
  const inputFocused = await evaluate(`document.activeElement === document.querySelector('[data-scene="choice"] input[type="text"]')`);
  if (!inputFocused) problems.push('choiceCustomInput: 未获得焦点');
  if (problems.length) throw new Error(`[${theme}] 场景断言失败：\n  - ${problems.join('\n  - ')}`);

  await fsp.mkdir(outDir, { recursive: true });
  const png = await win.webContents.capturePage();
  await fsp.writeFile(path.join(outDir, `${theme}.png`), png.toPNG());
  return styles;
}

async function runCapture(outDir, { mutate = false, breakTheme = null } = {}) {
  // 视口必须容纳全部场景（新增 4 个 Sidebar section 后页面高约 2.9k px）。
  // 用默认 780×760 会让下方场景拍不到 —— 那样「基线」里根本没有侧栏，等于没有覆盖。
  const scene = await kit.openScene(WORK, SCENE_VIEWPORT);
  const { win, evaluate } = scene;
  const styles = {};
  const probes = {};
  try {
    for (const theme of ['light', 'dark']) {
      styles[theme] = await captureTheme(win, theme, outDir, mutate, breakTheme);
      probes[theme] = await evaluate(kit.PROBE_JS);
    }
    kit.assertThemesDiffer(probes.light, probes.dark);
  } finally {
    scene.close();
  }
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(outDir, 'styles.json'), JSON.stringify({ styles, probes }, null, 2));
  return { styles, probes };
}

/** 样式等价比对：每个目标每个属性的 computed style 必须逐字相等。 */
function diffStyles(a, b) {
  const diffs = [];
  for (const theme of Object.keys(a)) {
    for (const key of Object.keys(a[theme] || {})) {
      const sa = a[theme][key], sb = (b[theme] || {})[key];
      if (!sb) { diffs.push(`${theme}/${key}: 新采集缺失`); continue; }
      if (sa.found !== sb.found) { diffs.push(`${theme}/${key}: found ${sa.found}->${sb.found}`); continue; }
      if (!sa.found) continue;
      for (const p of STYLE_PROPS) {
        if (sa.style[p] !== sb.style[p]) diffs.push(`${theme}/${key}.${p}: ${sa.style[p]} -> ${sb.style[p]}`);
      }
    }
  }
  return diffs;
}

async function main() {
  await buildApp();

  if (SELFCHECK) {
    const tmpA = path.join(COMP_ROOT, '_selfcheck');
    const a = await runCapture(path.join(tmpA, 'before'));
    const b = await runCapture(path.join(tmpA, 'after'), { mutate: true });
    const styleDiffs = diffStyles(a.styles, b.styles);
    const { compareImagePair, decodePng } = await import('./compare.mjs');
    const fsx = require('node:fs');
    const imgA = decodePng(fsx.readFileSync(path.join(tmpA, 'before', 'light.png')));
    const imgB = decodePng(fsx.readFileSync(path.join(tmpA, 'after', 'light.png')));
    const cmp = compareImagePair(imgA, imgB);
    const detected = styleDiffs.length > 0 || cmp.failed === true;
    console.log(JSON.stringify({ selfcheck: detected ? 'PASS' : 'BLIND', styleDiffs, pixelFailed: cmp.failed, changedPixels: cmp.changedPixels, maxChannelDelta: cmp.maxChannelDelta, strongPixels: cmp.strongPixels }, null, 2));
    app.exit(detected ? 0 : 1);
    return;
  }

  // 主题护栏自检：故意破坏主题切换，护栏必须报红；报告绿 = 护栏是瞎的。
  if (SELFCHECK_THEME) {
    const variant = argOf('selfcheck-theme', 'marker');
    if (!BREAK_THEME_JS[variant]) {
      console.error(`未知破坏方式：${variant}（可选 ${Object.keys(BREAK_THEME_JS).join(' / ')}）`);
      app.exit(2);
      return;
    }
    let caught = null;
    try {
      await runCapture(path.join(COMP_ROOT, '_selfcheck-theme', variant), { breakTheme: variant });
    } catch (e) {
      caught = e && e.message ? e.message : String(e);
    }
    const ok = !!caught;
    console.log(JSON.stringify({ selfcheckTheme: ok ? 'PASS' : 'BLIND', variant, caught }, null, 2));
    app.exit(ok ? 0 : 1);
    return;
  }

  if (MODE === 'baseline') {
    const { styles, probes } = await runCapture(BASE_DIR);
    console.log(JSON.stringify({ mode: 'baseline', outDir: BASE_DIR, probes, styles }, null, 2));
    app.exit(0);
    return;
  }

  // check：先采当前，再与基线做像素 + 样式双比对。
  const { styles, probes } = await runCapture(CUR_DIR);
  const baseStylesPath = path.join(BASE_DIR, 'styles.json');
  if (!fs.existsSync(baseStylesPath)) { console.error(`基线不存在：${baseStylesPath}（先跑 --mode baseline）`); app.exit(2); return; }
  const baseRaw = JSON.parse(fs.readFileSync(baseStylesPath, 'utf8'));
  const baseStyles = baseRaw.styles || baseRaw; // 兼容旧的纯 styles 格式
  const styleDiffs = diffStyles(baseStyles, styles);

  const { compareDirectories, DEFAULT_OPTIONS } = await import('./compare.mjs');
  // 组件场景图很小，收紧阈值，避免小面积文字色变化被整图比例吞掉。
  const options = { ...DEFAULT_OPTIONS, threshold: 0.0002, strongPixels: 12 };
  const px = compareDirectories({ baselineDir: BASE_DIR, currentDir: CUR_DIR, diffDir: DIFF_DIR, options });
  const failed = styleDiffs.length > 0 || px.failed > 0;
  console.log(JSON.stringify({ mode: 'check', probes, styleDiffs, pixel: { images: px.images, failed: px.failed, details: px.details, failures: px.failures } }, null, 2));
  app.exit(failed ? 1 : 0);
}

app.setPath('userData', path.join(WORK, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('组件视觉验证超时'); app.exit(1); }, 180000);
app.whenReady().then(async () => {
  try { await main(); } catch (e) { console.error(e && e.stack ? e.stack : e); app.exit(1); } finally { clearTimeout(deadline); }
}).catch(e => { console.error(e); app.exit(1); });
