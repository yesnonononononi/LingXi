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
  active: boolean;
  visible?: boolean;
  subSessions?: SubSessionVO[];
  sessionId?: string | number;
  isDark: boolean;
}>(), { visible: true });
const emit = defineEmits<{ (e: 'selectSubSession', id: string | number): void }>();
// 只由用户操作改变，文本增长、终态和历史对账不能覆盖展开选择。
const expanded = ref(false);
const summary = computed(() => summarizeProcess(props.segment.items, props.subSessions));
const headline = computed(() => formatProcessHeadline(summary.value, { active: props.active }));
// 标题/预览/状态全部来自同一份纯函数，组件只决定排版：长正文右对齐溢出，短值截断。
const title = computed(() => headline.value.title);
const preview = computed(() => headline.value.preview);
const statusLabel = computed(() => headline.value.status);
const previewIsText = computed(() => headline.value.previewKind === 'text');
</script>

<template>
  <div class="w-full min-w-0" data-testid="process-segment" :data-segment-id="segment.id">
    <button type="button" data-testid="process-segment-toggle" :aria-expanded="expanded"
      :aria-label="[title, preview, statusLabel].filter(Boolean).join(' ')"
      class="flex w-full min-w-0 items-center gap-2 py-1 text-left text-xs cursor-pointer group"
      :class="isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-gray-500 hover:text-gray-700'"
      @click="expanded = !expanded">
      <svg class="h-3.5 w-3.5 shrink-0 transition-transform" :class="expanded ? 'rotate-90' : ''"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="m9 5 7 7-7 7" />
      </svg>
      <!-- 加载态由标题自身的扫光表达（见 styles/loading-sweep.css），不再另起呼吸点。 -->
      <span class="min-w-0 max-w-[60%] truncate font-medium" data-testid="process-segment-title"
        :class="{ 'lx-sweep-text': active }">{{ title }}</span>
      <span v-if="preview" class="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
        :class="previewIsText ? 'flex justify-end' : ''" data-testid="process-segment-preview">
        <span :class="previewIsText ? 'shrink-0 min-w-full text-left' : 'block truncate'">{{ preview }}</span>
      </span>
      <span v-if="statusLabel" class="shrink-0 max-w-[40%] truncate text-[11px] text-amber-600 dark:text-amber-400"
        data-testid="process-segment-status">{{ statusLabel }}</span>
    </button>
    <CollapseTransition>
      <div v-if="expanded && visible" class="mt-1 pl-3 border-l border-gray-200 dark:border-white/10" data-testid="process-segment-details">
        <ProcessDetails :items="segment.detailItems" :message="message" :turn="turn"
          :sub-sessions="subSessions" :session-id="sessionId" :is-dark="isDark"
          @select-sub-session="emit('selectSubSession', $event)" />
      </div>
    </CollapseTransition>
  </div>
</template>
