<script setup lang="ts">
/**
 * 【内部接口 · 无兼容承诺】Sidebar 工作区树的**默认实现**。
 *
 * <p><b>为什么内部 props 这么宽（24 项）：</b>本组件是「把 Sidebar 的一段模板抽成函数」，
 * 它不是对外契约。对外契约是 `SidebarTreeSlotProps`（7 项，见 types/sidebarSlots.ts），
 * 宿主注册本组件时走的是内部接口；**替换实现只能收到对外契约**，拿不到这里的任何内部状态。
 * 这正是设计文档 §7.0 的方案③（两套接口），也因此本文件**不做** provide/inject 内部上下文——
 * 那会给替换实现留后门，让契约形同虚设。</p>
 *
 * <p><b>模板逐字迁移：</b>`<template>` 内容是从 `Sidebar.vue` 原 253–639 行原样切出来的，
 * 唯一改动是给两个根节点加了 `data-slot="workspace-tree"`（属性不参与渲染）。
 * 因此 `emit('selectSession', …)` 这类原始写法被保留 —— 下面提供一个同名 `emit` 垫片转调到
 * `props.actions`，保证「一个语义只有一个实现点」。</p>
 *
 * <p><b>为什么 `editingTitle` 传的是 `Ref`：</b>原模板用 `v-model="editingTitle"` 双向绑定
 * 重命名输入框，而该 ref 的所有者是父组件的 `useSidebarActions`。改成受控 prop 必须改写模板
 * （`v-model` → `:value` + `@input`），会破坏"逐字迁移"的可审计性；因此内部接口直接传 Ref，
 * 并在文件头显式声明这一约定（仅限内部，不对替换实现开放）。</p>
 */
import { computed, type Ref } from 'vue';
import BranchedMenu from '../common/BranchedMenu.vue';
import type { BranchedMenuChild, BranchedMenuItem } from '../common/BranchedMenu.vue';
import CollapseTransition from '../common/CollapseTransition.vue';
import { t } from '../../i18n';
import { SESSION_VISIBLE_LIMIT } from '../../composables/sidebar/useSessionVisibility';
import type { ProjectGroup } from '../../composables/sidebar/useSessionGrouping';
import type { ChatSession, WorkspaceVO } from '../../types/chat';
import type { SidebarTreeActions } from '../../types/sidebarSlots';

defineOptions({ inheritAttrs: false });

/**
 * 内部 props（24 项，**无兼容承诺**，随内部重构自由变动）。
 *
 * <p>与对外 `SidebarTreeSlotProps` 的差别：这里给的是组件内既有的 composable 产物与原始 handler，
 * 好让模板能逐字迁移；对外契约给的是装配后的语义模型（`groups`）。两者的唯一联系是
 * `actions`（同一个对象，保证两条路径的行为不会分叉）。</p>
 */
export interface SidebarWorkspaceTreeInternalProps {
  /** `useSessionGrouping` 的领域分组（含会话全量）。 */
  readonly projectGroups: ProjectGroup[];
  /** 未归属任何工作区的会话（「历史对话」分区）。 */
  readonly unassignedSessions: ChatSession[];
  /** `useWorkspaceExpansion` 的展开态（按 workspace id 字符串键控）。 */
  readonly expandedWorkspaces: Record<string, boolean>;
  /** `useSessionVisibility` 产出的 BranchedMenu 数据（暗色分支）。 */
  readonly branchedMenuItems: BranchedMenuItem[];
  readonly branchedOpenIndices: number[];
  /** 行内重命名：正在编辑的会话 id。 */
  readonly editingSessionId: string | null;
  /** 行内重命名的输入值。传 Ref 是为了让 `v-model` 在原模板里保持原样（见文件头）。 */
  readonly editingTitle: Ref<string>;
  /** 当前打开三点菜单的 workspace id。 */
  readonly activeMenuWorkspaceId: string | null;
  readonly activeSessionId: string | null;
  readonly isCollapsed: boolean;
  readonly isDark: boolean;
  /** `useSessionVisibility.limitSessions`：按上限截断（供 v-for 直接使用）。 */
  readonly limitSessions: (key: string, sessions: ChatSession[]) => ChatSession[];
  readonly isFullyExpanded: (key: string) => boolean;
  readonly toggleFullyExpanded: (key: string) => void;
  readonly toggleWorkspaceExpand: (wsId: string | number) => void;
  readonly isWorkspaceActive: (ws: WorkspaceVO) => boolean;
  readonly handleSelectWorkspace: (ws: WorkspaceVO) => void;
  readonly handleNewSessionInProject: (ws: WorkspaceVO, event: Event) => void;
  readonly toggleProjectMenu: (wsId: string | number, event: Event) => void;
  readonly handleDeleteProject: (ws: WorkspaceVO, event: Event) => Promise<void>;
  readonly startEdit: (session: ChatSession, event: Event) => void;
  readonly saveEdit: (session: ChatSession, event: Event) => void;
  readonly handleBranchedSelect: (value: string, item: BranchedMenuChild | BranchedMenuItem) => void;
  readonly handleBranchedToggle: (index: number, isOpen: boolean) => void;
  /** 语义动作集合：`emit` 垫片转调它，保证「一个语义只有一个实现点」。 */
  readonly actions: SidebarTreeActions;
}

