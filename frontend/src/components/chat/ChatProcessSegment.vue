<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ChatMessage, ChatTurn, SubSessionVO } from '../../types/chat';
import type { ProcessSegment } from '../../utils/processSegments';
import { summarizeProcess } from '../../utils/processSegments';
import { resolveToolRenderName } from '../../utils/toolDisplayNames';
import { resolveToolMeta } from '../../utils/toolMeta';
import { t } from '../../i18n';
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
const operationTitle = computed(() => {
  const names = [...new Set(summary.value.toolNames.map(resolveToolRenderName))];
  if (!names.length) return t('tool.category.think');
  const text = names.slice(0, 3).join(t('chat.process.separator'));
  return names.length > 3 ? t('chat.process.moreOperations', { names: text, count: names.length }) : text;
});
const latest = computed(() => summary.value.latest);
const title = computed(() => {
  if (!props.active) return operationTitle.value;
  return latest.value?.tool ? resolveToolRenderName(latest.value.tool.toolName) : t('tool.category.think');
});
const preview = computed(() => {
  if (props.active) {
    const item = latest.value;
    if (item?.step) return item.step.content.slice(-320).replace(/\s+/g, ' ').trim();
    if (item?.tool) {
      const meta = resolveToolMeta({ toolName: item.tool.toolName, args: item.tool.args ?? item.tool.query });
      return meta.target.split(/[\\/]/).filter(Boolean).at(-1) || meta.description || meta.command;
    }
    return '';
  }
  const targets = summary.value.targets;
  const text = targets.slice(0, 3).join(t('chat.process.separator'));
  return targets.length > 3 ? t('chat.process.moreTargets', { targets: text, count: targets.length }) : text;
});
const statusLabel = computed(() => [
  summary.value.pendingCount ? t('chat.process.pending', { count: summary.value.pendingCount }) : '',
  summary.value.unknownCount ? t('chat.process.unknown', { count: summary.value.unknownCount }) : '',
  !props.active && summary.value.runningCount ? t('chat.process.running', { count: summary.value.runningCount }) : '',
].filter(Boolean).join(t('chat.process.separator')));
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
      <span v-if="active" class="h-1.5 w-1.5 shrink-0 rounded-full bg-current animate-pulse" aria-hidden="true"></span>
      <span class="min-w-0 max-w-[60%] truncate font-medium" data-testid="process-segment-title">{{ title }}</span>
      <span v-if="preview" class="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
        :class="active && latest?.step ? 'flex justify-end' : ''" data-testid="process-segment-preview">
        <span :class="active && latest?.step ? 'shrink-0 min-w-full text-left' : 'block truncate'">{{ preview }}</span>
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
