<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChatMessage, ChatTurn, SubSessionVO } from '../../types/chat';
import type { ProcessSegment } from '../../utils/processSegments';
import { summarizeProcess } from '../../utils/processSegments';
import { formatProcessHeadline } from '../../utils/processHeadline';
import CollapseTransition from '../common/CollapseTransition.vue';
import ProcessDetails from './ProcessDetails.vue';

const props = withDefaults(defineProps<{
  segment: ProcessSegment;
  message: ChatMessage;
  turn?: ChatTurn | null;
  ongoing: boolean;
  visible?: boolean;
  subSessions?: SubSessionVO[];
  sessionId?: string | number;
  isDark: boolean;
}>(), { visible: true });
const emit = defineEmits<{ (e: 'selectSubSession', id: string | number): void }>();
const summary = computed(() => summarizeProcess(props.segment.items, props.subSessions));
// 文本只划分位置；段内仍在运行或等待收尾时，摘要不能替代实时过程。
const canSummarize = computed(() => !props.ongoing || (props.segment.closed
  && summary.value.runningCount === 0 && summary.value.pendingCount === 0));
const expanded = ref(false);
const headline = computed(() => formatProcessHeadline(summary.value));
// 摘要文案共用同一份格式化规则，只有已收尾的段才渲染。
const title = computed(() => headline.value.title);
const preview = computed(() => headline.value.preview);
const statusLabel = computed(() => headline.value.status);
</script>

<template>
  <div class="w-full min-w-0" data-testid="process-segment" :data-segment-id="segment.id"
    :data-process-mode="canSummarize ? 'summary' : 'live'">
    <button v-if="canSummarize" type="button" data-testid="process-segment-toggle" :aria-expanded="expanded"
      :aria-label="[title, preview, statusLabel].filter(Boolean).join(' ')"
      class="flex w-full min-w-0 items-center gap-2 py-1 text-left text-xs cursor-pointer group"
      :class="isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'"
      @click="expanded = !expanded">
      <svg class="h-3.5 w-3.5 shrink-0 transition-transform" :class="expanded ? 'rotate-90' : ''"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
      </svg>
      <span class="min-w-0 max-w-[60%] truncate font-medium" data-testid="process-segment-title">{{ title }}</span>
      <span v-if="preview" class="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
        data-testid="process-segment-preview">
        <span class="block truncate">{{ preview }}</span>
      </span>
      <span v-if="statusLabel" class="shrink-0 max-w-[40%] truncate text-[11px] text-amber-600 dark:text-amber-400"
        data-testid="process-segment-status">{{ statusLabel }}</span>
    </button>
    <CollapseTransition>
      <div v-if="visible && (!canSummarize || expanded)"
        :class="canSummarize ? 'mt-1 pl-3 border-l border-zinc-200 dark:border-white/10' : ''" data-testid="process-segment-details">
        <ProcessDetails :items="segment.detailItems" :message="message" :turn="turn"
          :sub-sessions="subSessions" :session-id="sessionId" :is-dark="isDark"
          @select-sub-session="emit('selectSubSession', $event)" />
      </div>
    </CollapseTransition>
  </div>
</template>
