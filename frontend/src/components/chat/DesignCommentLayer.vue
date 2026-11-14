<script setup lang="ts">
import {computed, ref} from 'vue';
import type {DesignCommentItem} from '../../composables/useDesignComments';

const props = defineProps<{
  comments: DesignCommentItem[];
  selectedLabel: string;
  selectedSelector: string;
  commentMode: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'toggleMode'): void;
  (e: 'addComment', text: string): void;
  (e: 'focusSelector', selector: string): void;
  (e: 'toggleResolve', id: string): void;
  (e: 'removeComment', id: string): void;
  (e: 'resolveAll'): void;
  (e: 'submitAll'): void;
}>();

const draft = ref('');
const unresolvedCount = computed(() => props.comments.filter(c => !c.resolved).length);

const handleAdd = (): void => {
  const clean = draft.value.trim();
  if (!clean || !props.selectedSelector) return;
  emit('addComment', clean);
  draft.value = '';
};
</script>

<template>
  <aside class="design-side-drawer" aria-label="画布评论">
    <header class="drawer-header">
      <div class="drawer-title">
        <span>元素评论</span>
        <span class="drawer-count">{{ unresolvedCount }}/{{ comments.length }}</span>
      </div>
      <div class="header-actions">
        <button
          type="button"
          class="mode-chip"
          :class="{ 'is-on': commentMode }"
          title="快捷键 C：点击画布元素快速定位评论"
          @click="emit('toggleMode')"
        >
          {{ commentMode ? '批注中 (C)' : '批注模式 (C)' }}
        </button>
        <button type="button" class="drawer-close-btn" title="关闭" @click="emit('close')">✕</button>
      </div>
    </header>

    <div class="comment-composer">
      <div v-if="selectedSelector" class="composer-target" :title="selectedSelector">
        目标：&lt;{{ selectedLabel }}&gt;
      </div>
      <div v-else class="composer-hint">
        点击画布内任意元素（或按 C 开启批注模式）以锚定评论
      </div>
      <div class="composer-row">
        <input
          v-model="draft"
          type="text"
          class="composer-input"
          :disabled="!selectedSelector"
          placeholder="输入对当前元素的修改意见…"
          @keydown.enter.prevent="handleAdd"
        />
        <button
          type="button"
          class="composer-add-btn"
          :disabled="!selectedSelector || !draft.trim()"
          @click="handleAdd"
        >
          添加
        </button>
      </div>
    </div>

    <div v-if="comments.length === 0" class="drawer-empty">
      还没有评论。可以在多个元素上分别留批注，最后点下方「全部交给 AI」一次改完。
    </div>

    <div v-else class="drawer-list">
      <div
        v-for="(item, idx) in comments"
        :key="item.id"
        class="comment-card"
        :class="{ 'is-resolved': item.resolved }"
        @click="emit('focusSelector', item.selector)"
      >
        <div class="comment-card-head">
          <span class="comment-pin">#{{ idx + 1 }}</span>
          <span class="comment-target" :title="item.selector">&lt;{{ item.elementLabel }}&gt;</span>
          <div class="comment-card-ops" @click.stop>
            <button
              type="button"
              class="op-btn"
              :title="item.resolved ? '标为未解决' : '标为已解决'"
              @click="emit('toggleResolve', item.id)"
            >
              {{ item.resolved ? '↺' : '✓' }}
            </button>
            <button
              type="button"
              class="op-btn is-danger"
              title="删除评论"
              @click="emit('removeComment', item.id)"
            >
              ✕
            </button>
          </div>
        </div>
        <div class="comment-text">{{ item.text }}</div>
      </div>
    </div>

    <footer v-if="comments.length > 0" class="drawer-footer">
      <button
        type="button"
        class="drawer-mini-btn"
        :disabled="unresolvedCount === 0"
        @click="emit('resolveAll')"
      >
        全部标为已解决
      </button>
      <button
        type="button"
        class="drawer-mini-btn is-primary"
        :disabled="unresolvedCount === 0"
        @click="emit('submitAll')"
      >
        全部交给 AI ({{ unresolvedCount }})
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.design-side-drawer {
  width: 288px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  color: var(--file-text, #18181b);
  height: 100%;
  overflow: hidden;
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--file-line, #e4e4e7);
}

.drawer-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}

.drawer-count {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--file-tab, #f4f4f5);
  color: var(--file-muted, #71717a);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mode-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-tab, #f4f4f5);
  color: inherit;
  cursor: pointer;
}

.mode-chip.is-on {
  border-color: var(--file-accent, #2563eb);
  background: var(--file-accent, #2563eb);
  color: #ffffff;
}

.drawer-close-btn {
  border: none;
  background: transparent;
  color: var(--file-muted, #71717a);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 4px;
}

.comment-composer {
  padding: 10px 12px;
  border-bottom: 1px solid var(--file-line, #e4e4e7);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.composer-target {
  font-size: 11px;
  font-weight: 600;
  color: var(--file-accent, #2563eb);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.composer-hint {
  font-size: 11px;
  color: var(--file-muted, #71717a);
}

.composer-row {
  display: flex;
  gap: 6px;
}

.composer-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-tab, #fafafa);
  color: inherit;
}

.composer-add-btn {
  font-size: 11px;
  font-weight: 600;
  padding: 5px 10px;
  border-radius: 6px;
  border: none;
  background: var(--file-accent, #2563eb);
  color: #ffffff;
  cursor: pointer;
}

.composer-add-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.drawer-empty {
  padding: 24px 16px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--file-muted, #71717a);
  text-align: center;
}

.drawer-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.comment-card {
  border: 1px solid var(--file-line, #e4e4e7);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--file-tab, #fafafa);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.comment-card:hover {
  border-color: var(--file-accent, #2563eb);
}

.comment-card.is-resolved {
  opacity: 0.55;
}

.comment-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.comment-pin {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--file-accent, #2563eb);
  color: #ffffff;
}

.comment-target {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.comment-card-ops {
  display: flex;
  gap: 2px;
}

.op-btn {
  border: none;
  background: transparent;
  color: var(--file-muted, #71717a);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 5px;
  border-radius: 4px;
}

.op-btn:hover {
  background: var(--file-bg, #ffffff);
  color: inherit;
}

.op-btn.is-danger:hover {
  color: #dc2626;
}

.comment-text {
  font-size: 12px;
  line-height: 1.45;
  word-break: break-word;
}

.drawer-footer {
  padding: 10px 12px;
  border-top: 1px solid var(--file-line, #e4e4e7);
  display: flex;
  gap: 6px;
}

.drawer-mini-btn {
  flex: 1;
  font-size: 11px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  color: inherit;
  cursor: pointer;
}

.drawer-mini-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.drawer-mini-btn.is-primary {
  background: var(--file-accent, #2563eb);
  border-color: var(--file-accent, #2563eb);
  color: #ffffff;
  font-weight: 600;
}
</style>
