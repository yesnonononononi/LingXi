<script setup lang="ts">
import { ref, computed, inject } from 'vue';
import type { PromptCardData } from '../../types/chat';
import { useChatInputFocus } from '../../composables/useChatInputFocus';
import MarkdownRenderer from './MarkdownRenderer.vue';

const props = defineProps<{
  /** 统一卡片数据（PLAN 计划审批） */
  promptCard: PromptCardData;
  /** 卡片所属会话；审批接口据此定位生效计划书（缺省时回落到 promptCard.conversationId） */
  sessionId?: string | number;
  isDark?: boolean;
}>();

/**
 * 由视图层注入的流式决策：提交决策后消费恢复执行的事件流并渲染成新的消息气泡。
 * 缺省（组件树外独立使用本卡片时）降级为不可提交，仅提示。
 */
const decideToolCall = inject<((payload: {
  conversationId: string;
  toolCallId: string;
  approved: boolean;
  text?: string;
}) => Promise<boolean>) | null>('decideToolCall', null);

/**
 * 「去聊天里说」：聚焦聊天输入框的能力，由 ChatView 通过 CHAT_INPUT_FOCUS_KEY 类型化注入。
 * 无 provider 时为 null，按钮不渲染（杜绝「点了没反应的死按钮」）。
 * 不再使用 window.dispatchEvent('focus-chat-input')（死事件）与全局 querySelector（审计 G8）。
 */
const focusChatInput = useChatInputFocus();
const goToChatInput = () => {
  focusChatInput?.();
};

const isSubmitting = ref(false);
const errorMsg = ref('');
const isAddingTip = ref(false);
const tipText = ref('');

/** 是否仍在等待用户审批：以后端下发的 pending 为准（唯一可审批判定） */
const isPending = computed(() => props.promptCard.pending === true);

/** 计划书正文：Markdown 正文 */
const planBody = computed(() => props.promptCard.content || '');
const planTitle = computed(() => props.promptCard.title || '任务计划');

/** 结论：raw_output.outcome（APPROVED / REJECTED / ...） */
const outcome = computed(() => String(props.promptCard.outcome ?? '').trim().toUpperCase());

const statusTone = computed<'approved' | 'rejected' | 'pending' | 'unknown'>(() => {
  if (outcome.value === 'APPROVED') return 'approved';
  if (outcome.value === 'REJECTED') return 'rejected';
  if (isPending.value) return 'pending';
  // 契约 §3：结论缺失/无法识别 = 状态未知，不得默认成功。
  return 'unknown';
});

const statusLabel = computed(() => {
  if (outcome.value === 'APPROVED') return '已批准';
  if (outcome.value === 'REJECTED') return '已否决';
  if (isPending.value) return '计划待审';
  return '状态未知';
});

/** 任务进度（批准后由 promptCard.tasks 驱动；缺失时不展示） */
const totalTasks = computed(() => props.promptCard.tasks?.length || 0);
const doneTasks = computed(() =>
  (props.promptCard.tasks || []).filter(t => String(t.status).trim().toUpperCase() === 'DONE').length
);

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
    // 流式审批：决策落库即 resolve（true），恢复执行的事件流由宿主继续渲染到消息列表
    const accepted = await decideToolCall({
      conversationId: String(conversationId),
      toolCallId: String(toolCallId),
      approved,
      text: tipText.value.trim()
    });
    if (!accepted) {
      errorMsg.value = approved ? '批准计划失败，请重试' : '否决计划失败，请重试';
      return;
    }

    // 结论由 outcome 表达，status 收敛为终态 completed
    props.promptCard.pending = false;
    props.promptCard.status = 'completed';
    props.promptCard.outcome = approved ? 'APPROVED' : 'REJECTED';
  } catch (err: any) {
    errorMsg.value = err?.message || (approved ? '批准计划失败，请重试' : '否决计划失败，请重试');
  } finally {
    isSubmitting.value = false;
  }
};
</script>