const props = defineProps<SidebarWorkspaceTreeInternalProps>();

// 重命名输入框的双向绑定：`editingTitle` 的所有者是父组件的 useSidebarActions。
// 直接持有同一个 Ref（脚本作用域不会自动解包），模板 `v-model="editingTitle"` 才能写回 .value。
// 说明：这条不能改成 props 解构 —— 解构后 v-model 会编译成对只读 props 赋值。
const editingTitle = props.editingTitle;

// 同名局部别名：让模板保持逐字迁移（零改名）。
// **值必须包成 computed**：props 变化时纯常量不会跟着变（实测事故：`isDark` 固定为初始值
// ⇒ 亮色下仍渲染 BranchedMenu 暗色分支）。computed 在模板里会被自动解包，读取写法不变。
const projectGroups = computed(() => props.projectGroups);
const unassignedSessions = computed(() => props.unassignedSessions);
const expandedWorkspaces = computed(() => props.expandedWorkspaces);
const branchedMenuItems = computed(() => props.branchedMenuItems);
const branchedOpenIndices = computed(() => props.branchedOpenIndices);
const editingSessionId = computed(() => props.editingSessionId);
const activeMenuWorkspaceId = computed(() => props.activeMenuWorkspaceId);
const activeSessionId = computed(() => props.activeSessionId);
const isCollapsed = computed(() => props.isCollapsed);
const isDark = computed(() => props.isDark);
// 函数类 props 只做透传，身份稳定，不需要包 computed。
const limitSessions = props.limitSessions;
const isFullyExpanded = props.isFullyExpanded;
const toggleFullyExpanded = props.toggleFullyExpanded;
const toggleWorkspaceExpand = props.toggleWorkspaceExpand;
const isWorkspaceActive = props.isWorkspaceActive;
const handleSelectWorkspace = props.handleSelectWorkspace;
const handleNewSessionInProject = props.handleNewSessionInProject;
const toggleProjectMenu = props.toggleProjectMenu;
const handleDeleteProject = props.handleDeleteProject;
const startEdit = props.startEdit;
const saveEdit = props.saveEdit;
const handleBranchedSelect = props.handleBranchedSelect;
const handleBranchedToggle = props.handleBranchedToggle;

/** 原模板里出现过的 emit 事件（只有这两个，多的名字属于迁移错误）。 */
interface TreeEmitShim {
  (e: 'selectSession', id: string): void;
  (e: 'deleteSession', id: string): void;
}

/**
 * `emit` 垫片：把原模板里的 `emit('selectSession' | 'deleteSession', …)` 转调到 `props.actions`。
 *
 * <p>为什么不做成"改成调用 actions"的模板改写：那会改动 5 处模板行，破坏"逐字迁移"的可审计性；
 * 垫片只有一处实现，且未知名直接抛错（迁移漏事件时会在开发期立刻暴露，而不是静默失效）。</p>
 */
const emitShim = (event: string, ...args: readonly unknown[]): void => {
  if (event === 'selectSession') {
    props.actions.onSelectSession(String(args[0]));
    return;
  }
  if (event === 'deleteSession') {
    props.actions.onDeleteSession(String(args[0]));
    return;
  }
  throw new Error(`SidebarWorkspaceTree: 未支持的 emit 事件「${event}」（模板与本组件契约不一致）`);
};
const emit = emitShim as TreeEmitShim;
</script>

