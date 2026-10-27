<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, inject } from 'vue';
import type { ChatSession, WorkspaceVO } from '../../types/chat';
import logoUrl from '../../assets/lingxi-agent-logo.png';
import { SIDEBAR_SLOTS_KEY } from '../../types/sidebarSlots';
import type {
  SidebarFooterSlotProps,
  SidebarGroupNode,
  SidebarTreeActions,
  SidebarTreeSlotProps
} from '../../types/sidebarSlots';
import SidebarWorkspaceTree from './SidebarWorkspaceTree.vue';
import type { SidebarWorkspaceTreeInternalProps } from './SidebarWorkspaceTree.vue';
import SidebarFooterBar from './SidebarFooterBar.vue';


import { useTheme } from '../../composables/useTheme';
import { t } from '../../i18n';
import CollapseTransition from '../common/CollapseTransition.vue';
import { useSessionGrouping } from '../../composables/sidebar/useSessionGrouping';
import { useSessionVisibility, SESSION_VISIBLE_LIMIT } from '../../composables/sidebar/useSessionVisibility';
import { useWorkspaceExpansion } from '../../composables/sidebar/useWorkspaceExpansion';
import { useSidebarActions } from '../../composables/sidebar/useSidebarActions';


const props = defineProps<{
  sessions: ChatSession[];
  activeSessionId: string | null;
  workspaces?: WorkspaceVO[];
  activeWorkspaceId?: string | number | null;
  isCollapsed: boolean;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'selectSession', id: string): void;
  (e: 'newSession', workspaceId?: string | number | null): void;
  (e: 'deleteSession', id: string): void;
  (e: 'renameSession', id: string, name: string): void;
  (e: 'selectWorkspace', workspace: WorkspaceVO | null): void;
  (e: 'newWorkspace'): void;
  (e: 'deleteWorkspace', id: string | number): void;
  (e: 'toggleCollapse'): void;
  (e: 'openSettings'): void;
  (e: 'openModels'): void;
  (e: 'toggleTheme'): void;
}>();

/**
 * 两个具名插槽（容器与出现时机归组件，插槽只替换容器内部内容）。
 * 解析顺序：父级 `$slots` > 宿主注入（SIDEBAR_SLOTS_KEY）> 内置默认实现。
 */
defineSlots<{
  /** 工作区树 / 历史分组的全部内容（容器、滚动、折叠态与空态时机由组件拥有）。 */
  workspaceTree(props: SidebarTreeSlotProps): unknown;
  /** 底部入口区内容（容器与布局由组件拥有）。 */
  sidebarFooter(props: SidebarFooterSlotProps): unknown;
}>();

const { isDark: themeIsDark } = useTheme();
const isDark = computed(() => themeIsDark.value);

// 搜索过滤状态
const isFilterOpen = ref(false);
const filterQuery = ref('');
const isSortAsc = ref(false);


// 会话分组（纯计算）、工作空间展开态、可见性（截断 / 展开态 / BranchedMenu 数据）均已下沉为 composable。
// 顺序不可调换：展开态持有 fullyExpandedWorkspaces（activeSessionId 的 immediate watch 会写它），
// 可见性只能在其之后实例化。
const { projectGroups, unassignedSessions, isWorkspaceActive: isWorkspaceActivePure } = useSessionGrouping({
  sessions: computed(() => props.sessions),
  workspaces: computed(() => props.workspaces),
  filterQuery,
  isSortAsc
});

const { expandedWorkspaces, fullyExpandedWorkspaces, toggleWorkspaceExpand } = useWorkspaceExpansion({
  workspaces: computed(() => props.workspaces),
  activeSessionId: computed(() => props.activeSessionId),
  sessions: computed(() => props.sessions),
  sessionVisibleLimit: SESSION_VISIBLE_LIMIT
});

const {
  isFullyExpanded,
  toggleFullyExpanded,
  limitSessions,
  branchedMenuItems,
  branchedOpenIndices
} = useSessionVisibility({ projectGroups, unassignedSessions, expandedWorkspaces, fullyExpandedWorkspaces });


// 按照后端 workspace 的 ID（及兼容 workDir）收敛会话。纯计算逻辑已下沉至
// composables/sidebar/useSessionGrouping.ts（保持 workDir 唯一性语义，勿与 watch 内联谓词合并）。
// 模板 6 处调用点的薄包装：签名保持 (ws) => boolean，模板零改动
const isWorkspaceActive = (ws: WorkspaceVO) =>
  isWorkspaceActivePure(ws, props.activeWorkspaceId, props.activeSessionId);

