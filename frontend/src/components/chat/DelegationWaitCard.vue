<script setup lang="ts">
import { computed } from 'vue';
import type { PromptCardData } from '../../types/chat';
import { CARD_SHELL_CLASS, CARD_BODY_CLASS, cardToneClass, type CardTone } from '../../utils/cardUi';
import CardHeader from './CardHeader.vue';

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

/** header 状态点语义色（与其余三类卡片同一套 CardTone） */
const headerTone = computed<CardTone>(() => {
  if (isPending.value) return 'pending';
  if (resolvedStatus.value === 'success') return 'approved';
  if (resolvedStatus.value === 'cancelled') return 'unknown';
  return 'rejected';
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
  <div :class="[CARD_SHELL_CLASS, isDark ? 'bg-[#151b26] border-gray-800' : 'bg-white border-gray-200/90']">
    <div :class="CARD_BODY_CLASS">
      <!-- 1. 统一 header：状态点 + 类型标签 + 标题 -->
      <CardHeader
        :tone="headerTone"
        type-label="子代理委派"
        :title="props.promptCard.title || '子代理'"
        :is-dark="isDark"
      />

      <!-- 2. 委派任务正文 -->
      <div
        v-if="props.promptCard.content"
        :class="[
          'rounded-xl border px-3 py-2.5 text-xs leading-relaxed break-all select-text',
          isDark ? 'bg-[#0e131d] border-gray-800 text-gray-300' : 'bg-[#f7f8fa] border-gray-200/80 text-gray-700'
        ]"
      >
        {{ props.promptCard.content }}
      </div>

      <!-- 3. 状态说明（二级信息，统一对比度） -->
      <div
        :class="['flex items-center gap-2 py-2 px-3 rounded-xl text-xs font-medium select-none', cardToneClass(headerTone, isDark)]"
      >
        <svg v-if="isPending" class="w-3.5 h-3.5 flex-shrink-0 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <svg v-else-if="resolvedStatus === 'success'" class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        <svg v-else-if="resolvedStatus === 'cancelled'" class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
        <svg v-else class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>{{ statusText }}</span>
      </div>
    </div>
  </div>
</template>
