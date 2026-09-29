<script setup lang="ts">
import { computed } from 'vue';
import type { PromptCardData } from '../../types/chat';
import PlanCard from './PlanCard.vue';
import RequireChoiceCard from './RequireChoiceCard.vue';
import ApprovalCard from './ApprovalCard.vue';

const props = defineProps<{
  /** 统一卡片数据（历史与实时同一形状） */
  promptCard: PromptCardData;
  /** 卡片所属会话（缺省时在子卡片内回落到 promptCard.conversationId） */
  sessionId?: string | number;
  isDark?: boolean;
}>();

/** 渲染分派依据：content.kind（唯一判别字段） */
const kind = computed(() => props.promptCard.kind);
/** tool_call 缺行 / content 解析失败时的诚实降级 */
const isUnavailable = computed(() => props.promptCard.unavailable === true);
</script>

<template>
  <div
    v-if="isUnavailable"
    :class="[
      'w-full rounded-2xl border my-3 p-4 text-xs leading-relaxed',
      isDark ? 'bg-[#151b26] border-gray-800 text-gray-400' : 'bg-white border-gray-200/90 text-gray-500'
    ]"
  >
    卡片状态不可用（工具调用数据缺失或解析失败），已保留消息记录。
  </div>

  <PlanCard
    v-else-if="kind === 'PLAN'"
    :prompt-card="promptCard"
    :session-id="sessionId"
    :is-dark="isDark"
  />

  <RequireChoiceCard
    v-else-if="kind === 'CHOICE'"
    :prompt-card="promptCard"
    :session-id="sessionId"
    :is-dark="isDark"
  />

  <ApprovalCard
    v-else
    :prompt-card="promptCard"
    :session-id="sessionId"
    :is-dark="isDark"
  />
</template>
