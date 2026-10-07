<script setup lang="ts">
import { ref, computed, inject } from 'vue';
import type { PromptCardData } from '../../types/chat';
import { DECIDE_TOOL_CALL_KEY } from '../../types/toolDecision';
import { useChatInputFocus } from '../../composables/useChatInputFocus';
import { CARD_SHELL_CLASS, CARD_BODY_CLASS, CARD_ERROR_TEXT_CLASS, cardToneClass, type CardTone } from '../../utils/cardUi';
import { canDecideCard } from '../../utils/toolCallCard';
import CardHeader from './CardHeader.vue';
import CardActionButton from './CardActionButton.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';

const props = defineProps<{
  /** 统一卡片数据（PLAN 计划审批） */
  promptCard: PromptCardData;
  /** 卡片所属会话；审批接口据此定位生效计划书（缺省时回落到 promptCard.conversationId） */
  sessionId?: string | number;
  isDark?: boolean;
}>();

/**
 * 由视图层注入的决策提交：走 JSON 回执，**不再消费请求级流**。
 * 恢复期的实时内容由会话级 v3 流渲染；本回调只负责提交并回执结果。
 * 缺省（组件树外独立使用本卡片时）降级为不可提交，仅提示。
 */
const decideToolCall = inject(DECIDE_TOOL_CALL_KEY, null);

/**
 * 「去聊天里说」：聚焦聊天输入框的能力，由 ChatView 通过 CHAT_INPUT_FOCUS_KEY 类型化注入。
 * 无 provider 时为 null，按钮不渲染（杜绝「点了没反应的死按钮」）。
 */
const focusChatInput = useChatInputFocus();
const goToChatInput = () => {
  focusChatInput?.();
};

const isSubmitting = ref(false);
const errorMsg = ref('');
const isAddingTip = ref(false);
const tipText = ref('');

/**
 * 是否可操作：**叠加权威 `pending`**（= type==='PROMISE' && status==='pending'），
 * 再要求后端动作集合含 APPROVE。只判 allowedActions 会被「已决但残留动作」的脏数据骗过，
 * 从而在已决卡上渲染出可点按钮。
 */
const isPending = computed(() => canDecideCard(props.promptCard, 'APPROVE'));

/** 计划书正文：Markdown 正文 */
const planBody = computed(() => props.promptCard.content || '');
const planTitle = computed(() => props.promptCard.title || '任务计划');

/** 结论：raw_output.outcome（APPROVED / REJECTED / ...） */
const outcome = computed(() => String(props.promptCard.outcome ?? '').trim().toUpperCase());

const statusTone = computed<CardTone>(() => {
  if (outcome.value === 'APPROVED') return 'approved';
  if (outcome.value === 'REJECTED') return 'rejected';
  if (isPending.value) return 'pending';
  // 契约 §3：结论缺失/无法识别 = 状态未知，不得默认成功。
  return 'unknown';
});

const statusLabel = computed(() => {
  if (outcome.value === 'APPROVED') return '✓ 计划已批准，正在实施';
  if (outcome.value === 'REJECTED') return '✕ 计划已被否决';
  if (isPending.value) return '计划待审';
  if (props.promptCard.status === 'preparing') return '准备中';
  if (props.promptCard.status === 'in_progress') return '处理中';
  if (props.promptCard.status === 'pending') return props.promptCard.unavailableReason || '正在同步状态';
  return '状态未知';
});

const toggleTipInput = () => {
  isAddingTip.value = !isAddingTip.value;
};

/** 提交审批决定；后端负责恢复 loop，这里只负责调用与就地更新卡片 */
const decide = async (approved: boolean) => {
  if (isSubmitting.value || !isPending.value) return;

  const conversationId = props.promptCard.conversationId
    ?? (props.sessionId != null && props.sessionId !== '' ? String(props.sessionId) : '');
  if (!conversationId) {
    errorMsg.value = '计划书缺少所属会话，无法提交审批';
    return;
  }

  // 决策锚点是 toolCallId：历史卡片由 TOOL 行 toolCall 提供、实时卡片由 CARD_PENDING 拉取，
  // 两条路径都落在同一个字段上。
  const toolCallId = props.promptCard.toolCallId;
  if (!toolCallId) {
    errorMsg.value = '计划书缺少互动状态ID，无法提交审批';
    return;
  }
  if (!decideToolCall) {
    errorMsg.value = '当前视图未接入事件流，无法提交审批';
    return;
  }

  isSubmitting.value = true;
  errorMsg.value = '';
  try {
    await decideToolCall({
      conversationId: String(conversationId),
      toolCallId: String(toolCallId),
      action: approved ? 'APPROVE' : 'REJECT',
      text: tipText.value.trim(),
      expectedVersion: props.promptCard.version ?? null
    });
  } catch (err: any) {
    errorMsg.value = err?.message || (approved ? '批准计划失败，请重试' : '拒绝计划失败，请重试');
  } finally {
    isSubmitting.value = false;
  }
};
</script>

