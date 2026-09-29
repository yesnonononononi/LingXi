<script setup lang="ts">
import { ref, computed, inject } from 'vue';
import type { PromptCardData } from '../../types/chat';
import { useCopyFeedback } from '../../composables/useCopyFeedback';
import SpecularButton from '../common/SpecularButton.vue';

const props = defineProps<{
  /** 统一卡片数据（COMMAND 命令审批） */
  promptCard: PromptCardData;
  sessionId?: string | number;
  isDark?: boolean;
}>();

/**
 * 由视图层注入的流式决策：提交审批后消费恢复执行的事件流并渲染成新的消息气泡。
 * 缺省（组件树外独立使用本卡片时）降级为不可提交，仅提示。
 * 契约：决策统一以 toolCallId 为锚点，走 decideToolCall({conversationId, toolCallId, approved, text})。
 */
const decideToolCall = inject<((payload: {
  conversationId: string;
  toolCallId: string;
  approved: boolean;
  text?: string;
}) => Promise<boolean>) | null>('decideToolCall', null);

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
const shellLabel = computed(() => props.promptCard.shell || '');

/** 是否仍待决策：以后端下发的 pending 为准（唯一可审批判定） */
const isPending = computed(() => props.promptCard.pending === true);
/** 数据不可用（tool_call 缺行 / content 解析失败） */
const isUnavailable = computed(() => props.promptCard.unavailable === true);

/** 结论：raw_output.outcome（APPROVED/REJECTED/CANCELLED/SUCCEEDED/FAILED/TIMED_OUT） */
const outcome = computed(() => String(props.promptCard.outcome ?? '').trim().toUpperCase());

/** 已决断（不可再操作）：不再 pending，或数据不可用 */
const isResolved = computed(() => isUnavailable.value || !isPending.value);

