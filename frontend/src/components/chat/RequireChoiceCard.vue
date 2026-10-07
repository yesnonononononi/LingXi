<script setup lang="ts">
import { ref, computed, inject, nextTick } from 'vue';
import type { PromptCardData } from '../../types/chat';
import { DECIDE_TOOL_CALL_KEY } from '../../types/toolDecision';
import { CARD_SHELL_CLASS, CARD_BODY_CLASS, CARD_ERROR_TEXT_CLASS, cardToneClass, type CardTone } from '../../utils/cardUi';
import { canDecideCard } from '../../utils/toolCallCard';
import CardHeader from './CardHeader.vue';
import CardActionButton from './CardActionButton.vue';
import CollapseTransition from '../common/CollapseTransition.vue';

const props = defineProps<{
  /** 统一卡片数据（CHOICE 澄清提问） */
  promptCard: PromptCardData;
  /** 卡片所属会话；决策接口据此定位（缺省时回落到 promptCard.conversationId） */
  sessionId?: string | number;
  isDark?: boolean;
}>();

/**
 * 由视图层注入的决策提交：走 JSON 回执，**不再消费请求级流**。
 * 与 PlanCard 复用同一个宿主能力——require_choice 与 plan 走同一条恢复链路。
 */
const decideToolCall = inject(DECIDE_TOOL_CALL_KEY, null);

/** 是否最小化/折叠 */
const isCollapsed = ref(false);
const isDismissed = ref(false);

// 选项与输入状态
const selectedIndex = ref<number | null>(null);
const customInput = ref('');
const isCustomSelected = ref(false);
const isSubmitting = ref(false);
const errorMsg = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

const questionText = computed(() => props.promptCard.content || props.promptCard.title || '需要您的进一步确认：');

/** 候选项：后端 options 为空数组时只保留自由输入，不伪造“方案 N”占位 */
const options = computed<string[]>(() =>
  (props.promptCard.options || []).map(item => String(item ?? '').trim()).filter(Boolean)
);

/**
 * 是否可操作：**叠加权威 `pending`**（= type==='PROMISE' && status==='pending'），
 * 再要求后端动作集合含 ANSWER。只判 allowedActions 会被「已决但残留动作」的脏数据骗过。
 */
const isPending = computed(() => canDecideCard(props.promptCard, 'ANSWER'));
const isResolved = computed(() => !isPending.value);
const resolvedAnswer = computed(() => props.promptCard.answer || '');

/** 结论：raw_output.outcome（ANSWERED / ...）；缺失 = 状态未知，不得默认成功 */
const outcome = computed(() => String(props.promptCard.outcome ?? '').trim().toUpperCase());
const isUnknownOutcome = computed(() => isResolved.value && !outcome.value);

/** header 状态点语义色：未决=待答，已决=已答/未知 */
const headerTone = computed<CardTone>(() => {
  if (!isResolved.value) return 'pending';
  return isUnknownOutcome.value ? 'unknown' : 'approved';
});

// 选择预设选项
const selectChoice = (idx: number) => {
  if (isResolved.value) return;
  selectedIndex.value = idx;
  isCustomSelected.value = false;
  errorMsg.value = '';
};

// 点击「自定义答案」整行 → 选中并聚焦输入框（避免用户需二次点击）
const selectCustom = () => {
  if (isResolved.value) return;
  isCustomSelected.value = true;
  selectedIndex.value = null;
  errorMsg.value = '';
  void nextTick(() => inputRef.value?.focus());
};

// 输入框自身获得焦点时同步选中态
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

/** 提交按钮禁用原因（明确提示，避免「点了没反应」） */
const disabledReason = computed(() => {
  if (isResolved.value || isSubmitting.value) return '';
  return canSubmit.value ? '' : '请选择一个选项，或输入你的答案后再提交';
});

/**
 * 提交选中的答案。
 *
 * 决策走 /tool-call/decisions，动作为 ANSWER：澄清提问里「给出回答」就是回答本身。
 * 回答原文作为 text 落进上下文，结论记为 ANSWERED。
 */
