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
/**
 * 基线「形态」标记（G-5）。
 *
 * <p>为什么要它：形态变了（全景图 → 每场景容器图）但字节也变了，光靠 MD5 无法区分
 * 「形态变更」与「视觉回归」。把形态写进 oracle 顶层 `forms` 后，不匹配就 exit 2
 * （基础设施/代码与基线没配对），而不是 exit 1（真视觉回归）。</p>
 */
const FORM = 'per-scene-v1';

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
  --assert-shadow               阴影逐字断言：box-shadow / text-shadow 与
                                scripts/theme-spec/shadow-baseline.json 完全相等（不设容差）。
                                无 shadow 的目标在报告里显式标注「无 shadow，跳过」。
  --write-shadow-baseline       写入阴影基线（生成/更新 shadow-baseline.json，需入仓）。
  --assert-low-tier             低档位（gray/zinc 100–400）专项：逐目标逐属性的 computed 色
                                与 low-tier-baseline.json 完全相等，并标注「是否为预期变更候选」。
  --write-low-tier-baseline     写入低档位基线（生成/更新 low-tier-baseline.json，需入仓）。
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
/**
 * V4 阴影逐字断言：`write` = 写基线（入仓），`check` = 与基线逐字比对，null = 不跑。
 * 之所以要独立开关：像素层对阴影几乎不可见（实测覆盖率 0.0012%），这一层是它唯一的证据。
 */
const SHADOW_MODE = argv.includes('--write-shadow-baseline')
  ? 'write'
  : (argv.includes('--assert-shadow') ? 'check' : null);
/**
 * V6 低档位专项：`write` = 写基线，`check` = 与基线比对。
 * 100–400 四档通道差 ≤6，正好落在像素阈值盲区里，只能靠 computed 色逐条比。
 */
const LOW_TIER_MODE = argv.includes('--write-low-tier-baseline')
  ? 'write'
  : (argv.includes('--assert-low-tier') ? 'check' : null);

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
 * 「固定画布」声明：每页都强制两条滚动条常驻。
 *
 * <p><b>为什么需要它（实测教训）：</b>页面的**可滚动画布**会决定经典滚动条是否占位，而占位与否
 * 直接改变布局宽度（800 或 800−17），进而改变 `main` 的居中偏移（x=20 或 x=11.5）。
 * x 落在半像素上还是整像素上，会让整片文字的亚像素抗锯齿都变 —— 于是「同一个元素、同一份代码」
 * 的 ROI 字节也会变。旧形态（所有场景同页、内容 5000+ px 高、最宽的 section 768+40 > 800）
 * 天然两条滚动条都在；一页一场景后窄场景页没有横向溢出，布局宽度就与旧形态不同。</p>
 *
 * <p>把它变成显式的固定画布（`overflow: scroll`）后，**每个场景页的布局几何逐像素一致**，
 * 与「这一页里有几个场景、多高」完全无关 —— 这既保住了既有 ROI 的字节，也保住了
 * 「新增场景不影响别人」这条解耦承诺（若依赖内容自然撑出滚动条，页内一改就又漂了）。</p>
 */
const SCENE_CANVAS_CSS = 'html { overflow: hidden; }';
/**
 * 场景页视口尺寸（G-5 起每场景一个独立 page，但宽度/高度取与旧基线同一有效视口）。
 *
 * <p><b>为什么宽度必须保持 800：</b>页面宽度决定 `main`（宽度 720、`margin:0 auto`）的居中偏移
 * 与可用宽度，进而决定每个元素落在哪个像素上。宽度一变，文字抗锯齿就会整片差异 ——
 * 那是「基线被悄悄换掉」，不是「场景解耦」。</p>
 *
 * <p><b>为什么高度取 1032 而不是 3100：</b>实测本机 offscreen 下 `capturePage()` 无论请求多高
 * 都只返回 800×1032，即旧基线的**有效**视口就是 800×1032。新形态照这个有效值开页面，
 * `vh` 与媒体查询的口径才与旧基线一致，既有 ROI 才能逐字节不变（G-5 硬指标）。</p>
 *
 * <p>需要更高视口的场景可在 {@link SCENES} 里单独给 `viewport`，互不影响 —— 这正是解耦的意义。</p>
 */
const SCENE_VIEWPORT = { width: 800, height: 1032 };


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
  // G-5：本目标固定在「展开态」页采集 —— 与 G-5 之前的口径逐字等价（旧选择器就是
  // 在 `[data-scene="sidebar-open"]` 内取最后一个 button[title]，即带文字的「设置」按钮）。
  // 曾经被错注册到 `sidebar-collapsed` 场景：一页一场景后那个页面上根本没有 open 容器，
  // 基线重建直接红；即使把选择器改成 `[data-scene^="sidebar-"]`，折叠态取到的是纯图标按钮
  // （40px 宽）而不是同一个元素（72px 宽）—— 那是「换了被测对象」，不是解耦。
  { key: 'sidebarFooterButton', desc: 'Sidebar 底部设置按钮（footer 容器内唯一带 title 的按钮）',
    sel: `(()=>{const root=document.querySelector('[data-scene="sidebar-open"]');if(!root)return null;const list=[...root.querySelectorAll('button[title]')];return list.length?list[list.length-1]:null;})()` },
  { key: 'sidebarEmptyState', desc: 'Sidebar 空态文案（无工作区无会话 → 「暂未指定工作区」）',
    sel: `(()=>{const root=document.querySelector('[data-scene="sidebar-empty"]');if(!root)return null;return [...root.querySelectorAll('div,span,p')].find(el=>el.children.length===0&&el.textContent.trim()==='暂未指定工作区')||null;})()` },
  { key: 'sidebarHistoryTitle', desc: 'Sidebar「历史对话」分组标题（未归属会话分区）',
    sel: `(()=>{const root=document.querySelector('[data-scene="sidebar-history"]');if(!root)return null;return [...root.querySelectorAll('div,span')].find(el=>el.children.length===0&&el.textContent.trim()==='历史对话')||null;})()` },
  // ── V1：5 个「灰阶混用组件」的探针（灰阶统一前置条件第一批）───────────────
  // 这些组件本轮**不许改**，场景只负责把当前外观钉在基线上，供后续 gray-N ↔ zinc-N
  // 统一时逐字节比对。选择器宁可依赖 DOM 结构也不要依赖颜色类名（类名正是未来要改的东西）。
  { key: 'cmiBubble', desc: 'ChatMessageItem 用户气泡容器（背景 = 灰阶混用点）',
    sel: `document.querySelector('[data-scene="chat-message-item"] [data-testid="user-message-bubble"]')` },
  { key: 'cmiBody', desc: 'ChatMessageItem 气泡正文（正文文字色）',
    sel: `document.querySelector('[data-scene="chat-message-item"] [data-testid="user-message-text"]')` },
  { key: 'cmiMeta', desc: 'ChatMessageItem 元信息行（时间戳 / 状态）',
    sel: `document.querySelector('[data-scene="chat-message-item"] [data-testid="user-message"] > div:last-child')` },
  { key: 'smCard', desc: 'SettingsModal 卡片本体（卡片背景 + 边框色）',
    sel: `document.querySelector('[data-scene="settings-modal-card"] div.rounded-3xl')` },
  { key: 'smTitle', desc: 'SettingsModal 标题文字',
    sel: `document.querySelector('[data-scene="settings-modal-card"] h3')` },
  { key: 'atRow', desc: 'AgentsTab 智能体卡片行（行背景 + 边框色）',
    sel: `document.querySelector('[data-scene="agents-tab-row"] div.space-y-3 > div')` },
  { key: 'atName', desc: 'AgentsTab 智能体名字（行主文字色）',
    sel: `document.querySelector('[data-scene="agents-tab-row"] div.space-y-3 > div span.text-sm')` },
  { key: 'atDesc', desc: 'AgentsTab 智能体描述（行次级文字色，已令牌化）',
    sel: `document.querySelector('[data-scene="agents-tab-row"] div.space-y-3 > div p')` },
  { key: 'sapShell', desc: 'SubAgentSidePanel 面板本体（面板背景）',
    sel: `document.querySelector('[data-scene="subagent-panel"] aside')` },
  { key: 'sapTitle', desc: 'SubAgentSidePanel 标题（子代理名）',
    sel: `document.querySelector('[data-scene="subagent-panel"] aside h3')` },
  { key: 'tmRow', desc: 'TeamModal 成员列表第 2 行（divide-y 产生的行上边框）',
    sel: `document.querySelector('[data-scene="team-modal-row"] div.divide-y > div:nth-child(2)')` },
  { key: 'tmName', desc: 'TeamModal 成员行名字（行文字色）',
    sel: `document.querySelector('[data-scene="team-modal-row"] div.divide-y > div span.text-xs')` },
];

/**
 * 场景注册表（G-5 的判据实现点）。
 *
 * <p><b>为什么要有这张表：</b>解耦的定义是「新增一个场景，既有基线的字节一个都不变」。
 * 要做到这点，每个场景必须拥有**自己的页面与自己的视口**，页面里只挂自己那一个容器 ——
 * 于是「新增场景」= 在这张表加一行，不会改动任何别的场景的文档高度、宽度或裁切源。</p>
 *
 * <p>字段说明：`targets` 是该场景页上要采集 computed style / 裁 ROI 的目标（必须在本页渲染）；
 * `prep` 是采集前的页面动作（展开下拉、聚焦输入框），顺序即执行顺序；
 * `settleMs` 是动作后的稳定等待（过渡/动画已被 STABILIZE_CSS 关掉，这里等的是布局提交）。</p>
 */
