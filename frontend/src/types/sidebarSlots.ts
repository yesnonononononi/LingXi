import type { Component, InjectionKey } from 'vue';
import type { ChatSession, WorkspaceVO } from './chat';

/**
 * 语义层分组节点。
 *
 * <p><b>这不是任一分支持有的数据形状：</b>暗色分支用 `branchedMenuItems`（UI 模型，含伪条目与已翻译
 * label），亮色分支用 `projectGroups` + `unassignedSessions`（领域模型）。插槽对外只暴露本语义模型，
 * 由组件装配（装配逻辑见设计文档 §4.4）。</p>
 */
export interface SidebarGroupNode {
  /** 稳定键：`ws-<workspaceId>`；历史分组恒为 `ws-unassigned`。 */
  readonly key: string;
  /** null = 「历史对话」分组（未归属任何工作区的会话）。 */
  readonly workspace: WorkspaceVO | null;
  /** 已翻译的显示名（工作区名/工作目录/「历史对话」）。 */
  readonly label: string;
  /** 已按 `sessionLimit` 截断后的可见会话（消费者无需自己 slice）。 */
  readonly sessions: readonly ChatSession[];
  /** 该组会话总数（截断前）。 */
  readonly totalCount: number;
  /** `totalCount > sessions.length`：是否还有未展示的会话。 */
  readonly truncated: boolean;
  /** 该组是否展开（写操作只能走 `actions.onToggleGroup`）。 */
  readonly expanded: boolean;
  /** 该组是否含当前激活会话（等价于组件内 `isWorkspaceActive` 的判定结果）。 */
  readonly active: boolean;
}

/**
 * 树内容区的唯一行为入口集合。
 *
 * <p>每个回调在组件内都**只有一个实现点**（emit 或 `useSidebarActions` 的既有 handler），
 * 消费者只能调用、不能自行 emit —— 组件不把 `emit` 交给插槽。</p>
 */
export interface SidebarTreeActions {
  readonly onSelectSession: (id: string) => void;
  readonly onSelectWorkspace: (workspace: WorkspaceVO | null) => void;
  readonly onToggleGroup: (groupKey: string) => void;
  /** 「展开显示 / 收起」：对应伪条目 `more-<key>` 的语义。 */
  readonly onToggleMore: (groupKey: string) => void;
  /** 进入行内重命名编辑态（组件内 `editingSessionId` 由它驱动）。 */
  readonly onStartEdit: (id: string) => void;
  /** 提交重命名（内部 `emit('renameSession', id, name)`，唯一 emit 点在 useSidebarActions）。 */
  readonly onRenameSession: (id: string, name: string) => void;
  readonly onDeleteSession: (id: string) => void;
  readonly onNewSession: (workspaceId?: string | number | null) => void;
  readonly onNewWorkspace: () => void;
  readonly onDeleteWorkspace: (id: string | number) => void;
}

/** `workspaceTree` 插槽 props：6 个只读状态 + 1 个行为入口集合。 */
export interface SidebarTreeSlotProps {
  readonly groups: readonly SidebarGroupNode[];
  readonly activeSessionId: string | null;
  readonly isCollapsed: boolean;
  readonly isDark: boolean;
  /** 每组可见条数上限（= `SESSION_VISIBLE_LIMIT`，实测 5）。 */
  readonly sessionLimit: number;
  /** 当前处于行内重命名编辑态的会话 id；null = 无。消费者据此避免抢焦点或重复渲染输入框。 */
  readonly editingSessionId: string | null;
  readonly actions: SidebarTreeActions;
}

/**
 * `sidebarFooter` 插槽 props：0 状态耦合，只给主题/折叠态与入口回调。
 *
 * <p><b>为什么不含 `onOpenModels` / `onToggleTheme`：</b>这两个是 Sidebar 声明但**全文 0 处 emit**
 * 的死事件（`ChatView` 侧却挂着监听）。把死码固化成契约，等于要求下一个替换实现去实现一个
 * 永不触发的回调 —— 那是缺陷不是特性，已另立缺陷单 D-1 独立处理。详见设计文档 §1.3 与主理人裁决 #1。</p>
 */
export interface SidebarFooterSlotProps {
  readonly isCollapsed: boolean;
  readonly isDark: boolean;
  /** 内部 `emit('openSettings')`（唯一 emit 点）。 */
  readonly onOpenSettings: () => void;
}

/** 宿主可注册的 Sidebar 渲染器集合。字段缺省 = 使用内置默认实现。 */
export interface SidebarSlotOverrides {
  readonly workspaceTree?: Component<SidebarTreeSlotProps>;
  readonly sidebarFooter?: Component<SidebarFooterSlotProps>;
}

/** 能力注入键：由宿主（ChatView）provide，Sidebar inject。范式同 FILE_PREVIEW_KEY / CHAT_MESSAGE_SLOTS_KEY。 */
export const SIDEBAR_SLOTS_KEY: InjectionKey<SidebarSlotOverrides> = Symbol('sidebar-slots');
