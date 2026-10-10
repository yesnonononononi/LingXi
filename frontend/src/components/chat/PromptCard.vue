<script setup lang="ts">
import { computed } from 'vue';
import type { PromptCardData } from '../../types/chat';
import { CARD_SHELL_CLASS } from '../../utils/cardUi';
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

/** 渲染分派依据：content.kind（唯一判别字段）；缺失/非法降级为 UNAVAILABLE */
const kind = computed(() => props.promptCard.kind);
/** tool_call 缺行 / content 解析失败 / kind 非法时的诚实降级 */
const isUnavailable = computed(() => props.promptCard.unavailable === true || kind.value === 'UNAVAILABLE');
</script>

<template>
  <div
    v-if="isUnavailable"
    :class="[
      CARD_SHELL_CLASS,
      'p-4 text-xs leading-relaxed',
      isDark ? 'bg-[#151b26] border-gray-800 text-gray-400' : 'bg-white border-gray-200/90 text-gray-500'
    ]"
  >
    卡片状态不可用（工具调用数据缺失、解析失败或形态不可识别），已保留消息记录。
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

  <!-- 只有明确 kind==='COMMAND' 才渲染命令审批卡；绝不用 v-else 回落，避免语义未知的卡片被当成命令审批 -->
  <ApprovalCard
    v-else-if="kind === 'COMMAND'"
    :prompt-card="promptCard"
    :session-id="sessionId"
    :is-dark="isDark"
  />
</template>
