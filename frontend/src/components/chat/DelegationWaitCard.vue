<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PromptCardData } from '../../types/chat';
import { CARD_SHELL_CLASS, CARD_BODY_CLASS, cardToneClass, type CardTone } from '../../utils/cardUi';
import CardHeader from './CardHeader.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';

/** 审批由子会话处理；父会话保留委派任务和终态结果，不重复提醒。 */
const props = defineProps<{
  /** 统一卡片数据（DELEGATION 委派等待） */
  promptCard: PromptCardData;
  isDark?: boolean;
}>();

const isExpanded = ref(false);

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
      <button
        type="button"
        class="w-full text-left cursor-pointer rounded-lg focus-visible:outline-2 focus-visible:outline-blue-500"
        :aria-expanded="isExpanded"
        :aria-label="`${isExpanded ? '收起' : '展开'}委派任务：${props.promptCard.title || '子代理'}`"
        @click="isExpanded = !isExpanded"
      >
        <CardHeader
          :tone="headerTone"
          type-label="子代理委派"
          :title="props.promptCard.title || '子代理'"
          :is-dark="isDark"
        >
          <template #actions>
            <svg
              :class="['w-4 h-4 transition-transform', isExpanded ? 'rotate-90' : '', isDark ? 'text-gray-400' : 'text-gray-500']"
              fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </template>
        </CardHeader>
      </button>

      <!-- 2. 委派任务正文 -->
      <div
        v-if="isExpanded && props.promptCard.content"
        :class="[
          'rounded-xl border px-3 py-2.5 select-text',
          isDark ? 'bg-[#0e131d] border-gray-800 text-gray-300' : 'bg-[#f7f8fa] border-gray-200/80 text-gray-700'
        ]"
      >
        <MarkdownRenderer :content="props.promptCard.content" :is-dark="isDark" />
      </div>

      <!-- 3. 状态说明（二级信息，统一对比度） -->
      <div
        v-if="!isPending"
        :class="['flex items-center gap-2 py-2 px-3 rounded-xl text-xs font-medium select-none', cardToneClass(headerTone, isDark)]"
      >
        <svg v-if="resolvedStatus === 'success'" class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
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