const submit = async (answer: string) => {
  const conversationId = props.promptCard.conversationId
    ?? (props.sessionId != null && props.sessionId !== '' ? String(props.sessionId) : '');
  if (!conversationId) {
    errorMsg.value = '提问卡片缺少所属会话，无法提交回答';
    return;
  }
  const toolCallId = props.promptCard.toolCallId;
  if (!toolCallId) {
    errorMsg.value = '提问卡片缺少互动状态ID，无法提交回答';
    return;
  }
  if (!decideToolCall) {
    errorMsg.value = '当前视图未接入决策通道，无法提交回答';
    return;
  }

  isSubmitting.value = true;
  errorMsg.value = '';
  try {
    await decideToolCall({
      conversationId: String(conversationId),
      toolCallId: String(toolCallId),
      action: 'ANSWER',
      text: answer,
      expectedVersion: props.promptCard.version ?? null
    });
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
  <div
    v-if="!isDismissed"
    :class="[CARD_SHELL_CLASS, isDark ? 'bg-[#161b26] border-gray-800' : 'bg-white border-gray-200/90']"
  >
    <div :class="CARD_BODY_CLASS">
      <!-- 1. 统一 header：状态点 + 类型标签；右侧折叠/关闭（关闭仅在已决态出现） -->
      <CardHeader :tone="headerTone" type-label="提问" :is-dark="isDark">
        <template #actions>
          <!-- ★ 待决策态不得移除操作入口：折叠 / 关闭均只在已决态出现 -->
          <button
            v-if="isResolved"
            type="button"
            @click="isCollapsed = !isCollapsed"
            class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition rounded-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/50"
            :title="isCollapsed ? '展开' : '收起'"
            :aria-label="isCollapsed ? '展开卡片' : '收起卡片'"
          >
            <svg :class="['w-4 h-4 transition-transform duration-200', isCollapsed ? '-rotate-90' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <!-- ★ 待决策态不得移除操作入口：只有已决态才允许关闭整卡 -->
          <button
            v-if="isResolved"
            type="button"
            @click="isDismissed = true"
            class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition rounded-md cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/50"
            title="关闭"
            aria-label="关闭卡片"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </template>
      </CardHeader>

      <!-- 2. 卡片主要内容 -->
      <CollapseTransition>
        <div v-if="!isCollapsed">
          <div class="space-y-3.5">

            <h3 :class="['text-[15px] sm:text-base font-bold leading-relaxed', isDark ? 'text-gray-100' : 'text-gray-900']">
              {{ questionText }}
            </h3>

            <!-- 已决断提示状态 -->
            <div
              v-if="isResolved"
              :class="['flex items-center gap-2 py-2 px-3 rounded-xl text-xs font-medium', cardToneClass(headerTone, isDark)]"
            >
              <svg v-if="!isUnknownOutcome" class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              <svg v-else class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span v-if="isUnknownOutcome">{{ promptCard.status === 'preparing' ? '准备中' : promptCard.unavailableReason || '状态未知（未获取到该提问的结论）' }}</span>
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

              <!-- 自定义答案输入行（整行点击即选中并聚焦） -->
              <div
                @click="selectCustom"
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
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </div>

                <input
                  ref="inputRef"
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

            <div v-if="errorMsg" :class="['text-xs py-1', CARD_ERROR_TEXT_CLASS]">
              {{ errorMsg }}
            </div>

            <!-- 3. 底部操作工具栏 -->
            <div v-if="!isResolved" class="pt-2 flex items-center justify-between gap-3 select-none">
              <span class="text-[11px] text-gray-500 dark:text-gray-400">{{ disabledReason }}</span>
              <CardActionButton
                tone="blue"
                :loading="isSubmitting"
                :disabled="!canSubmit"
                :is-dark="isDark"
                @click="handleSubmit"
              >
                <template #icon>
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                </template>
                提交回答
              </CardActionButton>
            </div>
          </div>
        </div>
      </CollapseTransition>
    </div>
  </div>
</template>
