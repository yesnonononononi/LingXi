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
const hasFlag = (key) => argv.some((value, index) => value === `--${key}`);

/**
 * 帮助文本。
 *
 * <p>为什么把 `--assert-dark-colors` 与 `--mode check` 的组合行为写进来：这两个开关语义独立，
 * 组合时的行为不做说明就会被误用（例如以为给了 `--assert-dark-colors` 就等于做了像素回归）。</p>
 */
const HELP = `用法：electron scripts/visual/component-scenes.cjs [选项]

  --mode <baseline|check>       baseline=重抓基线；check=与基线比对（像素 + computed style）。
  --themes <both|dark|light>    只跑指定主题（默认 both，保持既有行为）。
                                报告里会打印「实际跑了哪几态」（themesRun 字段 + stderr 一行），
                                避免因场景硬编码而「以为跑了暗态其实没跑」。
  --assert-dark-colors          暗态色值断言（不看像素占比，只看色值）：
                                对每个 target 的 color / background-color / border-top-color /
                                border-bottom-color / box-shadow / text-shadow 逐项与令牌真值比对，
                                输出四列表「元素 → 属性 → 期望色 → 实际色」，任一不等即退出码 1。
                                期望色一律由 scene-kit 的令牌解析（readTokenValues + toCssRgb）算出，
                                令牌解析不到直接报错（不静默跳过）。隐含 --themes dark。

  组合行为：--assert-dark-colors 与 --mode check 同时给出时，**先**做暗态色值断言，
  断言全绿**再**继续做 check 的像素 / computed-style 比对；任一段失败即退出码 1。
  只给 --assert-dark-colors 时不做基线比对（不要求基线存在）。

  --selfcheck                   对标题注入非法色，证明比对确实会红（防验证器是瞎子）。
  --selfcheck-theme <marker|token>  故意破坏主题切换，证明主题护栏会红。
  --help                        打印本帮助。
`;

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  app.exit(0);
}

const MODE = argOf('mode', 'baseline'); // baseline | check
const SELFCHECK = argv.includes('--selfcheck');
/** 故意破坏主题切换，验证「主题未翻转」这条护栏真的会红（防假基线）。 */
const SELFCHECK_THEME = argv.includes('--selfcheck-theme');

/** `--themes` 取值表：默认 both（与改动前「硬编码跑 light+dark」行为一致）。 */
const THEME_SETS = { both: ['light', 'dark'], dark: ['dark'], light: ['light'] };
const THEMES_ARG = argOf('themes', 'both');
/** 暗态色值断言开关（V5）。 */
const ASSERT_DARK = argv.includes('--assert-dark-colors');

const themesError = validateFlags();
if (themesError) {
  console.error(themesError);
  app.exit(2);
}

/**
 * 校验命令行组合。
 *
 * <p>为什么要在这里拦「--themes light + --assert-dark-colors」：这是一个自相矛盾的要求
 * （断言的是暗态，却只跑亮态），静默取其一都会让使用者以为断言做过。</p>
 *
 * @returns {string|null} 错误信息；null 表示组合合法。
 */
function validateFlags() {
  if (!Object.prototype.hasOwnProperty.call(THEME_SETS, THEMES_ARG)) {
    return `--themes 只接受 both|dark|light，收到「${THEMES_ARG}」。\n\n${HELP}`;
  }
  if (!['baseline', 'check'].includes(MODE)) {
    return `--mode 只接受 baseline|check，收到「${MODE}」。\n\n${HELP}`;
  }
  if (ASSERT_DARK && THEMES_ARG === 'light') return '--assert-dark-colors 断言的是暗态，不能与 --themes light 组合';
  return null;
}

/** 本次实际要跑的主题列表。 */
const THEMES = ASSERT_DARK ? ['dark'] : THEME_SETS[THEMES_ARG];

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
  // V7：整页图之外再从同一张 png 裁出每个目标的元素级 ROI（小面积变化的唯一可见证据）。
  // 用内存裁切而非再次 capturePage(rect)：offscreen 下 rect 抓图会抛 UnknownVizError（已实测）。
  const roi = await captureRoi(png, evaluate, theme, outDir);
  return { styles, roi };
}