const SCENES = [
  { key: 'card-header', label: 'CardHeader 标题', targets: ['cardHeaderTitle'], prep: [], settleMs: 120 },
  { key: 'choice', label: 'RequireChoiceCard 自定义输入框', targets: ['choiceCustomInput'], prep: ['focusCustomInput'], settleMs: 120 },
  { key: 'dropdown', label: 'DropUpSelect 展开菜单', targets: ['dropdownMenuTitle'], prep: ['openDropdown'], settleMs: 400 },
  { key: 'chat-input', label: 'ChatInputArea', targets: ['chatInputTextarea'], prep: [], settleMs: 120 },
  { key: 'chat-input-driven', label: 'ChatInputArea（已选智能体）', targets: [], prep: [], settleMs: 120 },
  { key: 'sidebar-open', label: 'Sidebar 展开态', targets: ['sidebarWorkspaceLabel', 'sidebarSessionTitle', 'sidebarFooterButton'], prep: [], settleMs: 120 },
  { key: 'sidebar-empty', label: 'Sidebar 空态', targets: ['sidebarEmptyState'], prep: [], settleMs: 120 },
  // 折叠态只采容器图：它的验收点是「折叠后的整体外观」，没有元素级目标（旧实现里被错挂的
  // sidebarFooterButton 已回到 sidebar-open —— 那个目标测的是带文字的设置按钮）。
  { key: 'sidebar-collapsed', label: 'Sidebar 折叠态', targets: [], prep: [], settleMs: 120 },
  { key: 'sidebar-history', label: 'Sidebar 历史分组', targets: ['sidebarHistoryTitle'], prep: [], settleMs: 120 },
  { key: 'chat-message-item', label: 'ChatMessageItem 气泡', targets: ['cmiBubble', 'cmiBody', 'cmiMeta'], prep: [], settleMs: 120 },
  { key: 'settings-modal-card', label: 'SettingsModal 卡片', targets: ['smCard', 'smTitle'], prep: [], settleMs: 120 },
  { key: 'agents-tab-row', label: 'AgentsTab 行', targets: ['atRow', 'atName', 'atDesc'], prep: [], settleMs: 120 },
  { key: 'subagent-panel', label: 'SubAgentSidePanel', targets: ['sapShell', 'sapTitle'], prep: [], settleMs: 120 },
  { key: 'team-modal-row', label: 'TeamModal 成员行', targets: ['tmRow', 'tmName'], prep: [], settleMs: 120 },
];

/**
 * 容器图一律用 CDP clip 抓（`capturePage()` 会被夹在 1032 高、小尺寸还会抛 UnknownVizError），
 * ROI 一律从该页的视口图裁（与旧基线同一原语、同一像素网格 ⇒ 逐字节不变）。见 scene-kit 的
 * `createCapturer` 注释。
 */


const STYLE_PROPS = ['color', 'backgroundColor', 'borderTopColor', 'outlineColor', 'textShadow', 'opacity', 'fontSize', 'fontWeight'];

const APP_VUE = `<script setup>
import {ref,onMounted,nextTick} from 'vue';
import CardHeader from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/CardHeader.vue'))}';
import RequireChoiceCard from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/RequireChoiceCard.vue'))}';
import DropUpSelect from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/common/DropUpSelect.vue'))}';
import ChatInputArea from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/ChatInputArea.vue'))}';
import Sidebar from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/Sidebar.vue'))}';
import ChatMessageItem from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/ChatMessageItem.vue'))}';
import SettingsModal from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/views/settings/SettingsModal.vue'))}';
import AgentsTab from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/views/settings/tabs/AgentsTab.vue'))}';
import SubAgentSidePanel from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/SubAgentSidePanel.vue'))}';
import TeamModal from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/components/chat/TeamModal.vue'))}';
import http from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/services/interceptor.ts'))}';
import { useTheme } from '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/composables/useTheme.ts'))}';
import '${kit.relFrom(WORK, path.join(FRONTEND_ROOT, 'src/style.css'))}';
const dark=ref(false);
/**
 * G-5：场景页参数（?scene=<key>）。
 *
 * <p>空串 = 组合模式：把所有场景按正常流渲染在同一页上。它只服务「只看 computed style、
 * 不截图」的断言路径（--assert-dark-colors / --assert-low-tier / --assert-shadow）与主题护栏自检，
 * 因此不需要绝对定位之类的布局规避技巧 —— 那些技巧只为截图服务，而截图已经改成一场景一页。</p>
 */
const sceneKey=new URLSearchParams(location.search).get('scene')||'';
const show=(key)=>!sceneKey||sceneKey===key;
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
/**
 * 场景内 API 桩（只作用于这个隔离场景，不碰任何生产代码）。
 *
 * <p><b>为什么必须有：</b>AgentsTab / SettingsModal 的部分页签 / TeamModal 都在 onMounted 里拉
 * 列表数据。没有后端时它们永远停在「加载中 → 加载失败」态，**列表行根本不会渲染**，
 * 那样「行文字色 / 边框色」的断言就是对着空气断言（或直接因目标不存在而失败）。
 * 用 axios adapter 返回确定性的 Result 形状（code:1 = 成功，见 utils/api.ts 的 SUCCESS_CODES），
 * 让组件走真实渲染分支，同时保证数据固定、基线不随时间漂移。</p>
 */
// 头像不用 emoji：彩色 emoji 的字体回退/加载时机不同会让行盒高度出现亚像素差，
// 进而让下方卡片的 1px 上边框落在不同像素上 —— 实测表现为「同一份代码两次采集
// 189 个像素、maxDelta 8」的假红。改用 CJK 单字（页面本身就是 zh-CN，字体必然已就位）。
const apiAgentRows=[
  {id:1,name:'代码助手',avatar:'代',modelId:'m1',description:'灰阶场景用的智能体',toolList:['read_file']},
  {id:2,name:'文档助手',avatar:'文',modelId:'m1',description:'第二个成员行（触发 divide 边框）',toolList:[]},
];
const apiToolRows=[{name:'read_file',description:'读取文件',readOnly:true},{name:'write_file',description:'写入文件',readOnly:false}];
const apiModelGroups=[{providerName:'本地',models:[{id:'m1',modelName:'GPT-Test',providerName:'本地'}]}];
const API_FIXTURES={
  '/agent/list':{code:1,data:{records:apiAgentRows,total:apiAgentRows.length}},
  '/tools/list':{code:1,data:apiToolRows},
  '/model/catalog':{code:1,data:apiModelGroups},
  '/model/list':{code:1,data:{records:[],total:0}},
  '/team/list':{code:1,data:{records:[],total:0}},
};
http.defaults.adapter=async(config)=>{
  const url=String(config.url||'');
  window.__apiCalls=(window.__apiCalls||[]).concat(url);
  // 在飞的请求计数：采集前必须等它归零。
  // 为什么不能靠「等固定时长」：组件取数是异步的，数据落地后会触发一次重渲染（行从 0 条变 2 条，
  // 容器高度、边框 y 坐标都会变）。若截图正好落在这之前/之后，同一份代码两次采集就会差出
  // 189px / maxDelta 8（正是 agents-tab-row 的实测抖动）。用「在飞计数归零」把这一点变成可观测事实，
  // 而不是靠猜时间。
  window.__apiPending=(window.__apiPending||0)+1;
  try{
    const hit=Object.keys(API_FIXTURES).find((k)=>url.startsWith(k));
    return {data:hit?API_FIXTURES[hit]:{code:1,data:null},status:200,statusText:'OK',headers:{},config,request:{}};
  } finally {
    window.__apiPending=Math.max(0,(window.__apiPending||1)-1);
  }
};
window.__apiProbe=async()=>{ try { const r=await http.get('/agent/list?page=1&pageSize=100'); return JSON.stringify(r).slice(0,300); } catch(e){ return 'ERR:'+String(e&&e.message||e); } };
/** 灰阶混用场景的数据：固定 id / 固定文案，保证基线可重复。 */
const cmiMessage={id:'u1',role:'user',content:'灰阶混用：气泡正文与元信息行',timestamp:1704067200000,messages:[]};
/**
 * TeamModal 必须先挂载（isOpen=false）再打开。
 *
 * 它的 watch(() => props.isOpen, ..., { immediate: true }) 在「挂载时 isOpen 已为 true」这一支里
 * 会调用 closeAgentForm()，而该函数是后面才声明的 const ⇒ 命中 TDZ 抛错，成员列表永远不加载。
 * 生产里弹窗总是先挂载（关闭态）再被打开，所以场景照真实顺序走；这不是改组件，只是不踩它的初始化缺陷。
 */
const teamOpen=ref(false);
onMounted(async()=>{await nextTick();teamOpen.value=true;});
const sapItems=[
  {id:'sub-1',agentName:'子代理甲',task:'整理灰阶清单',status:'completed'},
  {id:'sub-2',agentName:'子代理乙',task:'复核令牌映射',status:'running'},
];
window.setDark=value=>{dark.value=value;setTheme(value?'dark':'light');const el=document.documentElement;el.classList.toggle('dark',value);el.classList.toggle('light',!value);el.setAttribute('data-theme',value?'dark':'light');document.body.style.background=value?'#18181b':'#ffffff';};
window.openDropdown=()=>{const trigger=document.querySelector('[data-scene="dropdown"] button');if(trigger&&trigger.getAttribute('aria-expanded')!=='true')trigger.click();};
window.showCustomInput=()=>{};
window.focusCustomInput=()=>{const input=document.querySelector('[data-scene="choice"] input[type="text"]');if(input)input.focus();};
</script>
<template>
  <main style="width:720px;margin:0 auto;padding:20px;font-family:system-ui,sans-serif" :class="dark?'text-zinc-100':'text-zinc-900'">
    <section v-if="show('card-header')" data-scene="card-header" style="padding:10px 8px">
      <CardHeader tone="pending" type-label="计划" title="卡片标题可见性探针" :is-dark="dark" />
    </section>
    <section v-if="show('choice')" data-scene="choice" style="padding:10px 8px">
      <RequireChoiceCard :prompt-card="choiceCard" :is-dark="dark" />
    </section>
    <section v-if="show('dropdown')" data-scene="dropdown" style="padding:10px 8px;min-height:260px">
      <DropUpSelect v-model="sel" :options="opts" :is-dark="dark" menu-title="下拉菜单标题" />
    </section>
    <section v-if="show('chat-input')" data-scene="chat-input" style="padding:10px 8px;min-height:220px">
      <ChatInputArea :is-dark="dark" :context-usage="inputUsage" :models="inputModels" />
    </section>
    <section v-if="show('chat-input-driven')" data-scene="chat-input-driven" style="padding:10px 8px;min-height:220px">
      <ChatInputArea :is-dark="dark" :models="inputModels" :agents="inputAgents" selected-agent-id="a1" />
    </section>
    <!-- 以下 4 个 Sidebar 场景：固定尺寸 + 固定数据，明暗两态由 runner 切换。
         一个 section × 两主题即可同时覆盖「暗色 BranchedMenu 分支」与「亮色自绘列表」。 -->
    <section v-if="show('sidebar-open')" data-scene="sidebar-open" style="width:264px;height:520px;overflow:hidden;border:1px solid #8884">
      <Sidebar :sessions="sbSessions" active-session-id="s1" :workspaces="sbWorkspaces" :active-workspace-id="1" :is-collapsed="false" :is-dark="dark" />
    </section>
    <section v-if="show('sidebar-empty')" data-scene="sidebar-empty" style="width:264px;height:520px;overflow:hidden;border:1px solid #8884">
      <Sidebar :sessions="[]" :active-session-id="null" :workspaces="[]" :is-collapsed="false" :is-dark="dark" />
    </section>
    <section v-if="show('sidebar-collapsed')" data-scene="sidebar-collapsed" style="width:80px;height:520px;overflow:hidden;border:1px solid #8884">
      <Sidebar :sessions="[]" :active-session-id="null" :workspaces="sbWorkspaces" :is-collapsed="true" :is-dark="dark" />
    </section>
    <section v-if="show('sidebar-history')" data-scene="sidebar-history" style="width:264px;height:640px;overflow:hidden;border:1px solid #8884">
      <Sidebar :sessions="sbHistorySessions" :active-session-id="null" :workspaces="[]" :is-collapsed="false" :is-dark="dark" />
    </section>
    <!-- 以下 5 个「灰阶混用组件」场景（V1）。
         它们以前靠 position:absolute;top:3400px 避开文档流，因为共用一页时新增场景会把上方
         既有场景挤下去（滚动条一出现，上部 8.2 万像素就变）。G-5 改成一场景一页后这个 hack
         已删除：每个场景页里只有自己，谁也不会挤谁。
         SettingsModal / TeamModal 根节点是 fixed inset-0 全屏遮罩，因此仍套一层 transform 容器
         让它们以该容器为包含块（这是组件本身的使用方式，不是布局规避）。 -->
    <section v-if="show('chat-message-item')" data-scene="chat-message-item" style="padding:10px 8px">
      <ChatMessageItem :message="cmiMessage" :is-dark="dark" session-id="42" />
    </section>
    <section v-if="show('settings-modal-card')" data-scene="settings-modal-card" style="position:relative;transform:translateZ(0);width:768px;height:600px;overflow:hidden;border:1px solid #8884">
      <SettingsModal :is-dark="dark" initial-tab="about" :teleport="false" />
    </section>
    <section v-if="show('agents-tab-row')" data-scene="agents-tab-row" style="width:720px;padding:8px;border:1px solid #8884">
      <AgentsTab :is-dark="dark" />
    </section>
    <section v-if="show('subagent-panel')" data-scene="subagent-panel" style="width:380px;height:460px;overflow:hidden;border:1px solid #8884">
      <SubAgentSidePanel :items="sapItems" active-sub-id="sub-1" :is-open="true" :is-dark="dark" />
    </section>
    <section v-if="show('team-modal-row')" data-scene="team-modal-row" style="position:relative;transform:translateZ(0);width:768px;height:620px;overflow:hidden;border:1px solid #8884">
      <TeamModal :is-open="teamOpen" :is-dark="dark" :models="[]" :teleport="false" />
    </section>
  </main>
</template>
<style>${STABILIZE_CSS}${SCENE_CANVAS_CSS}</style>`;

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

