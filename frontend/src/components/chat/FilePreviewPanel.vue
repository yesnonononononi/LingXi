<script setup lang="ts">
import {computed, defineAsyncComponent, onBeforeUnmount, ref} from 'vue';
import type {FilePreviewTab} from '../../types/filePreview';
import type {PreviewPanelMode} from '../../types/projectPagePreview';
import {useCopyFeedback} from '../../composables/useCopyFeedback';
import {t} from '../../i18n';
import ProjectPagePreview from './ProjectPagePreview.vue';
import DesignCanvasPreview from './DesignCanvasPreview.vue';

/**
 * 预览面板外壳：顶栏（标题 / 模式切换 / 最大化 / 关闭）、拖拽调宽、最大化。
 *
 * <p>外壳与内容分离：文件模式渲染原有的标签 + 工具栏 + 代码区，页面模式只渲染
 * {@code ProjectPagePreview}，**不渲染**标签与代码区。`mode` 是可选的受控属性：
 * 父级绑定时走父级状态（v-model:mode），未绑定时用组件内部兜底状态，
 * 这样既保持既有的独立挂载（filePreview.smoke.cjs 只传 tabs/activeId/isDark）可用，
 * 又不会出现「点了模式按钮但状态没动」的双真源。</p>
 */
const props = defineProps<{
  tabs: FilePreviewTab[];
  activeId: string;
  isDark: boolean;
  /** 内容模式；省略时按 'file' 处理（保持旧调用方行为不变）。 */
  mode?: PreviewPanelMode;
}>();
const emit = defineEmits<{
  (e: 'activate', id: string): void;
  (e: 'closeTab', id: string): void;
  (e: 'close'): void;
  (e: 'refresh', tab: FilePreviewTab): void;
  (e: 'open'): void;
  (e: 'reveal'): void;
  (e: 'update:mode', mode: PreviewPanelMode): void;
}>();

/** 未受控时的兜底模式（受控时以 props.mode 为准）。 */
const internalMode = ref<PreviewPanelMode>('file');
const currentMode = computed<PreviewPanelMode>(() => props.mode ?? internalMode.value);
const isPageMode = computed<boolean>(() => currentMode.value === 'page');
const isDesignMode = computed<boolean>(() => currentMode.value === 'design');
const isFileMode = computed<boolean>(() => currentMode.value === 'file');

const active = computed(() => props.tabs.find(tab => tab.id === props.activeId));
const panelTitle = computed(() => {
  if (isDesignMode.value) return t('designPreview.title') || '设计原型预览';
  if (isPageMode.value) return t('projectPagePreview.title');
  return t('filePreview.title');
});
const CodePreview = defineAsyncComponent(() => import('../common/CodePreview.vue'));
const maximized = ref(false);
const panelWidth = ref(540);
const resizing = ref(false);
const { copy, isCopied } = useCopyFeedback();
let dragStart: { x: number; width: number } | undefined;

/**
 * 切换内容模式：内部状态先跟上，再通知父级（受控时父级会回写 props.mode）。
 *
 * @param mode 目标模式。
 */
const setMode = (mode: PreviewPanelMode): void => {
  if (mode !== 'file' && mode !== 'page' && mode !== 'design') return;
  if (internalMode.value !== mode) internalMode.value = mode;
  if (props.mode !== mode) emit('update:mode', mode);
};

