<script setup lang="ts">
import {computed} from 'vue';
import type {ImageProcessItem} from '../../utils/readImageTools';
import type {SubItemStatus, SubSessionVO, ToolCallTrace} from '../../types/chat';
import {asyncSubSessionStatus} from '../../utils/asyncDelegation';
import {extractSubAgentParams} from '../../utils/toolMeta';

const props = defineProps<{
  item: ImageProcessItem;
  isDark: boolean;
  subSessions?: SubSessionVO[];
  onSelectSubSession: (id: string | number) => void;
}>();

const members = computed<ToolCallTrace[]>(() => props.item.subAgents ?? []);

const memberStatus = (tool: ToolCallTrace): SubItemStatus => {
  const params = extractSubAgentParams(tool);
  const agentId = params.agentId ?? tool.subAgentId;
  const subSessionId = tool.subSessionId ?? params.subSessionId;
  const matched = (subSessionId
    ? props.subSessions?.find(item => String(item.id) === String(subSessionId))
    : undefined)
    || (agentId ? props.subSessions?.find(item => String(item.agentId) === String(agentId)) : undefined);
  return asyncSubSessionStatus(matched, tool);
};

const completedCount = computed(() =>
  members.value.filter(tc => memberStatus(tc) === 'completed').length,
);
const progressPct = computed(() =>
  members.value.length ? Math.round((completedCount.value / members.value.length) * 100) : 0,
);

/** 终端里用一个字符表达状态，比彩色胶囊更省宽度也更容易扫读。 */
const statusGlyph = (status: SubItemStatus): string => {
  if (status === 'running') return '⋯';
  if (status === 'failed' || status === 'cancelled') return '✕';
  if (status === 'completed') return '✓';
  return '·';
};

const statusColor = (status: SubItemStatus): string => {
  if (status === 'running') return 'var(--lx-info)';
  if (status === 'failed' || status === 'cancelled') return 'var(--lx-danger)';
  if (status === 'completed') return 'var(--lx-success)';
  return 'var(--lx-warning)';
};
</script>

<!--
  协同矩阵 HUD（内置 Slot 极限）→ 终端里的进程表。
  一个头部（几个 agent、跑完几个）+ 若干行成员，行内点击跳子会话。
-->
<template>
  <div
    v-if="members.length"
    data-slot="process-sub-agent"
    class="tui-agents w-full overflow-hidden"
    :style="{
      backgroundColor: 'color-mix(in srgb, var(--lx-surface-sunken) 94%, var(--lx-accent) 6%)',
      borderColor: 'color-mix(in srgb, var(--lx-accent) 28%, var(--lx-border-default))',
    }"
  >
    <div class="tui-head flex items-center justify-between gap-2 px-3 py-1.5">
      <div class="flex min-w-0 items-center gap-2">
        <span class="tui-mark" :style="{ color: 'var(--lx-accent)' }">⛬</span>
        <span class="tui-label" :style="{ color: 'var(--lx-accent)' }">agents</span>
        <span class="tui-progress" :style="{ backgroundColor: 'var(--lx-surface-hover)' }">
          <span :style="{ width: `${progressPct}%`, backgroundColor: 'var(--lx-success)' }" />
        </span>
      </div>
      <span class="tui-meta tabular-nums">{{ completedCount }}/{{ members.length }} done</span>
    </div>

    <div class="pb-1">
      <button
        v-for="(tc, idx) in members"
        :key="tc.id || idx"
        type="button"
        class="tui-node flex w-full items-center gap-2 px-3 py-1 text-left cursor-pointer"
        @click="props.onSelectSubSession(tc.subSessionId || tc.id)"
      >
        <span class="tui-glyph shrink-0" :style="{ color: statusColor(memberStatus(tc)) }">{{ statusGlyph(memberStatus(tc)) }}</span>
        <span class="tui-node-name truncate" :style="{ color: 'var(--lx-text-secondary)' }">
          {{ tc.subAgentName || `agent#${tc.displayIndex || idx + 1}` }}
        </span>
        <span class="tui-node-status shrink-0" :style="{ color: statusColor(memberStatus(tc)) }">
          [{{ memberStatus(tc) }}]
        </span>
        <span class="tui-enter shrink-0" aria-hidden="true">↗</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.tui-agents {
  border: 1px solid;
  border-radius: 4px;
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
.tui-head { border-bottom: 1px solid var(--lx-border-subtle); }
.tui-mark { font-size: 12px; line-height: 1; }
.tui-label { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; }
.tui-meta { font-size: 10px; color: var(--lx-text-faint); letter-spacing: 0.04em; }

.tui-progress {
  display: inline-block;
  width: 56px;
  height: 4px;
  overflow: hidden;
  border-radius: 1px;
}
.tui-progress > span { display: block; height: 100%; transition: width 0.3s ease; }

.tui-node {
  position: relative;
  font-size: 11px;
  transition: background-color 0.15s ease;
}
.tui-node::before {
  content: '';
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  width: 2px;
  background: var(--lx-accent);
  opacity: 0;
  transition: opacity 0.15s ease;
}
.tui-node:hover { background-color: var(--lx-surface-hover); }
.tui-node:hover::before { opacity: 1; }

.tui-glyph { font-size: 11px; width: 10px; text-align: center; }
.tui-node-name { font-size: 11.5px; }
.tui-node-status { font-size: 10px; letter-spacing: 0.04em; }
.tui-enter { font-size: 10px; color: var(--lx-text-faint); opacity: 0; transition: opacity 0.15s ease; }
.tui-node:hover .tui-enter { opacity: 1; }
</style>