/**
 * 在渲染器里读取目标元素的 computed style 与可见性。
 *
 * @param {string[]} keys 要采集的目标键（G-5 起按场景页过滤：一页只有该场景的目标）
 * @returns {string} 渲染器表达式
 */
function readStylesExpr(keys) {
  const selected = TARGETS.filter((t) => keys.includes(t.key));
  return `(() => {
    const props = ${JSON.stringify(STYLE_PROPS)};
    const out = {};
    const defs = ${JSON.stringify(selected.map(t => ({ key: t.key, sel: t.sel })))};
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

/** 目标键 → 目标声明（报错文案用）。 */
const TARGET_BY_KEY = new Map(TARGETS.map((t) => [t.key, t]));

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

/**
 * 等到容器 DOM 稳定（连续两次采样签名相同）。
 *
 * <p><b>为什么必需：</b>场景里挂的是真实组件，有些组件会异步取数据（AgentsTab 会打后端，
 * 测试环境拿到 500 后落到空态）。若在「取数中 → 空态」的交界处截图，同一份代码两次采集会
 * 得到 189 个像素、maxDelta 8 的微差 —— 那是**假红**，会让人去查一个根本不存在的回归。
 * 这里用「连续两次 innerHTML+textContent 采样完全一致」作为稳定判据，与组件内部实现无关。</p>
 *
 * @param {(expr: string) => Promise<any>} evaluate 页面求值函数
 * @param {string} sceneKey 场景键
 * @param {{timeoutMs?: number, sampleMs?: number}} [options] 超时与采样间隔
 * @returns {Promise<void>}
 * @throws {Error} 超时仍未稳定时抛出（宁可红，也不要在抖动中截图）
 */
async function waitForStableDom(evaluate, sceneKey, { timeoutMs = 6000, sampleMs = 120 } = {}) {
  const expr = `(() => { const el = document.querySelector('[data-scene="${sceneKey}"]');
    return el ? (el.innerHTML.length + '|' + el.textContent) : 'missing'; })()`;
  let prev = null;
  let stableCount = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const signature = await evaluate(expr);
    if (signature === 'missing') throw new Error(`[${sceneKey}] 场景容器不存在，无法等待稳定`);
    if (signature === prev) {
      stableCount += 1;
      if (stableCount >= 2) return;
    } else {
      stableCount = 0;
      prev = signature;
    }
    await new Promise((r) => setTimeout(r, sampleMs));
  }
  throw new Error(`[${sceneKey}] 容器 DOM 在 ${timeoutMs}ms 内没有稳定（异步内容一直在变），拒绝在抖动中截图`);
}

/**
 * 等到「没有在飞的接口请求」。
 *
 * <p><b>为什么需要它（与 {@link waitForStableDom} 互补，不能互相替代）：</b>
 * DOM 采样只能看到「已经落到 DOM 上的变化」。AgentsTab 的取数是
 * 「挂载 → adapter 返回 → nextTick 落 DOM」，若采样窗口正好卡在「请求已发出、数据还没落 DOM」
 * 的那一小段，两次 DOM 采样可能都是同一个「空态」而判定稳定 —— 但紧接着的 re-render 会让
 * 截图变成「列表态」，于是同一份代码两次采集就差了 189 个像素（实测就是 agents-tab-row）。
 * 把 adapter 的在飞计数也纳入判据后，这一类「尚未落到 DOM 的异步工作」也能被观测到。</p>
 *
 * @param {(expr: string) => Promise<any>} evaluate 页面求值函数
 * @param {string} sceneKey 场景键（仅用于报错定位）
 * @param {{timeoutMs?: number, sampleMs?: number}} [options] 超时与采样间隔
 * @returns {Promise<void>} 在飞请求归零时返回
 * @throws {Error} 超时仍有在飞请求时抛出
 */
async function waitForNoPendingRequests(evaluate, sceneKey, { timeoutMs = 6000, sampleMs = 60 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = await evaluate('window.__apiPending||0');
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, sampleMs));
  }
  throw new Error(`[${sceneKey}] ${timeoutMs}ms 内仍有在飞接口请求（window.__apiPending≠0），拒绝在异步未落定时截图`);
}

/**
 * 采集一次的「图集合」：容器 clip 图 +（可选）整页图，各带 PNG 字节。
 *
 * <p>为什么两遍 PNG 字节要一起验：ROI 是从整页图裁的，只验容器图的话，
 * 「容器图稳定但整页图抖」仍会让 42 张 ROI 里的一张变字节。</p>
 *
 * @typedef {{image: object, buffer: Buffer}} Shot
 * @typedef {{container: Shot, fullPage: Shot|null, box: {x: number, y: number, width: number, height: number}}} ShotSet
 */

/** 采集确定性判据的最大轮数（1 轮 = 抓两遍并逐字节比对）。 */
const CAPTURE_STABILITY_ROUNDS = 5;

/**
 * 抓一次「图集合」，并在字节层面做像素差异描述（仅用于失败诊断）。
 *
 * @param {{a: Buffer, b: Buffer}} pair 两遍 PNG 字节
 * @param {string} label 图像标识
 * @returns {Promise<string>} 人话描述
 */
async function describeShotDiff(pair, label) {
  const bytes = `字节 ${pair.a.length} vs ${pair.b.length}`;
  if (pair.a.length === pair.b.length && pair.a.equals(pair.b)) return `${label}：一致`;
  try {
    const { decodePng, compareImagePair } = await import('./compare.mjs');
    const result = compareImagePair(decodePng(pair.a), decodePng(pair.b));
    return `${label}：${bytes}，changedPixels=${result.changedPixels} maxChannelDelta=${result.maxChannelDelta}`;
  } catch (e) {
    return `${label}：${bytes}（像素级诊断不可用：${e && e.message ? e.message : e}）`;
  }
}

/**
 * 确定性地抓「一场景一态」的图：同一状态连抓两遍，**逐字节相等才采信**；不等就重抓，最多 N 轮。
 *
 * <p><b>为什么这个判据能根治抖动（而不是「多等一会」）：</b>
 * 抖动的本质是「截图采样了一个正在移动的状态」。单次截图只能给出某一个合成帧，
 * 它是否属于终态**无法从这一帧本身判断**。连续抓两遍逐字节比对，等价于在采样时刻
 * 检查「这一页的像素是不是已经静止」：静止页两帧必然相同；只要还有任何在变的东西
 * （异步 re-render、字体回填、图层提升、动画残留）就会暴露为字节差异，于是我们**不落盘**。
 * 于是「写进基线的每一张图」都满足「至少被连续观测到两次相同」，两次 baseline 之间也就不可能
 * 出现字节差异；真正的持续抖动会在 N 轮后抛错（宁可红，也不留不稳定基线）。</p>
 *
 * <p><b>判据只作用于采集，不放宽任何比对口径</b>：pixelDelta / threshold / strongPixels 全部未动。</p>
 *
 * @param {{capturer: object, evaluate: Function, sceneKey: string, theme: 'light'|'dark', needFullPage: boolean}} options 采集参数
 * @returns {Promise<ShotSet>} 已确认稳定的图集合
 * @throws {Error} N 轮后仍不稳定时抛出
 */
async function captureStableSet({ capturer, evaluate, sceneKey, theme, needFullPage }) {
  const measureBox = async () => {
    const box = await evaluate(`(() => { const el = document.querySelector('[data-scene="${sceneKey}"]');
      if (!el) return null; const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error(`[${theme}/${sceneKey}] 场景容器不存在或不可见，拒绝截图（否则是空图基线）`);
    }
    return box;
  };
  const grab = async () => {
    const box = await measureBox();
    const containerImage = await capturer.clip(box);
    const containerBuffer = containerImage.toPNG();
    let fullPage = null;
    if (needFullPage) {
      const fullPageImage = await captureFullPageShot(capturer, theme, sceneKey);
      fullPage = { image: fullPageImage, buffer: fullPageImage.toPNG() };
    }
    return { container: { image: containerImage, buffer: containerBuffer }, fullPage, box };
  };

  let lastProblem = '';
  for (let round = 1; round <= CAPTURE_STABILITY_ROUNDS; round += 1) {
    const first = await grab();
    // 让合成管线走完两帧再抓第二遍：静止页面两帧后像素必然一致；
    // 仍在变（异步 re-render / 字体回填 / 图层提升）就必然在这里暴露。
    await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
    const second = await grab();
    const containerSame = first.container.buffer.equals(second.container.buffer);
    const fullSame = needFullPage ? first.fullPage.buffer.equals(second.fullPage.buffer) : true;
    if (containerSame && fullSame) {
      if (round > 1) console.error(`[capture] ${theme}/${sceneKey} 第 ${round} 轮才稳定（已丢弃前 ${round - 1} 轮抖动样本）`);
      return second;
    }
    const details = [];
    if (!containerSame) details.push(await describeShotDiff({ a: first.container.buffer, b: second.container.buffer }, '容器图'));
    if (!fullSame) details.push(await describeShotDiff({ a: first.fullPage.buffer, b: second.fullPage.buffer }, '整页图'));
    lastProblem = details.join('；');
    console.error(`[capture] ${theme}/${sceneKey} 第 ${round}/${CAPTURE_STABILITY_ROUNDS} 轮两遍抓图不一致 → 重抓。${lastProblem}`);
    // 重抓之前再等一帧：如果是「正好卡在某个异步落定瞬间」，下一轮通常立刻稳定。
    await evaluate('new Promise((r) => setTimeout(r, 0))');
  }
  throw new Error(
    `[${theme}/${sceneKey}] 采集不确定：连续 ${CAPTURE_STABILITY_ROUNDS} 轮「抓两遍逐字节相等」判据均失败（${lastProblem}）。`
    + '拒绝写入抖动基线 —— 这是采集层的基础设施问题，不是视觉回归；请先让该场景的渲染输入确定（无异步 re-render / 无字体回填）。',
  );
}

