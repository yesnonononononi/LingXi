<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import type { WorkspaceVO } from '../../types/chat';
import { useTheme } from '../../composables/useTheme';

const props = defineProps<{
  workspaces: WorkspaceVO[];
  selectedWorkspaceId?: string | number | null;
  isDark?: boolean;
}>();

const { isDark: themeIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? themeIsDark.value);

const emit = defineEmits<{
  (e: 'selectWorkspace', workspace: WorkspaceVO | null): void;
  (e: 'newProject'): void;
  (e: 'quickStart'): void;
  (e: 'openChange', isOpen: boolean): void;
}>();

const isOpen = ref(false);
watch(isOpen, (val) => {
  emit('openChange', val);
});
const dropdownRef = ref<HTMLElement | null>(null);

const currentWorkspace = computed(() => {
  if (!props.selectedWorkspaceId) return null;
  return props.workspaces.find(w => String(w.id) === String(props.selectedWorkspaceId)) ?? null;
});

const currentWorkspaceName = computed(() => {
  return currentWorkspace.value?.name || (props.selectedWorkspaceId ? String(props.selectedWorkspaceId) : 'No Project');
});

const toggleDropdown = () => {
  isOpen.value = !isOpen.value;
};

const handleSelectWorkspace = (ws: WorkspaceVO) => {
  emit('selectWorkspace', ws);
  isOpen.value = false;
};

const handleSelectNoProject = () => {
  emit('selectWorkspace', null);
  isOpen.value = false;
};

const handleNewProject = () => {
  isOpen.value = false;
  emit('newProject');
};

const handleQuickStart = () => {
  isOpen.value = false;
  emit('quickStart');
};

const handleClickOutside = (event: MouseEvent) => {
  if (dropdownRef.value && !dropdownRef.value.contains(event.target as Node)) {
    isOpen.value = false;
  }
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    isOpen.value = false;
  }
};

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
  document.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <div ref="dropdownRef" class="relative inline-block text-left select-none">
    <!-- Trigger Button -->
    <button
      type="button"
      @click="toggleDropdown"
      :class="[
        'inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-medium rounded-lg transition-all cursor-pointer outline-none border shadow-2xs select-none',
        isOpen
          ? (isDark
              ? 'bg-zinc-800 border-zinc-700 text-white shadow-xs'
              : 'bg-zinc-100 border-zinc-300 text-gray-900 shadow-xs')
          : (isDark
              ? 'bg-zinc-800/80 border-zinc-700/60 text-zinc-300 hover:bg-zinc-800 hover:text-white hover:border-zinc-600'
              : 'bg-white/90 border-zinc-200/90 text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900 hover:border-zinc-300')
      ]"
      title="选择项目 / 工作空间"
    >
      <!-- Folder Icon -->
      <svg
        v-if="currentWorkspace"
        class="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
      <!-- No Project Slash Icon -->
      <svg
        v-else
        class="w-3.5 h-3.5 text-zinc-400 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
      </svg>

      <!-- Label -->
      <span class="truncate max-w-[180px]">{{ currentWorkspaceName }}</span>

      <!-- Chevron Down -->
      <svg
        :class="['w-3.5 h-3.5 text-zinc-400 transition-transform duration-200 shrink-0', isOpen ? 'rotate-180' : '']"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
      </svg>
    </button>

    <!-- Dropdown Menu Card -->
    <div
      v-if="isOpen"
      :class="[
        'absolute left-0 top-full mt-1.5 w-60 rounded-xl border shadow-2xl p-1.5 z-50 transition-all animate-in fade-in zoom-in-95 duration-150 backdrop-blur-2xl',
        isDark
          ? 'bg-black/95 border-white/20 text-zinc-100 shadow-[0_12px_40px_rgba(0,0,0,0.95)]'
          : 'bg-white/95 border-zinc-200 text-gray-800 shadow-gray-400/20'
      ]"
    >
      <!-- 1. Existing Workspaces List -->
      <div class="max-h-52 overflow-y-auto scrollbar-thin space-y-0.5 px-0.5">
        <div
          v-for="ws in workspaces"
          :key="ws.id"
          @click="handleSelectWorkspace(ws)"
          :class="[
            'group relative flex items-center justify-between px-2.5 py-1.5 rounded-xl cursor-pointer text-xs transition-colors',
            String(selectedWorkspaceId) === String(ws.id)
              ? (isDark ? 'bg-cyan-500/15 text-cyan-300 font-medium border border-cyan-500/30' : 'bg-gray-100 text-gray-900 font-medium')
              : (isDark ? 'hover:bg-white/10 text-zinc-300 hover:text-white' : 'hover:bg-gray-100/70 text-gray-700 hover:text-gray-900')
          ]"
        >
          <!-- Left: Folder Icon + Name -->
          <div class="flex items-center gap-2 truncate min-w-0 pr-2">
            <svg class="w-4 h-4 text-zinc-400 group-hover:text-cyan-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <span class="truncate">{{ ws.name || ws.workDir }}</span>
          </div>

          <!-- Right: Selected checkmark -->
          <div class="flex items-center gap-1.5 shrink-0">
            <svg
              v-if="String(selectedWorkspaceId) === String(ws.id)"
              class="w-3.5 h-3.5 text-cyan-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>
      </div>

      <!-- Divider 1 -->
      <div :class="['h-px my-1 mx-1', isDark ? 'bg-white/10' : 'bg-gray-100']"></div>

      <!-- 2. Action Items: New Project & Quick Start -->
      <div class="space-y-0.5 px-0.5">
        <!-- New Project -->
        <div
          @click="handleNewProject"
          :class="[
            'flex items-center gap-2 px-2.5 py-1.5 rounded-xl cursor-pointer text-xs transition-colors',
            isDark ? 'hover:bg-white/10 text-zinc-300 hover:text-white' : 'hover:bg-gray-100/70 text-gray-700 hover:text-gray-900'
          ]"
        >
          <svg class="w-4 h-4 text-zinc-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
          <span>New Project</span>
        </div>

        <!-- Quick Start -->
        <div
          @click="handleQuickStart"
          :class="[
            'flex items-center gap-2 px-2.5 py-1.5 rounded-xl cursor-pointer text-xs transition-colors',
            isDark ? 'hover:bg-white/10 text-zinc-300 hover:text-white' : 'hover:bg-gray-100/70 text-gray-700 hover:text-gray-900'
          ]"
        >
          <svg class="w-4 h-4 text-zinc-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M14 11l3 3m0 0l-3 3m3-3H9" />
          </svg>
          <span>Quick Start</span>
        </div>
      </div>

      <!-- Divider 2 -->
      <div :class="['h-px my-1 mx-1', isDark ? 'bg-white/10' : 'bg-gray-100']"></div>

      <!-- 3. No Project -->
      <div class="px-0.5">
        <div
          @click="handleSelectNoProject"
          :class="[
            'flex items-center gap-2 px-2.5 py-1.5 rounded-xl cursor-pointer text-xs transition-colors',
            !selectedWorkspaceId
              ? (isDark ? 'bg-cyan-500/15 text-cyan-300 font-medium border border-cyan-500/30' : 'bg-gray-100 text-gray-900 font-medium')
              : (isDark ? 'hover:bg-white/10 text-zinc-300 hover:text-white' : 'hover:bg-gray-100/70 text-gray-700 hover:text-gray-900')
          ]"
        >
          <svg class="w-4 h-4 text-zinc-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
          </svg>
          <span>No Project</span>
        </div>
      </div>
    </div>
  </div>
</template>
