<script setup lang="ts">
import {computed, inject, ref} from 'vue';
import type {PromptCardData} from '../../types/chat';
import {DECIDE_TOOL_CALL_KEY} from '../../types/toolDecision';
import {useCopyFeedback} from '../../composables/useCopyFeedback';
import {APPROVE_ACTION, normalizeOutcome, resolveApprovalState} from '../../utils/approvalOutcome';
import {canDecideCard} from '../../utils/toolCallCard';
import {
  CARD_BODY_CLASS,
  CARD_ERROR_TEXT_CLASS,
  CARD_SHELL_CLASS,
  type CardTone,
  cardToneClass
} from '../../utils/cardUi';
import CardHeader from './CardHeader.vue';
import CardActionButton from './CardActionButton.vue';
import CollapseTransition from '../common/CollapseTransition.vue';
import {useI18n} from '../../i18n';

const props = defineProps<{
  /** 统一卡片数据（COMMAND 命令审批 / FILE_WRITE 文件改动审批） */
  promptCard: PromptCardData;
  sessionId?: string | number;
  isDark?: boolean;
  docked?: boolean;
}>();

const { t } = useI18n();

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

/**
 * 本组件同时承载两种审批形态：命令审批（正文是命令行）与文件改动审批（正文是目标路径）。
 *
 * <p>两者的批准/拒绝语义完全一致，只有类型标签、正文来源与已决文案不同 —— 不为此拆成两个组件，
 * 否则提交、按钮门控、折叠、错误提示这几段会各写一份，迟早漂移。</p>
 */
const isFileWrite = computed(() => props.promptCard.kind === 'FILE_WRITE');
/** 正文：命令审批取命令行，文件改动审批取目标路径；都缺时回落到卡片正文 */
const primaryText = computed(() => props.promptCard.command || props.promptCard.path || props.promptCard.content || '');
const targetWorkDir = computed(() => props.promptCard.workDir || '');
/** 模型声明的意图（content.intention）；缺失时整行不渲染 */
const targetIntention = computed(() => props.promptCard.intention || '');
/** header 类型标签随形态变 */
const typeLabel = computed(() => isFileWrite.value ? t('chat.approval.fileTypeLabel') : t('chat.approval.typeLabel'));
/** 复制按钮文案随形态变 */
const copyActionLabel = computed(() => isFileWrite.value ? t('chat.approval.copyPath') : t('chat.approval.copyCommand'));
/** 已决态文案随形态变，避免「已批准执行该命令」出现在文件改动卡上 */
const approvedLabel = computed(() => isFileWrite.value ? t('chat.approval.fileApproved') : t('chat.approval.approved'));
const rejectedLabel = computed(() => isFileWrite.value ? t('chat.approval.fileRejected') : t('chat.approval.rejected'));

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

// 复制正文（保留原有「空文本不复制」守卫）
const copyText = () => {
  const text = primaryText.value;
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
    errorMsg.value = t('chat.approval.infoIncomplete');
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
    errorMsg.value = err?.message || t('chat.approval.submitFailed');
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
    :class="docked
      ? 'w-full overflow-hidden'
      : [CARD_SHELL_CLASS, 'overflow-hidden', isDark ? 'bg-zinc-950 border-white/10' : 'bg-white border-zinc-200/90']"
  >
    <div :class="docked ? 'py-1 space-y-2.5' : CARD_BODY_CLASS">
      <!-- 1. 统一 header：状态点 + 类型标签；右侧折叠/关闭（关闭仅在已决态出现） -->
      <CardHeader :tone="headerTone" :type-label="typeLabel" :is-dark="isDark">
        <template #actions>
          <!-- ★ 待决策态不得移除操作入口：折叠 / 关闭均只在已决态出现 -->
          <button
            v-if="isResolved"
            type="button"
            @click="isCollapsed = !isCollapsed"
            class="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50"
                        :title="isCollapsed ? t('common.expand') : t('common.collapse')"
                        :aria-label="isCollapsed ? t('chat.approval.expandCard') : t('chat.approval.collapseCard')"
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
            class="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50"
                        :title="t('common.close')"
            :aria-label="t('chat.approval.closeCard')"
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
              v-if="primaryText"
              :class="[
                'rounded-xl border relative group overflow-hidden',
                isDark ? 'bg-zinc-900/70 border-white/10' : 'bg-zinc-50/90 border-zinc-200/80'
              ]"
            >
              <!-- 复制按钮 (右上角悬浮)；意图/目录行右侧预留安全区，避免遮挡 -->
              <div class="absolute right-2 top-2 z-10">
                <button
                  type="button"
                  @click="copyText"
                  :aria-label="copyActionLabel"
                  :class="[
                    'text-lx-fs-sm px-2 py-0.5 rounded-md transition flex items-center gap-1 cursor-pointer select-none border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/50',
                    isDark
                      ? 'bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border-zinc-700/60'
                      : 'bg-white hover:bg-zinc-50 text-zinc-500 hover:text-zinc-800 border-zinc-200 shadow-2xs'
                  ]"
                >
                  <template v-if="copied">
                    <svg class="w-3 h-3 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                    </svg>
                    <span class="text-emerald-600 dark:text-emerald-400 font-medium">{{ t('common.copied') }}</span>
                  </template>
                  <template v-else>
                    <svg class="w-3 h-3 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                    </svg>
                    <span>{{ t('common.copy') }}</span>
                  </template>
                </button>
              </div>

              <div v-if="targetIntention" class="px-3 pt-2 pr-16 text-xs break-all text-lx-tertiary">
                                <span class="font-medium">{{ t('chat.approval.intention') }}</span>{{ targetIntention }}
              </div>
              <div v-if="targetWorkDir" class="px-3 pt-2 pr-16 text-xs text-zinc-500 break-all">{{ t('chat.approval.workDir') }}{{ targetWorkDir }}</div>
              <!-- 正文：命令审批带 $ 提示符，文件改动审批用落笔图标，不假装自己是命令 -->
              <div class="p-3 pr-16 font-mono text-lx-fs-md leading-relaxed break-all select-text flex items-start gap-2">
                <span v-if="!isFileWrite" class="text-zinc-400 dark:text-zinc-500 font-semibold select-none">$</span>
                <svg v-else class="w-3.5 h-3.5 mt-1 shrink-0 text-zinc-400 dark:text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <span :class="isDark ? 'text-zinc-200' : 'text-zinc-800'">{{ primaryText }}</span>
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
              <span>{{ isUnavailable ? t('chat.approval.resolvedUnavailable') : resolvedStatus === 'approved' ? approvedLabel : resolvedStatus === 'rejected' ? rejectedLabel : promptCard.status === 'preparing' ? t('chat.approval.preparing') : promptCard.unavailableReason || t('chat.approval.statusUnknown') }}</span>
            </div>

            <!-- 错误提示 -->
            <div v-if="errorMsg" :class="['text-xs font-medium', CARD_ERROR_TEXT_CLASS]">
              {{ errorMsg }}
            </div>

            <!-- 3. 底部操作栏 (未决断时展示) -->
            <div v-if="!isResolved" class="pt-2 flex items-center justify-end gap-2.5 select-none border-t border-zinc-100 dark:border-zinc-800/80">
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
                                {{ t('chat.approval.rejectAction') }}
              </CardActionButton>

              <CardActionButton
                tone="neutral"
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
                                {{ t('chat.approval.approveAction') }}
              </CardActionButton>
            </div>
          </div>
        </div>
      </CollapseTransition>
    </div>
  </div>
</template>
