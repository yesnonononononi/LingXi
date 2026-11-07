<script setup lang="ts">
import {computed, ref, watch} from 'vue';
import type {ChatMessage, ChatTurn, SubSessionVO} from '../../types/chat';
import type {ProcessSegmentView} from '../../utils/processViewModel';
import CollapseTransition from '../common/CollapseTransition.vue';
import ProcessDetails from './ProcessDetails.vue';
import {t} from '../../i18n';

const props = withDefaults(defineProps<{
  /** 视图模型：段事实 + 呈现模式 + 折叠行文案，全部由 ChatMessageItem 的纯函数层算好。 */
  view: ProcessSegmentView;
  message: ChatMessage;
  turn?: ChatTurn | null;
  visible?: boolean;
  /**
   * 回答级「当前扫光位置」：整组过程里只有一段为 true（由 `deriveProcessViews` 裁决）。
   *
   * <p>扫光**不再**看 `mode`：多段 live 并存是正确的事实（旧段已收尾但段内工具仍在跑），
   * 但「此刻还在动」这条信号整组只能有一个，否则同一回答里会同时闪三四道扫光。</p>
   */
  sweep?: boolean;
  /** 延迟由 CSS 控制，避免短空窗闪烁和异步回调持有旧消息。 */
  awaitModel?: boolean;
  subSessions?: SubSessionVO[];
  sessionId?: string | number;
  isDark: boolean;
}>(), { visible: true, sweep: false, awaitModel: false });
const emit = defineEmits<{ (e: 'selectSubSession', id: string | number): void }>();
// 组件只剩「解引用 + 本地折叠状态」，不含任何判据。
const segment = computed(() => props.view.segment);
const mode = computed(() => props.view.mode);
const expanded = ref(false);
const detailsBox = ref<HTMLElement | null>(null);
// 每次展开先呈现最新过程，后续更新保留用户主动上翻的位置。
watch(detailsBox, box => {
  if (box) box.scrollTop = box.scrollHeight;
}, {flush: 'post'});
const headline = computed(() => props.view.headline);
// 标题/预览/状态全部来自视图模型，组件只决定排版：长正文右对齐溢出，短值截断。
const title = computed(() => headline.value.title);
const preview = computed(() => headline.value.preview);
const statusLabel = computed(() => headline.value.status);
const previewIsText = computed(() => headline.value.previewKind === 'text');
/**
 * 轮次是否仍在运行 —— 与原来传给 `ProcessDetails` 的 `turn` 判定逐字等价：
 * 有 turn 时看 `turn.status`，无 turn 时看 `message.isComplete !== true`。
 */
const isRunningTurn = computed(() => props.turn
  ? props.turn.status === 'RUNNING'
  : props.message.isComplete !== true);
</script>

<template>
  <div class="w-full min-w-0" data-testid="process-segment" :data-segment-id="segment.id"
    :data-process-mode="mode">
    <!-- 按钮名称描述展开对象，避免摘要让位后仍通过无障碍名称残留旧内容。 -->
    <button type="button" data-testid="process-segment-toggle" :aria-expanded="expanded"
      :aria-label="t('chat.message.process')"
      class="flex w-full min-w-0 items-center gap-2 py-1 text-left text-xs cursor-pointer group"
      :class="isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'"
      @click="expanded = !expanded">
      <svg class="h-3.5 w-3.5 shrink-0 transition-transform" :class="expanded ? 'rotate-90' : ''"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
      </svg>
      <!-- 身份变化只重建标题槽，防止新消息继承旧动画；折叠选择仍留在段组件。 -->
      <span :key="JSON.stringify([sessionId, message.id, message.turnId, segment.id])"
        class="min-w-0 flex-1" data-testid="process-segment-headline">
        <span class="lx-process-headline" :class="{ 'lx-awaiting-model': awaitModel }">
          <span class="lx-process-summary flex min-w-0 items-center gap-2" data-testid="process-segment-summary">
            <!-- 扫光只能裁切标题自身，放到父容器会重新绘出预览中已被截断的文字。 -->
            <span class="min-w-0 max-w-[60%] truncate font-medium" data-testid="process-segment-title"
              :class="{ 'lx-sweep-text': sweep }">{{ title }}</span>
            <span v-if="preview" class="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
              :class="previewIsText ? 'flex justify-end' : ''"
              data-testid="process-segment-preview">
              <span :class="previewIsText ? 'shrink-0 min-w-full text-left' : 'block truncate'">{{ preview }}</span>
            </span>
            <span v-if="statusLabel" class="shrink-0 max-w-[40%] truncate text-lx-fs-sm text-amber-600 dark:text-amber-400"
              data-testid="process-segment-status">{{ statusLabel }}</span>
          </span>
          <span v-if="awaitModel" class="lx-process-waiting min-w-0 truncate font-medium" data-testid="process-segment-await"
            role="status">
            <span class="block truncate lx-sweep-text">{{ t('chat.message.awaitModelResponse') }}</span>
          </span>
        </span>
      </span>
    </button>
    <CollapseTransition>
      <div v-if="visible && expanded" class="mt-1">
        <!-- 滚动框与动画层分开，避免折叠动画按全部内容高度测量而撑开页面。 -->
        <div class="h-[480px] max-h-[70dvh] overflow-y-auto overscroll-y-contain pl-3 pr-2 border-l border-zinc-200 dark:border-white/10"
          ref="detailsBox" data-testid="process-segment-details" tabindex="0" :aria-label="t('chat.message.process')">
          <ProcessDetails :items="segment.detailItems" :is-dark="isDark" :session-id="sessionId"
            :file-edits="message.fileEdits" :is-message-complete="message.isComplete"
            :message-is-suspended="Boolean(message.isSuspended)" :is-running-turn="isRunningTurn"
            :sub-sessions="subSessions" @select-sub-session="emit('selectSubSession', $event)" />
        </div>
      </div>
    </CollapseTransition>
  </div>
</template>