/**
 * 抓整页图（ROI 的裁切源），失败重试并给出可诊断的错误。
 *
 * <p><b>为什么用整页图而不是视口图：</b>`capturePage()`（视口图）在本机 offscreen 下恒为
 * 800×1032，目标一旦落在 1032 以下就裁出「越界后的空白」而比对照样全绿 —— 旧实现正是
 * 靠「超界才改用整页图」的分支绕过了它，代价是 ROI 的字节取决于元素是否越界（同一个元素
 * 上下挪一下，字节就变）。G-5 起统一：ROI 一律从整页图裁，规则唯一、与元素位置无关。</p>
 *
 * <p><b>为什么要重试：</b>offscrereen 下 CDP 截图偶发抛 `UnknownVizError`
 * （实测一页一场景后单轮要开 28 个窗口，某个窗口的首次合成有时还没就绪）。
 * 这是**基础设施瞬态**，不是视觉回归，因此重试而不是直接判红；同参数重复抓图逐字节一致
 * （已由「连跑两次零差异」验证），重试不会让 ROI 字节漂移。</p>
 *
 * @param {{fullPage: Function}} capturer 截图器
 * @param {'light'|'dark'} theme 主题（仅用于报错定位）
 * @param {string} sceneKey 场景键（仅用于报错定位）
 * @returns {Promise<object>} nativeImage 整页图
 */