// 交互动作层（重命名编辑态、项目菜单、删除确认、BranchedMenu 选择、点击外部关闭）
const {
  editingSessionId,
  editingTitle,
  activeMenuWorkspaceId,
  handleSelectWorkspace,
  handleNewSessionInProject,
  toggleProjectMenu,
  handleDeleteProject,
  startEdit,
  saveEdit,
  handleBranchedSelect,
  handleBranchedToggle,
  installClickOutside,
  disposeClickOutside
} = useSidebarActions({
  emit,
  workspaces: computed(() => props.workspaces),
  expandedWorkspaces,
  branchedMenuItems,
  toggleWorkspaceExpand,
  toggleFullyExpanded
});

/**
 * 宿主注册的渲染器（三层解析的中间层：父级 `$slots` > 宿主注入 > 内置默认实现）。
 *
 * <p>必须**按字段判空**，不能按对象真值判：宿主 `provide(SIDEBAR_SLOTS_KEY, {})` 时对象为真
 * 但两个字段缺省，按对象真值判会把两侧都当成「已注册」，结果整块区域渲染成空白。
 * `inject` 的默认值给 `undefined`，与「未注册」语义一致。</p>
 */
const slotOverrides = inject(SIDEBAR_SLOTS_KEY, undefined);
const injectedTree = computed(() => slotOverrides?.workspaceTree);
const injectedFooter = computed(() => slotOverrides?.sidebarFooter);

/** 注册项是否就是内置默认实现（决定用内部 props 还是对外契约渲染，见下方模板注释）。 */
const isDefaultTree = computed(() => injectedTree.value === SidebarWorkspaceTree);

/**
 * 语义键 → 组件内部状态键。
 *
 * <p><b>为什么需要这个映射（与设计稿 §4.4 的一处偏差）：</b>插槽的语义键统一为 `ws-<id>` /
 * `ws-unassigned`（与 BranchedMenu 的 value 对齐），但组件内部 `fullyExpandedWorkspaces` 对
 * **工作区分组**用的键是 `String(workspace.id)`（见 useWorkspaceExpansion 的 activeSessionId watch
 * 与亮色分支的 toggle），只有历史分组用 `ws-unassigned`。若直接拿 `ws-<id>` 去查，`isFullyExpanded`
 * 恒为 false ⇒ 对外语义模型会谎报「未展开」。这里显式还原真实键，避免把内部键口径泄漏成契约的一部分。</p>
 *
 * @param groupKey 语义键（`ws-12` / `ws-unassigned`）
 * @returns 组件内部使用的工作区 id 字符串 / `ws-unassigned`
 */
const internalKeyOf = (groupKey: string): string =>
  groupKey === 'ws-unassigned' ? 'ws-unassigned' : groupKey.replace(/^ws-/, '');

/**
 * 树内容区的唯一行为入口集合（10 个回调，每个 1:1 对应组件内既有实现点）。
 *
 * <p>消费者只能调用这些回调，拿不到 `emit` —— 这样替换实现无法自造一条事件路径（§5.3 D2）。</p>
 */
const treeActions: SidebarTreeActions = {
  onSelectSession: (id: string) => emit('selectSession', id),
  onSelectWorkspace: (workspace: WorkspaceVO | null) => {
    // 历史分组（null）只有「选中」语义：不切换任何工作区展开态，直接上报给宿主。
    if (workspace === null) { emit('selectWorkspace', null); return; }
    handleSelectWorkspace(workspace);
  },
  onToggleGroup: (groupKey: string) => {
    // 历史分组没有「展开/折叠」状态（它的可见性由 onToggleMore 控制），因此是显式 no-op。
    if (groupKey === 'ws-unassigned') return;
    toggleWorkspaceExpand(internalKeyOf(groupKey));
  },
  onToggleMore: (groupKey: string) => toggleFullyExpanded(internalKeyOf(groupKey)),
  onStartEdit: (id: string) => {
    const session = props.sessions.find((item) => item.id === id);
    if (!session) return;
    // 复用既有 startEdit：它需要 Event（内部会 stopPropagation 并写 editingSessionId/editingTitle）。
    startEdit(session, new Event('click'));
  },
  onRenameSession: (id: string, name: string) => emit('renameSession', id, name),
  onDeleteSession: (id: string) => emit('deleteSession', id),
  onNewSession: (workspaceId?: string | number | null) => emit('newSession', workspaceId),
  onNewWorkspace: () => emit('newWorkspace'),
  onDeleteWorkspace: (id: string | number) => emit('deleteWorkspace', id)
};

/**
 * 语义层装配：把 `projectGroups`（领域模型）+ `unassignedSessions` 投影成插槽契约模型。
 *
 * <p>三个必须由这里做、不能外移的决定：①「历史对话」分组以 `workspace: null` 表达（它在一处被折进
 * branchedMenuItems，在另一处是独立区块）；②截断与「展开显示」还原成 `truncated`/`totalCount`
 * （伪条目 `<more-*>` 属渲染细节）；③`active` 复用组件既有的 `isWorkspaceActive` 判定，
 * 保证两种默认实现与替换实现的选中态一致。</p>
 */
