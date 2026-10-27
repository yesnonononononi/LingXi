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
 * 场景视口尺寸。
 *
 * <p>为什么不是默认的 780×760：本批把 Sidebar 的 4 个场景追加在页面下方，整体高度约 2.9k px。
 * 若沿用默认视口，`capturePage()` 只截到前 760 px ⇒ 侧栏根本不在基线图里（"有场景没覆盖"的假绿）。</p>
 */
/**
 * 场景窗口尺寸。
 *
 * <p><b>为什么保持 800×3100 不变：</b>窗口高度会改变 CSS `vh`，从而改变既有 9 个场景的布局 ——
 * 一旦调高窗口，既有 light.png / dark.png 与 4 张既有 ROI 就会整片变化（实测改到 5800 时
 * 上部区域有 8.2 万像素差），那等于默默重建既有基线。</p>
 *
 * <p>下方新增场景不靠调大窗口来覆盖，而靠 {@link captureFullPage} 的 CDP 全页截图
 * （`captureBeyondViewport`）作为 ROI 裁切源 —— 既不动既有基线，也不会把新场景裁掉。
 * 另外实测本机 `capturePage()` 无论窗口多高都只返回 800×1032，调大窗口本身也拿不到下方内容。</p>
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
const apiAgentRows=[
  {id:1,name:'代码助手',avatar:'🤖',modelId:'m1',description:'灰阶场景用的智能体',toolList:['read_file']},
  {id:2,name:'文档助手',avatar:'📄',modelId:'m1',description:'第二个成员行（触发 divide 边框）',toolList:[]},
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
  const hit=Object.keys(API_FIXTURES).find((k)=>url.startsWith(k));
  return {data:hit?API_FIXTURES[hit]:{code:1,data:null},status:200,statusText:'OK',headers:{},config,request:{}};
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
    <!-- 以下 5 个「灰阶混用组件」场景（V1）。
         关键：外层用 **绝对定位** 承载，不参与文档流 ⇒ 页面总高度不变、不出现竖向滚动条 ⇒
         上方 9 个既有场景的布局与像素一字节不变（实测：把新场景放进正常流会让上部 8.2 万像素
         因滚动条挤压而变，等于默默重建既有基线）。绝对定位元素仍会渲染、仍可测 computed style，
         也仍被 CDP 全页截图（captureBeyondViewport）覆盖，因此新场景的 ROI 不丢。
         SettingsModal / TeamModal 根节点是 fixed inset-0 全屏遮罩，再套一层 transform 容器，
         让它们以该容器为包含块，避免盖住整页。 -->
    <div data-scene-group="gray-scale" style="position:absolute;left:0;top:3400px;width:800px">
    <section data-scene="chat-message-item" style="padding:10px 8px">
      <ChatMessageItem :message="cmiMessage" :is-dark="dark" session-id="42" />
    </section>
    <section data-scene="settings-modal-card" style="position:relative;transform:translateZ(0);width:768px;height:600px;overflow:hidden;border:1px solid #8884">
      <SettingsModal :is-dark="dark" initial-tab="about" />
    </section>
    <section data-scene="agents-tab-row" style="width:720px;padding:8px;border:1px solid #8884">
      <AgentsTab :is-dark="dark" />
    </section>
    <section data-scene="subagent-panel" style="width:380px;height:460px;overflow:hidden;border:1px solid #8884">
      <SubAgentSidePanel :items="sapItems" active-sub-id="sub-1" :is-open="true" :is-dark="dark" />
    </section>
    <section data-scene="team-modal-row" style="position:relative;transform:translateZ(0);width:768px;height:620px;overflow:hidden;border:1px solid #8884">
      <TeamModal :is-open="teamOpen" :is-dark="dark" :models="[]" />
    </section>
    </div>
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
  // 视口图只覆盖 800×1032，下方场景另取一张 CDP 全页图作为裁切源（只写新文件，不动既有 ROI）。
  const bigImage = await captureFullPage(win);
  const roi = await captureRoi(png, evaluate, theme, outDir, bigImage);
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

/**
 * 用 CDP 截一张「完整页面」图（`captureBeyondViewport` 才能突破窗口可视区）。
 *
 * <p><b>为什么必须补这条路径：</b>实测本机（offscreen）`webContents.capturePage()` 无论窗口多高
 * 都只返回 **800×1032** 的可视区图 —— 页面下方的场景（侧栏、本轮新增的 5 个灰阶场景）
 * 从来没进过像素基线，属于「有场景没覆盖」的假绿。`capturePage(rect)` 又会抛 UnknownVizError，
 * 因此改走 CDP 的 `Page.captureScreenshot({ captureBeyondViewport: true })`。</p>
 *
 * <p><b>为什么只用于下方目标：</b>既有 4 个目标的 ROI 是从原来那张视口图裁出来的，
 * 换成新图会改变既有基线的字节。这里只在「目标超出视口图范围」时才用大图，既有文件零改动。</p>
 *
 * @param {object} win BrowserWindow
 * @returns {Promise<object|null>} nativeImage 或 null（CDP 失败时不阻塞主流程）
 */
