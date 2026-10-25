/**
 * ChatInputArea 的**命令面契约**（B-5 阶段 1a）。
 *
 * <p><b>为什么需要这个文件：</b>`ChatInputArea` 通过 `defineExpose` 对外暴露 11 项命令，
 * 但历史调用方（`ChatView` / `useChatView`）一直用 `InstanceType<typeof ChatInputArea>` 取类型。
 * 那是"结构上依赖组件内部形状"的写法：组件内任何一个非 expose 成员的增删、甚至 `defineExpose`
 * 里某个函数签名的收紧，都可能让调用方在别处莫名报错或（更糟）静默变宽 —— 命令面是**隐式约定**。</p>
 *
 * <p>本接口把它变成**显式类型契约**：签名逐项照抄 `ChatInputArea.vue` 的 `defineExpose` 实现实测结果，
 * 不放宽也不多加。此后任何实现改动都会在 `vue-tsc` 阶段被抓到，而不是等到运行时。</p>
 *
 * <p><b>刻意不包含什么：</b>不含 props / emits / 模板 / 内部状态（输入文本、附件、语音、斜杠菜单、
 * 拖拽缩放、弹弓力学……），也不含任何"替换实现"的能力对象 —— 目前没有任何输入区替换实现，
 * 那些分支会是永不执行的死代码。</p>
 */
export interface ChatInputCommands {
  /** 聚焦输入框（与 {@link ChatInputCommands.focusInput} 等价，历史别名）。 */
  focus: () => void;
  /** 聚焦输入框。`CHAT_INPUT_FOCUS_KEY` 的提供者依赖此方法。 */
  focusInput: () => void;
  /** 覆盖输入框文本（不触发发送）。 */
  setInputText: (text: string) => void;
  /** 设置单个附件图片；传 null 表示清空全部附件。 */
  setAttachedImage: (file: File | null) => void;
  /** 批量设置附件图片（实现即 `processImageFiles`，会走既有的校验/去重/上限逻辑）。 */
  setAttachedImages: (files: File[]) => void;
  /**
   * 拉取团队列表（默认第 1 页）。
   *
   * <p>返回类型取实测值：实现是 `async (page = 1) => { … }` 且**无 return**，即 `Promise<void>`；
   * 数据落在组件内部的 `localTeams`，不在返回值里（因此不可能是 `Promise<TeamVO[]>`）。</p>
   */
  fetchTeams: (page?: number) => Promise<void>;
  /** 选中团队；null 表示清空。 */
  selectTeam: (id: string | number | null) => void;
  /** 拉取 Agent 列表（默认第 1 页）。返回类型同 {@link ChatInputCommands.fetchTeams}：实测 `Promise<void>`。 */
  fetchAgents: (page?: number) => Promise<void>;
  /** 选中 Agent；null 表示清空。 */
  selectAgent: (id: string | number | null) => void;
  /** 打开 Agent 选择菜单。 */
  openAgentMenu: () => void;
  /** 打开技能选择菜单。 */
  openSkillMenu: () => void;
}

/** 命令面的全部键名（运行时断言与类型契约共用一份来源，避免两边漂移）。 */
export const CHAT_INPUT_COMMAND_KEYS = [
  'focus',
  'focusInput',
  'setInputText',
  'setAttachedImage',
  'setAttachedImages',
  'fetchTeams',
  'selectTeam',
  'fetchAgents',
  'selectAgent',
  'openAgentMenu',
  'openSkillMenu',
] as const;
