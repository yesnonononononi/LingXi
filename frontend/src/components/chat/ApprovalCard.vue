<script setup lang="ts">
import { ref, computed, inject } from 'vue';
import type { PromptCardData } from '../../types/chat';
import { DECIDE_TOOL_CALL_KEY } from '../../types/toolDecision';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import { APPROVE_ACTION, normalizeOutcome, resolveApprovalState } from '../../utils/approvalOutcome';
import { canDecideCard } from '../../utils/toolCallCard';
import { CARD_SHELL_CLASS, CARD_BODY_CLASS, CARD_ERROR_TEXT_CLASS, cardToneClass, type CardTone } from '../../utils/cardUi';
import CardHeader from './CardHeader.vue';
import CardActionButton from './CardActionButton.vue';
import CollapseTransition from '../common/CollapseTransition.vue';

const props = defineProps<{
  /** 统一卡片数据（COMMAND 命令审批） */
  promptCard: PromptCardData;
  sessionId?: string | number;
  isDark?: boolean;
}>();

/**
 * 由视图层注入的决策提交：走 JSON 回执，**不再消费请求级流**。
 * 恢复期的实时内容由会话级 v3 流渲染；本回调只负责提交并回执结果。
 */
const decideToolCall = inject(DECIDE_TOOL_CALL_KEY, null);

const isCollapsed = ref(false);
const isDismissed = ref(false);
const isSubmitting = ref(false);
const submittingAction = ref<'approve' | 'reject' | null>(null);
const errorMsg = ref('');
// 复制反馈（布尔键控；见 composables/useCopyFeedback.ts）
const { isCopied: copied, copy: copyRaw } = useCopyFeedback();

/** 命令正文：优先结构化 command，回落卡片正文 */
const commandText = computed(() => props.promptCard.command || props.promptCard.content || '');
const commandWorkDir = computed(() => props.promptCard.workDir || '');
/** 模型声明的命令意图（content.intention）；缺失时整行不渲染 */
const commandIntention = computed(() => props.promptCard.intention || '');

/**
 * 是否可操作：**叠加权威 `pending`**（= type==='PROMISE' && status==='pending'），
 * 再要求后端动作集合含 APPROVE。只判 allowedActions 会被「已决但残留动作」的脏数据骗过。
 */
const isPending = computed(() => canDecideCard(props.promptCard, APPROVE_ACTION));
/** 数据不可用（tool_call 缺行 / content 解析失败） */
const isUnavailable = computed(() => props.promptCard.unavailable === true);

/** 结论：raw_output.outcome（APPROVED/REJECTED/CANCELLED/SUCCEEDED/FAILED/TIMED_OUT） */
const outcome = computed(() => normalizeOutcome(props.promptCard.outcome));

/** 已决断（不可再操作）：不再 pending，或数据不可用 */
const isResolved = computed(() => isUnavailable.value || !isPending.value);

const resolvedStatus = computed(() => {
  if (isUnavailable.value) return null;
  // 契约 §3：结论缺失/无法识别 = 状态未知，绝不臆断为「已批准」。
  return resolveApprovalState(outcome.value, isPending.value);
});

/** header 状态点语义色 */
const headerTone = computed<CardTone>(() => {
  if (!isResolved.value) return 'pending';
  if (resolvedStatus.value === 'approved') return 'approved';
  if (resolvedStatus.value === 'rejected') return 'rejected';
  return 'unknown';
});

// 复制命令（保留原有「空文本不复制」守卫）
const copyCommand = () => {
  const text = commandText.value;
  if (!text) return;
  void copyRaw(text);
};

// 允许/批准执行
const submit = async (approved: boolean) => {
  if (isSubmitting.value || isResolved.value) return;
  const conversationId = props.promptCard.conversationId
    ?? (props.sessionId != null && props.sessionId !== '' ? String(props.sessionId) : '');
  const toolCallId = props.promptCard.toolCallId;
  if (!conversationId || !toolCallId || !decideToolCall) {
    errorMsg.value = '审批信息不完整，请刷新会话后重试';
    return;
  }
  isSubmitting.value = true;
  submittingAction.value = approved ? 'approve' : 'reject';
  errorMsg.value = '';

  try {
    await decideToolCall({
      conversationId: String(conversationId),
      toolCallId: String(toolCallId),
      action: approved ? 'APPROVE' : 'REJECT',
      expectedVersion: props.promptCard.version ?? null
    });
    // 卡片状态一律以回执携带的工具实体与后续 v3 事件为准，不在此自行改写。
  } catch (err: any) {
    errorMsg.value = err?.message || '提交审批失败，请重试';
  } finally {
    isSubmitting.value = false;
    submittingAction.value = null;
  }
};

const handleApprove = () => submit(true);
const handleReject = () => submit(false);
</script>

