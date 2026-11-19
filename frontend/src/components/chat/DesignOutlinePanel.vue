<script setup lang="ts">
import type {DesignOutlineNode} from '../../utils/designCanvasHelpers';

defineProps<{
  nodes: DesignOutlineNode[];
  selectedSelector: string;
}>();

const emit = defineEmits<{
  (e: 'select', index: number): void;
  (e: 'move', payload: { index: number; direction: 'up' | 'down' }): void;
  (e: 'toggleVisibility', index: number): void;
  (e: 'remove', index: number): void;
  (e: 'close'): void;
}>();
</script>

<template>
  <aside class="outline-panel">
    <div class="outline-header">
      <span class="outline-title">DOM 层级 ({{ nodes.length }})</span>
      <button type="button" class="outline-close" title="关闭" @click="emit('close')">×</button>
    </div>

    <div v-if="nodes.length === 0" class="outline-empty">
      当前画布暂无可编辑节点
    </div>

    <div v-else class="outline-list">
      <div
        v-for="(node, index) in nodes"
        :key="node.id"
        class="outline-row"
        :class="{
          'is-selected': selectedSelector && node.selector === selectedSelector,
          'is-hidden': node.hidden,
        }"
        :style="{ paddingLeft: `${8 + Math.min(node.depth, 6) * 12}px` }"
        @click="emit('select', index)"
      >
        <span class="outline-label" :title="node.selector">{{ node.label }}</span>
        <div class="outline-actions" @click.stop>
          <button
            type="button"
            class="outline-act-btn"
            :disabled="!node.canMoveUp"
            title="上移同级节点"
            @click="emit('move', { index, direction: 'up' })"
          >
            ↑
          </button>
          <button
            type="button"
            class="outline-act-btn"
            :disabled="!node.canMoveDown"
            title="下移同级节点"
            @click="emit('move', { index, direction: 'down' })"
          >
            ↓
          </button>
          <button
            type="button"
            class="outline-act-btn"
            :title="node.hidden ? '显示元素' : '隐藏元素'"
            @click="emit('toggleVisibility', index)"
          >
            {{ node.hidden ? '显' : '隐' }}
          </button>
          <button
            type="button"
            class="outline-act-btn is-danger"
            title="删除元素"
            @click="emit('remove', index)"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.outline-panel {
  width: 248px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  color: var(--file-ink, #18181b);
  min-height: 0;
}

.outline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--file-line, #e4e4e7);
  flex-shrink: 0;
}

.outline-title {
  font-size: 12px;
  font-weight: 600;
}

.outline-close {
  border: 0;
  background: transparent;
  color: var(--file-muted, #71717a);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 5px;
}

.outline-close:hover {
  background: var(--file-tab, #f4f4f5);
  color: var(--file-ink, #18181b);
}

.outline-empty {
  padding: 20px 12px;
  font-size: 12px;
  color: var(--file-muted, #71717a);
  text-align: center;
}

.outline-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.outline-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
  transition: background-color 0.12s;
}

.outline-row:hover {
  background: var(--file-tab, #f4f4f5);
}

.outline-row.is-selected {
  background: rgba(59, 130, 246, 0.12);
  color: #2563eb;
  font-weight: 600;
}

.outline-row.is-hidden .outline-label {
  opacity: 0.45;
  text-decoration: line-through;
}

.outline-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.outline-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0.25;
  transition: opacity 0.12s;
  flex-shrink: 0;
}

.outline-row:hover .outline-actions,
.outline-row.is-selected .outline-actions {
  opacity: 1;
}

.outline-act-btn {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 4px;
  line-height: 1.2;
}

.outline-act-btn:hover:not(:disabled) {
  background: var(--file-line, #e4e4e7);
}

.outline-act-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.outline-act-btn.is-danger:hover {
  color: #dc2626;
}
</style>