<template>
      <!-- Collapsed view for icons -->
      <div v-if="isCollapsed" class="space-y-1 py-1" data-slot="workspace-tree">
        <div
          v-for="group in projectGroups"
          :key="group.workspace.id"
          @click="handleSelectWorkspace(group.workspace)"
          :class="[
            'p-2 rounded-xl flex items-center justify-center cursor-pointer transition',
            isWorkspaceActive(group.workspace)
              ? 'bg-blue-600/15 text-blue-500'
              : 'text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-gray-800 hover:text-lx-secondary'
          ]"
          :title="group.workspace.name || group.workspace.workDir"
        >
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
        </div>
      </div>

      <!-- Expanded Workspace Tree View -->
      <div v-else class="space-y-0.5" data-slot="workspace-tree">
        <!-- Empty State if no workspaces and no unassigned sessions -->
        <div v-if="projectGroups.length === 0 && unassignedSessions.length === 0" class="px-2 py-6 text-center text-xs text-lx-faint select-none">
                    {{ t('chat.sidebar.noWorkspace') }}
        </div>

        <!-- Dark Mode: 使用 BranchedMenu 树形分支结构渲染 -->
        <div v-else-if="isDark" class="py-1">
          <BranchedMenu
            :items="branchedMenuItems"
            :active="activeSessionId || ''"
            :openIndices="branchedOpenIndices"
            color="#a1a1aa"
            accentColor="#38bdf8"
            lineColor="rgba(255, 255, 255, 0.12)"
            :lineWidth="1.2"
            :rowHeight="34"
            :indent="36"
            :trunk="14"
            :radius="8"
            :fontSize="13"
            className="w-full"
            @select="handleBranchedSelect"
            @toggle="handleBranchedToggle"
          >
            <!-- Header Prefix: 文件夹图标 -->
            <template #header-prefix="{ item }">
              <svg
                class="w-3.5 h-3.5 shrink-0 transition-colors"
                :class="item.raw && isWorkspaceActive(item.raw) ? 'text-zinc-100' : 'text-zinc-500'"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </template>

            <!-- Header Label: 标题 -->
            <template #header-label="{ item }">
              <span
                class="truncate text-xs tracking-wide"
                :class="item.raw && isWorkspaceActive(item.raw) ? 'text-white font-medium' : ''"
              >
                {{ item.label }}
              </span>
            </template>

            <!-- Header Actions: 工作区操作与新建会话 -->
            <template #header-actions="{ item }">
              <div v-if="item.raw" class="flex items-center gap-1 shrink-0">
                <div class="relative">
                                    <button
                    @click="toggleProjectMenu(item.raw.id, $event)"
                    class="p-0.5 rounded opacity-0 group-hover/head:opacity-80 hover:opacity-100 hover:text-zinc-100 transition cursor-pointer"
                    :title="t('chat.sidebar.workspaceActions')"
                  >
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                    </svg>
                  </button>

                  <!-- Context Menu Floating Panel -->
                  <Transition
                    enter-active-class="transition duration-150 ease-out"
                    enter-from-class="opacity-0 scale-95 translate-y-1"
                    enter-to-class="opacity-100 scale-100 translate-y-0"
                    leave-active-class="transition duration-100 ease-in"
                    leave-from-class="opacity-100 scale-100 translate-y-0"
                    leave-to-class="opacity-0 scale-95 translate-y-1"
                  >
                    <div
                      v-if="activeMenuWorkspaceId === String(item.raw.id)"
                      class="absolute right-0 top-6 w-32 py-1 rounded-xl shadow-2xl border border-white/[0.08] bg-zinc-900 text-zinc-200 z-50 text-xs backdrop-blur-md"
                    >
                      <button
                                                @click="handleDeleteProject(item.raw, $event)"
                        class="w-full text-left px-3 py-1.5 hover:bg-red-500/10 text-red-400 transition-colors flex items-center gap-1.5 cursor-pointer"
                      >
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        <span>{{ t('chat.sidebar.deleteWorkspaceLabel') }}</span>
                      </button>
                    </div>
                  </Transition>
                </div>

                <button
                                    @click="handleNewSessionInProject(item.raw, $event)"
                  class="p-0.5 rounded opacity-0 group-hover/head:opacity-80 hover:opacity-100 hover:text-white transition cursor-pointer"
                  :title="t('chat.sidebar.newSessionInWorkspace')"
                >
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                  </svg>
                </button>
              </div>
            </template>

            <!-- Item Label: 会话标题或行内编辑器 -->
            <template #item-label="{ item }">
              <div class="flex-1 truncate min-w-0 pr-1">
                <input
                  v-if="editingSessionId === item.value"
                  v-model="editingTitle"
                  @blur="saveEdit(item.raw, $event)"
                  @keyup.enter="saveEdit(item.raw, $event)"
                  @click.stop
                  class="w-full bg-transparent border-b border-white/50 outline-none text-xs px-0.5 text-inherit"
                  autoFocus
                />
                <span v-else class="block truncate" :title="item.label">{{ item.label }}</span>
              </div>
            </template>

            <!-- Item Actions: 重命名与删除 -->
            <template #item-actions="{ item }">
              <div
                v-if="editingSessionId !== item.value"
                class="hidden group-hover/kid:flex items-center gap-1 opacity-70 shrink-0"
                @click.stop
              >
                                <button
                  @click.stop="startEdit(item.raw, $event)"
                  class="p-0.5 hover:text-white transition cursor-pointer"
                  :title="t('chat.sidebar.rename')"
                >
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                                <button
                  @click.stop="emit('deleteSession', item.value)"
                  class="p-0.5 hover:text-red-400 transition cursor-pointer"
                  :title="t('common.remove')"
                >
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </template>
          </BranchedMenu>
        </div>

        <!-- Light Mode: 既有会话列表渲染 -->
        <div v-else class="space-y-0.5">
          <!-- Each Workspace Group Item -->
          <div
            v-for="group in projectGroups"
            :key="group.workspace.id"
            class="rounded-lg transition-colors"
          >
            <!-- Workspace Row (Folder Icon + Name) -->
            <div
              @click="handleSelectWorkspace(group.workspace)"
              :class="[
                'group relative flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer text-xs transition-colors',
                isWorkspaceActive(group.workspace)
                  ? 'bg-zinc-200/80 text-gray-900 font-medium'
                  : 'text-gray-700 hover:text-gray-900 hover:bg-zinc-100'
              ]"
            >
              <!-- Left: Chevron Indicator + Folder Icon + Workspace Name -->
              <div class="flex items-center gap-1.5 truncate min-w-0 pr-1" @click.stop="toggleWorkspaceExpand(group.workspace.id!)">
                <svg
                  class="w-3 h-3 shrink-0 transition-transform duration-200 text-zinc-400 group-hover:text-zinc-600"
                  :class="expandedWorkspaces[String(group.workspace.id)] ? 'rotate-90' : 'rotate-0'"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
                <svg
                  class="w-4 h-4 shrink-0 transition-colors text-zinc-400 group-hover:text-zinc-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span class="truncate">{{ group.workspace.name || group.workspace.workDir }}</span>
              </div>

              <!-- Right: Three Dots Menu ⋮ and New Chat + -->
              <div class="flex items-center gap-1 shrink-0">
                <!-- Three Dots Context Menu ⋮ -->
                <div class="relative">
                  <button
                    @click="toggleProjectMenu(group.workspace.id!, $event)"
                                        :class="[
                      'p-0.5 rounded transition-opacity cursor-pointer',
                      isWorkspaceActive(group.workspace) ? 'opacity-80 hover:opacity-100' : 'opacity-0 group-hover:opacity-80 hover:opacity-100',
                      'hover:text-gray-900'
                    ]"
                    :title="t('chat.sidebar.workspaceActions')"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                    </svg>
                  </button>

                  <!-- Context Menu Floating Panel -->
                  <Transition
                    enter-active-class="transition duration-150 ease-out"
                    enter-from-class="opacity-0 scale-95 translate-y-1"
                    enter-to-class="opacity-100 scale-100 translate-y-0"
                    leave-active-class="transition duration-100 ease-in"
                    leave-from-class="opacity-100 scale-100 translate-y-0"
                    leave-to-class="opacity-0 scale-95 translate-y-1"
                  >
                    <div
                      v-if="activeMenuWorkspaceId === String(group.workspace.id)"
                      class="absolute right-0 top-6 w-32 py-1 rounded-xl shadow-xl border z-50 text-xs bg-white border-zinc-200 text-gray-700 backdrop-blur-md"
                    >
                      <button
                                                @click="handleDeleteProject(group.workspace, $event)"
                        class="w-full text-left px-3 py-1.5 hover:bg-red-500/10 text-red-500 transition-colors flex items-center gap-1.5 cursor-pointer"
                      >
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        <span>{{ t('chat.sidebar.deleteWorkspaceLabel') }}</span>
                      </button>
                    </div>
                  </Transition>
                </div>

                <!-- + New Chat in this Workspace -->
                <button
                                    @click="handleNewSessionInProject(group.workspace, $event)"
                  :class="[
                    'p-0.5 rounded transition-opacity cursor-pointer',
                    isWorkspaceActive(group.workspace) ? 'opacity-80 hover:opacity-100' : 'opacity-0 group-hover:opacity-80 hover:opacity-100',
                    'hover:text-blue-500'
                  ]"
                  :title="t('chat.sidebar.newSessionInWorkspace')"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- Sessions under this Workspace -->
            <CollapseTransition>
              <div v-if="expandedWorkspaces[String(group.workspace.id)] && group.sessions.length > 0">
                <div class="pl-4 pr-1 py-0.5 space-y-0.5">
                  <div
                    v-for="session in limitSessions(String(group.workspace.id), group.sessions)"
                    :key="session.id"
                    @click="emit('selectSession', session.id)"
                    :class="[
                      'group/session relative flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-xs transition-colors',
                      activeSessionId === session.id
                        ? 'bg-blue-50 text-blue-600 font-medium'
                        : 'hover:bg-zinc-100/70 text-zinc-600 hover:text-gray-900'
                    ]"
                  >
                    <!-- Chat Bubble Icon -->
                    <svg class="w-3.5 h-3.5 shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                    </svg>

                    <!-- Session Title or Inline Editor -->
                    <div class="flex-1 truncate">
                      <input
                        v-if="editingSessionId === session.id"
                        v-model="editingTitle"
                        @blur="saveEdit(session, $event)"
                        @keyup.enter="saveEdit(session, $event)"
                        class="w-full bg-transparent border-b border-blue-500 outline-none text-xs px-0.5 text-inherit"
                        autoFocus
                      />
                      <span v-else class="block truncate" :title="session.title || t('session.newConversation')">{{ session.title || t('session.newConversation') }}</span>
                    </div>

                    <!-- Action Controls: Rename & Delete -->
                    <div v-if="editingSessionId !== session.id" class="hidden group-hover/session:flex items-center gap-1 opacity-70 shrink-0">
                      <button @click="startEdit(session, $event)" class="p-0.5 hover:text-blue-500 transition cursor-pointer" :title="t('chat.sidebar.rename')">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button @click.stop="emit('deleteSession', session.id)" class="p-0.5 hover:text-red-500 transition cursor-pointer" :title="t('common.remove')">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <!-- 展开显示 / 收起 -->
                  <button
                    v-if="group.sessions.length > SESSION_VISIBLE_LIMIT"
                    @click.stop="toggleFullyExpanded(String(group.workspace.id))"
                    class="w-full text-left px-2 py-1.5 rounded-lg text-xs transition-colors cursor-pointer"
                    :class="isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'"
                  >
                    {{ isFullyExpanded(String(group.workspace.id)) ? t('chat.sidebar.collapseDisplay') : t('chat.sidebar.expandDisplay', { count: group.sessions.length }) }}
                  </button>
                </div>
              </div>
            </CollapseTransition>
          </div>

          <!-- Unassigned Sessions Section (if any) -->
          <div v-if="unassignedSessions.length > 0" class="pt-2">
                        <div class="px-2 py-1 text-[11px] font-medium text-zinc-400 tracking-wider">
              {{ t('chat.sidebar.history') }}
            </div>
            <div class="space-y-0.5">
              <div
                v-for="session in limitSessions('ws-unassigned', unassignedSessions)"
                :key="session.id"
                @click="emit('selectSession', session.id)"
                :class="[
                  'group/session relative flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-xs transition-colors',
                  activeSessionId === session.id
                    ? 'bg-blue-50 text-blue-600 font-medium'
                    : 'hover:bg-zinc-100/70 text-zinc-600 hover:text-gray-900'
                ]"
              >
                <svg class="w-3.5 h-3.5 shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
                <div class="flex-1 truncate">
                  <input
                    v-if="editingSessionId === session.id"
                    v-model="editingTitle"
                    @blur="saveEdit(session, $event)"
                    @keyup.enter="saveEdit(session, $event)"
                    class="w-full bg-transparent border-b border-blue-500 outline-none text-xs px-0.5 text-inherit"
                    autoFocus
                  />
                  <span v-else class="block truncate">{{ session.title || t('session.newConversation') }}</span>
                </div>
                <div v-if="editingSessionId !== session.id" class="hidden group-hover/session:flex items-center gap-1 opacity-70 shrink-0">
                  <button @click="startEdit(session, $event)" class="p-0.5 hover:text-blue-500 transition cursor-pointer" :title="t('chat.sidebar.rename')">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                  </button>
                  <button @click.stop="emit('deleteSession', session.id)" class="p-0.5 hover:text-red-500 transition cursor-pointer" :title="t('common.remove')">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
              <button
                v-if="unassignedSessions.length > SESSION_VISIBLE_LIMIT"
                @click.stop="toggleFullyExpanded('ws-unassigned')"
                class="w-full text-left px-2 py-1.5 rounded-lg text-xs transition-colors cursor-pointer"
                :class="isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'"
              >
                {{ isFullyExpanded('ws-unassigned') ? t('chat.sidebar.collapseDisplay') : t('chat.sidebar.expandDisplay', { count: unassignedSessions.length }) }}
              </button>
            </div>
          </div>
        </div>
      </div>
</template>
