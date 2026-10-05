<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { WorkspaceRequest, WorkspaceEnvType } from '../../types/chat';
import { UserConfigAPI } from '../../services/api';
import { extractDirName } from '../../utils/path';
import { isElectron, openDirectoryPicker } from '../../utils/platform';
import { useTheme } from '../../composables/useTheme';

const props = defineProps<{
  isOpen: boolean;
  isDark?: boolean;
}>();

const { isDark: themeIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? themeIsDark.value);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', data: WorkspaceRequest): void;
}>();

// 契约 §5：环境类型取值为后端 WorkspaceType 枚举名（SAND_BOX / LOCAL / NONE），非小写 sandbox。
const envType = ref<WorkspaceEnvType>('SAND_BOX');
const pathInput = ref('');
const errorMsg = ref('');
const showManualInput = ref(false);

const detectedProjectName = computed(() => {
  const trimmed = pathInput.value.trim();
  return extractDirName(trimmed) || (trimmed ? '未命名项目' : '');
});

const loadEnvType = async () => {
  envType.value = await UserConfigAPI.currentWorkspaceType();
};

const pickFolder = async () => {
  errorMsg.value = '';
  if (isElectron()) {
    const selected = await openDirectoryPicker();
    if (selected) {
      pathInput.value = selected;
    }
    return;
  }

  try {
    const dirHandle = await window.showDirectoryPicker?.();
    if (dirHandle?.name) {
      pathInput.value = dirHandle.name;
    }
  } catch {
    // 用户取消或无权限
  }
};

const handleDrop = (e: DragEvent) => {
  e.preventDefault();
  errorMsg.value = '';
  const items = e.dataTransfer?.items;
  if (items && items.length > 0) {
    const item = items[0] as DataTransferItemWithEntry;
    const entry = item.webkitGetAsEntry?.();
    if (entry && entry.isDirectory) {
      pathInput.value = entry.name;
      return;
    }
  }
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    const filePath = (files[0] as FileWithPath).path;
    if (filePath) {
      pathInput.value = filePath;
      return;
    }
    pathInput.value = files[0].name;
  }
};

watch(
  () => props.isOpen,
  (open) => {
    if (!open) return;
    pathInput.value = '';
    errorMsg.value = '';
    showManualInput.value = false;
    loadEnvType();
  },
  { immediate: true }
);