<template>
  <div
    v-if="!isDismissed"
    :class="[CARD_SHELL_CLASS, 'overflow-hidden', isDark ? 'bg-[#151b26] border-gray-800' : 'bg-white border-gray-200/90']"
  >
    <div :class="CARD_BODY_CLASS">
      <!-- 1. 统一 header：状态点 + 类型标签；右侧折叠/关闭（关闭仅在已决态出现） -->
      <CardHeader :tone="headerTone" type-label="命令审批" :is-dark="isDark">
        <template #actions>
          <!-- ★ 待决策态不得移除操作入口：折叠 / 关闭均只在已决态出现 -->
          <button
            v-if="isResolved"
            type="button"
            @click="isCollapsed = !isCollapsed"
            class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/50"
            :title="isCollapsed ? '展开' : '收起'"
            :aria-label="isCollapsed ? '展开卡片' : '收起卡片'"
          >
            <svg :class="['w-3.5 h-3.5 transition-transform duration-200', isCollapsed ? '-rotate-90' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <!-- ★ 待决策态不得移除操作入口：只有已决态才允许关闭整卡 -->
          <button
            v-if="isResolved"
            type="button"
            @click="isDismissed = true"
            class="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/50"
            title="关闭"
            aria-label="关闭卡片"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </template>
      </CardHeader>

      <!-- 2. 内容主体 (可折叠) -->
      <CollapseTransition>
        <div v-if="!isCollapsed">
          <div class="space-y-2.5">
            <!-- 命令展示区 -->
            <div
              v-if="commandText"
              :class="[
                'rounded-xl border relative group overflow-hidden',
                isDark ? 'bg-[#0e131d] border-gray-800' : 'bg-[#f7f8fa] border-gray-200/80'
              ]"
            >
              <!-- 复制按钮 (右上角悬浮)；意图/目录行右侧预留安全区，避免遮挡 -->
              <div class="absolute right-2 top-2 z-10">
                <button
                  type="button"
                  @click="copyCommand"
                  aria-label="复制命令"
                  :class="[
                    'text-[11px] px-2 py-0.5 rounded-md transition flex items-center gap-1 cursor-pointer select-none border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/50',
                    isDark
                      ? 'bg-gray-800/80 hover:bg-gray-700 text-gray-400 hover:text-gray-200 border-gray-700/60'
                      : 'bg-white hover:bg-gray-50 text-gray-500 hover:text-gray-800 border-gray-200 shadow-2xs'
                  ]"
                >
                  <template v-if="copied">
                    <svg class="w-3 h-3 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                    </svg>
                    <span class="text-emerald-600 dark:text-emerald-400 font-medium">已复制</span>
                  </template>
                  <template v-else>
                    <svg class="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                    </svg>
                    <span>复制</span>
                  </template>
                </button>
              </div>

              <div v-if="commandIntention" class="px-3 pt-2 pr-16 text-xs break-all" :class="isDark ? 'text-gray-300' : 'text-gray-600'">
                <span class="font-medium">意图：</span>{{ commandIntention }}
              </div>
              <div v-if="commandWorkDir" class="px-3 pt-2 pr-16 text-xs text-gray-500 break-all">工作目录：{{ commandWorkDir }}</div>
              <!-- 命令正文 -->
              <div class="p-3 pr-16 font-mono text-[12px] leading-relaxed break-all select-text flex items-start gap-2">
                <span class="text-blue-500/80 font-bold select-none">$</span>
                <span :class="isDark ? 'text-gray-200' : 'text-gray-800'">{{ commandText }}</span>
              </div>
            </div>

            <!-- 已决断状态提示（二级信息，统一对比度） -->
            <div
              v-if="isResolved"
              :class="['flex items-center gap-2 py-2 px-3 rounded-xl text-xs font-medium select-none', cardToneClass(headerTone, isDark)]"
            >
              <svg v-if="resolvedStatus === 'approved'" class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
              <svg v-else-if="resolvedStatus === 'rejected'" class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
              <svg v-else class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{{ isUnavailable ? '审批已结束或状态不可用' : resolvedStatus === 'approved' ? '已批准执行该命令' : resolvedStatus === 'rejected' ? '已拒绝执行该命令' : promptCard.status === 'preparing' ? '准备中' : promptCard.unavailableReason || '状态未知' }}</span>
            </div>

            <!-- 错误提示 -->
            <div v-if="errorMsg" :class="['text-xs font-medium', CARD_ERROR_TEXT_CLASS]">
              {{ errorMsg }}
            </div>

            <!-- 3. 底部操作栏 (未决断时展示) -->
            <div v-if="!isResolved" class="pt-2 flex items-center justify-end gap-2.5 select-none border-t border-gray-100 dark:border-gray-800/80">
              <CardActionButton
                tone="danger"
                variant="outline"
                :loading="submittingAction === 'reject'"
                :disabled="isSubmitting"
                :is-dark="isDark"
                @click="handleReject"
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
                :loading="submittingAction === 'approve'"
                :disabled="isSubmitting"
                :is-dark="isDark"
                @click="handleApprove"
              >
                <template #icon>
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M5 13l4 4L19 7" />
                  </svg>
                </template>
                批准并执行
              </CardActionButton>
            </div>
          </div>
        </div>
      </CollapseTransition>
    </div>
  </div>
</template>
