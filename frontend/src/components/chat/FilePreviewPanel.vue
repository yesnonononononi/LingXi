<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref } from 'vue';
import type { FilePreviewTab } from '../../types/filePreview';
import { useCopyFeedback } from '../../composables/useCopyFeedback';

const props = defineProps<{
  tabs: FilePreviewTab[];
  activeId: string;
  isDark: boolean;
}>();
const emit = defineEmits<{
  (e: 'activate', id: string): void;
  (e: 'closeTab', id: string): void;
  (e: 'close'): void;
  (e: 'refresh', tab: FilePreviewTab): void;
  (e: 'open'): void;
  (e: 'reveal'): void;
}>();

const active = computed(() => props.tabs.find(tab => tab.id === props.activeId));
const CodePreview = defineAsyncComponent(() => import('../common/CodePreview.vue'));
const maximized = ref(false);
const panelWidth = ref(540);
const { copy, isCopied } = useCopyFeedback();
let dragStart: { x: number; width: number } | undefined;

const moveResize = (event: PointerEvent) => {
  if (!dragStart) return;
  panelWidth.value = Math.max(320, Math.min(window.innerWidth - 360, dragStart.width + dragStart.x - event.clientX));
};
const stopResize = () => {
  dragStart = undefined;
  window.removeEventListener('pointermove', moveResize);
  window.removeEventListener('pointerup', stopResize);
  window.removeEventListener('pointercancel', stopResize);
};
const startResize = (event: PointerEvent) => {
  if (event.button !== 0) return;
  event.preventDefault();
  dragStart = { x: event.clientX, width: panelWidth.value };
  window.addEventListener('pointermove', moveResize);
  window.addEventListener('pointerup', stopResize);
  window.addEventListener('pointercancel', stopResize);
};
onBeforeUnmount(stopResize);
</script>

<template>
  <aside
    class="file-preview-panel"
    :class="{ 'is-dark': isDark, 'is-maximized': maximized }"
    :style="{ width: maximized ? undefined : `${panelWidth}px` }"
    aria-label="文件预览"
    @keydown.esc="!$event.defaultPrevented && (maximized ? maximized = false : emit('close'))"
  >
    <div v-if="!maximized" class="resize-handle" role="separator" aria-label="调整文件预览宽度" aria-orientation="vertical" tabindex="0"
      @pointerdown="startResize" @keydown.left.prevent="panelWidth = Math.min(panelWidth + 32, 1000)" @keydown.right.prevent="panelWidth = Math.max(panelWidth - 32, 320)" />
    <header class="preview-topbar">
      <span class="panel-title">文件预览</span>
      <div class="topbar-actions">
        <button type="button" :title="maximized ? '还原面板' : '最大化预览'" :aria-label="maximized ? '还原面板' : '最大化预览'" @click="maximized = !maximized">{{ maximized ? '还原' : '展开' }}</button>
        <button type="button" aria-label="关闭文件预览" title="关闭文件预览" @click="emit('close')">✕</button>
      </div>
    </header>
    <div class="file-tabs" role="tablist" aria-label="已打开的文件">
      <div v-for="tab in tabs" :key="tab.id" class="file-tab" :class="{ selected: tab.id === activeId }">
        <button type="button" role="tab" :aria-selected="tab.id === activeId" :title="tab.request.path" @click="emit('activate', tab.id)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" /></svg>
          <span>{{ tab.name }}</span>
        </button>
        <button type="button" :aria-label="`关闭 ${tab.name}`" @click="emit('closeTab', tab.id)">×</button>
      </div>
    </div>
    <template v-if="active">
      <div class="preview-toolbar">
        <div class="file-heading" :title="active.data?.path ?? active.request.path">
          <strong>{{ active.name }}</strong>
          <span>{{ active.data?.path ?? active.request.path }}</span>
        </div>
        <div class="toolbar-actions">
          <button type="button" :disabled="!active.data" @click="copy(active.data?.content ?? '')">{{ isCopied ? '已复制' : '复制' }}</button>
          <button type="button" :disabled="active.loading" @click="emit('refresh', active)">刷新</button>
          <button type="button" title="用系统默认程序打开" @click="emit('open')">打开</button>
          <button type="button" title="在文件夹中显示" @click="emit('reveal')">定位</button>
        </div>
      </div>
      <div v-if="active.error" class="preview-error" role="alert">
        <span>{{ active.error }}</span>
        <button type="button" :disabled="active.loading" @click="emit('refresh', active)">重试</button>
      </div>
      <div class="code-preview" role="tabpanel" aria-label="文件代码">
        <CodePreview v-show="!!active.data" :tabs="tabs" :activeId="activeId" :isDark="isDark" />
        <div v-if="active.loading && !active.data" class="preview-placeholder" role="status">正在读取文件…</div>
        <div v-else-if="!active.data" class="preview-placeholder">暂无可预览的内容</div>
      </div>
      <footer class="preview-status">
        <span>{{ active.loading ? '正在刷新…' : active.error && active.data ? '显示上次读取的内容' : active.data?.watchId ? '文件变化时自动刷新' : '只读预览' }}</span>
        <span v-if="active.data">{{ active.data.encoding }} · {{ Math.ceil(active.data.size / 1024) }} KB</span>
      </footer>
      <div v-if="active.data?.truncated" class="preview-truncated">文件较大，仅显示前 256 KB 或 3000 行，可用外部编辑器查看完整内容。</div>
    </template>
  </aside>