const handleSave = () => {
  errorMsg.value = '';
  const trimmedPath = pathInput.value.trim();
  if (!trimmedPath) {
    errorMsg.value = '请先选择项目目录';
    return;
  }
  const folderName = extractDirName(trimmedPath);
  const finalName = folderName || '工作空间';

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
    class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-150"
    @click.self="emit('close')"
  >
    <div
      :class="[
        'w-full max-w-md rounded-2xl border p-6 transition-all shadow-2xl',
        isDark
          ? 'bg-black/95 border-white/20 text-zinc-100 shadow-[0_12px_48px_rgba(0,0,0,0.95)] backdrop-blur-2xl'
          : 'bg-white border-zinc-200 text-zinc-800'
      ]"
    >
      <!-- 头部：标题与关闭按钮 -->
      <div class="flex items-center justify-between pb-3 border-b" :class="isDark ? 'border-white/10' : 'border-zinc-200/80'">
        <h3 class="text-base font-semibold flex items-center gap-2.5">
          <svg
            class="w-5 h-5 transition-transform"
            :class="isDark ? 'text-white drop-shadow-[0_0_8px_rgba(255,255,255,0.6)]' : 'text-zinc-700'"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span :class="isDark ? 'text-white text-glow-white tracking-wide' : 'text-zinc-900'">新建项目 (New Project)</span>
        </h3>
        <button
          @click="emit('close')"
          class="p-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- 内容区 -->
      <div class="mt-4 space-y-4 text-sm">
        <div v-if="errorMsg" class="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
          {{ errorMsg }}
        </div>

        <!-- 交互主区：未选择目录时的大选择卡片 -->
        <div v-if="!pathInput">
          <button
            type="button"
            @click="pickFolder"
            @dragover.prevent
            @drop="handleDrop"
            class="w-full flex flex-col items-center justify-center p-7 rounded-2xl border border-dashed transition-all duration-200 group cursor-pointer"
            :class="isDark
              ? 'bg-zinc-950/60 border-white/20 hover:border-white/50 hover:bg-white/[0.04] hover:shadow-[0_0_24px_rgba(255,255,255,0.08)]'
              : 'bg-zinc-50 border-zinc-300 hover:border-zinc-400 hover:bg-zinc-100'"
          >
            <div
              class="w-13 h-13 rounded-2xl flex items-center justify-center mb-3 transition-transform group-hover:scale-105"
              :class="isDark
                ? 'bg-white/10 text-white border border-white/20 shadow-[0_0_16px_rgba(255,255,255,0.2)]'
                : 'bg-zinc-200 text-zinc-800 border border-zinc-300'"
            >
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <span
              class="text-sm font-medium transition"
              :class="isDark ? 'text-white text-glow-white' : 'text-zinc-900'"
            >
              点击选择本地项目目录
            </span>
            <span class="mt-1 text-xs text-zinc-400">
              自动识别项目名称，无需手动输入路径
            </span>
          </button>
        </div>

        <!-- 交互主区：已选择目录时的信息卡片 -->
        <div v-else>
          <div
            class="p-4 rounded-2xl border transition-all"
            :class="isDark ? 'bg-zinc-950/80 border-white/20 shadow-[0_0_20px_rgba(255,255,255,0.05)]' : 'bg-zinc-50 border-zinc-200'"
          >
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-3 overflow-hidden min-w-0">
                <div
                  class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border"
                  :class="isDark ? 'bg-white/10 border-white/20 text-white shadow-[0_0_12px_rgba(255,255,255,0.2)]' : 'bg-zinc-200 border-zinc-300 text-zinc-800'"
                >
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                </div>
                <div class="truncate min-w-0">
                  <div class="text-[11px] text-zinc-400">已识别项目名称</div>
                  <div class="font-semibold text-sm truncate mt-0.5" :class="isDark ? 'text-white text-glow-white' : 'text-zinc-900'">
                    {{ detectedProjectName }}
                  </div>
                  <div class="text-[11px] truncate font-mono text-zinc-400 mt-0.5" :title="pathInput">
                    {{ pathInput }}
                  </div>
                </div>
              </div>
              <button
                type="button"
                @click="pickFolder"
                class="px-2.5 py-1.5 text-xs rounded-xl border shrink-0 transition cursor-pointer"
                :class="isDark ? 'border-white/20 text-zinc-300 hover:text-white hover:bg-white/10' : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100'"
              >
                更换
              </button>
            </div>
          </div>
        </div>

        <!-- 高级折叠项：手动微调或输入路径 -->
        <div class="pt-1">
          <button
            type="button"
            @click="showManualInput = !showManualInput"
            class="text-xs text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1 transition cursor-pointer"
          >
            <span>{{ showManualInput ? '收起路径微调' : '高级：手动调整路径' }}</span>
            <svg
              class="w-3.5 h-3.5 transition-transform duration-200"
              :class="showManualInput ? 'rotate-180' : ''"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
          </button>
          <div v-if="showManualInput" class="mt-2 space-y-1">
            <input
              v-model="pathInput"
              @keyup.enter="handleSave"
              placeholder="例如: D:/Code/my-project 或 /workspace"
              :class="[
                'w-full px-3 py-2 rounded-xl border text-xs font-mono outline-none transition',
                isDark
                  ? 'bg-black/90 border-white/20 focus:border-white text-white placeholder-zinc-600'
                  : 'bg-zinc-50 border-zinc-300 focus:border-zinc-500 text-zinc-900 placeholder-zinc-400'
              ]"
            />
          </div>
        </div>
      </div>

      <!-- 底部操作按钮 -->
      <div class="mt-6 flex items-center justify-end pt-3 border-t" :class="isDark ? 'border-white/10' : 'border-zinc-200/80'">
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="emit('close')"
            :class="[
              'px-4 py-1.5 text-xs rounded-xl border transition cursor-pointer',
              isDark ? 'border-white/15 text-zinc-300 hover:bg-white/5' : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100'
            ]"
          >
            取消
          </button>
          <button
            type="button"
            @click="handleSave"
            :disabled="!pathInput.trim()"
            class="px-4 py-1.5 text-xs rounded-xl font-medium transition cursor-pointer"
            :class="[
              isDark
                ? 'bg-white text-black hover:bg-zinc-200 shadow-[0_0_20px_rgba(255,255,255,0.3)] disabled:opacity-30 disabled:pointer-events-none disabled:shadow-none'
                : 'bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-40 disabled:pointer-events-none'
            ]"
          >
            创建项目
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
