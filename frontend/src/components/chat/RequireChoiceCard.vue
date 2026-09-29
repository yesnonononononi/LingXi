<script setup lang="ts">
import { ref, computed, inject } from 'vue';
import type { PromptCardData } from '../../types/chat';

const props = defineProps<{
  /** 统一卡片数据（CHOICE 澄清提问） */
  promptCard: PromptCardData;
  /** 卡片所属会话；决策接口据此定位（缺省时回落到 promptCard.conversationId） */
  sessionId?: string | number;
  isDark?: boolean;
}>();

/**
 * 由视图层注入的流式决策：提交回答后消费恢复执行的事件流并渲染成新的消息气泡。
 * 缺省（组件树外独立使用本卡片时）降级为不可提交，仅提示。
 * 与 PlanCard 复用同一个宿主能力——require_choice 与 plan 走同一条恢复链路。
 */
const decideToolCall = inject<((payload: {
  conversationId: string;
  toolCallId: string;
  approved: boolean;
  text?: string;
}) => Promise<boolean>) | null>('decideToolCall', null);

/** 是否最小化/折叠 */
const isCollapsed = ref(false);
const isDismissed = ref(false);

// 选项与输入状态
const selectedIndex = ref<number | null>(null);
const customInput = ref('');
const isCustomSelected = ref(false);
const isSubmitting = ref(false);
const errorMsg = ref('');

const questionText = computed(() => props.promptCard.content || props.promptCard.title || '需要您的进一步确认：');

/** 候选项：后端 options 为空数组时只保留自由输入，不伪造“方案 N”占位 */
const options = computed<string[]>(() =>
  (props.promptCard.options || []).map(item => String(item ?? '').trim()).filter(Boolean)
);

/** 是否仍待决策：以后端下发的 pending 为准（唯一可审批判定） */
const isPending = computed(() => props.promptCard.pending === true);
const isResolved = computed(() => !isPending.value);
const resolvedAnswer = computed(() => props.promptCard.answer || '');

/** 结论：raw_output.outcome（ANSWERED / ...）；缺失 = 状态未知，不得默认成功 */
const outcome = computed(() => String(props.promptCard.outcome ?? '').trim().toUpperCase());
const isUnknownOutcome = computed(() => isResolved.value && !outcome.value);

// 选择预设选项
const selectChoice = (idx: number) => {
  if (isResolved.value) return;
  selectedIndex.value = idx;
  isCustomSelected.value = false;
  errorMsg.value = '';
};

// 聚焦自定义输入框
const onCustomFocus = () => {
  if (isResolved.value) return;
  isCustomSelected.value = true;
  selectedIndex.value = null;
  errorMsg.value = '';
};

// 当前是否有有效选中
const canSubmit = computed(() => {
  if (isResolved.value || isSubmitting.value) return false;
  if (isCustomSelected.value) return customInput.value.trim().length > 0;
  return selectedIndex.value !== null;
});

/**
 * 提交选中的答案并恢复执行。
 *
 * 决策统一走 /tool-call/decide（approved=true）：对澄清提问而言「给出回答」即批准继续，
 * 用户想表达拒绝时直接自由输入即可。回答原文作为 text 落进上下文，结论记为 ANSWERED。
 */
const submit = async (answer: string) => {
  const conversationId = props.promptCard.conversationId
    ?? (props.sessionId != null && props.sessionId !== '' ? String(props.sessionId) : '');
  if (!conversationId) {
    errorMsg.value = '提问卡片缺少所属会话，无法提交回答';
    return;
  }
  // 决策锚点是 toolCallId：历史卡片由 TOOL 行 toolCall 提供、实时卡片由 CARD_PENDING 拉取。
  const toolCallId = props.promptCard.toolCallId;
  if (!toolCallId) {
    errorMsg.value = '提问卡片缺少互动状态ID，无法提交回答';
    return;
  }
  if (!decideToolCall) {
    errorMsg.value = '当前视图未接入事件流，无法提交回答';
    return;
  }

  isSubmitting.value = true;
  errorMsg.value = '';
  try {
    const accepted = await decideToolCall({
      conversationId: String(conversationId),
      toolCallId: String(toolCallId),
      approved: true,
      text: answer
    });
    if (!accepted) {
      errorMsg.value = '提交回答失败，请重试';
      return;
    }
    // 结论由 outcome 表达（ANSWERED），status 收敛为终态 completed
    props.promptCard.pending = false;
    props.promptCard.status = 'completed';
    props.promptCard.outcome = 'ANSWERED';
    props.promptCard.answer = answer;
  } catch (err: any) {
    errorMsg.value = err?.message || '提交回答失败，请重试';
  } finally {
    isSubmitting.value = false;
  }
};

const handleSubmit = () => {
  if (!canSubmit.value) return;
  let answer = '';
  if (isCustomSelected.value) {
    answer = customInput.value.trim();
  } else if (selectedIndex.value !== null) {
    answer = options.value[selectedIndex.value] ?? '';
  }
  if (!answer) return;
  void submit(answer);
};
</script>