const moveResize = (event: PointerEvent) => {
  if (!dragStart) return;
  panelWidth.value = Math.max(320, Math.min(window.innerWidth - 360, dragStart.width + dragStart.x - event.clientX));
};
const stopResize = () => {
  dragStart = undefined;
  resizing.value = false;
  window.removeEventListener('pointermove', moveResize);
  window.removeEventListener('pointerup', stopResize);
  window.removeEventListener('pointercancel', stopResize);
};
const startResize = (event: PointerEvent) => {
  if (event.button !== 0) return;
  event.preventDefault();
  resizing.value = true;
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
    :aria-label="panelTitle"
    @keydown.esc="!$event.defaultPrevented && (maximized ? maximized = false : emit('close'))"
  >
    <div v-if="!maximized" class="resize-handle" role="separator" :aria-label="t('filePreview.resizeAria')" aria-orientation="vertical" tabindex="0"
      @pointerdown="startResize" @keydown.left.prevent="panelWidth = Math.min(panelWidth + 32, 1000)" @keydown.right.prevent="panelWidth = Math.max(panelWidth - 32, 320)" />
    <header class="preview-topbar">
      <span class="panel-title">{{ panelTitle }}</span>
      <div class="topbar-actions">
        <!-- 模式切换：用 aria-pressed 双按钮而不是 role=tab（文件标签已占用 role=tab，语义不能混） -->
        <div class="mode-switch" role="group" :aria-label="t('filePreview.modeLabel')">
          <button type="button" :aria-pressed="isFileMode" :title="t('filePreview.modeFile')" @click="setMode('file')">{{ t('filePreview.modeFile') }}</button>
          <button type="button" :aria-pressed="isPageMode" :title="t('filePreview.modePage')" @click="setMode('page')">{{ t('filePreview.modePage') }}</button>
          <button type="button" :aria-pressed="isDesignMode" :title="t('filePreview.modeDesign')" @click="setMode('design')">{{ t('filePreview.modeDesign') }}</button>
        </div>
        <button type="button" :title="maximized ? t('filePreview.restorePanel') : t('filePreview.maximize')" :aria-label="maximized ? t('filePreview.restorePanel') : t('filePreview.maximize')" @click="maximized = !maximized">{{ maximized ? t('filePreview.restore') : t('common.expand') }}</button>
        <button type="button" :aria-label="t('filePreview.closePreview')" :title="t('filePreview.closePreview')" @click="emit('close')">✕</button>
      </div>
    </header>
    <template v-if="isFileMode">
      <div class="file-tabs" role="tablist" :aria-label="t('filePreview.openedFiles')">
        <div v-for="tab in tabs" :key="tab.id" class="file-tab" :class="{ selected: tab.id === activeId }">
          <button type="button" role="tab" :aria-selected="tab.id === activeId" :title="tab.request.path" @click="emit('activate', tab.id)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5" /></svg>
            <span>{{ tab.name }}</span>
          </button>
          <button type="button" :aria-label="t('filePreview.closeNamed', { name: tab.name })" @click="emit('closeTab', tab.id)">×</button>
        </div>
      </div>
      <!-- 文件正文自身判空（不再用 v-if="active" 包住整块）：页面模式没有 active 也必须能渲染别的内容 -->
      <div v-if="active" class="preview-toolbar">
        <div class="file-heading" :title="active.data?.path ?? active.request.path">
          <strong>{{ active.name }}</strong>
          <span>{{ active.data?.path ?? active.request.path }}</span>
        </div>
        <div class="toolbar-actions">
          <button type="button" :disabled="!active.data" @click="copy(active.data?.content ?? '')">{{ isCopied ? t('common.copied') : t('common.copy') }}</button>
          <button type="button" :disabled="active.loading" @click="emit('refresh', active)">{{ t('common.refresh') }}</button>
          <button type="button" :title="t('filePreview.openWithSystem')" @click="emit('open')">{{ t('common.open') }}</button>
          <button type="button" :title="t('filePreview.revealInFolder')" @click="emit('reveal')">{{ t('filePreview.reveal') }}</button>
        </div>
      </div>
      <div v-if="active?.error" class="preview-error" role="alert">
        <span>{{ active.error }}</span>
        <button type="button" :disabled="active.loading" @click="emit('refresh', active)">{{ t('common.retry') }}</button>
      </div>
      <div class="code-preview" :role="active ? 'tabpanel' : undefined" :aria-label="t('filePreview.codeAria')">
        <template v-if="active">
          <CodePreview v-show="!!active.data" :tabs="tabs" :activeId="activeId" :isDark="isDark" />
          <div v-if="active.loading && !active.data" class="preview-placeholder" role="status">{{ t('filePreview.reading') }}</div>
          <div v-else-if="!active.data" class="preview-placeholder">{{ t('filePreview.noContent') }}</div>
        </template>
        <div v-else class="preview-placeholder">{{ t('filePreview.noOpenFile') }}</div>
      </div>
      <footer v-if="active" class="preview-status">
        <span>{{ active.loading ? t('filePreview.refreshing') : active.error && active.data ? t('filePreview.showLastContent') : active.data?.watchId ? t('filePreview.autoRefresh') : t('filePreview.readOnly') }}</span>
        <span v-if="active.data">{{ active.data.encoding }} · {{ Math.ceil(active.data.size / 1024) }} KB</span>
      </footer>
      <div v-if="active?.data?.truncated" class="preview-truncated">{{ t('filePreview.truncated') }}</div>
    </template>
    <!-- 隐藏只暂停显示，页面状态由主进程保留；拖拽时让指针事件留在主页面。 -->
    <ProjectPagePreview v-show="isPageMode" :active="isPageMode && !resizing" class="page-preview-frame" />
    <DesignCanvasPreview v-if="isDesignMode" :active="isDesignMode" :tabs="tabs" :activeId="activeId" class="design-preview-frame" />
  </aside>
</template>

<style scoped>
.file-preview-panel { --file-bg: #fff; --file-muted: #71717a; --file-line: #e4e4e7; --file-tab: #f4f4f5; position: relative; flex: none; display: flex; flex-direction: column; height: 100%; min-width: 0; max-width: calc(100vw - 360px); color: #27272a; background: var(--file-bg); border-left: 1px solid var(--file-line); }
.file-preview-panel.is-dark { --file-bg: #0c0e13; --file-muted: #8b92a1; --file-line: #252933; --file-tab: #1b1f29; color: #e4e4e7; }
.file-preview-panel.is-maximized { position: absolute; inset: 0; z-index: 40; width: 100%; max-width: none; }
.resize-handle { position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; cursor: col-resize; z-index: 5; touch-action: none; }
.resize-handle:hover, .resize-handle:focus-visible { background: #6366f140; }
.preview-topbar, .preview-toolbar, .preview-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; }
.mode-switch { display: flex; gap: 2px; padding: 2px; margin-right: 4px; border: 1px solid var(--file-line); border-radius: 8px; }
.mode-switch button[aria-pressed='true'] { background: var(--file-tab); font-weight: 600; }
/* 页面正文根元素：占满面板剩余高度，内部布局归 ProjectPagePreview 自己（显式选择器，不用通配符） */
.page-preview-frame { flex: 1 1 0%; min-height: 0; min-width: 0; }
.design-preview-frame { flex: 1 1 0%; min-height: 0; min-width: 0; }
.preview-topbar { border-bottom: 1px solid var(--file-line); }
.panel-title { font-size: var(--lx-font-size-lg); font-weight: 600; }
.topbar-actions, .toolbar-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
button { cursor: pointer; color: inherit; background: transparent; border: 0; border-radius: 6px; padding: 5px 7px; font-size: var(--lx-font-size-md); }
button:hover { background: var(--file-tab); }
button:focus-visible { outline: 2px solid #6366f1; outline-offset: -2px; }
button:disabled { opacity: .4; cursor: default; }
.file-tabs { display: flex; flex-shrink: 0; gap: 4px; padding: 8px 10px; overflow-x: auto; border-bottom: 1px solid var(--file-line); }
.file-tab { display: flex; align-items: center; border-radius: 8px; color: var(--file-muted); flex-shrink: 0; }
.file-tab.selected { background: var(--file-tab); color: inherit; }
.file-tab [role=tab] { display: flex; align-items: center; gap: 7px; max-width: 180px; padding: 7px 8px; }
.file-tab span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-tab > button:last-child { font-size: var(--lx-font-size-3xl); padding: 2px 7px; }
.preview-toolbar { align-items: flex-start; flex-wrap: wrap; padding-bottom: 14px; }
.file-heading { display: flex; flex-direction: column; gap: 5px; min-width: 0; flex: 1; }
.file-heading strong { font-size: var(--lx-font-size-xl); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-heading > span { font-size: var(--lx-font-size-sm); color: var(--file-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.code-preview { flex: 1; min-height: 0; overflow: hidden; }
.preview-placeholder { height: 100%; display: grid; place-items: center; font-size: var(--lx-font-size-lg); color: var(--file-muted); }
.preview-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px; font-size: var(--lx-font-size-md); color: #dc2626; background: #ef444410; }
.preview-status { font-size: var(--lx-font-size-sm); color: var(--file-muted); padding: 9px 14px; border-top: 1px solid var(--file-line); }
.preview-truncated { padding: 6px 14px; font-size: var(--lx-font-size-sm); color: #b45309; background: #f59e0b10; }
@media (max-width: 900px) { .file-preview-panel { position: absolute; inset: 0; z-index: 40; width: 100% !important; max-width: none; } .resize-handle { display: none; } }
</style>