<template>
  <div :class="[CARD_SHELL_CLASS, isDark ? 'bg-[#161b26] border-gray-800' : 'bg-white border-gray-200/90']">
    <div :class="CARD_BODY_CLASS">

      <!-- 1. 统一 header：状态点 + 类型标签 + 标题 -->
      <CardHeader :tone="statusTone" type-label="计划" :title="planTitle" :is-dark="isDark" />

      <!-- 2. 计划书正文（Markdown；长文限高可滚动） -->
      <div
        v-if="planBody"
        class="text-[13.5px] leading-relaxed max-h-[420px] overflow-y-auto scrollbar-thin pr-1"
      >
        <MarkdownRenderer :content="planBody" :is-dark="isDark" />
      </div>

      <!-- 3. 补充 Tip 输入区（可折叠） -->
      <div
        v-if="isPending && isAddingTip"
        class="pt-3 border-t border-gray-100 dark:border-gray-800/80"
      >
        <div class="flex items-center justify-between mb-1.5 text-xs text-gray-500 dark:text-gray-400">
          <div class="flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <span class="font-medium text-gray-700 dark:text-gray-300">补充 Tip / 修改建议</span>
          </div>
          <button
            type="button"
            @click="isAddingTip = false"
            class="text-[11px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/50"
          >
            收起
          </button>
        </div>
        <textarea
          v-model="tipText"
          rows="2"
          placeholder="输入补充建议、指导意见或调整要求（选填，点批准或拒绝时会自动带上）..."
          :class="[
            'w-full text-xs sm:text-sm px-3 py-2 rounded-xl border outline-none transition resize-none',
            isDark
              ? 'bg-[#1a2130] border-gray-700 text-gray-200 placeholder-gray-500 focus:border-blue-500'
              : 'bg-gray-50 border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'
          ]"
        ></textarea>
      </div>

      <!-- 错误反馈 -->
      <div v-if="errorMsg" :class="['text-xs', CARD_ERROR_TEXT_CLASS]">
        {{ errorMsg }}
      </div>

      <!-- 4. 底部操作栏 -->
      <div class="pt-3 border-t border-gray-100 dark:border-gray-800/80 flex items-center justify-between gap-3 select-none flex-wrap">

        <!-- 左：去聊天里说（无 provider 时不渲染，避免死按钮） -->
        <button
          v-if="isPending && focusChatInput"
          type="button"
          @click="goToChatInput"
          :class="[
            'text-xs sm:text-sm font-normal transition flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/50',
            isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-600 hover:text-gray-900'
          ]"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
          <span>去聊天里说</span>
        </button>
        <div v-else></div>

        <!-- 待审：决策按钮组 -->
        <div v-if="isPending" class="flex items-center gap-2.5">
          <button
            type="button"
            @click="toggleTipInput"
            :class="[
              'px-3.5 py-1.5 rounded-xl border text-xs sm:text-sm font-normal transition cursor-pointer flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/50',
              isAddingTip
                ? (isDark ? 'border-amber-500/50 bg-amber-500/10 text-amber-400' : 'border-amber-400 bg-amber-50 text-amber-700')
                : (isDark ? 'border-gray-700 text-gray-300 hover:bg-gray-800' : 'border-gray-200 text-gray-700 hover:bg-gray-50')
            ]"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            <span>{{ isAddingTip ? '收起 Tip' : '增加 Tip' }}</span>
          </button>

          <CardActionButton
            tone="danger"
            variant="outline"
            :disabled="isSubmitting"
            :is-dark="isDark"
            @click="decide(false)"
          >
            <template #icon>
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </template>
            拒绝执行
          </CardActionButton>

          <CardActionButton
            tone="emerald"
            :loading="isSubmitting"
            :is-dark="isDark"
            @click="decide(true)"
          >
            <template #icon>
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </template>
            批准
          </CardActionButton>
        </div>

        <!-- 已决：状态横幅（二级信息） -->
        <div
          v-else
          :class="['text-xs px-3 py-1.5 rounded-xl font-medium', cardToneClass(statusTone, isDark)]"
        >
          {{ statusLabel }}
        </div>

      </div>
    </div>
  </div>
</template>
