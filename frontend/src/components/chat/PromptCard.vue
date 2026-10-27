<script setup lang="ts">
import { computed } from 'vue';
import type { PromptCardData } from '../../types/chat';
import { CARD_SHELL_CLASS } from '../../utils/cardUi';
import PlanCard from './PlanCard.vue';
import RequireChoiceCard from './RequireChoiceCard.vue';
import ApprovalCard from './ApprovalCard.vue';
import { useI18n } from '../../i18n';

const props = defineProps<{
  /** 统一卡片数据（历史与实时同一形状） */
  promptCard: PromptCardData;
  /** 卡片所属会话（缺省时在子卡片内回落到 promptCard.conversationId） */
  sessionId?: string | number;
  isDark?: boolean;
}>();

const { t } = useI18n();

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
      isDark ? 'bg-[#151b26] border-zinc-800 text-zinc-400' : 'bg-white border-zinc-200/90 text-zinc-500'
    ]"
  >
        {{ t('chat.prompt.unavailable') }}
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