async function runCapture(outDir, { mutate = false, breakTheme = null } = {}) {
  // 视口必须容纳全部场景（新增 4 个 Sidebar section 后页面高约 2.9k px）。
  // 用默认 780×760 会让下方场景拍不到 —— 那样「基线」里根本没有侧栏，等于没有覆盖。
  const scene = await kit.openScene(WORK, SCENE_VIEWPORT);
  const { win, evaluate } = scene;
  const styles = {};
  const probes = {};
  /** @type {Record<string, Array<{key: string, file: string, rect: object}>>} */
  const roiByTheme = {};
  try {
    for (const theme of THEMES) {
      const captured = await captureTheme(win, theme, outDir, mutate, breakTheme);
      styles[theme] = captured.styles;
      roiByTheme[theme] = captured.roi;
      probes[theme] = await evaluate(kit.PROBE_JS);
    }
    // 两态都要跑时才能比较「明暗是否真的不同」；只跑一态时这条护栏无意义（也是显式跳过而非假绿）。
    if (THEMES.length === 2) kit.assertThemesDiffer(probes.light, probes.dark);
  } finally {
    scene.close();
  }
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(
    path.join(outDir, 'styles.json'),
    JSON.stringify({ themesRun: THEMES, styles, probes, roi: roiByTheme }, null, 2),
  );
  return { styles, probes, roi: roiByTheme };
}

// ─────────────────────────────────────────────────────────────────────────────
// V7：元素级 ROI 截图
// ─────────────────────────────────────────────────────────────────────────────

/** ROI 在元素包围盒四周留的白边（px）。 */
const ROI_PADDING = 4;

/**
 * 对每个 computed-style 目标从**已抓到的整页图**里裁出「元素包围盒 + 4px」的小图，命名 `<key>-roi.png`。
 *
 * <p><b>为什么需要它：</b>整页图里一处 12px 文字色变化只占约 130 个像素（≈0.01%），
 * 整图比例阈值天然把它吞掉 —— 暗态阴影盲区实测覆盖只有 0.0012%，就是这个原因。
 * 把每个目标单独裁出来，同样的变化占比立刻变成可观数字，断言才有分辨力。</p>
 *
 * <p><b>为什么用 nativeImage.crop 而不是 capturePage(rect)：</b>本仓库的视觉场景跑在
 * offscreen 渲染下，实测 `webContents.capturePage(rect)` 会抛 `UnknownVizError`（整条 baseline 失败），
 * 而**无参** `capturePage()` 正常。因此这里只在内存里裁整页图：不再触发一次抓图，
 * 性能更好，也不依赖 rect 抓图这条在 offscreen 下不可靠的路径。</p>
 *
 * <p><b>为什么同时保留整页图：</b>ROI 只覆盖目标本体，看不到「周围元素被挤位 / 布局塌陷」这类
 * 结构性回归；整页图是兜底。两者一起进 baseline/check，缺一不可。</p>
 *
 * @param {object} fullImage 已抓到的整页 nativeImage
 * @param {(expr: string) => Promise<any>} evaluate 页面求值函数
 * @param {'light'|'dark'} theme 当前主题（写进返回值，便于报告）
 * @param {string} outDir 本次产物目录
 * @returns {Promise<Array<{key: string, file: string, rect: object, theme: string}>>} 已写出的 ROI 清单
 */