<template>
  <div :class="['w-full rounded-2xl border transition-all my-3 p-6 shadow-xs', isDark ? 'bg-[#161b26] border-gray-800' : 'bg-white border-gray-200/90']">

    <!-- 1. 顶部标题与状态指示徽标 -->
    <div class="flex items-center justify-between select-none">
      <div class="flex items-center gap-2.5 min-w-0">
        <span
          :class="[
            'w-2 h-2 rounded-full flex-shrink-0',
            statusTone === 'approved' ? 'bg-emerald-500' :
            statusTone === 'rejected' ? 'bg-red-500' :
            statusTone === 'pending' ? 'bg-amber-400 animate-pulse' : 'bg-gray-400'
          ]"
        ></span>
        <h4 class="font-medium text-sm text-gray-800 dark:text-gray-100 truncate">
          {{ planTitle }}
        </h4>
        <span
          :class="[
            'text-xs font-semibold px-2 py-0.5 rounded-full',
            statusTone === 'approved' ? 'bg-emerald-500/10 text-emerald-500' :
            statusTone === 'rejected' ? 'bg-red-500/10 text-red-500' :
            statusTone === 'pending' ? 'bg-amber-400/10 text-amber-500' : 'bg-gray-500/10 text-gray-400'
          ]"
        >
          {{ statusLabel }}
        </span>
      </div>

      <!-- 进度指示 (批准并铺开检查点后才有) -->
      <span v-if="totalTasks" class="text-xs text-gray-400 font-mono flex-shrink-0">
        进度: {{ doneTasks }} / {{ totalTasks }}
      </span>
    </div>

    <!-- 2. 计划书正文（统一走 Markdown 渲染器） -->
    <div class="text-[13.5px] leading-relaxed mt-4">
      <MarkdownRenderer
        v-if="planBody"
        :content="planBody"
        :is-dark="isDark"
      />
    </div>

    <!-- 3. 增加 Tip 输入区 (可折叠展示) -->
    <div
      v-if="isPending && isAddingTip"
      class="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800/80 transition-all duration-200"
    >
      <div class="flex items-center justify-between mb-1.5 text-xs text-gray-500 dark:text-gray-400">
        <div class="flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          <span class="font-medium text-gray-700 dark:text-gray-300">补充 Tip / 修改建议</span>
        </div>
        <button
          type="button"
          @click="isAddingTip = false"
          class="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
        >
          收起
        </button>
      </div>
      <textarea
        v-model="tipText"
        rows="2"
        placeholder="输入补充建议、指导意见或调整要求（选填，点批准或否决时会自动带上）..."
        :class="[
          'w-full text-xs sm:text-sm px-3 py-2 rounded-xl border outline-none transition resize-none',
          isDark
            ? 'bg-[#1a2130] border-gray-700 text-gray-200 placeholder-gray-500 focus:border-blue-500'
            : 'bg-gray-50 border-gray-200 text-gray-800 placeholder-gray-400 focus:border-blue-500'
        ]"
      ></textarea>
    </div>

    <!-- 错误反馈提示 -->
    <div v-if="errorMsg" class="mt-3 text-xs text-red-400">
      {{ errorMsg }}
    </div>

    <!-- 4. 底部操作栏 -->
    <div class="mt-6 pt-3 flex items-center justify-between gap-3 select-none flex-wrap">

      <!-- 左侧：去聊天里说（聚焦聊天输入框）。能力由 ChatView 类型化注入；无 provider 时不渲染，避免死按钮。 -->
      <button
        v-if="isPending && focusChatInput"
        type="button"
        @click="goToChatInput"
        :class="[
          'text-xs sm:text-sm font-normal transition flex items-center gap-1.5 cursor-pointer',
          isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-600 hover:text-gray-900'
        ]"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
        <span>去聊天里说</span>
      </button>
      <div v-else></div>

      <!-- 待审状态下的决策按钮组 -->
      <div v-if="isPending" class="flex items-center gap-2.5">
        <!-- 增加 Tip 按钮 -->
        <button
          type="button"
          @click="toggleTipInput"
          :class="[
            'px-3.5 py-1.5 rounded-xl border text-xs sm:text-sm font-normal transition cursor-pointer flex items-center gap-1.5',
            isAddingTip
              ? (isDark ? 'border-amber-500/50 bg-amber-500/10 text-amber-400' : 'border-amber-400 bg-amber-50 text-amber-700')
              : (isDark ? 'border-gray-700 text-gray-300 hover:bg-gray-800' : 'border-gray-200 text-gray-700 hover:bg-gray-50')
          ]"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <span>{{ isAddingTip ? '收起Tip' : '增加tip' }}</span>
        </button>

        <!-- 否决按钮 -->
        <button
          type="button"
          @click="decide(false)"
          :disabled="isSubmitting"
          :class="[
            'px-4 py-1.5 rounded-xl border text-xs sm:text-sm font-normal transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5',
            isDark
              ? 'border-red-900/60 text-red-400 hover:bg-red-950/40 hover:border-red-800'
              : 'border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300'
          ]"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
          <span>否决</span>
        </button>

        <!-- 批准按钮 -->
        <button
          type="button"
          @click="decide(true)"
          :disabled="isSubmitting"
          :class="[
            'px-5 py-1.5 rounded-xl text-xs sm:text-sm font-medium transition cursor-pointer shadow-xs flex items-center gap-1.5 disabled:opacity-50',
            isDark
              ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
              : 'bg-emerald-600 hover:bg-emerald-700 text-white'
          ]"
        >
          <svg v-if="isSubmitting" class="w-3.5 h-3.5 animate-spin mr-1" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <svg v-else class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <span>批准</span>
        </button>
      </div>

      <!-- 已决断状态提示 -->
      <div
        v-else
        class="text-xs px-3 py-1.5 rounded-xl font-medium"
        :class="statusTone === 'approved' ? 'bg-emerald-500/10 text-emerald-500' : statusTone === 'rejected' ? 'bg-red-500/10 text-red-400' : 'bg-gray-500/10 text-gray-400'"
      >
        {{ statusTone === 'approved' ? '✓ 计划已批准，正在实施' : statusTone === 'rejected' ? '✕ 计划已被否决' : '状态未知' }}
      </div>

    </div>

  </div>
</template>
