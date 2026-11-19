<script setup lang="ts">
import {computed, inject, ref} from 'vue';
import type {ImageProcessItem} from '../../utils/readImageTools';
import type {ChatMessage} from '../../types/chat';
import {isFileMutationTool, isReadFileTool, unwrapToolResultEnvelope} from '../../utils/toolMeta';
import {resolveToolRenderName} from '../../utils/toolDisplayNames';
import {buildEditDiffLines, canExpandToolRow, isToolInProgress, resolveToolRowDiff, resolveToolRowMeta} from '../../utils/toolRowUi';
import {useCopyFeedback} from '../../composables/useCopyFeedback';
import {FILE_PREVIEW_KEY} from '../../types/filePreview';
import {PROCESS_SEGMENT_SCROLL_KEY} from '../../types/processScroll';

const props = defineProps<{
  item: ImageProcessItem;
  isDark: boolean;
  sessionId?: string | number;
  fileEdits?: ChatMessage['fileEdits'];
}>();

const tool = computed(() => props.item.tool);
const meta = computed(() => (tool.value ? resolveToolRowMeta(tool.value) : null));
const diff = computed(() => (tool.value ? resolveToolRowDiff(tool.value, props.fileEdits) : null));
const expandable = computed(() => !!tool.value && canExpandToolRow(tool.value.toolName));
const running = computed(() => !!tool.value && isToolInProgress(tool.value.status));
const failed = computed(() => tool.value?.status === 'failed');
const diffLines = computed(() => (tool.value ? buildEditDiffLines({
  query: tool.value.query,
  oldStartLine: tool.value.oldStartLine,
  newStartLine: tool.value.newStartLine,
}) : null));

const diffRatio = computed(() => {
  if (!diff.value) return 0;
  const plus = diff.value.plusLines ?? 0;
  const minus = diff.value.minusLines ?? 0;
  const total = plus + minus;
  return total > 0 ? Math.round((plus / total) * 100) : 50;
});

const expanded = ref(false);
const activeTab = ref<'output' | 'args'>('output');
const segmentScroll = inject(PROCESS_SEGMENT_SCROLL_KEY, null);
const toggle = (): void => {
  if (!expandable.value) return;
  segmentScroll?.pauseAutoFollow();
  expanded.value = !expanded.value;
};

const openFilePreview = inject(FILE_PREVIEW_KEY, null);
const canPreviewFile = computed(() => !!openFilePreview && !!tool.value
  && (isReadFileTool(tool.value.toolName) || isFileMutationTool(tool.value.toolName)));

const previewTarget = (): void => {
  if (!tool.value || !canPreviewFile.value) return;
  const { executionId, recordId } = tool.value;
  const edit = isFileMutationTool(tool.value.toolName) && executionId && recordId ? { executionId, recordId } : undefined;
  openFilePreview?.({ sessionId: props.sessionId, path: meta.value?.target ?? '', edit });
};

const { copiedKey, copy } = useCopyFeedback();
const copyResult = (): void => {
  if (!tool.value) return;
  copy(unwrapToolResultEnvelope(tool.value.result), tool.value.id);
};

/** 终端里的一行调用：`⏵ name target`，状态用方括号文本而不是彩点。 */
const statusText = computed(() => (running.value ? 'run' : failed.value ? 'err' : 'ok'));
</script>

<!--
  工坊执行卡片（内置 Slot 极限）→ 终端里的单行调用记录。
  终端的强项是「一行一条命令」，所以默认只占一行：动作、目标、改动量、退出状态。
  详情收进抽屉，输出按等宽原始文本呈现，不做卡片套卡片。