async function captureRoi(fullImage, evaluate, theme, outDir) {
  // 按主题分子目录存放：明暗两态的元素包围盒尺寸不同（文字宽度与主题无关但边框/内距可能变），
  // 若两态写同一个 `<key>-roi.png`，后跑的一态会覆盖前一态，单跑 light 时会拿暗色 ROI 当基线
  // 直接 100% 全图差异（实测踩到）。分子目录后文件名仍是要求的 `<key>-roi.png`。
  const themeDir = path.join(outDir, theme);
  await fsp.rm(themeDir, { recursive: true, force: true });
  await fsp.mkdir(themeDir, { recursive: true });
  const imageSize = fullImage.getSize();
  /**
   * 页面坐标 → 图片像素坐标。
   *
   * <p>整页图按 devicePixelRatio 缩放（crop 用的是图片像素而非 CSS 像素），因此必须换算；
   * 同时把结果 clamp 到图片范围内 —— crop 越界会返回空白或抛错，是这一类"ROI 图全是空白"的根因。</p>
   */
  const rects = await evaluate(`(() => {
    const defs = ${JSON.stringify(TARGETS.map((t) => ({ key: t.key, sel: t.sel })))};
    const pad = ${ROI_PADDING};
    const out = [];
    for (const d of defs) {
      const el = eval(d.sel);
      if (!el) { out.push({ key: d.key, rect: null, reason: 'not-found' }); continue; }
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) { out.push({ key: d.key, rect: null, reason: 'not-visible' }); continue; }
      out.push({
        key: d.key,
        rect: { x: r.left - pad, y: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 },
      });
    }
    return out;
  })()`);

  const written = [];
  // 页面 CSS 像素 → 图片像素：整页图宽度 / 页面宽度（只求一次，页面宽度在本次采集内不变）
  const pageWidth = await evaluate('document.documentElement.scrollWidth || window.innerWidth');
  const ratio = pageWidth > 0 ? imageSize.width / pageWidth : 1;
  for (const item of rects) {
    if (!item.rect) continue; // 目标不可见：captureTheme 的可见性断言负责报错，这里不重复失败
    const x = Math.max(0, Math.round(item.rect.x * ratio));
    const y = Math.max(0, Math.round(item.rect.y * ratio));
    const width = Math.max(1, Math.round(item.rect.width * ratio));
    const height = Math.max(1, Math.round(item.rect.height * ratio));
    // 二次 clamp：crop 的矩形必须完全落在图片内
    const clampedWidth = Math.min(width, imageSize.width - x);
    const clampedHeight = Math.min(height, imageSize.height - y);
    if (clampedWidth < 1 || clampedHeight < 1) continue;
    const cropped = fullImage.crop({ x, y, width: clampedWidth, height: clampedHeight });
    const file = path.join(themeDir, `${item.key}-roi.png`);
    await fsp.writeFile(file, cropped.toPNG());
    written.push({ key: item.key, file, rect: { x, y, width: clampedWidth, height: clampedHeight }, theme });
  }
  return written;
}

// ─────────────────────────────────────────────────────────────────────────────
// V5：暗态色值断言（四列表：元素 → 属性 → 期望色 → 实际色）
// ─────────────────────────────────────────────────────────────────────────────

/** 六项必查属性：CSS 属性名 → 报告里的显示名。 */
const DARK_ASSERT_PROPS = [
  ['color', 'color'],
  ['backgroundColor', 'background-color'],
  ['borderTopColor', 'border-top-color'],
  ['borderBottomColor', 'border-bottom-color'],
  ['boxShadow', 'box-shadow'],
  ['textShadow', 'text-shadow'],
];

/**
 * 期望值来源的三种形态：
 * - 令牌名（以 `--lx-` 开头）：期望色由 `kit.readTokenValues()` 解析后换算成 rgb，绝不硬编码 hex；
 * - 结构哨兵：某些属性本来就不该有令牌（例如「这个元素没有背景」「没有边框」「没有阴影」），
 *   用哨兵表达比硬编码一个色值更耐改；
 * - 显式跳过：属性确实未令牌化时**必须**写明原因并出现在报告里 —— 这是「显式跳过」，
 *   与「静默跳过」的区别是它在四列表里占一行、能被审计到。
 */
const STRUCTURAL = {
  /** 声明「该属性必须等于元素自身的 color」（border-color 未设时即 currentColor）。 */
  currentColor: '@currentColor',
  /** 声明「该属性必须完全透明」——即这个元素没有背景。 */
  transparent: 'rgba(0, 0, 0, 0)',
  /** 声明「该属性必须为 none」——即没有阴影 / 光效。 */
  none: 'none',
};

/** 显式跳过标记：带了它就一定会在报告里打出一行带原因的 SKIP。 */
const skip = (reason) => ({ skip: reason });