async function captureFullPage(win) {
  const dbg = win.webContents.debugger;
  let attached = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true; }
    await dbg.sendCommand('Page.enable');
    const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
    const content = metrics.cssContentSize || metrics.contentSize;
    const result = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.ceil(content.width), height: Math.ceil(content.height), scale: 1 },
    });
    const { nativeImage } = require('electron');
    return nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'));
  } catch (err) {
    console.error(`[roi] CDP 全页截图失败（回落到视口图）：${err && err.message ? err.message : err}`);
    return null;
  } finally {
    if (attached) { try { dbg.detach(); } catch { /* 已分离则忽略 */ } }
  }
}

async function captureRoi(fullImage, evaluate, theme, outDir, bigImage = null) {
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
  // 诊断开关：给了 ROI_DEBUG 就打印每个目标的裁切决策（定位「为什么某目标没有 ROI 图」）。
  if (process.env.ROI_DEBUG) console.error(`[roi/${theme}] ` + JSON.stringify(rects.map((r) => `${r.key}:${r.reason || 'ok'}`)));

  // 页面 CSS 像素 → 图片像素：整页图宽度 / 页面宽度（只求一次，页面宽度在本次采集内不变）
  const pageWidth = await evaluate('document.documentElement.scrollWidth || window.innerWidth');
  const ratio = pageWidth > 0 ? imageSize.width / pageWidth : 1;
  for (const item of rects) {
    if (!item.rect) continue; // 目标不可见：captureTheme 的可见性断言负责报错，这里不重复失败
    /**
     * 选图：视口图能完整容纳该目标就用视口图（既有 ROI 因此逐字节不变），
     * 否则用 CDP 全页图（否则下方场景会被静默裁掉 —— 那正是「有场景没覆盖」的假绿）。
     */
    const inViewport = item.rect.y + item.rect.height <= imageSize.height;
    const source = inViewport || !bigImage ? fullImage : bigImage;
    const sourceSize = source.getSize();
    if (!inViewport && !bigImage) continue; // 两种图都拿不到：不写空图，交给报告里的 roi 数量体现
    const x = Math.max(0, Math.round(item.rect.x * ratio));
    const y = Math.max(0, Math.round(item.rect.y * ratio));
    const width = Math.max(1, Math.round(item.rect.width * ratio));
    const height = Math.max(1, Math.round(item.rect.height * ratio));
    // 二次 clamp：crop 的矩形必须完全落在图片内
    const clampedWidth = Math.min(width, sourceSize.width - x);
    const clampedHeight = Math.min(height, sourceSize.height - y);
    if (clampedWidth < 1 || clampedHeight < 1) continue;
    const cropped = source.crop({ x, y, width: clampedWidth, height: clampedHeight });
    const file = path.join(themeDir, `${item.key}-roi.png`);
    await fsp.writeFile(file, cropped.toPNG());
    written.push({ key: item.key, file, rect: { x, y, width: clampedWidth, height: clampedHeight }, theme, source: inViewport ? 'viewport' : 'cdp-fullpage' });
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
