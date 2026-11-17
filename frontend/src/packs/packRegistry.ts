import type {OfficialPackCategory, OfficialPackEntry} from './types';

/**
 * 内置官方扩展包清单：
 * 按 category 分类注册，不同分类可同时叠加激活，未启用时不会加载包体 chunk。
 */
export const OFFICIAL_PACKS: readonly OfficialPackEntry[] = Object.freeze([
  // ========== 主题皮肤 (theme) ==========
  {
    meta: {
      id: 'obsidian-editorial',
      category: 'theme',
      name: '曜石编辑风',
      description: '暖金强调色与深邃炭黑/羊皮纸双态配色，统一调整侧边栏与输入区表面质感。',
      version: '1.0.0',
      capabilities: ['明暗配色', '表面质感'],
      preview: { canvas: '#0b0a09', surface: '#141210', accent: '#d4a359', text: '#f4f4f5' },
    },
    load: async () => (await import('./builtin/obsidianEditorial')).obsidianEditorialPack,
  },
  {
    meta: {
      id: 'forest-moss',
      category: 'theme',
      name: '森系松苔',
      description: '低饱和护眼森林绿与暖米白双态配色，适合长时间专注编码与深度阅读。',
      version: '1.0.0',
      capabilities: ['明暗配色', '护眼低饱和'],
      preview: { canvas: '#070d0a', surface: '#101c15', accent: '#10b981', text: '#ecfdf5' },
    },
    load: async () => (await import('./builtin/forestMoss')).forestMossPack,
  },
  {
    meta: {
      id: 'crimson-neon',
      category: 'theme',
      name: '绯红赛博',
      description: '高对比洋红强调色搭配暗夜炭黑与珊瑚白双态表面，视觉张力十足。',
      version: '1.0.0',
      capabilities: ['明暗配色', '高对比度'],
      preview: { canvas: '#0c0609', surface: '#1a0d14', accent: '#f43f5e', text: '#fff1f2' },
    },
    load: async () => (await import('./builtin/crimsonNeon')).crimsonNeonPack,
  },

  // ========== 文字字体 (font) ==========
  {
    meta: {
      id: 'editorial-serif-font',
      category: 'font',
      name: '书卷衬线体',
      description: '正文字体切换为衬线阅读栈，代码块搭配清晰等宽字体，适合长文阅读与写作。',
      version: '1.0.0',
      capabilities: ['正文字体', '代码字体'],
      fontPreview: { sample: 'Aa 永字八法 · code()', family: "'Georgia', 'Noto Serif SC', serif" },
    },
    load: async () => (await import('./builtin/editorialSerifFont')).editorialSerifFontPack,
  },
  {
    meta: {
      id: 'geek-mono-font',
      category: 'font',
      name: '极客等宽体',
      description: '全局正文与代码块统一采用等宽技术字体栈，呈现终端与 IDE 一体化质感。',
      version: '1.0.0',
      capabilities: ['全局等宽', '终端风'],
      fontPreview: { sample: 'const lx = 0x2A; // 等宽对齐', family: "'JetBrains Mono', 'Cascadia Mono', monospace" },
    },
    load: async () => (await import('./builtin/geekMonoFont')).geekMonoFontPack,
  },
  {
    meta: {
      id: 'modern-sans-font',
      category: 'font',
      name: '现代清雅体',
      description: '清爽几何无衬线字体栈搭配代码等宽字体，优化高分屏下的中英文混排观感。',
      version: '1.0.0',
      capabilities: ['无衬线', '混排优化'],
      fontPreview: { sample: 'LingXi Agent · 清晰现代排版', family: "'Inter', 'HarmonyOS Sans SC', 'PingFang SC', sans-serif" },
    },
    load: async () => (await import('./builtin/modernSansFont')).modernSansFontPack,
  },

  // ========== 主页背景 (background) ==========
  {
    meta: {
      id: 'aurora-glass',
      category: 'background',
      name: '极光氛围背景',
      description: '替换主页背景表面为极光渐变光斑，营造柔和通透的视觉氛围。',
      version: '1.0.0',
      capabilities: ['背景 Slot', '环境光晕'],
      preview: { canvas: '#04090b', surface: '#0b161c', accent: '#14b8a6', text: '#f4f4f5' },
    },
    load: async () => (await import('./builtin/auroraGlass')).auroraGlassPack,
  },
  {
    meta: {
      id: 'blueprint-grid',
      category: 'background',
      name: '工程点阵网格',
      description: '在主页背景绘制极细坐标点阵网格与边缘渐隐遮罩，兼顾工程感与可读性。',
      version: '1.0.0',
      capabilities: ['背景 Slot', '坐标点阵'],
      preview: { canvas: '#0a0a0c', surface: '#141418', accent: '#64748b', text: '#f8fafc' },
    },
    load: async () => (await import('./builtin/blueprintGrid')).blueprintGridPack,
  },
  {
    meta: {
      id: 'sunset-glow',
      category: 'background',
      name: '暮光余晖',
      description: '暖金与琥珀色对角渐变光晕铺底，让对话工作区呈现柔和暖意。',
      version: '1.0.0',
      capabilities: ['背景 Slot', '暖色光晕'],
      preview: { canvas: '#140c07', surface: '#1e120b', accent: '#f59e0b', text: '#fffbeb' },
    },
    load: async () => (await import('./builtin/sunsetGlow')).sunsetGlowPack,
  },

  // ========== 侧边栏 (sidebar) ==========
  {
    meta: {
      id: 'floating-sidebar',
      category: 'sidebar',
      name: '悬浮玻璃侧边栏',
      description: '将侧边栏改造为圆角悬浮毛玻璃卡片，并升级底部设置入口为胶囊指示样式。',
      version: '1.0.0',
      capabilities: ['侧边栏底栏 Slot', '悬浮毛玻璃'],
    },
    load: async () => (await import('./builtin/floatingSidebar')).floatingSidebarPack,
  },
  {
    meta: {
      id: 'minimal-borderless-sidebar',
      category: 'sidebar',
      name: '极简无界边栏',
      description: '移除侧边栏右侧分割线并叠加柔和毛玻璃，让导航区自然融入底层画布。',
      version: '1.0.0',
      capabilities: ['无边框', '画布融合'],
    },
    load: async () => (await import('./builtin/minimalBorderlessSidebar')).minimalBorderlessSidebarPack,
  },
  {
    meta: {
      id: 'accent-rail-sidebar',
      category: 'sidebar',
      name: '强调色导轨边栏',
      description: '在侧边栏左侧边缘增加强调色细光导轨，提升高频切换会话时的空间锚定感。',
      version: '1.0.0',
      capabilities: ['强调导轨', '层次强化'],
    },
    load: async () => (await import('./builtin/accentRailSidebar')).accentRailSidebarPack,
  },

  // ========== 输入框 (input) ==========
  {
    meta: {
      id: 'glass-input',
      category: 'input',
      name: '流光玻璃输入栏',
      description: '输入卡片改为半透明毛玻璃容器 + 聚焦流光边框，并替换为胶囊上下文用量徽标。',
      version: '1.0.0',
      capabilities: ['上下文 Slot', '毛玻璃输入栏'],
    },
    load: async () => (await import('./builtin/glassInput')).glassInputPack,
  },
  {
    meta: {
      id: 'capsule-pill-input',
      category: 'input',
      name: '悬浮胶囊输入栏',
      description: '采用 28px 超大圆角与三级立体浮起阴影，打造饱满圆润的交互输入舱。',
      version: '1.0.0',
      capabilities: ['大圆角胶囊', '立体阴影'],
    },
    load: async () => (await import('./builtin/capsulePillInput')).capsulePillInputPack,
  },
  {
    meta: {
      id: 'neon-underline-input',
      category: 'input',
      name: '极简底线输入栏',
      description: '隐藏四周边框与阴影，聚焦时仅点亮底部强调色指示线，专注纯文本输入。',
      version: '1.0.0',
      capabilities: ['极简无框', '底线聚焦'],
    },
    load: async () => (await import('./builtin/neonUnderlineInput')).neonUnderlineInputPack,
  },

  // ========== 渲染动效 (motion) ==========
  {
    meta: {
      id: 'pulse-stream',
      category: 'motion',
      name: '流式脉冲套件',
      description: '替换输入区发送按钮为极简胶囊样式，并优化流式文本渐显与思维链呼吸节奏。',
      version: '1.0.0',
      capabilities: ['发送按钮 Slot', '流式动效'],
    },
    load: async () => (await import('./builtin/pulseStream')).pulseStreamPack,
  },
  {
    meta: {
      id: 'crisp-instant-stream',
      category: 'motion',
      name: '极速零延迟套件',
      description: '将流式文本 arrival 与思维链动效压缩至 90ms 内，追求零拖影的极速响应感。',
      version: '1.0.0',
      capabilities: ['极速流式', '低动画延迟'],
    },
    load: async () => (await import('./builtin/crispInstantStream')).crispInstantStreamPack,
  },
  {
    meta: {
      id: 'soft-ink-stream',
      category: 'motion',
      name: '墨韵缓显套件',
      description: '拉长流式渐显与卡片入场缓动曲线，呈现舒缓柔和的水墨晕染阅读节奏。',
      version: '1.0.0',
      capabilities: ['舒缓渐显', '阅读节奏'],
    },
    load: async () => (await import('./builtin/softInkStream')).softInkStreamPack,
  },

  // ========== 任务进度 (taskProgress) ==========
  {
    meta: {
      id: 'neon-hud-background-task',
      category: 'taskProgress',
      taskProgressTab: 'background',
      name: '指挥台遥测 · 内置 Slot',
      description: '内置极限组件重构：波形胶囊、运行中/已结束 KPI 遥测条、状态筛选与可一键复制的终端日志抽屉。',
      version: '1.0.0',
      capabilities: ['内置 Slot 极限', 'KPI 遥测', '日志一键复制'],
      preview: { canvas: '#0f172a', surface: '#1e1b4b', accent: '#22d3ee', text: '#e0f2fe' },
    },
    load: async () => (await import('./builtin/neonHudBackgroundTask')).neonHudBackgroundTaskPack,
  },
  {
    meta: {
      id: 'amber-craft-background-task',
      category: 'taskProgress',
      taskProgressTab: 'background',
      name: '声呐雷达 · 纯 CSS',
      description: '外部纯 CSS 极限：不改组件结构，用扫光胶囊、雷达脉冲边框、等宽指标标签与暗色终端输出井打造战术外观。',
      version: '1.0.0',
      capabilities: ['纯 CSS 极限', '雷达脉冲', '零 JS 依赖'],
      preview: { canvas: '#ecfdf5', surface: '#064e3b', accent: '#10b981', text: '#065f46' },
    },
    load: async () => (await import('./builtin/amberCraftBackgroundTask')).amberCraftBackgroundTaskPack,
  },
  {
    meta: {
      id: 'neon-hud-checklist',
      category: 'taskProgress',
      taskProgressTab: 'checklist',
      name: '轨道里程碑 · 内置 Slot',
      description: '内置极限组件重构：SVG 环形进度胶囊、四态分段占比条、步骤状态过滤与发光垂直时间轴轨道。',
      version: '1.0.0',
      capabilities: ['内置 Slot 极限', 'SVG 进度环', '垂直时间轴'],
      preview: { canvas: '#0f172a', surface: '#0c4a6e', accent: '#38bdf8', text: '#e0f2fe' },
    },
    load: async () => (await import('./builtin/neonHudChecklist')).neonHudChecklistPack,
  },
  {
    meta: {
      id: 'amber-craft-checklist',
      category: 'taskProgress',
      taskProgressTab: 'checklist',
      name: '琥珀手账 · 纯 CSS',
      description: '外部纯 CSS 极限：不改组件结构，用横格笔记纹理、红线装订边、CSS 自动编号与荧光笔高亮打造手账外观。',
      version: '1.0.0',
      capabilities: ['纯 CSS 极限', '手账网格', '零 JS 依赖'],
      preview: { canvas: '#fffdf7', surface: '#fef3c7', accent: '#d97706', text: '#78350f' },
    },
    load: async () => (await import('./builtin/amberCraftChecklist')).amberCraftChecklistPack,
  },
  {
    meta: {
      id: 'neon-hud-pending-queue',
      category: 'taskProgress',
      taskProgressTab: 'pendingQueue',
      name: '调度发射台 · 内置 Slot',
      description: '内置极限组件重构：READY/PAUSED 状态徽章、附件总数统计、NEXT 优先轨道高亮与长文行内展开预览。',
      version: '1.0.0',
      capabilities: ['内置 Slot 极限', 'NEXT 轨道', '行内展开'],
      preview: { canvas: '#ecfeff', surface: '#e0e7ff', accent: '#06b6d4', text: '#1e1b4b' },
    },
    load: async () => (await import('./builtin/neonHudPendingQueue')).neonHudPendingQueuePack,
  },
  {
    meta: {
      id: 'amber-craft-pending-queue',
      category: 'taskProgress',
      taskProgressTab: 'pendingQueue',
      name: '赛博磁带 · 纯 CSS',
      description: '外部纯 CSS 极限：不改组件结构，用动态警示斜纹顶栏、工业等宽序号与左轨悬停抬升重构队列质感。',
      version: '1.0.0',
      capabilities: ['纯 CSS 极限', '动态斜纹', '零 JS 依赖'],
      preview: { canvas: '#fffbeb', surface: '#18181b', accent: '#f59e0b', text: '#78350f' },
    },
    load: async () => (await import('./builtin/amberCraftPendingQueue')).amberCraftPendingQueuePack,
  },

  // ========== 互动卡片 (interactionCard) ==========
  {
    meta: {
      id: 'amber-guard-approval',
      category: 'interactionCard',
      interactionTab: 'approval',
      name: '琥珀警戒审批卡',
      description: '暖琥珀渐变背景搭配顶部斜纹警戒条与深色终端命令框，突出风险操作辨识度。',
      version: '1.0.0',
      capabilities: ['琥珀警戒', '渐变按钮', '审批卡片 Slot'],
      preview: { canvas: '#fffbeb', surface: '#fef3c7', accent: '#f59e0b', text: '#78350f' },
    },
    load: async () => (await import('./builtin/amberGuardApproval')).amberGuardApprovalPack,
  },
  {
    meta: {
      id: 'cyber-aurora-approval',
      category: 'interactionCard',
      interactionTab: 'approval',
      name: '赛博极光审批卡',
      description: '青蓝与靛紫极光渐变毛玻璃背景，搭配霓虹顶栏光束与渐变操作按钮。',
      version: '1.0.0',
      capabilities: ['极光毛玻璃', '霓虹光束', '审批卡片 Slot'],
      preview: { canvas: '#eef2ff', surface: '#e0e7ff', accent: '#06b6d4', text: '#1e1b4b' },
    },
    load: async () => (await import('./builtin/cyberAuroraApproval')).cyberAuroraApprovalPack,
  },
  {
    meta: {
      id: 'emerald-blueprint-plan',
      category: 'interactionCard',
      interactionTab: 'plan',
      name: '翡翠蓝图计划卡',
      description: '工程蓝图细网格纹理背景搭配翡翠绿主题徽章与实心操作按钮，架构感十足。',
      version: '1.0.0',
      capabilities: ['蓝图网格', '翡翠主题', '计划卡片 Slot'],
      preview: { canvas: '#ecfdf5', surface: '#d1fae5', accent: '#10b981', text: '#064e3b' },
    },
    load: async () => (await import('./builtin/emeraldBlueprintPlan')).emeraldBlueprintPlanPack,
  },
  {
    meta: {
      id: 'sunset-editorial-plan',
      category: 'interactionCard',
      interactionTab: 'plan',
      name: '暖阳手账计划卡',
      description: '珊瑚橙落日渐变纸张质感搭配左侧书签饰条与内嵌 Markdown 正文，阅读体验温润鲜明。',
      version: '1.0.0',
      capabilities: ['落日渐变', '内嵌正文', '计划卡片 Slot'],
      preview: { canvas: '#fff1f2', surface: '#ffe4e6', accent: '#f43f5e', text: '#881337' },
    },
    load: async () => (await import('./builtin/sunsetEditorialPlan')).sunsetEditorialPlanPack,
  },
  {
    meta: {
      id: 'rpg-quest-choice',
      category: 'interactionCard',
      interactionTab: 'choice',
      name: '剧情抉择任务卡',
      description: 'RPG 游戏对话抉择框风格，耀金边框配字母快捷键徽章与金色选中微光。',
      version: '1.0.0',
      capabilities: ['剧情抉择', '字母角标', '选择卡片 Slot'],
      preview: { canvas: '#fffbeb', surface: '#fef3c7', accent: '#f59e0b', text: '#78350f' },
    },
    load: async () => (await import('./builtin/rpgQuestChoice')).rpgQuestChoicePack,
  },
  {
    meta: {
      id: 'neon-pill-choice',
      category: 'interactionCard',
      interactionTab: 'choice',
      name: '霓虹胶囊矩阵卡',
      description: '双列响应式胶囊网格配顶部步骤点阵进度条，打破传统长条单选排版。',
      version: '1.0.0',
      capabilities: ['双列矩阵', '点阵进度', '选择卡片 Slot'],
      preview: { canvas: '#ecfeff', surface: '#e0e7ff', accent: '#06b6d4', text: '#1e1b4b' },
    },
    load: async () => (await import('./builtin/neonPillChoice')).neonPillChoicePack,
  },
]);

/** 按 id 查找内置扩展包；找不到返回 undefined。 */
export function findOfficialPack(packId: string): OfficialPackEntry | undefined {
  return OFFICIAL_PACKS.find(entry => entry.meta.id === packId);
}

/** 按分类过滤官方扩展包列表。 */
export function listOfficialPacksByCategory(category: OfficialPackCategory): readonly OfficialPackEntry[] {
  return OFFICIAL_PACKS.filter(entry => entry.meta.category === category);
}