</template>

<style scoped>
.file-preview-panel { --file-bg: #fff; --file-muted: #71717a; --file-line: #e4e4e7; --file-tab: #f4f4f5; position: relative; flex: none; display: flex; flex-direction: column; height: 100%; min-width: 0; max-width: calc(100vw - 360px); color: #27272a; background: var(--file-bg); border-left: 1px solid var(--file-line); }
.file-preview-panel.is-dark { --file-bg: #0c0e13; --file-muted: #8b92a1; --file-line: #252933; --file-tab: #1b1f29; color: #e4e4e7; }
.file-preview-panel.is-maximized { position: absolute; inset: 0; z-index: 40; width: 100%; max-width: none; }
.resize-handle { position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; cursor: col-resize; z-index: 5; touch-action: none; }
.resize-handle:hover, .resize-handle:focus-visible { background: #6366f140; }
.preview-topbar, .preview-toolbar, .preview-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; }
.preview-topbar { border-bottom: 1px solid var(--file-line); }
.panel-title { font-size: 13px; font-weight: 600; }
.topbar-actions, .toolbar-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
button { cursor: pointer; color: inherit; background: transparent; border: 0; border-radius: 6px; padding: 5px 7px; font-size: 12px; }
button:hover { background: var(--file-tab); }
button:focus-visible { outline: 2px solid #6366f1; outline-offset: -2px; }
button:disabled { opacity: .4; cursor: default; }
.file-tabs { display: flex; flex-shrink: 0; gap: 4px; padding: 8px 10px; overflow-x: auto; border-bottom: 1px solid var(--file-line); }
.file-tab { display: flex; align-items: center; border-radius: 8px; color: var(--file-muted); flex-shrink: 0; }
.file-tab.selected { background: var(--file-tab); color: inherit; }
.file-tab [role=tab] { display: flex; align-items: center; gap: 7px; max-width: 180px; padding: 7px 8px; }
.file-tab span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-tab > button:last-child { font-size: 18px; padding: 2px 7px; }
.preview-toolbar { align-items: flex-start; flex-wrap: wrap; padding-bottom: 14px; }
.file-heading { display: flex; flex-direction: column; gap: 5px; min-width: 0; flex: 1; }
.file-heading strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-heading > span { font-size: 11px; color: var(--file-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.code-preview { flex: 1; min-height: 0; overflow: hidden; }
.preview-placeholder { height: 100%; display: grid; place-items: center; font-size: 13px; color: var(--file-muted); }
.preview-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px; font-size: 12px; color: #dc2626; background: #ef444410; }
.preview-status { font-size: 11px; color: var(--file-muted); padding: 9px 14px; border-top: 1px solid var(--file-line); }
.preview-truncated { padding: 6px 14px; font-size: 11px; color: #b45309; background: #f59e0b10; }
@media (max-width: 900px) { .file-preview-panel { position: absolute; inset: 0; z-index: 40; width: 100% !important; max-width: none; } .resize-handle { display: none; } }
</style>