/**
 * 逐目标声明的「期望令牌」。
 *
 * <p>期望值**只**来自 `kit.readTokenValues()`（scene-kit 里的令牌解析），不硬编码任何 hex ——
 * 令牌改名或改值时断言自动跟随，写死色值则会悄悄失去意义。
 * 声明里出现的令牌名解析不到 ⇒ 直接报错退出（禁止静默跳过，否则断言会变成"零条断言也全绿"）。</p>
 *
 * <p>六个属性全部条目都必须显式声明（值可以是令牌名 / 结构哨兵 / 显式跳过），
 * 漏声明会红 —— 目的是让「新增光效」「新增背景」成为需要显式决策的动作。</p>
 */
const DARK_EXPECT_TOKENS = {
  // 卡片标题、选择卡自定义输入、聊天输入框正文：实测 #f4f4f5 = 正文「柔和档」（primary-soft），
  // 不是 primary(#ffffff)。这条映射是 V5 首次运行时由断言自己暴露出来的，不是凭文档抄的。
  cardHeaderTitle: { color: '--lx-text-primary-soft', backgroundColor: STRUCTURAL.transparent, borderTopColor: STRUCTURAL.currentColor, borderBottomColor: STRUCTURAL.currentColor, boxShadow: STRUCTURAL.none, textShadow: STRUCTURAL.none },
  choiceCustomInput: { color: '--lx-text-primary-soft', backgroundColor: STRUCTURAL.transparent, borderTopColor: STRUCTURAL.currentColor, borderBottomColor: STRUCTURAL.currentColor, boxShadow: STRUCTURAL.none, textShadow: STRUCTURAL.none },
  chatInputTextarea: { color: '--lx-text-primary-soft', backgroundColor: STRUCTURAL.transparent, borderTopColor: STRUCTURAL.currentColor, borderBottomColor: STRUCTURAL.currentColor, boxShadow: STRUCTURAL.none, textShadow: STRUCTURAL.none },
  // 下拉菜单标题：最弱一档文字（faint）
  dropdownMenuTitle: { color: '--lx-text-faint', backgroundColor: STRUCTURAL.transparent, borderTopColor: STRUCTURAL.currentColor, borderBottomColor: STRUCTURAL.currentColor, boxShadow: STRUCTURAL.none, textShadow: STRUCTURAL.none },
  // 侧栏工作区标签：主色；会话标题：选中态走 info 蓝
  sidebarWorkspaceLabel: { color: '--lx-text-primary', backgroundColor: STRUCTURAL.transparent, borderTopColor: STRUCTURAL.currentColor, borderBottomColor: STRUCTURAL.currentColor, boxShadow: STRUCTURAL.none, textShadow: STRUCTURAL.none },
  sidebarSessionTitle: { color: '--lx-info', backgroundColor: STRUCTURAL.transparent, borderTopColor: STRUCTURAL.currentColor, borderBottomColor: STRUCTURAL.currentColor, boxShadow: STRUCTURAL.none, textShadow: STRUCTURAL.none },
  // 侧栏底栏按钮：muted 档
  sidebarFooterButton: { color: '--lx-text-muted', backgroundColor: STRUCTURAL.transparent, borderTopColor: STRUCTURAL.currentColor, borderBottomColor: STRUCTURAL.currentColor, boxShadow: STRUCTURAL.none, textShadow: STRUCTURAL.none },
  // 空态文案：faint 档
  sidebarEmptyState: { color: '--lx-text-faint', backgroundColor: STRUCTURAL.transparent, borderTopColor: STRUCTURAL.currentColor, borderBottomColor: STRUCTURAL.currentColor, boxShadow: STRUCTURAL.none, textShadow: STRUCTURAL.none },
  // 历史分组标题：实测 #a1a1aa，**不在** 20 条令牌表里（--lx-text-muted 是 #9f9fa9，差 2/255）。
  // 不做「就近取令牌」——那会把「未令牌化」伪装成已覆盖。显式跳过并在报告里打出一行。
  sidebarHistoryTitle: {
    color: skip('未令牌化：实测 #a1a1aa 不在令牌表（--lx-text-muted=#9f9fa9，差 2/255），待补令牌后再纳入断言'),
    backgroundColor: STRUCTURAL.transparent,
    borderTopColor: STRUCTURAL.currentColor,
    borderBottomColor: STRUCTURAL.currentColor,
    boxShadow: STRUCTURAL.none,
    textShadow: STRUCTURAL.none,
  },
};

