<script setup lang="ts">
import { useConfirm } from '../../../composables/useConfirm';

defineProps<{
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'clearSessions'): void;
}>();

const { confirm } = useConfirm();

const handleClearSessions = async () => {
  const ok = await confirm({
    title: '删除所有对话',
    content: '确定要清空全部会话吗？此操作无法撤销。',
    confirmText: '删除全部',
    cancelText: '取消',
    type: 'danger',
  });
  if (!ok) return;
  emit('clearSessions');
};
</script>

<template>
  <div class="space-y-4 text-xs">
    <!--
      原「数据用于优化体验 / 我共享的链接 / 导出所有历史对话」入口仅弹 window.alert 文案
      （数据开关也不落库、不生效），会让用户误以为功能存在，故隐藏。待后端/产品实现后再恢复。
    -->
    <div class="py-6 text-center text-gray-400 dark:text-gray-500">
      数据管理功能尚未开放
    </div>

    <!-- 删除所有对话：真实能力（清空全部会话），保留并带二次确认 -->
    <div class="h-px bg-gray-100 dark:bg-white/10"></div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-gray-800 dark:text-zinc-200 dark:text-glow-subtle">删除所有对话</span>
      <button
        type="button"
        @click="handleClearSessions"
        class="px-4 py-1 rounded-full border border-red-500/40 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/15 text-xs transition cursor-pointer"
      >
        删除
      </button>
    </div>
  </div>
</template>