<template>
  <!-- 当卡片被彻底关闭时隐藏 -->
  <div v-if="!isDismissed" :class="['w-full rounded-2xl border transition-all my-2 shadow-[0_1px_4px_rgba(0,0,0,0.05)]', isDark ? 'bg-[#161b26] border-gray-800' : 'bg-white border-gray-200/90']">

    <!-- 1. 顶部 Header -->
    <div class="px-5 pt-4 pb-2 flex items-center justify-between select-none">
      <span class="text-xs font-normal text-gray-400 tracking-wide">Clarify</span>
      <div class="flex items-center gap-2">
        <button
          type="button"
          @click="isCollapsed = !isCollapsed"
          class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition rounded-md"
          :title="isCollapsed ? '展开' : '收起'"
        >
          <svg :class="['w-4 h-4 transition-transform duration-200', isCollapsed ? '-rotate-90' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <button
          type="button"
          @click="isDismissed = true"
          class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition rounded-md"
          title="关闭"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 2. 卡片主要内容 -->
    <div v-show="!isCollapsed" class="px-5 pb-5 space-y-3.5">

      <h3 :class="['text-[15px] sm:text-base font-bold leading-relaxed', isDark ? 'text-gray-100' : 'text-gray-900']">
        {{ questionText }}
      </h3>

      <!-- 已决断提示状态 -->
      <div
        v-if="isResolved"
        :class="[
          'flex items-center gap-2 py-2 px-3 rounded-xl text-xs font-medium',
          isUnknownOutcome
            ? 'bg-gray-500/10 border border-gray-500/20 text-gray-400'
            : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-500'
        ]"
      >
        <svg v-if="!isUnknownOutcome" class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
        </svg>
        <svg v-else class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span v-if="isUnknownOutcome">状态未知（未获取到该提问的结论）</span>
        <span v-else>已确认决策：<span class="font-semibold">{{ resolvedAnswer }}</span></span>
      </div>

      <div v-if="!isResolved" class="space-y-2">
        <!-- 候选项列表（options 为空时整块不渲染） -->
        <div
          v-for="(item, idx) in options"
          :key="idx"
          @click="selectChoice(idx)"
          :class="[
            'flex items-start sm:items-center gap-3 p-2.5 rounded-xl border transition-all cursor-pointer select-none group',
            selectedIndex === idx
              ? (isDark ? 'bg-blue-950/30 border-blue-500/60' : 'bg-blue-50/80 border-blue-400/80 shadow-xs')
              : (isDark ? 'border-transparent hover:bg-gray-800/40 hover:border-gray-700' : 'border-transparent hover:bg-gray-50/80 hover:border-gray-200')
          ]"
        >
          <div
            :class="[
              'w-6 h-6 rounded-md flex items-center justify-center text-xs font-semibold flex-shrink-0 transition-colors mt-0.5 sm:mt-0',
              selectedIndex === idx
                ? 'bg-blue-600 text-white'
                : (isDark ? 'bg-gray-800 text-gray-400 group-hover:text-gray-200' : 'bg-[#eef2f6] text-gray-500 group-hover:text-gray-700')
            ]"
          >
            {{ idx + 1 }}
          </div>

          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 flex-1 min-w-0">
            <span :class="['text-[13.5px] font-semibold transition-colors', isDark ? 'text-gray-100' : 'text-gray-900']">
              {{ item }}
            </span>
          </div>
        </div>

        <!-- 自定义答案输入行 -->
        <div
          @click="onCustomFocus"
          :class="[
            'flex items-center gap-3 p-2 rounded-xl border transition-all cursor-text',
            isCustomSelected
              ? (isDark ? 'bg-blue-950/30 border-blue-500/60' : 'bg-blue-50/80 border-blue-400/80 shadow-xs')
              : (isDark ? 'border-transparent hover:bg-gray-800/40 hover:border-gray-700' : 'border-transparent hover:bg-gray-50/80 hover:border-gray-200')
          ]"
        >
          <div
            :class="[
              'w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 transition-colors',
              isCustomSelected
                ? 'bg-blue-600 text-white'
                : (isDark ? 'bg-gray-800 text-gray-400' : 'bg-[#eef2f6] text-gray-400')
            ]"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </div>

          <input
            v-model="customInput"
            @focus="onCustomFocus"
            @keydown.enter.prevent="handleSubmit"
            type="text"
            placeholder="输入你的答案"
            :class="[
              'w-full text-[13px] bg-transparent outline-none placeholder:text-gray-400',
              isDark ? 'text-gray-100' : 'text-gray-800'
            ]"
          />
        </div>
      </div>

      <div v-if="errorMsg" class="text-xs text-red-400 py-1">
        {{ errorMsg }}
      </div>

      <!-- 3. 底部操作工具栏 -->
      <div v-if="!isResolved" class="pt-2 flex items-center justify-end select-none">
        <button
          type="button"
          @click="handleSubmit"
          :disabled="!canSubmit"
          :class="[
            'px-5 py-1.5 rounded-xl text-xs font-medium text-white transition shadow-xs flex items-center gap-1',
            canSubmit
              ? 'bg-blue-600 hover:bg-blue-500 cursor-pointer'
              : 'bg-[#888e9b] dark:bg-gray-700 opacity-60 cursor-not-allowed'
          ]"
        >
          <svg v-if="isSubmitting" class="w-3 h-3 animate-spin mr-1" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
          </svg>
          <span>提交</span>
        </button>
      </div>

    </div>
  </div>
</template>