const treeGroups = computed<SidebarGroupNode[]>(() => {
  const nodes: SidebarGroupNode[] = projectGroups.value.map((group) => {
    const internalKey = String(group.workspace.id);
    const visible = limitSessions(internalKey, group.sessions);
    return {
      key: 'ws-' + internalKey,
      workspace: group.workspace,
      label: group.workspace.name || group.workspace.workDir || t('session.workspace'),
      sessions: visible,
      totalCount: group.sessions.length,
      truncated: visible.length < group.sessions.length,
      expanded: isFullyExpanded(internalKey),
      active: isWorkspaceActive(group.workspace)
    };
  });
  if (unassignedSessions.value.length > 0) {
    const visible = limitSessions('ws-unassigned', unassignedSessions.value);
    nodes.push({
      key: 'ws-unassigned',
      workspace: null,
      label: t('chat.sidebar.history'),
      sessions: visible,
      totalCount: unassignedSessions.value.length,
      truncated: visible.length < unassignedSessions.value.length,
      expanded: isFullyExpanded('ws-unassigned'),
      active: false
    });
  }
  return nodes;
});

/** `workspaceTree` 插槽 props（对外契约，7 项）。 */
const treeSlotProps = computed<SidebarTreeSlotProps>(() => ({
  groups: treeGroups.value,
  activeSessionId: props.activeSessionId,
  isCollapsed: props.isCollapsed,
  isDark: isDark.value,
  sessionLimit: SESSION_VISIBLE_LIMIT,
  editingSessionId: editingSessionId.value,
  actions: treeActions
}));

/**
 * 工作区树**默认实现**的内部 props（24 项，无兼容承诺）。
 *
 * <p>`editingTitle` 传的是 Ref 本身（不是 `.value`）：原模板用 `v-model` 双向绑定重命名输入框，
 * 传值会让输入框变成只读。这里在 script 作用域里组对象，模板不会再自动解包，
 * 因此子组件拿到的是真正的 Ref —— 这是内部接口专有的约定，对外契约不这样写。</p>
 */
const treeDefaultProps = computed<SidebarWorkspaceTreeInternalProps>(() => ({
  projectGroups: projectGroups.value,
  unassignedSessions: unassignedSessions.value,
  expandedWorkspaces: expandedWorkspaces.value,
  branchedMenuItems: branchedMenuItems.value,
  branchedOpenIndices: branchedOpenIndices.value,
  editingSessionId: editingSessionId.value,
  editingTitle,
  activeMenuWorkspaceId: activeMenuWorkspaceId.value,
  activeSessionId: props.activeSessionId,
  isCollapsed: props.isCollapsed,
  isDark: isDark.value,
  limitSessions,
  isFullyExpanded,
  toggleFullyExpanded,
  toggleWorkspaceExpand,
  isWorkspaceActive,
  handleSelectWorkspace,
  handleNewSessionInProject,
  toggleProjectMenu,
  handleDeleteProject,
  startEdit,
  saveEdit,
  handleBranchedSelect,
  handleBranchedToggle,
  actions: treeActions
}));

/** `sidebarFooter` 插槽 props（对外契约，3 项）+ 默认实现的同一份 props。 */
const footerSlotProps = computed<SidebarFooterSlotProps>(() => ({
  isCollapsed: props.isCollapsed,
  isDark: isDark.value,
  onOpenSettings: () => emit('openSettings')
}));

onMounted(() => {
  installClickOutside();
});

onBeforeUnmount(() => {
  disposeClickOutside();
});

</script>

