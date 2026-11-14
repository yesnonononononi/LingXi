<script setup lang="ts">
import {computed, ref} from 'vue';
import {
  computeDesignVersionDiff,
  type DesignVersionEntry,
} from '../../composables/useDesignVersions';

const props = defineProps<{
  versions: DesignVersionEntry[];
  currentHtml: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'restore', entry: DesignVersionEntry): void;
}>();

const comparingId = ref<string | null>(null);

const activeDiff = computed(() => {
  if (!comparingId.value) return null;
  const target = props.versions.find(v => v.id === comparingId.value);
  if (!target) return null;
  return computeDesignVersionDiff(target.html, props.currentHtml);
});

const toggleCompare = (id: string): void => {
  comparingId.value = comparingId.value === id ? null : id;
};

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};
</script>

<template>
  <aside class="design-side-drawer" aria-label="版本历史">
    <header class="drawer-header">
      <div class="drawer-title">
        <span>版本历史</span>
        <span class="drawer-count">{{ versions.length }}</span>
      </div>
      <button type="button" class="drawer-close-btn" title="关闭" @click="emit('close')">✕</button>
    </header>

    <div v-if="versions.length === 0" class="drawer-empty">
      暂无版本记录。加载、保存或由 AI 更新画布后会自动生成快照。
    </div>

    <div v-else class="drawer-list">
      <div v-for="(ver, idx) in versions" :key="ver.id" class="version-card">
        <div class="version-card-head">
          <span class="version-badge" :class="`is-${ver.source}`">{{ ver.label }}</span>
          <span class="version-time">{{ formatTime(ver.createdAt) }}</span>
        </div>
        <div class="version-meta">
          <span>{{ idx === 0 ? '最新快照' : `v${versions.length - idx}` }}</span>
          <span>{{ ver.lineCount }} 行 · {{ Math.max(1, Math.round(ver.charCount / 1024)) }} KB</span>
        </div>
        <div class="version-actions">
          <button
            type="button"
            class="drawer-mini-btn"
            :class="{ 'is-active': comparingId === ver.id }"
            @click="toggleCompare(ver.id)"
          >
            {{ comparingId === ver.id ? '收起对比' : '对比当前' }}
          </button>
          <button
            type="button"
            class="drawer-mini-btn is-primary"
            @click="emit('restore', ver)"
          >
            回退到此版本
          </button>
        </div>

        <div v-if="comparingId === ver.id && activeDiff" class="version-diff-box">
          <div class="version-diff-summary">
            <span class="diff-add">+{{ activeDiff.added }}</span>
            <span class="diff-del">-{{ activeDiff.removed }}</span>
            <span v-if="activeDiff.lines.length === 0" class="diff-same">与当前画布一致</span>
          </div>
          <div v-if="activeDiff.lines.length > 0" class="version-diff-lines">
            <div
              v-for="(line, lIdx) in activeDiff.lines"
              :key="lIdx"
              class="version-diff-line"
              :class="`is-${line.kind}`"
            >
              <span class="diff-sigil">{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ' }}</span>
              <span class="diff-text">{{ line.text }}</span>
            </div>
            <div v-if="activeDiff.truncated" class="version-diff-truncated">差异较多，已截断显示</div>
          </div>
        </div>
      </div>
    </div>
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

.drawer-close-btn {
  border: none;
  background: transparent;
  color: var(--file-muted, #71717a);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 4px;
}

.drawer-close-btn:hover {
  background: var(--file-tab, #f4f4f5);
  color: inherit;
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

.version-card {
  border: 1px solid var(--file-line, #e4e4e7);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--file-tab, #fafafa);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.version-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.version-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--file-bg, #ffffff);
  border: 1px solid var(--file-line, #e4e4e7);
}

.version-badge.is-ai {
  color: #047857;
  border-color: #a7f3d0;
  background: #ecfdf5;
}

.version-badge.is-manual {
  color: #1d4ed8;
  border-color: #bfdbfe;
  background: #eff6ff;
}

.version-badge.is-restore {
  color: #b45309;
  border-color: #fde68a;
  background: #fef3c7;
}

.version-time {
  font-size: 11px;
  color: var(--file-muted, #71717a);
  font-variant-numeric: tabular-nums;
}

.version-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--file-muted, #71717a);
}

.version-actions {
  display: flex;
  gap: 6px;
}

.drawer-mini-btn {
  flex: 1;
  font-size: 11px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #ffffff);
  color: inherit;
  cursor: pointer;
}

.drawer-mini-btn.is-active {
  border-color: var(--file-accent, #2563eb);
  color: var(--file-accent, #2563eb);
}

.drawer-mini-btn.is-primary {
  background: var(--file-accent, #2563eb);
  border-color: var(--file-accent, #2563eb);
  color: #ffffff;
}

.version-diff-box {
  margin-top: 4px;
  border-top: 1px solid var(--file-line, #e4e4e7);
  padding-top: 6px;
}

.version-diff-summary {
  display: flex;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 4px;
}

.diff-add { color: #059669; }
.diff-del { color: #dc2626; }
.diff-same { color: var(--file-muted, #71717a); font-weight: 400; }

.version-diff-lines {
  max-height: 180px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 10px;
  line-height: 1.45;
  background: var(--file-bg, #ffffff);
  border: 1px solid var(--file-line, #e4e4e7);
  border-radius: 6px;
  padding: 4px;
}

.version-diff-line {
  display: flex;
  gap: 4px;
  white-space: pre;
}

.version-diff-line.is-add { background: rgba(16, 185, 129, 0.12); color: #047857; }
.version-diff-line.is-del { background: rgba(239, 68, 68, 0.12); color: #b91c1c; }

.version-diff-truncated {
  padding: 4px;
  font-size: 10px;
  color: var(--file-muted, #71717a);
  text-align: center;
}
</style>