async function captureFullPageShot(capturer, theme, sceneKey) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await capturer.fullPage();
    } catch (e) {
      lastError = e;
      console.error(`[capture] ${theme}/${sceneKey} 整页抓图失败（第 ${attempt}/4 次）：${e && e.message ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw new Error(`[${theme}/${sceneKey}] 整页抓图连续失败：${lastError && lastError.message ? lastError.message : lastError}`);
}

/**
 * 采集「一个场景页」的一态：断言主题 → 前置动作 → computed style → 容器图 + 元素 ROI。
 *
 * <p><b>为什么一场景一页：</b>共用一页时，任何场景的增删都会改变文档高度/宽度与
 * `capturePage()` 的裁切源，于是「新增场景」= 「既有基线字节全变」。一场景一页后，
 * 页面里只有自己那一个容器，新增场景再也不会改动别人的页面。</p>
 *
 * <p><b>两种图的来源不同，这是有意的：</b>
 * <ul>
 *   <li>容器图 `scene-&lt;key&gt;.png`：CDP clip，正好是容器矩形（`capturePage()` 会被夹在 1032 高）；</li>
 *   <li>元素 ROI `&lt;key&gt;-roi.png`：从该页的**视口图**（`capturePage()`）裁 —— 与 G-5 之前的
 *       基线同一原语、同一像素网格，因此 42 张既有 ROI 可以逐字节不变（G-5 硬指标）。</li>
 * </ul></p>
 *
 * @param {{scene: object, theme: 'light'|'dark', outDir: string, mutate?: boolean, breakTheme?: string|null}} options 采集参数
 * @returns {Promise<{styles: object, roi: Array<object>, probe: object, scenes: object}>} 本场景本态的采集结果
 */
async function captureScene({ scene, theme, outDir, mutate = false, breakTheme = null }) {
  const viewport = scene.viewport || SCENE_VIEWPORT;
  // 进度打到 stderr：一页一场景后单轮要开 28 个窗口，失败时没有这行就只能靠猜「卡在哪一页」。
  console.error(`[capture] ${theme}/${scene.key} 视口 ${viewport.width}x${viewport.height}`);
  const page = await kit.openScene(WORK, {
    width: viewport.width,
    height: viewport.height,
    query: { scene: scene.key },
  });
  const { win, evaluate } = page;
  const capturer = kit.createCapturer(win);
  try {
    if (breakTheme) {
      await evaluate(BREAK_THEME_JS[breakTheme]);
      await evaluate('window.flush()');
    }
    await evaluate(`window.setDark(${theme === 'dark'})`);
    await evaluate('window.flush()');
    // 护栏：主题必须真的翻转（根标记位 + 令牌变量 + Tailwind 映射后的计算色）。
    await kit.assertThemeApplied(evaluate, theme, TOKENS);

    // 前置动作按场景声明执行（顺序即语义：先开下拉再聚焦，点按钮会让输入框失焦）。
    for (const prep of scene.prep || []) {
      await evaluate(`window.${prep}()`);
      await evaluate('window.flush()');
      await new Promise((r) => setTimeout(r, scene.settleMs || 120));
    }

    if (mutate) {
      // 只改「标题」颜色，制造一个极小面积差异，验证比对/样式采集不会漏。
      await evaluate(`(() => { const el = document.querySelector('[data-scene="card-header"] span[title]'); if (el) el.style.setProperty('color', 'rgb(255, 0, 255)', 'important'); })()`);
      await evaluate('window.flush()');
    }

    // 稳定化三道（全部是「可观测事实」，不是「多等一会」）：
    // ① 字体加载完（否则同一份代码会因字体替换时机产生 1px 级差异）；
    // ② adapter 在飞请求归零（异步取数尚未落到 DOM 的窗口也要排除）；
    // ③ 容器 DOM 连续两次采样一致（落定后的 DOM 事实）。
    // 三道之后仍由 captureStableSet 做「抓两遍逐字节相等」的最终判据。
    await evaluate('document.fonts.ready.then(() => true)');
    await waitForNoPendingRequests(evaluate, scene.key);
    await waitForStableDom(evaluate, scene.key);

    const styles = await evaluate(readStylesExpr(scene.targets));
    // 断言：本场景的目标都在、都可见（缺失或不可见时截图就是空图基线）。
    const problems = [];
    for (const key of scene.targets) {
      const target = TARGET_BY_KEY.get(key);
      const s = styles[key];
      if (!s || !s.found) problems.push(`${key}: 目标不存在（${target ? target.desc : '未登记'}）`);
      else if (!s.visible) problems.push(`${key}: 目标不可见`);
    }
    if (scene.key === 'choice') {
      const inputFocused = await evaluate(`document.activeElement === document.querySelector('[data-scene="choice"] input[type="text"]')`);
      if (!inputFocused) problems.push('choiceCustomInput: 未获得焦点');
    }
    if (problems.length) throw new Error(`[${theme}/${scene.key}] 场景断言失败：\n  - ${problems.join('\n  - ')}`);

    const probe = await evaluate(kit.PROBE_JS);

    // 容器图 + 整页图：同一时刻连抓两遍、逐字节相等才采信（见 captureStableSet 的机制说明）。
    // 容器尺寸同时记进 styles.json.scenes（「容器被意外裁小」要能回溯期望值）。
    const needFullPage = scene.targets.length > 0;
    const stable = await captureStableSet({ capturer, evaluate, sceneKey: scene.key, theme, needFullPage });
    const containerShot = stable.container.image;
    const containerFile = await kit.themeImagePath(outDir, theme, kit.sceneImageName(scene.key));
    await fsp.writeFile(containerFile, stable.container.buffer);
    const containerSize = containerShot.getSize();

    // 元素 ROI：一律从整页图裁（见 captureFullPageShot 的注释：单一规则、不被视口高度夹掉）。
    const roi = [];
    if (needFullPage) {
      const fullImage = stable.fullPage.image;
      const pageWidth = await evaluate('document.documentElement.scrollWidth || window.innerWidth');
      const ratio = kit.imageRatio(fullImage, pageWidth);
      const rects = await evaluate(`(() => {
        const defs = ${JSON.stringify(TARGETS.filter((t) => scene.targets.includes(t.key)).map((t) => ({ key: t.key, sel: t.sel })))};
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
      // 诊断开关：给了 ROI_DEBUG 就打印裁切几何（定位「ROI 内容整体位移」这类问题：
      // 位移通常是 imageRatio 的 pageWidth 取错 —— 图片宽度与 scrollWidth 不是同一口径时，
      // crop 坐标会被整体缩放，表现就是「卡片大小一样、内容偏了几个像素」）。
      if (process.env.ROI_DEBUG) {
        console.error(`[roi/${theme}/${scene.key}] pageWidth=${pageWidth} image=${JSON.stringify(fullImage.getSize())} ratio=${ratio} `
          + JSON.stringify(rects.map((r) => (r.rect ? `${r.key}@${Math.round(r.rect.x)},${Math.round(r.rect.y)}` : `${r.key}:${r.reason}`))));
      }
      for (const item of rects) {
        if (!item.rect) continue; // 目标不可见：上面的可见性断言负责报错，这里不重复失败
        const cropped = kit.cropImage(fullImage, item.rect, ratio);
        if (!cropped) continue;
        const file = await kit.themeImagePath(outDir, theme, kit.roiImageName(item.key));
        await fsp.writeFile(file, cropped.image.toPNG());
        roi.push({ key: item.key, file, rect: cropped.rect, theme, source: 'fullpage' });
      }
    }

    return {
      styles,
      roi,
      probe,
      scenes: { [scene.key]: { width: containerSize.width, height: containerSize.height } },
    };
  } finally {
    capturer.detach();
    page.close();
  }
}

/**
 * 采集全部场景的全部主题。
 *
 * <p>顺序是「主题 → 场景」：每个场景页内只跑一态，避免同一页跑两态时主题切换的串扰
 * （旧实现是同一页里切两次主题）。</p>
 *
 * @param {string} outDir 产物目录（baseline / current / 自检临时目录）
 * @param {{mutate?: boolean, breakTheme?: string|null}} [options] 变异开关
 * @returns {Promise<{styles: object, probes: object, roi: object, scenes: object}>} 采集结果
 */
async function runCapture(outDir, { mutate = false, breakTheme = null } = {}) {
  const styles = {};
  const probes = {};
  /** @type {Record<string, Array<object>>} */
  const roiByTheme = {};
  /** @type {Record<string, Record<string, {width: number, height: number}>>} */
  const sceneSizes = {};
  await fsp.mkdir(outDir, { recursive: true });
  for (const theme of THEMES) {
    styles[theme] = {};
    roiByTheme[theme] = [];
    sceneSizes[theme] = {};
    // 清掉本主题目录与旧形态遗留的全景图：旧 light.png / dark.png 不属新形态，
    // 留着会被 oracle 报成「多余文件」，也会让「这一轮到底产了什么」不可判定。
    await fsp.rm(path.join(outDir, theme), { recursive: true, force: true });
    await fsp.rm(path.join(outDir, `${theme}.png`), { force: true });
    for (const scene of SCENES) {
      const captured = await captureScene({ scene, theme, outDir, mutate, breakTheme });
      Object.assign(styles[theme], captured.styles);
      Object.assign(sceneSizes[theme], captured.scenes);
      roiByTheme[theme].push(...captured.roi);
      if (!probes[theme]) probes[theme] = captured.probe;
    }
  }
  // 两态都要跑时才能比较「明暗是否真的不同」；只跑一态时这条护栏无意义（也是显式跳过而非假绿）。
  if (THEMES.length === 2) kit.assertThemesDiffer(probes.light, probes.dark);
  await fsp.writeFile(
    path.join(outDir, 'styles.json'),
    JSON.stringify({ themesRun: THEMES, styles, probes, scenes: sceneSizes, roi: roiByTheme }, null, 2),
  );
  return { styles, probes, roi: roiByTheme, scenes: sceneSizes };
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
/**
 * 把失败图像整理成「相对路径 + 原因」的清单条目。
 *
 * @param {Array<object>} details compareDirectories 的明细
 * @param {string[]} failures its 的失败原因串
 * @returns {Array<{image: string, status: string, changedPixels?: number, reasons: string[]}>} 失败清单
 */
function recordOfDiffFailures(details, failures) {
  return details.map((d) => ({
    image: String(d.image).split(path.sep).join('/'),
    status: String(d.status),
    changedPixels: d.changedPixels,
    changedRatio: d.changedRatio,
    reasons: Array.isArray(d.reasons) ? d.reasons : [failures.find((f) => String(f).startsWith(String(d.image))) || '未知原因'],
  }));
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
 * 「锁当前值」标记：该属性目前**没有**语义令牌（灰阶统一的前置目标），
 * 但断言仍然要断具体色值，因此把当前计算色写死成期望，并附上理由。
 *
 * <p>为什么允许写死：这些正是「灰阶混用」要统一的值，统一前必须先把现状钉住，
 * 否则无从证明改造只改了实现、没改外观。统一完成后必须把它们换成令牌（见未决项）。</p>
 *
 * @param {string} value 期望色（hex 或 rgba(...)）
 * @param {string} reason 为什么此处还没有令牌
 * @returns {{literal: string, reason: string}}
 */
const literal = (value, reason) => ({ literal: normalizeColorString(value), reason });

/**
 * 把颜色字符串归一成「与浏览器 computed style 可比」的形式。
 *
 * <p>两侧都要归一，否则半透明色会因为 alpha 精度（0.7 / 0.698 / 0.702）互不相等而假红：
 * 画布像素采样只能给出 8 位 alpha（38/255=0.149），因此统一把 alpha 收到两位小数。</p>
 *
 * @param {string} raw 形如 `#e5e7eb` / `rgba(255, 255, 255, 0.7)` 的颜色
 * @returns {string} `rgb(r, g, b)` 或 `rgba(r, g, b, a)`（a 两位小数）
 */
function normalizeColorString(raw) {
  const asRgb = kit.toCssRgb(String(raw));
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(asRgb.trim());
  if (!m) return asRgb.trim();
  const alpha = m[4] === undefined ? 1 : Math.round(parseFloat(m[4]) * 100) / 100;
  const head = `rgb(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])}`;
  return alpha >= 1 ? `${head})` : `rgba(${Number(m[1])}, ${Number(m[2])}, ${Number(m[3])}, ${alpha})`;
}

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
  // ── V1：灰阶混用组件（暗态期望）───────────────────────────────────────────
  // 说明：能落到令牌上的直接写令牌；还没令牌化的**锁当前值**并写明理由 —— 这些正是
  // 「gray-N ↔ zinc-N 统一」待改造的点，先钉现状才能证明后续改造零视觉漂移。
  cmiBubble: {
    // 气泡正文色：暗 text-zinc-100(#f4f4f5) 恰好等于 primary-soft 的暗值 ⇒ 可令牌化
    color: '--lx-text-primary-soft',
    // 气泡背景：暗 bg-zinc-800(#27272a)，令牌表里没有对应语义（surface-elevated 是 0.902 黑）
    backgroundColor: literal('#27272a', '气泡底色仍是原始灰阶类 bg-zinc-800，待灰阶统一后补令牌'),
    // 暗态有 border border-white/[0.08]
    borderTopColor: literal('rgba(255, 255, 255, 0.08)', '气泡描边是原始 alpha 类，无对应令牌'),
    borderBottomColor: literal('rgba(255, 255, 255, 0.08)', '气泡描边是原始 alpha 类，无对应令牌'),
    boxShadow: skip('shadow-xs 是原始阴影类，本批不追踪阴影（灰阶只管颜色）'),
    textShadow: STRUCTURAL.none,
  },
  cmiBody: {
    color: '--lx-text-primary-soft',
    backgroundColor: STRUCTURAL.transparent,
    borderTopColor: STRUCTURAL.currentColor,
    borderBottomColor: STRUCTURAL.currentColor,
    boxShadow: STRUCTURAL.none,
    textShadow: STRUCTURAL.none,
  },
  cmiMeta: {
    // 元信息行（时间戳/状态）已折成 text-lx-faint
    color: '--lx-text-faint',
    backgroundColor: STRUCTURAL.transparent,
    borderTopColor: STRUCTURAL.currentColor,
    borderBottomColor: STRUCTURAL.currentColor,
    boxShadow: STRUCTURAL.none,
    textShadow: STRUCTURAL.none,
  },
  smCard: {
    color: '--lx-text-primary-soft',
    backgroundColor: literal('#000000', '卡片底色仍是原始 bg-black，令牌 surface-elevated 是 0.902 黑，不等价'),
    borderTopColor: literal('rgba(255, 255, 255, 0.15)', '卡片描边是原始 alpha 类 border-white/15，与 border-default(0.149) 差 0.001'),
    borderBottomColor: literal('rgba(255, 255, 255, 0.15)', '同上'),
    boxShadow: skip('shadow-2xl + 自定义发光阴影是复合值，本批不追踪阴影'),
    textShadow: STRUCTURAL.none,
  },
  smTitle: {
    color: '--lx-text-primary',
    backgroundColor: STRUCTURAL.transparent,
    borderTopColor: STRUCTURAL.currentColor,
    borderBottomColor: STRUCTURAL.currentColor,
    boxShadow: STRUCTURAL.none,
    textShadow: skip('标题带 dark:text-glow-white 发光特效，属 GLOW 类，按规格书不许改也不纳入色值断言'),
  },
  atRow: {
    color: skip('行容器文字色继承自场景外壳，不代表组件自身取色'),
    backgroundColor: literal('rgba(0, 0, 0, 0.9)', '行底色仍是原始 bg-black/90，待灰阶统一后补令牌'),
    borderTopColor: literal('rgba(255, 255, 255, 0.15)', '行描边是原始 alpha 类 border-white/15'),
    borderBottomColor: literal('rgba(255, 255, 255, 0.15)', '同上'),
    boxShadow: skip('行带自定义发光阴影（rgba(0,0,0,0.8) 外发光），本批不追踪阴影'),
    textShadow: STRUCTURAL.none,
  },
  atName: {
    color: '--lx-text-primary',
    backgroundColor: STRUCTURAL.transparent,
    borderTopColor: STRUCTURAL.currentColor,
    borderBottomColor: STRUCTURAL.currentColor,
    boxShadow: STRUCTURAL.none,
    textShadow: skip('名字带 dark: text-glow-white 发光特效（GLOW 类，原样保留）'),
  },
  atDesc: {
    color: '--lx-text-muted',
    backgroundColor: STRUCTURAL.transparent,
    borderTopColor: STRUCTURAL.currentColor,
    borderBottomColor: STRUCTURAL.currentColor,
    boxShadow: STRUCTURAL.none,
    textShadow: STRUCTURAL.none,
  },
  sapShell: {
    color: '--lx-text-secondary',
    backgroundColor: literal('rgba(9, 9, 11, 0.95)', '面板底是原始 bg-[#09090b]/95，无对应令牌'),
    // aside 只有 border-l，但 border-white/[0.06] 是 border-color 简写 ⇒ 四边 color 都被设上了
    borderTopColor: literal('rgba(255, 255, 255, 0.06)', '面板描边是原始 alpha 类 border-white/[0.06]，无对应令牌'),
    borderBottomColor: literal('rgba(255, 255, 255, 0.06)', '同上'),
    boxShadow: STRUCTURAL.none,
    textShadow: STRUCTURAL.none,
  },
  sapTitle: {
    color: '--lx-text-secondary',
    backgroundColor: STRUCTURAL.transparent,
    borderTopColor: STRUCTURAL.currentColor,
    borderBottomColor: STRUCTURAL.currentColor,
    boxShadow: STRUCTURAL.none,
    textShadow: STRUCTURAL.none,
  },
  tmRow: {
    color: skip('行容器文字色继承自弹窗外壳，不代表组件自身取色'),
    backgroundColor: STRUCTURAL.transparent,
    // 实测行上边框取的是 currentColor（divide-white/10 在当前 Tailwind 版本下未生效），
    // 因此按「与自身 color 一致」断言，比写死一个色值更能反映真实渲染。
    borderTopColor: STRUCTURAL.currentColor,
    borderBottomColor: STRUCTURAL.currentColor,
    boxShadow: STRUCTURAL.none,
    textShadow: STRUCTURAL.none,
  },
  tmName: {
    color: literal('#e4e4e7', '行名字是 text-gray-800 dark:text-zinc-200 混用对，暗值 zinc-200(#e4e4e7) 与 secondary 暗值 #e4e4e7 相同，是否令牌化留待后续批次裁决'),
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
  // V4：阴影只有一个真值源（入仓的 shadow-baseline.json），缺失即报错，不退回「跳过」。
  const shadowBaseline = fs.existsSync(SHADOW_BASELINE_PATH)
    ? JSON.parse(fs.readFileSync(SHADOW_BASELINE_PATH, 'utf8'))
    : null;
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
        const alpha = Math.round((d[3] / 255) * 100) / 100;
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
        const isShadow = prop === 'boxShadow' || prop === 'textShadow';
        const actualValue = row[prop];
        if (isShadow) {
          // V4：阴影唯一真值源是 shadow-baseline.json（逐字相等，不设容差）。
          // 阴影里的颜色会随主题变，任何「归一化 rgba 顺序 / 容差」都会把真实差异抹平。
          if (!shadowBaseline) {
            throw new Error('--assert-dark-colors：缺少 scripts/theme-spec/shadow-baseline.json，阴影断言无从进行（先跑 --write-shadow-baseline）');
          }
          const expectedShadow = (shadowBaseline.themes.dark || {})[target.key];
          if (!expectedShadow) {
            throw new Error(`--assert-dark-colors：阴影基线缺少 dark / ${target.key}（禁止静默跳过）`);
          }
          const wanted = expectedShadow[prop];
          // 配置冲突要显式报：表格里若还留着手写 shadow 期望，必须与基线一致，避免两套真值
          const declaredShadow = declared[prop];
          if (typeof declaredShadow === 'string' && declaredShadow !== wanted) {
            throw new Error(`--assert-dark-colors：${target.key}.${label} 的表格声明（${declaredShadow}）与阴影基线（${wanted}）冲突`);
          }
          rows.push({
            target: target.key,
            property: label,
            expected: wanted,
            actual: actualValue,
            token: 'shadow-baseline',
            ok: wanted === actualValue,
          });
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(declared, prop)) {
          throw new Error(
            `--assert-dark-colors：目标「${target.key}」的属性 ${label} 没有声明期望`
            + `（在 DARK_EXPECT_TOKENS 里补 { ${prop}: '<令牌名>' | STRUCTURAL.* | skip('<原因>') }；禁止静默跳过）`,
          );
        }
        const spec = declared[prop];
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
        } else if (spec && typeof spec === 'object' && spec.literal) {
          expected = spec.literal;
          tokenLabel = `锁当前值（未令牌化）：${spec.reason}`;
        } else {
          expected = normalizeColorString(tokens[spec]);
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

// ─────────────────────────────────────────────────────────────────────────────
// V4：暗态阴影逐字断言（box-shadow / text-shadow 字符串严格相等，不设容差）
// V6：低档位（gray/zinc 100–400）专项断言
// ─────────────────────────────────────────────────────────────────────────────

/** 阴影基线（入仓）：暗态「像素覆盖不到阴影」是实测事实（0.0012%），只能靠字符串逐字断言。 */
const SHADOW_BASELINE_PATH = path.join(FRONTEND_ROOT, 'scripts', 'theme-spec', 'shadow-baseline.json');
/** 低档位基线（入仓）：记录「替换前」的 computed 色，统一实施时用来判定「哪些目标会变色」。 */
const LOW_TIER_BASELINE_PATH = path.join(FRONTEND_ROOT, 'scripts', 'theme-spec', 'low-tier-baseline.json');

/**
 * 页面内的颜色归一化函数（1×1 画布采样）。
 *
 * <p>为什么不用字符串比较：computed style 可能给 `oklch(...)`（Tailwind v4 产物）或 `#f4f4f5`，
 * 与令牌的 hex / rgba 表示不同，直接比会大面积假红。画布采样是对所有色彩空间都成立的归一化。</p>
 */
const NORM_RGB_JS = `const norm = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  return (value) => {
    const raw = String(value).trim();
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = raw;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    if (d[3] === 0) return 'rgba(0, 0, 0, 0)';
    const alpha = Math.round((d[3] / 255) * 100) / 100;
    return alpha >= 1 ? 'rgb(' + d[0] + ', ' + d[1] + ', ' + d[2] + ')'
      : 'rgba(' + d[0] + ', ' + d[1] + ', ' + d[2] + ', ' + alpha + ')';
  };
})();`;

/**
 * 采集「目标 × 属性 × 主题」的 computed style 矩阵。
 *
 * <p>必须与 check 模式保持同一套场景前置动作（展开下拉、聚焦自定义输入框），
 * 否则同一目标在不同模式下的取值可能不同，断言就成了对另一份 DOM 说话。</p>
 *
 * @param {string[]} props CSS 属性名（camelCase）
 * @param {string[]} themes 要跑的主题列表
 * @returns {Promise<Record<string, Record<string, Record<string, string>>>>} theme → key → prop → 值
 */
async function captureStyleMatrix(props, themes) {
  const scene = await kit.openScene(WORK, SCENE_VIEWPORT);
  const { evaluate } = scene;
  const matrix = {};
  try {
    for (const theme of themes) {
      await evaluate(`window.setDark(${theme === 'dark'})`);
      await evaluate('window.flush()');
      await kit.assertThemeApplied(evaluate, theme, TOKENS);
      await evaluate('window.openDropdown()');
      await evaluate('window.flush()');
      await new Promise((r) => setTimeout(r, 400));
      await evaluate('window.focusCustomInput()');
      await evaluate('window.flush()');
      await new Promise((r) => setTimeout(r, 120));
      matrix[theme] = await evaluate(`(() => {
        ${NORM_RGB_JS}
        const defs = ${JSON.stringify(TARGETS.map((t) => ({ key: t.key, sel: t.sel })))};
        const props = ${JSON.stringify(props)};
        const out = {};
        for (const d of defs) {
          const el = eval(d.sel);
          if (!el) { out[d.key] = null; continue; }
          const cs = getComputedStyle(el);
          const row = {};
          for (const p of props) {
            const raw = cs[p];
            row[p] = (p === 'boxShadow' || p === 'textShadow') ? String(raw).trim() : norm(raw);
          }
          out[d.key] = row;
        }
        return out;
      })()`);
    }
  } finally {
    scene.close();
  }
  return matrix;
}

/**
 * V4：阴影基线写入 / 逐字断言。
 *
 * <p>判据是**字符串完全相等**，没有容差：阴影里的颜色会随主题变，任何"归一化 rgba 顺序"的做法
 * 都会把真实差异抹平（任务里明确禁止）。所以基线原样保存 computed style 返回的完整字符串。</p>
 *
 * @param {{write: boolean}} options write=true 时写基线，否则与基线逐字比对
 * @returns {Promise<{rows: Array<object>, mismatches: Array<object>}>} 结果行与不匹配项
 */
async function runShadowBaseline({ write }) {
  const themes = ['light', 'dark'];
  const matrix = await captureStyleMatrix(['boxShadow', 'textShadow'], themes);
  const rows = [];
  if (write) {
    /** @type {Record<string, Record<string, Record<string, string>>>} */
    const payload = { generatedBy: 'scripts/visual/component-scenes.cjs --write-shadow-baseline', note: '暗态阴影逐字基线：box-shadow / text-shadow 完整字符串，禁止归一化', themes: {} };
    for (const theme of themes) {
      payload.themes[theme] = {};
      for (const target of TARGETS) {
        const row = matrix[theme][target.key];
        if (!row) throw new Error(`--write-shadow-baseline：目标「${target.key}」未找到，拒绝写入不完整基线`);
        payload.themes[theme][target.key] = { boxShadow: row.boxShadow, textShadow: row.textShadow };
      }
    }
    await fsp.mkdir(path.dirname(SHADOW_BASELINE_PATH), { recursive: true });
    await fsp.writeFile(SHADOW_BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    return { rows: [], mismatches: [], written: true, path: SHADOW_BASELINE_PATH };
  }
  if (!fs.existsSync(SHADOW_BASELINE_PATH)) {
    throw new Error(`阴影基线不存在：${SHADOW_BASELINE_PATH}（先跑 --write-shadow-baseline 并提交该文件）`);
  }
  const base = JSON.parse(fs.readFileSync(SHADOW_BASELINE_PATH, 'utf8'));
  for (const theme of themes) {
    for (const target of TARGETS) {
      const actual = matrix[theme][target.key];
      if (!actual) throw new Error(`--assert-shadow：目标「${target.key}」在 ${theme} 下未找到，禁止对空目标断言`);
      const expected = (base.themes[theme] || {})[target.key];
      if (!expected) throw new Error(`--assert-shadow：基线缺少 ${theme} / ${target.key}（禁止静默跳过）`);
      for (const prop of ['boxShadow', 'textShadow']) {
        const bothNone = expected[prop] === 'none' && actual[prop] === 'none';
        rows.push({
          theme,
          target: target.key,
          property: prop,
          expected: expected[prop],
          actual: actual[prop],
          skipped: bothNone,
          ok: expected[prop] === actual[prop],
        });
      }
    }
  }
  return { rows, mismatches: rows.filter((r) => !r.ok) };
}

/**
 * 读取低档位灰阶（100–400）的调色板真值。
 *
 * <p>从构建产物 CSS 里读 `--color-gray-*` / `--color-zinc-*`，不硬编码 hex：
 * 调色板一旦被改（正是本轮明令禁止的事），这里的判据会自动跟着变，而不是悄悄比错。</p>
 *
 * @param {(expr: string) => Promise<any>} evaluate 页面求值函数
 * @returns {Promise<Record<string, string>>} 形如 { 'gray-300': 'rgb(209, 213, 220)' }
 */
async function readLowTierPalette(evaluate) {
  return evaluate(`(() => {
    ${NORM_RGB_JS}
    const names = ['gray-100','gray-200','gray-300','gray-400','zinc-100','zinc-200','zinc-300','zinc-400'];
    const root = getComputedStyle(document.documentElement);
    const out = {};
    for (const n of names) {
      const raw = root.getPropertyValue('--color-' + n).trim();
      if (raw) out[n] = norm(raw);
    }
    return out;
  })()`);
}

/** 低档位配对：gray-N ↔ zinc-N（统一方案就是把这对称呼合并掉）。 */
const LOW_TIER_PAIRS = [
  ['gray-100', 'zinc-100'], ['gray-200', 'zinc-200'], ['gray-300', 'zinc-300'], ['gray-400', 'zinc-400'],
];

/**
 * V6：低档位专项断言。
 *
 * <p>这一档的通道差 ≤6（100/200/300/400 实测 1/4/4/6），像素阈值天生看不见，
 * 所以改成「逐目标逐属性的 computed 色与基线完全相等」+「标注该处是否属于预期变更候选」。</p>
 *
 * <p>当下（尚未开始替换）应当全部相等 —— 它的价值是统一实施时立刻指出「哪些目标会变色」。</p>
 *
 * @param {{write: boolean}} options write=true 时写基线，否则逐条比对
 * @returns {Promise<{rows: Array<object>, mismatches: Array<object>, palette: Record<string, string>}>} 结果
 */
async function runLowTier({ write }) {
  const themes = ['light', 'dark'];
  const props = ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor'];
  const scene = await kit.openScene(WORK, SCENE_VIEWPORT);
  const { evaluate } = scene;
  /** @type {Record<string, Record<string, Record<string, string>>>} */
  const matrix = {};
  let palette = {};
  try {
    palette = await readLowTierPalette(evaluate);
    for (const theme of themes) {
      await evaluate(`window.setDark(${theme === 'dark'})`);
      await evaluate('window.flush()');
      await kit.assertThemeApplied(evaluate, theme, TOKENS);
      await evaluate('window.openDropdown()');
      await evaluate('window.flush()');
      await new Promise((r) => setTimeout(r, 400));
      await evaluate('window.focusCustomInput()');
      await evaluate('window.flush()');
      await new Promise((r) => setTimeout(r, 120));
      matrix[theme] = await evaluate(`(() => {
        ${NORM_RGB_JS}
        const defs = ${JSON.stringify(TARGETS.map((t) => ({ key: t.key, sel: t.sel })))};
        const props = ${JSON.stringify(props)};
        const out = {};
        for (const d of defs) {
          const el = eval(d.sel);
          if (!el) { out[d.key] = null; continue; }
          const cs = getComputedStyle(el);
          const row = {};
          for (const p of props) row[p] = norm(cs[p]);
          out[d.key] = row;
        }
        return out;
      })()`);
    }
  } finally {
    scene.close();
  }

  /** 把某个实际色匹配到低档位调色板名（精确相等才算，不做就近）。 */
  const matchPalette = (value) => Object.keys(palette).find((n) => palette[n] === value) || null;
  /** 配对档位名。 */
  const pairOf = (name) => {
    for (const [a, b] of LOW_TIER_PAIRS) {
      if (name === a) return b;
      if (name === b) return a;
    }
    return null;
  };

  /** @type {Array<object>} */
  const rows = [];
  /** @type {Record<string, Record<string, Record<string, string>>>} */
  const fresh = {};
  for (const theme of themes) {
    fresh[theme] = {};
    for (const target of TARGETS) {
      const actual = matrix[theme][target.key];
      if (!actual) throw new Error(`--assert-low-tier：目标「${target.key}」在 ${theme} 下未找到，禁止对空目标断言`);
      fresh[theme][target.key] = {};
      for (const prop of props) {
        const value = actual[prop];
        const pal = matchPalette(value);
        if (!pal) continue; // 非低档位灰阶值：本模式不管（由 --assert-dark-colors / check 负责）
        fresh[theme][target.key][prop] = value;
        const pair = pairOf(pal);
        const pairValue = pair ? palette[pair] : null;
        const changedIfUnified = pairValue !== null && pairValue !== value;
        rows.push({
          theme,
          target: target.key,
          property: prop,
          actual: value,
          palette: pal,
          pair,
          pairValue,
          candidate: changedIfUnified,
          note: changedIfUnified
            ? `预期变更候选：统一后 ${pal} → ${pair}（${value} → ${pairValue}）`
            : `同档位取值相同，统一后无视觉变化`,
        });
      }
    }
  }

  if (write) {
    await fsp.mkdir(path.dirname(LOW_TIER_BASELINE_PATH), { recursive: true });
    const payload = {
      generatedBy: 'scripts/visual/component-scenes.cjs --write-low-tier-baseline',
      note: '低档位（gray/zinc 100–400）替换前基线：替换后必须与本文件逐条相等，否则即为未登记的预期变更',
      palette,
      values: fresh,
    };
    await fsp.writeFile(LOW_TIER_BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    return { rows, mismatches: [], written: true, palette, path: LOW_TIER_BASELINE_PATH };
  }
  if (!fs.existsSync(LOW_TIER_BASELINE_PATH)) {
    throw new Error(`低档位基线不存在：${LOW_TIER_BASELINE_PATH}（先跑 --write-low-tier-baseline 并提交该文件）`);
  }
  const base = JSON.parse(fs.readFileSync(LOW_TIER_BASELINE_PATH, 'utf8'));
  const mismatches = [];
  // 双向比对：基线有而当前没有（值被替换掉了）也算不一致 —— 单看「当前有值」会漏掉删除。
  for (const theme of themes) {
    for (const target of TARGETS) {
      const expectedRow = (base.values[theme] || {})[target.key] || {};
      const actualRow = fresh[theme][target.key] || {};
      for (const prop of new Set([...Object.keys(expectedRow), ...Object.keys(actualRow)])) {
        const e = expectedRow[prop];
        const a = actualRow[prop];
        if (e === a) continue;
        mismatches.push({ theme, target: target.key, property: prop, expected: e ?? '(非低档位值)', actual: a ?? '(非低档位值)' });
      }
      // 把期望值补进报告行，保证四列里的「期望色」永远来自基线
      for (const row of rows) {
        if (row.theme === theme && row.target === target.key && expectedRow[row.property]) {
          row.expected = expectedRow[row.property];
        }
      }
    }
  }
  return { rows, mismatches, palette };
}

/** 低档位报告渲染（四列：目标 | 属性 | 当前实际色 | 期望色（基线））。 */
function formatLowTierTable(rows) {
  const width = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));
  const head = ['目标', '属性', '当前实际色', '期望色（基线）'];
  const body = rows.map((r) => [`${r.theme}/${r.target}`, r.property, r.actual, r.expected ?? '(基线无此值，新增)']);
  const widths = head.map((h, i) => Math.max(width(h), ...body.map((b) => width(b[i]))));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ');
  return [line(head), widths.map((w) => '─'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  await buildApp();

  // ── V4：阴影逐字基线（写 / 断言）────────────────────────────────────────────
  if (SHADOW_MODE) {
    const write = SHADOW_MODE === 'write';
    const result = await runShadowBaseline({ write });
    if (write) {
      console.log(JSON.stringify({ mode: 'write-shadow-baseline', path: result.path, themes: ['light', 'dark'], targets: TARGETS.length }, null, 2));
      app.exit(0);
      return;
    }
    const skipped = result.rows.filter((r) => r.skipped);
    console.log(`\n=== 暗态/亮态阴影逐字断言：${result.rows.length} 条（无 shadow 跳过 ${skipped.length} 条）===`);
    for (const r of result.rows) {
      console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.theme}/${r.target} ${r.property}: ${r.ok ? '与基线逐字相同' : `期望 ${r.expected} / 实际 ${r.actual}`}${r.skipped ? '（无 shadow，跳过）' : ''}`);
    }
    if (result.mismatches.length > 0) {
      console.error(`\n[FAIL] ${result.mismatches.length} 条阴影字符串与基线不一致（不设容差）`);
      app.exit(1);
      return;
    }
    console.log(`\n[PASS] 阴影逐字断言全绿（${result.rows.length - skipped.length} 条非 none，${skipped.length} 条无 shadow 已登记跳过）`);
    app.exit(0);
    return;
  }

  // ── V6：低档位（100–400）专项 ───────────────────────────────────────────────
  if (LOW_TIER_MODE) {
    const write = LOW_TIER_MODE === 'write';
    const result = await runLowTier({ write });
    const candidates = result.rows.filter((r) => r.candidate);
    if (write) {
      console.log(JSON.stringify({ mode: 'write-low-tier-baseline', path: result.path, rows: result.rows.length, palette: result.palette }, null, 2));
      app.exit(0);
      return;
    }
    console.log(`\n=== 低档位专项（gray/zinc 100–400）：${result.rows.length} 条（预期变更候选 ${candidates.length} 条）===`);
    console.log(formatLowTierTable(result.rows));
    console.log('\n--- 预期变更候选明细（统一实施时这些目标的色值会变，必须进 expect-inventory）---');
    for (const r of candidates) console.log(`  ${r.theme}/${r.target} / ${r.property}: ${r.note}`);
    if (result.mismatches.length > 0) {
      console.error(`\n[FAIL] ${result.mismatches.length} 条低档位色值与基线不一致：`);
      for (const m of result.mismatches) console.error(`  ${m.theme}/${m.target} / ${m.property}: 基线 ${m.expected} → 当前 ${m.actual}`);
      app.exit(1);
      return;
    }
    console.log(`\n[PASS] 低档位色值与基线完全相等（${result.rows.length} 条）`);
    app.exit(0);
    return;
  }

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
    // G-5：形态变更后没有 light.png 全景图，自检改为比较「被注入非法色的那个场景」的容器图
    // （card-header 就是变异点），语义不变：注入极小面积颜色变化，像素比对必须能看见。
    const selfcheckFile = path.join('light', kit.sceneImageName('card-header'));
    const imgA = decodePng(fsx.readFileSync(path.join(tmpA, 'before', selfcheckFile)));
    const imgB = decodePng(fsx.readFileSync(path.join(tmpA, 'after', selfcheckFile)));
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
    const { styles, probes, roi, scenes } = await runCapture(BASE_DIR);
    // V11：显式打印「实际跑了哪几态」——由 --themes 决定，不再靠场景硬编码去猜。
    console.error(`[themes] 本次实际运行：${THEMES.join(' + ')}（--themes ${ASSERT_DARK ? 'dark（--assert-dark-colors 隐含）' : THEMES_ARG}）`);
    console.error(`[scenes] 每场景独立页：${SCENES.length} 个场景 × ${THEMES.length} 态 = ${SCENES.length * THEMES.length} 张容器图（scene-*.png）+ ${Object.values(roi).flat().length} 张 ROI`);
    // G-4/G-5：重建基线后必须同步 oracle 指纹与形态标记，否则下一个人 check 立刻红 / 报错。
    // 只在全量（--themes both 且未被 --assert-dark-colors 收窄成单态）时写：部分采集只覆盖子集，
    // 当成整节写回会把 fingerprint 削成残缺。
    const { writeBaselineSuite } = await import('./baseline-manifest.mjs');
    if (THEMES_ARG === 'both' && !ASSERT_DARK) {
      const written = writeBaselineSuite({ suite: 'components', baselineDir: BASE_DIR, form: FORM });
      console.error(`[baseline] 已同步视觉基线 oracle：suite=components ${written.count} 张，form=${FORM}，counts=${JSON.stringify(written.counts)}`);
    } else {
      console.error('[baseline] 警告：本次是部分采集（--themes 过滤），已跳过视觉基线 oracle 重写；'
        + '否则会把整节指纹削成残缺。需要同步指纹请跑一次全量 npm run visual:components:baseline。');
    }
    console.log(JSON.stringify({ mode: 'baseline', form: FORM, themesRun: THEMES, outDir: BASE_DIR, probes, styles, scenes, roi }, null, 2));
    app.exit(0);
    return;
  }

  // check：先采当前，再与基线做像素 + 样式双比对。
  const { styles, probes, roi, scenes } = await runCapture(CUR_DIR);
  console.error(`[themes] 本次实际运行：${THEMES.join(' + ')}（--themes ${ASSERT_DARK ? 'dark（--assert-dark-colors 隐含）' : THEMES_ARG}）`);
  const baseStylesPath = path.join(BASE_DIR, 'styles.json');
  if (!fs.existsSync(baseStylesPath)) { console.error(`基线不存在：${baseStylesPath}（先跑 --mode baseline）`); app.exit(2); return; }
  // G-4/G-5：先验「形态」再验「完整性」。
  // 形态不匹配（旧全景基线 + 新 per-scene harness，或反之）不是视觉回归，而是代码与基线没配对，
  // 因此一律 exit 2（基础设施），绝不落到 exit 1（那会让人去 diff 图里找一个不存在的视觉变化）。
  {
    const { readForms, verifyBaseline, formatVerifyFailure } = await import('./baseline-manifest.mjs');
    const forms = readForms();
    const declaredForm = forms.components;
    if (!declaredForm) {
      console.error(`[形态未知] oracle 里没有 forms.components（${FORM}）。这不是视觉回归：请跑一次全量 --mode baseline 重建基线并写入形态标记。`);
      app.exit(2);
      return;
    }
    if (declaredForm !== FORM) {
      console.error(`[形态不匹配] 基线按 ${declaredForm} 形态生成，当前 harness 是 ${FORM}。`
        + '这不是视觉回归：请先用 --mode baseline 按当前形态重建基线（单独一条 commit），或切到生成该基线的代码版本。');
      app.exit(2);
      return;
    }
    // 基线残缺（少几张 ROI / 容器图）会让 compare 只比剩下那几张、failed=0 → 静默假绿。
    const integrity = verifyBaseline({ suite: 'components', baselineDir: BASE_DIR });
    if (!integrity.ok) {
      console.error(formatVerifyFailure(integrity));
      app.exit(2);
      return;
    }
  }
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
  // 容器尺寸也要比：容器图被意外裁小/裁高时像素比对会报「尺寸不一致」，但那条信息回溯不到
  // 「期望尺寸是多少」。把期望值记在 styles.json.scenes 里，这里逐场景比一遍。
  const baseScenes = baseRaw.scenes || {};
  for (const theme of comparableThemes) {
    const baseTheme = baseScenes[theme] || {};
    const curTheme = (scenes && scenes[theme]) || {};
    for (const key of Object.keys(baseTheme)) {
      const expected = baseTheme[key];
      const actual = curTheme[key];
      if (!actual) { styleDiffs.push(`${theme}/${key}: 场景容器缺失`); continue; }
      if (expected.width !== actual.width || expected.height !== actual.height) {
        styleDiffs.push(`${theme}/${key}: 容器尺寸 ${expected.width}x${expected.height} -> ${actual.width}x${actual.height}`);
      }
    }
  }

  const { compareDirectories, DEFAULT_OPTIONS } = await import('./compare.mjs');
  // 组件场景图很小，收紧阈值，避免小面积文字色变化被整图比例吞掉。
  const options = { ...DEFAULT_OPTIONS, threshold: 0.0002, strongPixels: 12 };
  // 先清空 diff 目录：compare 只在「有差异」时写文件、从不清理，历史残留会让
  // 「本轮有哪些场景变了」这个事实变得不可判定（visual:expect-inventory 直接读这个目录）。
  await fsp.rm(DIFF_DIR, { recursive: true, force: true });
  await fsp.mkdir(DIFF_DIR, { recursive: true });
  // V7：全屏图 + 每个目标的 <key>-roi.png 一起参与比对（ROI 是"小面积变化"的有效证据）。
  const px = compareDirectories({ baselineDir: BASE_DIR, currentDir: CUR_DIR, diffDir: DIFF_DIR, options });
  /**
   * 写出「本轮失败图像清单」。
   *
   * <p>为什么需要它：`compare.mjs` 对**每一张**比对过的图都写 diff.png（通过与否都写），
   * 所以「diff 目录里有文件」并不等于「有变化」。真正的信号是 `status === 'fail'`。
   * 把失败清单固化成文件后，`visual:expect-inventory` 才能准确回答「这一轮哪些场景真的变了」。</p>
   */
  const diffFailures = px.details.filter((d) => d.status !== 'pass');
  await fsp.writeFile(
    path.join(COMP_ROOT, 'diff-manifest.json'),
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: 'visual:components:check',
      themesRun: THEMES,
      imagesCompared: px.images,
      failedCount: px.failed,
      failures: recordOfDiffFailures(diffFailures, px.failures),
    }, null, 2)}\n`,
  );
  const roiFiles = Object.values(roi).flat().map((r) => path.basename(r.file));
  const failed = styleDiffs.length > 0 || px.failed > 0;
  console.log(JSON.stringify({
    mode: 'check',
    form: FORM,
    themesRun: THEMES,
    comparedThemes: comparableThemes,
    roi: { count: roiFiles.length, files: roiFiles },
    scenes,
    probes,
    styleDiffs,
    pixel: { images: px.images, failed: px.failed, details: px.details, failures: px.failures },
  }, null, 2));
  app.exit(failed ? 1 : 0);
}

app.setPath('userData', path.join(WORK, 'profile'));
app.on('window-all-closed', () => {});
// 每场景一页后页面数从 1 变成 14×2，单轮耗时会上升，超时相应放宽（仍远低于 CI 上限）。
const deadline = setTimeout(() => { console.error('组件视觉验证超时'); app.exit(1); }, 300000);
app.whenReady().then(async () => {
  try { await main(); } catch (e) { console.error(e && e.stack ? e.stack : e); app.exit(1); } finally { clearTimeout(deadline); }
}).catch(e => { console.error(e); app.exit(1); });