<template>
  <aside
    :class="[
      'h-full flex flex-col transition-all duration-300 z-30 select-none border-r',
      isCollapsed ? 'w-16' : 'w-64',
      isDark
        ? 'bg-black border-white/[0.06] text-zinc-100'
        : 'bg-[#fafafa] border-zinc-200/80 text-gray-800'
    ]"
  >
    <!-- Top Header: Logo & Sidebar Toggle Button -->
    <div class="px-3 pt-3 pb-2 flex items-center justify-between shrink-0">
      <div v-if="!isCollapsed" class="flex items-center gap-2 px-1">
        <!-- LingXi Logo Icon -->
        <img :src="logoUrl" alt="LingXi" class="h-7 w-7 object-contain drop-shadow-sm" />
        <!-- LingXi Text -->
        <span class="font-bold text-sm tracking-tight text-gray-900 dark:text-zinc-100">
          LingXi
        </span>
      
      </div>

      <!-- Collapse / Expand Icon Button [|] -->
      <button
        @click="emit('toggleCollapse')"
        :title="t('chat.sidebar.toggleSidebar')"
        :class="[
          'p-1.5 rounded-lg transition-colors cursor-pointer',
          isDark
            ? 'hover:bg-white/[0.06] text-zinc-400 hover:text-zinc-100'
            : 'hover:bg-zinc-200/70 text-zinc-500 hover:text-gray-900',
          isCollapsed ? 'mx-auto' : ''
        ]"
      >
        <!-- Sidebar Panel Icon [|] -->
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <rect x="3" y="3" width="18" height="18" rx="2.5" stroke-width="1.8"/>
          <line x1="9" y1="3" x2="9" y2="21" stroke-width="1.8"/>
        </svg>
      </button>
    </div>

    <!-- New Chat Button (+ 新会话) -->
    <div class="px-3 py-1.5 shrink-0">
      <button
        v-if="!isCollapsed"
        @click="emit('newSession', activeWorkspaceId)"
        :class="[
          'w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl border text-xs sm:text-sm font-medium transition-all shadow-xs cursor-pointer',
          isDark
            ? 'bg-zinc-900/90 border-white/[0.08] hover:bg-zinc-800 hover:border-white/[0.16] text-zinc-200 hover:text-white'
            : 'bg-white border-zinc-200 hover:border-zinc-300 hover:bg-white text-gray-800'
        ]"
        :title="t('chat.sidebar.newChat')"
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <circle cx="12" cy="12" r="9" stroke-width="1.8"/>
          <path d="M12 8v8M8 12h8" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        <span>{{ t('chat.sidebar.newSession') }}</span>
      </button>

      <!-- Collapsed New Chat Icon -->
      <button
        v-else
        @click="emit('newSession', activeWorkspaceId)"
        :class="[
          'w-10 h-10 mx-auto flex items-center justify-center rounded-xl border transition-all shadow-xs cursor-pointer',
          isDark
            ? 'bg-zinc-900/90 border-white/[0.08] hover:bg-zinc-800 hover:border-white/[0.16] text-zinc-200 hover:text-white'
            : 'bg-white border-zinc-200 hover:border-zinc-300 text-gray-800'
        ]"
        :title="t('chat.sidebar.newSession')"
      >
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M12 5v14M5 12h14" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <!-- Workspaces Section Header -->
    <div v-if="!isCollapsed" class="px-4 pt-3 pb-1 flex items-center justify-between shrink-0 text-lx-muted">
      <span class="font-medium text-xs tracking-tight">{{ t('chat.sidebar.workspace') }}</span>
      <div class="flex items-center gap-1">
        <!-- Search / Filter Icon -->
        <button
          @click="isFilterOpen = !isFilterOpen"
          :class="[
            'p-1 rounded-md transition-colors cursor-pointer',
            isFilterOpen
              ? 'text-blue-500'
              : 'text-zinc-400 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-white/[0.06]'
          ]"
          :title="t('chat.sidebar.searchWorkspace')"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
        </button>

        <!-- Sort / Switch Icon -->
        <button
          @click="isSortAsc = !isSortAsc"
          class="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
          :title="isSortAsc ? t('chat.sidebar.sortDefault') : t('chat.sidebar.sortByName')"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l4-4m-4 4l-4-4"/>
          </svg>
        </button>

        <!-- Add Workspace Icon -->
        <button
          @click="emit('newWorkspace')"
          class="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
          :title="t('chat.sidebar.newWorkspace')"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Filter Search Input Box -->
    <CollapseTransition>
      <div v-if="!isCollapsed && isFilterOpen" class="px-3 pb-1.5 shrink-0">
        <input
          v-model="filterQuery"
          :placeholder="t('chat.sidebar.searchWorkspacePlaceholder')"
          class="w-full px-2.5 py-1 text-xs rounded-lg border outline-none bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 focus:border-blue-500 dark:focus:border-zinc-600 text-gray-800 dark:text-zinc-200 placeholder:text-lx-faint"
          autoFocus
        />
      </div>
    </CollapseTransition>

    <!-- Workspaces List (Scrollable Area) -->
    <div class="flex-1 overflow-y-auto px-2 py-1 space-y-0.5 scrollbar-thin">
      <slot name="workspaceTree" v-bind="treeSlotProps">
        <component :is="injectedTree" v-if="injectedTree && !isDefaultTree" v-bind="treeSlotProps" />
        <SidebarWorkspaceTree v-else v-bind="treeDefaultProps" />
      </slot>
    </div>

    <!-- Bottom Left Settings Bar (Image style) -->
    <div :class="['p-3 border-t shrink-0', isDark ? 'border-white/[0.06]' : 'border-zinc-200/80']">
      <slot name="sidebarFooter" v-bind="footerSlotProps">
        <component :is="injectedFooter" v-if="injectedFooter" v-bind="footerSlotProps" />
        <SidebarFooterBar v-else v-bind="footerSlotProps" />
      </slot>
    </div>
  </aside>
</template>
