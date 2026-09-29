<script setup lang="ts">
import { ref, watch } from 'vue';
import type { WorkspaceRequest, WorkspaceEnvType } from '../../types/chat';
import { UserConfigAPI } from '../../services/api';
import { extractDirName } from '../../utils/path';

const props = defineProps<{
  isOpen: boolean;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', data: WorkspaceRequest): void;
}>();

// 契约 §5：环境类型取值为后端 WorkspaceType 枚举名（SAND_BOX / LOCAL / NONE），非小写 sandbox。
const envType = ref<WorkspaceEnvType>('SAND_BOX');
const pathInput = ref('');
const errorMsg = ref('');

const canPickFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const loadEnvType = async () => {
  envType.value = await UserConfigAPI.currentWorkspaceType();
};


const pickFolder = async () => {
  try {
    const dirHandle = await (window as any).showDirectoryPicker();
    if (dirHandle?.name) {
      if (!pathInput.value) {
        pathInput.value = dirHandle.name;
      }
    }
  } catch {
    // 用户取消或无权限
  }
};

watch(
  () => props.isOpen,
  (open) => {
    if (!open) return;
    pathInput.value = '';
    errorMsg.value = '';
    loadEnvType();
  },
  { immediate: true }
);

const handleSave = () => {
  errorMsg.value = '';
  const trimmedPath = pathInput.value.trim();
  if (!trimmedPath) {
    errorMsg.value = '请填写项目目录绝对路径';
    return;
  }
  const folderName = extractDirName(trimmedPath);
  const finalName =  folderName || '工作空间';

  emit('save', {
    name: finalName,
    hostDir: trimmedPath
  });
  emit('close');
};
</script>

<template>
  <div
    v-if="isOpen"
    class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-150"
    @click.self="emit('close')"
  >
    <div
      :class="[
        'w-full max-w-md rounded-2xl border shadow-2xl p-6 transition-all',
        isDark ? 'bg-[#182030] border-[#2b374f] text-gray-100' : 'bg-white border-gray-200 text-gray-800'
      ]"
    >
      <div class="flex items-center justify-between pb-3 border-b border-gray-200/50 dark:border-gray-700/50">
        <h3 class="text-base font-semibold flex items-center gap-2">
          <svg class="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span>新建项目 (New Project)</span>
        </h3>
        <button
          @click="emit('close')"
          class="p-1 rounded-lg text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="mt-4 space-y-4 text-sm">
        <div v-if="errorMsg" class="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-xs">
          {{ errorMsg }}
        </div>

        <div>
          <div class="flex items-center justify-between mb-1">
            <label class="block text-xs font-medium text-gray-700 dark:text-gray-300">
              项目目录路径 <span class="text-red-500">*</span>
            </label>
            <button
              v-if="canPickFolder"
              type="button"
              @click="pickFolder"
              class="text-[11px] text-blue-500 hover:text-blue-400 cursor-pointer flex items-center gap-1"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              <span>浏览文件夹</span>
            </button>
          </div>
          <input
            v-model="pathInput"
            @keyup.enter="handleSave"
            autoFocus
            placeholder="例如: D:/Code/my-project 或 /home/user/project"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-sm font-mono outline-none transition',
              isDark
                ? 'bg-[#101725] border-[#2b374f] focus:border-blue-500 text-white placeholder-gray-600'
                : 'bg-gray-50 border-gray-300 focus:border-blue-500 text-gray-900 placeholder-gray-400'
            ]"
          />
      
        </div>

      </div>

      <div class="mt-6 flex items-center justify-end pt-3 border-t border-gray-200/50 dark:border-gray-700/50">
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="emit('close')"
            :class="[
              'px-4 py-1.5 text-xs rounded-xl border transition cursor-pointer',
              isDark ? 'border-[#2b374f] text-gray-400 hover:bg-white/5' : 'border-gray-300 text-gray-600 hover:bg-gray-100'
            ]"
          >
            取消
          </button>
          <button
            type="button"
            @click="handleSave"
            class="px-4 py-1.5 text-xs rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium shadow-md transition cursor-pointer"
          >
            创建项目
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