/**
 * 把令牌值解析成浏览器 computed style 的可比字符串。
 *
 * @param {Record<string, string>} tokens 暗态令牌表（token 名 → 原值）
 * @param {string} tokenName 令牌名；不存在则抛错
 * @returns {string} 形如 `rgb(228, 228, 231)`
 */
function resolveTokenRgb(tokens, tokenName) {
  if (!Object.prototype.hasOwnProperty.call(tokens, tokenName)) {
    throw new Error(`--assert-dark-colors：令牌「${tokenName}」在 scene-kit 的暗态令牌表里解析不到（不允许静默跳过）`);
  }
  return kit.toCssRgb(tokens[tokenName]);
}

/**
 * 暗态色值断言主体。
 *
 * <p>判据是**色值**而不是像素占比：暗态阴影区实测像素覆盖只有 0.0012%，任何"按比例"的阈值
 * 都看不见它；色值逐项比对没有这个问题。</p>
 *
 * @returns {Promise<{rows: Array<object>, mismatches: Array<object>}>} 四列表行与不匹配项
 */
async function runDarkColorAssert() {
  // 令牌真值分两层使用：断言函数要整张表（它内部按 theme 取子表），解析期望色只要暗态子表。
  const allTokens = TOKENS;
  const tokens = allTokens.dark;
  const scene = await kit.openScene(WORK, SCENE_VIEWPORT);
  const { evaluate } = scene;
  const rows = [];
  try {
    await evaluate('window.setDark(true)');
    await evaluate('window.openDropdown()');
    await evaluate('window.flush()');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await kit.assertThemeApplied(evaluate, 'dark', allTokens);

    const actual = await evaluate(`(() => {
      const defs = ${JSON.stringify(TARGETS.map((t) => ({ key: t.key, sel: t.sel })))};
      const props = ${JSON.stringify(DARK_ASSERT_PROPS.map((p) => p[0]))};
      const ctx = document.createElement('canvas').getContext('2d');
      // 颜色统一归一成 rgb()/rgba() 字符串再比较：
      // 计算值可能是 hex（Tailwind 的 #f4f4f5）也可能是 oklch（Tailwind v4 的输出），
      // 两种表示不能直接和令牌的 hex 比。用 1×1 画布采样拿到真实 RGB，是唯一对所有色彩空间都成立的归一化方式。
      const toRgb = (value) => {
        const raw = String(value).trim();
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = raw;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        if (d[3] === 0) return 'rgba(0, 0, 0, 0)';
        const alpha = Math.round((d[3] / 255) * 1000) / 1000;
        return alpha >= 1 ? 'rgb(' + d[0] + ', ' + d[1] + ', ' + d[2] + ')'
          : 'rgba(' + d[0] + ', ' + d[1] + ', ' + d[2] + ', ' + alpha + ')';
      };
      const out = {};
      for (const d of defs) {
        const el = eval(d.sel);
        if (!el) { out[d.key] = null; continue; }
        const cs = getComputedStyle(el);
        const row = {};
        for (const p of props) {
          const raw = cs[p];
          // 阴影是复合值，逐字比较；其余颜色归一成 rgb() 再比，避免表示差异造成假红
          row[p] = (p === 'boxShadow' || p === 'textShadow') ? String(raw).trim() : toRgb(raw);
        }
        out[d.key] = row;
      }
      return out;
    })()`);

    for (const target of TARGETS) {
      const row = actual[target.key];
      if (!row) {
        throw new Error(`--assert-dark-colors：目标「${target.key}」未找到或不可见（${target.desc}），禁止对空目标断言`);
      }
      const declared = DARK_EXPECT_TOKENS[target.key] || {};
      for (const [prop, label] of DARK_ASSERT_PROPS) {
        if (!Object.prototype.hasOwnProperty.call(declared, prop)) {
          throw new Error(
            `--assert-dark-colors：目标「${target.key}」的属性 ${label} 没有声明期望`
            + `（在 DARK_EXPECT_TOKENS 里补 { ${prop}: '<令牌名>' | STRUCTURAL.* | skip('<原因>') }；禁止静默跳过）`,
          );
        }
        const spec = declared[prop];
        const actualValue = row[prop];
        if (spec && typeof spec === 'object' && spec.skip) {
          // 显式跳过：占用一行、写明原因，可被审计 —— 不是静默漏掉
          rows.push({
            target: target.key,
            property: label,
            expected: '—（跳过）',
            actual: actualValue,
            token: null,
            note: spec.skip,
            skipped: true,
            ok: true,
          });
          continue;
        }
        let expected;
        let tokenLabel;
        if (spec === STRUCTURAL.currentColor) {
          // 无边框时 border-color 计算值即元素自身 color，断言「与 color 一致」比断言某个色值更稳
          expected = row.color;
          tokenLabel = '结构: currentColor';
        } else if (spec === STRUCTURAL.transparent || spec === STRUCTURAL.none) {
          expected = spec;
          tokenLabel = `结构: ${spec}`;
        } else {
          expected = resolveTokenRgb(tokens, spec);
          tokenLabel = spec;
        }
        rows.push({
          target: target.key,
          property: label,
          expected,
          actual: actualValue,
          token: tokenLabel,
          ok: expected === actualValue,
        });
      }
    }
  } finally {
    scene.close();
  }
  return { rows, mismatches: rows.filter((r) => !r.ok) };
}

