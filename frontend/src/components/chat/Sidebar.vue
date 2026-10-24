<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import type { ChatSession, WorkspaceVO } from '../../types/chat';
import logoUrl from '../../assets/lingxi-agent-logo.png';
import BranchedMenu from '../common/BranchedMenu.vue';


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
        : 'bg-[#fafafa] border-gray-200/80 text-gray-800'
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
            : 'hover:bg-gray-200/70 text-gray-500 hover:text-gray-900',
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
            : 'bg-white border-gray-200 hover:border-gray-300 hover:bg-white text-gray-800'
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
            : 'bg-white border-gray-200 hover:border-gray-300 text-gray-800'
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
              : 'text-gray-400 hover:text-gray-700 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-gray-200/70 dark:hover:bg-white/[0.06]'
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
          class="p-1 rounded-md text-gray-400 hover:text-gray-700 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-gray-200/70 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
          :title="isSortAsc ? t('chat.sidebar.sortDefault') : t('chat.sidebar.sortByName')"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l4-4m-4 4l-4-4"/>
          </svg>
        </button>

        <!-- Add Workspace Icon -->
        <button
          @click="emit('newWorkspace')"
          class="p-1 rounded-md text-gray-400 hover:text-gray-700 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-gray-200/70 dark:hover:bg-white/[0.06] transition-colors cursor-pointer"
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
          class="w-full px-2.5 py-1 text-xs rounded-lg border outline-none bg-white dark:bg-zinc-900 border-gray-200 dark:border-zinc-800 focus:border-blue-500 dark:focus:border-zinc-600 text-gray-800 dark:text-zinc-200 placeholder:text-lx-faint"
          autoFocus
        />
      </div>
    </CollapseTransition>

    <!-- Workspaces List (Scrollable Area) -->
    <div class="flex-1 overflow-y-auto px-2 py-1 space-y-0.5 scrollbar-thin">
      <!-- Collapsed view for icons -->
      <div v-if="isCollapsed" class="space-y-1 py-1">
        <div
          v-for="group in projectGroups"
          :key="group.workspace.id"
          @click="handleSelectWorkspace(group.workspace)"
          :class="[
            'p-2 rounded-xl flex items-center justify-center cursor-pointer transition',
            isWorkspaceActive(group.workspace)
              ? 'bg-blue-600/15 text-blue-500'
              : 'text-gray-400 hover:bg-gray-200/60 dark:hover:bg-gray-800 hover:text-lx-secondary'
          ]"
          :title="group.workspace.name || group.workspace.workDir"
        >
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
        </div>
      </div>

      <!-- Expanded Workspace Tree View -->
      <div v-else class="space-y-0.5">
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
                  ? 'bg-gray-200/80 text-gray-900 font-medium'
                  : 'text-gray-700 hover:text-gray-900 hover:bg-gray-100'
              ]"
            >
              <!-- Left: Chevron Indicator + Folder Icon + Workspace Name -->
              <div class="flex items-center gap-1.5 truncate min-w-0 pr-1" @click.stop="toggleWorkspaceExpand(group.workspace.id!)">
                <svg
                  class="w-3 h-3 shrink-0 transition-transform duration-200 text-gray-400 group-hover:text-gray-600"
                  :class="expandedWorkspaces[String(group.workspace.id)] ? 'rotate-90' : 'rotate-0'"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
                <svg
                  class="w-4 h-4 shrink-0 transition-colors text-gray-400 group-hover:text-gray-600"
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
                      class="absolute right-0 top-6 w-32 py-1 rounded-xl shadow-xl border z-50 text-xs bg-white border-gray-200 text-gray-700 backdrop-blur-md"
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
                        : 'hover:bg-gray-100/70 text-gray-600 hover:text-gray-900'
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
                    :class="isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-400 hover:text-gray-600'"
                  >
                    {{ isFullyExpanded(String(group.workspace.id)) ? t('chat.sidebar.collapseDisplay') : t('chat.sidebar.expandDisplay', { count: group.sessions.length }) }}
                  </button>
                </div>
              </div>
            </CollapseTransition>
          </div>

          <!-- Unassigned Sessions Section (if any) -->
          <div v-if="unassignedSessions.length > 0" class="pt-2">
                        <div class="px-2 py-1 text-[11px] font-medium text-gray-400 tracking-wider">
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
                    : 'hover:bg-gray-100/70 text-gray-600 hover:text-gray-900'
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
                :class="isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-gray-400 hover:text-gray-600'"
              >
                {{ isFullyExpanded('ws-unassigned') ? t('chat.sidebar.collapseDisplay') : t('chat.sidebar.expandDisplay', { count: unassignedSessions.length }) }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom Left Settings Bar (Image style) -->
    <div :class="['p-3 border-t shrink-0', isDark ? 'border-white/[0.06]' : 'border-gray-200/80']">
      <div :class="['flex items-center', isCollapsed ? 'justify-center' : 'justify-between']">
        <!-- Settings Button (⚙ 设置) -->
        <button
          @click="emit('openSettings')"
          :class="[
            'flex items-center gap-2 text-xs font-medium transition-colors cursor-pointer py-1.5 px-2 rounded-lg',
            isDark ? 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05]' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200/60'
          ]"
          :title="t('chat.sidebar.systemSettings')"
        >
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span v-if="!isCollapsed">{{ t('chat.sidebar.settings') }}</span>
        </button>
      </div>
    </div>
  </aside>
</template>