-->
<template>
  <div
    v-if="tool"
    data-slot="process-tool"
    class="tui-call w-full overflow-hidden transition-colors duration-200"
    :style="{
      backgroundColor: 'var(--lx-surface-sunken)',
      borderColor: running ? 'color-mix(in srgb, var(--lx-warning) 45%, var(--lx-border-default))' : 'var(--lx-border-subtle)',
    }"
  >
    <div class="flex items-center gap-2 px-2.5 py-1.5">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer"
        @click="toggle"
      >
        <span class="tui-sign shrink-0" :style="{ color: running ? 'var(--lx-warning)' : failed ? 'var(--lx-danger)' : 'var(--lx-success)' }">
          {{ running ? '⋯' : failed ? '✕' : '⏵' }}
        </span>
        <span class="tui-name shrink-0" :style="{ color: 'var(--lx-text-primary)' }">{{ resolveToolRenderName(tool.toolName) }}</span>
        <span
          v-if="meta?.target"
          class="tui-target truncate"
          :class="canPreviewFile ? 'tui-target--link' : ''"
          :style="{ color: canPreviewFile ? 'var(--lx-accent)' : 'var(--lx-text-muted)' }"
          @click.stop="canPreviewFile ? previewTarget() : toggle()"
        >{{ meta.target }}</span>
      </button>

      <div class="tui-meta flex shrink-0 items-center gap-2">
        <span v-if="diff" class="tui-diff flex items-center gap-1 tabular-nums">
          <span :style="{ color: 'var(--lx-success)' }">+{{ diff.plusLines ?? 0 }}</span>
          <span class="tui-ratio" :style="{ backgroundColor: 'var(--lx-danger-soft)' }">
            <span :style="{ width: `${diffRatio}%`, backgroundColor: 'var(--lx-success)' }" />
          </span>
          <span :style="{ color: 'var(--lx-danger)' }">-{{ diff.minusLines ?? 0 }}</span>
        </span>
        <span
          class="tui-status"
          :style="{ color: running ? 'var(--lx-warning)' : failed ? 'var(--lx-danger)' : 'var(--lx-success)' }"
        >[{{ statusText }}]</span>
        <span v-if="expandable" class="tui-chev" :class="expanded ? 'is-open' : ''" @click="toggle">›</span>
      </div>
    </div>

    <div
      v-if="expanded"
      class="tui-drawer"
      :style="{ borderColor: 'var(--lx-border-subtle)', backgroundColor: 'var(--lx-canvas-subtle)' }"
    >
      <div class="flex items-center justify-between gap-2 px-2.5 py-1" :style="{ borderColor: 'var(--lx-border-subtle)' }">
        <div class="flex items-center gap-3">
          <button type="button" class="tui-tab" :data-active="activeTab === 'output' ? 'true' : 'false'" @click="activeTab = 'output'">
            {{ diffLines?.length ? 'diff' : 'stdout' }}
          </button>
          <button v-if="tool.query" type="button" class="tui-tab" :data-active="activeTab === 'args' ? 'true' : 'false'" @click="activeTab = 'args'">
            argv
          </button>
        </div>
        <button v-if="tool.result" type="button" class="tui-btn" :data-active="copiedKey === tool.id ? 'true' : 'false'" @click="copyResult">
          {{ copiedKey === tool.id ? 'copied' : 'copy' }}
        </button>
      </div>

      <div class="max-h-64 overflow-y-auto px-2.5 py-2">
        <template v-if="activeTab === 'output'">
          <div v-if="diffLines?.length" class="tui-out">
            <div
              v-for="(line, idx) in diffLines"
              :key="idx"
              class="whitespace-pre-wrap break-all"
              :style="{
                backgroundColor: line.kind === 'add' ? 'var(--lx-diff-add-bg)' : line.kind === 'del' ? 'var(--lx-diff-del-bg)' : 'transparent',
                color: 'var(--lx-code-text)',
              }"
            >{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ' }} {{ line.text }}</div>
          </div>
          <pre v-else-if="tool.result" class="tui-out whitespace-pre-wrap break-all" :style="{ color: 'var(--lx-code-text)' }">{{ unwrapToolResultEnvelope(tool.result) }}</pre>
          <span v-else class="tui-out" :style="{ color: 'var(--lx-text-faint)' }">(no output)</span>
        </template>
        <pre v-else class="tui-out whitespace-pre-wrap break-all" :style="{ color: 'var(--lx-text-secondary)' }">{{ tool.query }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tui-call {
  border: 1px solid;
  border-radius: 4px;
  font-family: var(--font-lx-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
.tui-sign { font-size: 11px; line-height: 1; width: 10px; text-align: center; }
.tui-name { font-size: 11.5px; letter-spacing: 0.01em; }
.tui-target { font-size: 11px; }
.tui-target--link:hover { text-decoration: underline; }

.tui-meta { font-size: 10px; color: var(--lx-text-faint); }
.tui-diff { letter-spacing: 0.02em; }
.tui-ratio {
  display: inline-block;
  height: 6px;
  width: 34px;
  overflow: hidden;
  border-radius: 1px;
}
.tui-ratio > span { display: block; height: 100%; }
.tui-status { letter-spacing: 0.05em; }

.tui-chev {
  display: inline-block;
  color: var(--lx-text-faint);
  cursor: pointer;
  transition: transform 0.18s ease;
}
.tui-chev.is-open { transform: rotate(90deg); }

.tui-drawer { border-top: 1px solid; }
.tui-drawer > div:first-child { border-bottom: 1px solid; }

.tui-tab {
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--lx-text-faint);
  background: transparent;
  border: 0;
  border-bottom: 1px solid transparent;
  padding: 1px 0;
  cursor: pointer;
}
.tui-tab[data-active='true'] { color: var(--lx-accent); border-bottom-color: var(--lx-accent); }

.tui-btn {
  padding: 1px 6px;
  font-size: 10px;
  color: var(--lx-text-muted);
  background: transparent;
  border: 1px solid var(--lx-border-subtle);
  border-radius: 3px;
  cursor: pointer;
}
.tui-btn:hover { color: var(--lx-accent); border-color: var(--lx-accent); }
.tui-btn[data-active='true'] { color: var(--lx-success); border-color: var(--lx-success); }

.tui-out { font-size: 11.5px; line-height: 1.65; }
</style>