/**
 * 把四列表渲染成定宽文本（中文/全角字符按 2 列计宽，保证表头与数据对齐）。
 *
 * @param {Array<object>} rows 断言行
 * @returns {string} 可直接打印的表格文本
 */
function formatDarkAssertTable(rows) {
  /** 视觉宽度：CJK / 全角标点算 2。 */
  const width = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));
  const head = ['元素', '属性', '期望色', '实际色'];
  const body = rows.map((r) => [r.target, r.property, r.expected, r.actual]);
  const widths = head.map((h, i) => Math.max(width(h), ...body.map((b) => width(b[i]))));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ');
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  return [line(head), sep, ...body.map(line)].join('\n');
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

  // ── V5：暗态色值断言（给 --assert-dark-colors 时先跑，绿了才继续做其它模式） ──────────
  if (ASSERT_DARK) {
    const { rows, mismatches } = await runDarkColorAssert();
    const skipped = rows.filter((r) => r.skipped);
    console.log(`\n=== 暗态色值断言（--assert-dark-colors）：共 ${rows.length} 条（其中显式跳过 ${skipped.length} 条），实际跑 ${THEMES.join(' + ')} 态 ===`);
    console.log(formatDarkAssertTable(rows));
    if (skipped.length > 0) {
      // 跳过项必须逐条打印原因：跳过可以，静默跳过不可以
      console.log('\n--- 显式跳过明细（未令牌化属性，不计入失败但必须可审计）---');
      for (const r of skipped) console.log(`  ${r.target} / ${r.property}: ${r.note}`);
    }
    if (mismatches.length > 0) {
      console.error(`\n[FAIL] ${mismatches.length} 条色值不匹配：`);
      for (const m of mismatches) console.error(`  ${m.target} / ${m.property}: 期望 ${m.expected}，实际 ${m.actual}`);
      app.exit(1);
      return;
    }
    console.log(`\n[PASS] ${rows.length - skipped.length} 条色值断言全绿（跳过 ${skipped.length} 条，原因见上）`);
    // 只给 --assert-dark-colors 时到此为止，不要求基线存在。
    if (!argv.some((v) => v === '--mode' || v.startsWith('--mode='))) {
      app.exit(0);
      return;
    }
    console.log('继续执行 --mode 的像素 / computed-style 比对…\n');
  }

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
    console.log(JSON.stringify({ selfcheck: detected ? 'PASS' : 'BLIND', themesRun: THEMES, styleDiffs, pixelFailed: cmp.failed, changedPixels: cmp.changedPixels, maxChannelDelta: cmp.maxChannelDelta, strongPixels: cmp.strongPixels }, null, 2));
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
    console.log(JSON.stringify({ selfcheckTheme: ok ? 'PASS' : 'BLIND', variant, themesRun: THEMES, caught }, null, 2));
    app.exit(ok ? 0 : 1);
    return;
  }

  if (MODE === 'baseline') {
    const { styles, probes, roi } = await runCapture(BASE_DIR);
    // V11：显式打印「实际跑了哪几态」——由 --themes 决定，不再靠场景硬编码去猜。
    console.error(`[themes] 本次实际运行：${THEMES.join(' + ')}（--themes ${ASSERT_DARK ? 'dark（--assert-dark-colors 隐含）' : THEMES_ARG}）`);
    console.log(JSON.stringify({ mode: 'baseline', themesRun: THEMES, outDir: BASE_DIR, probes, styles, roi }, null, 2));
    app.exit(0);
    return;
  }

  // check：先采当前，再与基线做像素 + 样式双比对。
  const { styles, probes, roi } = await runCapture(CUR_DIR);
  console.error(`[themes] 本次实际运行：${THEMES.join(' + ')}（--themes ${ASSERT_DARK ? 'dark（--assert-dark-colors 隐含）' : THEMES_ARG}）`);
  const baseStylesPath = path.join(BASE_DIR, 'styles.json');
  if (!fs.existsSync(baseStylesPath)) { console.error(`基线不存在：${baseStylesPath}（先跑 --mode baseline）`); app.exit(2); return; }
  const baseRaw = JSON.parse(fs.readFileSync(baseStylesPath, 'utf8'));
  const baseStyles = baseRaw.styles || baseRaw; // 兼容旧的纯 styles 格式
  const baseThemes = Array.isArray(baseRaw.themesRun) ? baseRaw.themesRun : Object.keys(baseStyles);
  /**
   * 只比较本次实际跑过的、且基线里也有的主题。
   *
   * <p>为什么必须过滤：`--themes dark` 时当前目录里没有 light.png 与 light 的 computed style，
   * 直接拿基线全集来比会报"基线有当前没有"，那是比较口径错位，不是视觉回归。</p>
   */
  const comparableThemes = THEMES.filter((theme) => baseThemes.includes(theme));
  if (comparableThemes.length === 0) {
    console.error(`基线里没有本次要跑的主题（基线 ${baseThemes.join('+')} / 本次 ${THEMES.join('+')}），无法比对；请先用相同 --themes 抓基线`);
    app.exit(2);
    return;
  }
  const filteredBase = {};
  const filteredCur = {};
  for (const theme of comparableThemes) {
    filteredBase[theme] = baseStyles[theme];
    filteredCur[theme] = styles[theme];
  }
  const styleDiffs = diffStyles(filteredBase, filteredCur);

  const { compareDirectories, DEFAULT_OPTIONS } = await import('./compare.mjs');
  // 组件场景图很小，收紧阈值，避免小面积文字色变化被整图比例吞掉。
  const options = { ...DEFAULT_OPTIONS, threshold: 0.0002, strongPixels: 12 };
  // V7：全屏图 + 每个目标的 <key>-roi.png 一起参与比对（ROI 是"小面积变化"的有效证据）。
  const px = compareDirectories({ baselineDir: BASE_DIR, currentDir: CUR_DIR, diffDir: DIFF_DIR, options });
  const roiFiles = Object.values(roi).flat().map((r) => path.basename(r.file));
  const failed = styleDiffs.length > 0 || px.failed > 0;
  console.log(JSON.stringify({
    mode: 'check',
    themesRun: THEMES,
    comparedThemes: comparableThemes,
    roi: { count: roiFiles.length, files: roiFiles },
    probes,
    styleDiffs,
    pixel: { images: px.images, failed: px.failed, details: px.details, failures: px.failures },
  }, null, 2));
  app.exit(failed ? 1 : 0);
}

app.setPath('userData', path.join(WORK, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('组件视觉验证超时'); app.exit(1); }, 180000);
app.whenReady().then(async () => {
  try { await main(); } catch (e) { console.error(e && e.stack ? e.stack : e); app.exit(1); } finally { clearTimeout(deadline); }
}).catch(e => { console.error(e); app.exit(1); });