const resolvedStatus = computed<'approved' | 'rejected' | 'unknown' | null>(() => {
  if (isUnavailable.value) return null;
  if (outcome.value === 'APPROVED' || outcome.value === 'SUCCEEDED') return 'approved';
  if (
    outcome.value === 'REJECTED' ||
    outcome.value === 'CANCELLED' ||
    outcome.value === 'FAILED' ||
    outcome.value === 'TIMED_OUT'
  ) {
    return 'rejected';
  }
  // 契约 §3：结论缺失/无法识别 = 状态未知，绝不臆断为「已批准」。
  return isPending.value ? null : 'unknown';
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
    const accepted = await decideToolCall({
      conversationId: String(conversationId),
      toolCallId: String(toolCallId),
      approved
    });
    if (!accepted) {
      errorMsg.value = '提交审批失败，请重试';
      return;
    }
    // 结论由 outcome 表达，status 收敛为终态 completed（不再用 [rejected] 字符串嗅探）
    props.promptCard.pending = false;
    props.promptCard.status = 'completed';
    props.promptCard.outcome = approved ? 'APPROVED' : 'REJECTED';
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
    :class="[
      'w-full rounded-2xl border transition-all my-2.5 overflow-hidden shadow-xs',
      isDark ? 'bg-[#151b26] border-gray-800' : 'bg-white border-gray-200/90'
    ]"
  >
    <!-- 卡片内边距容器 -->
    <div class="p-3.5 sm:p-4 space-y-2.5">
      <!-- 1. Header 栏 (精简、现代、克制) -->
      <div class="flex items-center justify-between select-none">
        <div class="flex items-center gap-2 min-w-0">
          <!-- 状态小圆点 -->
          <span
            :class="[
              'w-2 h-2 rounded-full flex-shrink-0',
              isResolved && resolvedStatus === 'approved'
                ? 'bg-emerald-500'
                : isResolved && resolvedStatus === 'rejected'
                ? 'bg-red-500'
                : isResolved && resolvedStatus === 'unknown'
                ? 'bg-gray-400'
                : 'bg-amber-400 animate-pulse'
            ]"
          ></span>

          <!-- 标题与类型胶囊 -->
          <div class="flex items-center gap-1.5 flex-wrap">
            <span :class="['text-xs font-semibold', isDark ? 'text-gray-200' : 'text-gray-800']">
              请求执行终端命令
            </span>
            <span
              v-if="shellLabel"
              :class="[
                'text-[10px] px-1.5 py-0.2 rounded font-mono font-normal',
                isDark ? 'bg-gray-800 text-gray-400' : 'bg-gray-100 text-gray-500'
              ]"
            >
              {{ shellLabel }}
            </span>
          </div>
        </div>

        <!-- 折叠/关闭操作 -->
        <div class="flex items-center gap-1 text-gray-400">
          <button
            type="button"
            @click="isCollapsed = !isCollapsed"
            class="p-1 hover:text-gray-600 dark:hover:text-gray-200 rounded transition cursor-pointer"
            :title="isCollapsed ? '展开' : '收起'"
          >
            <svg :class="['w-3.5 h-3.5 transition-transform duration-200', isCollapsed ? '-rotate-90' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button
            type="button"
            @click="isDismissed = true"
            class="p-1 hover:text-gray-600 dark:hover:text-gray-200 rounded transition cursor-pointer"
            title="关闭"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- 2. 内容主体 (可折叠) -->
      <div v-show="!isCollapsed" class="space-y-2.5">
        <!-- 命令展示区 (对齐现代开发者工具，浅色高质感灰底 / 深色低反光底) -->
        <div
          v-if="commandText"
          :class="[
            'rounded-xl border relative group overflow-hidden',
            isDark ? 'bg-[#0e131d] border-gray-800' : 'bg-[#f7f8fa] border-gray-200/80'
          ]"
        >
          <!-- 复制按钮 (右上角悬浮) -->
          <div class="absolute right-2 top-2 z-10">
            <button
              type="button"
              @click="copyCommand"
              :class="[
                'text-[11px] px-2 py-0.5 rounded-md transition flex items-center gap-1 cursor-pointer select-none border',
                isDark
                  ? 'bg-gray-800/80 hover:bg-gray-700 text-gray-400 hover:text-gray-200 border-gray-700/60'
                  : 'bg-white hover:bg-gray-50 text-gray-500 hover:text-gray-800 border-gray-200 shadow-2xs'
              ]"
            >
              <template v-if="copied">
                <svg class="w-3 h-3 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                </svg>
                <span class="text-emerald-500 font-medium">已复制</span>
              </template>
              <template v-else>
                <svg class="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                </svg>
                <span>复制</span>
              </template>
            </button>
          </div>

          <div v-if="commandWorkDir" class="px-3 pt-2 text-xs text-gray-500 break-all">工作目录：{{ commandWorkDir }}</div>
          <!-- 命令正文 -->
          <div class="p-3 pr-16 font-mono text-[12px] leading-relaxed break-all select-text flex items-start gap-2">
            <span class="text-blue-500/80 font-bold select-none">$</span>
            <span :class="isDark ? 'text-gray-200' : 'text-gray-800'">{{ commandText }}</span>
          </div>
        </div>

        <!-- 已决断状态提示 -->
        <div
          v-if="isResolved"
          :class="[
            'flex items-center gap-2 py-2 px-3 rounded-xl text-xs font-medium select-none',
            resolvedStatus === 'approved'
              ? (isDark ? 'bg-emerald-950/30 text-emerald-400 border border-emerald-900/40' : 'bg-emerald-50 text-emerald-700 border border-emerald-200/60')
              : resolvedStatus === 'rejected'
              ? (isDark ? 'bg-red-950/30 text-red-400 border border-red-900/40' : 'bg-red-50 text-red-700 border border-red-200/60')
              : (isDark ? 'bg-gray-800/40 text-gray-400 border border-gray-700/60' : 'bg-gray-50 text-gray-500 border border-gray-200')
          ]"
        >
          <svg v-if="resolvedStatus === 'approved'" class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <svg v-else-if="resolvedStatus === 'rejected'" class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
          <svg v-else class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{{ isUnavailable ? '审批已结束或状态不可用' : resolvedStatus === 'approved' ? '已批准执行该命令' : resolvedStatus === 'rejected' ? '已拒绝执行该命令' : '状态未知' }}</span>
        </div>

        <!-- 错误提示 -->
        <div v-if="errorMsg" class="text-xs text-red-500 font-medium">
          {{ errorMsg }}
        </div>

        <!-- 3. 底部操作栏 (未决断时展示) -->
        <div v-if="!isResolved" class="pt-2 flex items-center justify-end gap-2.5 select-none border-t border-gray-100 dark:border-gray-800/80">
          <!-- 拒绝按钮 (轻量次级按钮) -->
          <button
            type="button"
            @click="handleReject"
            :disabled="isSubmitting"
            :class="[
              'px-3.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer flex items-center gap-1 border disabled:opacity-50',
              isDark
                ? 'border-gray-700/80 text-gray-400 hover:text-red-400 hover:border-red-900/50 hover:bg-red-950/20'
                : 'border-gray-200 text-gray-600 hover:text-red-600 hover:border-red-200 hover:bg-red-50/50'
            ]"
          >
            <svg v-if="submittingAction === 'reject'" class="w-3 h-3 animate-spin mr-0.5" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
            </svg>
            <svg v-else class="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span>拒绝</span>
          </button>

          <!-- 允许执行按钮 (采用 SpecularButton WebGL 光影流光，克制、高级、无多余黑影) -->
          <SpecularButton
            size="xs"
            :radius="8"
            tint="#10b981"
            :tint-opacity="1"
            text-color="#ffffff"
            line-color="#a7f3d0"
            base-color="#059669"
            :intensity="1.1"
            :shine-size="16"
            :shine-fade="35"
            :thickness="1"
            :speed="0.35"
            follow-mouse
            no-shadow
            :disabled="isSubmitting"
            @click="handleApprove"
          >
            <div class="flex items-center gap-1.5 text-xs font-semibold px-0.5">
              <svg v-if="submittingAction === 'approve'" class="w-3 h-3 animate-spin mr-0.5" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
              </svg>
              <svg v-else class="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M5 13l4 4L19 7" />
              </svg>
              <span>批准并执行</span>
            </div>
          </SpecularButton>
        </div>
      </div>
    </div>
  </div>
</template>
