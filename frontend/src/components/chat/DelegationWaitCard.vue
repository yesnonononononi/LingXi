<script setup lang="ts">
import { computed } from 'vue';
import type { PromptCardData } from '../../types/chat';

/**
 * 委派等待卡（kind=DELEGATION）：父会话里「子代理已暂停、等待其会话内审批」的状态卡。
 *
 * <p><b>不是人工审批卡</b>：审批对象在子会话里（命令 / 计划 / 提问），本卡只呈现等待状态，
 * 不提供批准 / 拒绝按钮。子执行终态后由后端自动回填结果并恢复父执行，
 * 卡片随对账刷新为终态（成功 / 失败 / 已取消）。</p>
 */
const props = defineProps<{
  /** 统一卡片数据（DELEGATION 委派等待） */
  promptCard: PromptCardData;
  isDark?: boolean;
}>();

/** 是否仍等待子执行落定：以后端下发的 pending 为准 */
const isPending = computed(() => props.promptCard.pending === true);

/** 结论：raw_output.outcome（SUCCEEDED/FAILED/CANCELLED/...） */
const outcome = computed(() => String(props.promptCard.outcome ?? '').trim().toUpperCase());

const resolvedStatus = computed<'success' | 'failed' | 'cancelled' | null>(() => {
  if (isPending.value) return null;
  if (outcome.value === 'SUCCEEDED' || outcome.value === 'APPROVED') return 'success';
  if (outcome.value === 'CANCELLED') return 'cancelled';
  return 'failed';
});

const statusText = computed(() => {
  if (isPending.value) return '子代理已暂停，等待其会话内的人工审批';
  return resolvedStatus.value === 'success'
    ? '子代理已完成，结果已回填'
    : resolvedStatus.value === 'cancelled'
    ? '子代理执行已取消'
    : '子代理执行失败';
});
</script>

<template>
  <div
    :class="[
      'w-full rounded-2xl border transition-all my-2.5 overflow-hidden shadow-xs',
      isDark ? 'bg-[#151b26] border-gray-800' : 'bg-white border-gray-200/90'
    ]"
  >
    <div class="p-3.5 sm:p-4 space-y-2.5">
      <!-- 状态点 + 标题 -->
      <div class="flex items-center gap-2 select-none">
        <span
          :class="[
            'w-2 h-2 rounded-full flex-shrink-0',
            isPending
              ? 'bg-amber-400 animate-pulse'
              : resolvedStatus === 'success'
              ? 'bg-emerald-500'
              : resolvedStatus === 'cancelled'
              ? 'bg-gray-400'
              : 'bg-red-500'
          ]"
        ></span>
        <span :class="['text-xs font-semibold', isDark ? 'text-gray-200' : 'text-gray-800']">
          委派任务 · {{ props.promptCard.title || '子代理' }}
        </span>
      </div>

      <!-- 委派任务正文 -->
      <div
        v-if="props.promptCard.content"
        :class="[
          'rounded-xl border px-3 py-2.5 text-xs leading-relaxed break-all select-text',
          isDark ? 'bg-[#0e131d] border-gray-800 text-gray-300' : 'bg-[#f7f8fa] border-gray-200/80 text-gray-700'
        ]"
      >
        {{ props.promptCard.content }}
      </div>

      <!-- 状态说明 -->
      <div
        :class="[
          'flex items-center gap-2 py-2 px-3 rounded-xl text-xs font-medium select-none',
          isPending
            ? (isDark ? 'bg-amber-950/20 text-amber-400 border border-amber-900/40' : 'bg-amber-50 text-amber-700 border border-amber-200/60')
            : resolvedStatus === 'success'
            ? (isDark ? 'bg-emerald-950/30 text-emerald-400 border border-emerald-900/40' : 'bg-emerald-50 text-emerald-700 border border-emerald-200/60')
            : resolvedStatus === 'cancelled'
            ? (isDark ? 'bg-gray-800/40 text-gray-400 border border-gray-700/60' : 'bg-gray-50 text-gray-500 border border-gray-200')
            : (isDark ? 'bg-red-950/30 text-red-400 border border-red-900/40' : 'bg-red-50 text-red-700 border border-red-200/60')
        ]"
      >
        <svg v-if="isPending" class="w-3.5 h-3.5 flex-shrink-0 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <svg v-else-if="resolvedStatus === 'success'" class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        <svg v-else-if="resolvedStatus === 'cancelled'" class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
        <svg v-else class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>{{ statusText }}</span>
      </div>
    </div>
  </div>
</template>
