<script setup lang="ts">
import {computed, defineAsyncComponent, onBeforeUnmount, ref, watch} from 'vue';
import type {FilePreviewTab} from '../../types/filePreview';
import type {PreviewPanelMode} from '../../types/projectPagePreview';
import {useCopyFeedback} from '../../composables/useCopyFeedback';
import {getApiBaseUrl} from '../../utils/apiConfig';
import {mergeFullFileDiff, type MergedDiffLine} from '../../utils/fileDiff';
import hljs from 'highlight.js';
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

/* ============================ 编辑差异与撤销 ============================ */

/** 当前标签是否带着「某次编辑」的上下文（由编辑工具行打开时才有）。 */
const editRef = computed(() => active.value?.request.edit);
const hasEdit = computed(() => !!editRef.value && isFileMode.value);

const diffView = ref<'diff' | 'source'>('diff');
const diffText = ref('');
const diffTruncated = ref(false);
const diffLoading = ref(false);
const diffError = ref('');
const reverting = ref(false);
const reverted = ref(false);
const revertMessage = ref('');

/** 全文与差异合并后的逐行结果；没有全文时不渲染，避免出现「只有 diff 没有文件」的错位视图。 */
const mergedLines = computed<MergedDiffLine[]>(() =>
  active.value?.data ? mergeFullFileDiff(active.value.data.content, diffText.value) : []);

const codeLanguage = computed(() => {
  const name = active.value?.name.toLowerCase() ?? '';
  if (name.endsWith('.vue')) return 'xml';
  const extMatch = name.match(/\.([a-z0-9_-]+)$/);
  const ext = extMatch ? extMatch[1] : '';
  const extMap: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', mts: 'typescript', cts: 'typescript',
    jsx: 'javascript', tsx: 'typescript',
    java: 'java', kt: 'kotlin', kts: 'kotlin',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    html: 'xml', xml: 'xml', svg: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', yml: 'yaml', yaml: 'yaml',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
    sql: 'sql', md: 'markdown'
  };
  return extMap[ext] || (hljs.getLanguage(ext) ? ext : '');
});

function escapeDiffHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightLine(text: string): string {
  if (!text) return '&nbsp;';
  const trimmed = text.trimStart();
  if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
    return `<span class="hljs-comment">${escapeDiffHtml(text)}</span>`;
  }
  const lang = codeLanguage.value;
  try {
    if (lang) {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(text).value;
  } catch {
    return escapeDiffHtml(text);
  }
}

const editEndpoint = (suffix = ''): string => {
  const edit = editRef.value!;
  const base = getApiBaseUrl() || window.location.origin;
  return `${base}/a/file-edits/${encodeURIComponent(edit.executionId)}/${encodeURIComponent(edit.recordId)}${suffix}`;
};

/** 按需拉取本次编辑的差异：只在打开带编辑上下文的标签时请求，不进入事件流。 */
const loadDiff = async (): Promise<void> => {
  if (!editRef.value) return;
  diffLoading.value = true;
  diffError.value = '';
  try {
    const response = await fetch(editEndpoint());
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    if (!body?.data) throw new Error('empty diff');
    diffText.value = body.data.unifiedDiff ?? '';
    diffTruncated.value = !!body.data.truncated;
    diffView.value = 'diff';
    reverted.value = false;
    revertMessage.value = '';
  } catch {
    diffError.value = t('filePreview.diffUnavailable');
  } finally {
    diffLoading.value = false;
  }
};

/**
 * 撤销这次编辑。
 *
 * <p>失败原因原样透传：后端会在「文件在编辑后又被改过」时拒绝回滚（内容 hash 不匹配），
 * 这类信息必须让用户看到，不能统一吞成「撤销失败」。</p>
 */
const revertEdit = async (): Promise<void> => {
  const current = active.value;
  if (!current?.request.edit || reverting.value) return;
  if (!window.confirm(t('filePreview.revertConfirm'))) return;
  reverting.value = true;
  revertMessage.value = '';
  try {
    const query = current.request.sessionId ? `?sessionId=${encodeURIComponent(current.request.sessionId)}` : '';
    const response = await fetch(editEndpoint(`/reject${query}`), {method: 'POST'});
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.code === 0) throw new Error(body?.errMsg || String(response.status));
    reverted.value = true;
    revertMessage.value = t('filePreview.revertDone');
    // 文件已还原，差异视图不再成立，回到源码态并让主进程重新读一次内容。
    diffView.value = 'source';
    emit('refresh', current);
  } catch (error) {
    revertMessage.value = t('filePreview.revertFailed', {
      reason: error instanceof Error ? error.message : ''
    });
  } finally {
    reverting.value = false;
  }
};

/** 切换标签时按新标签的编辑上下文重新取差异；没有上下文的标签不发请求。 */
watch(() => props.activeId, () => {
  diffText.value = '';
  diffTruncated.value = false;
  diffError.value = '';
  diffView.value = 'diff';
  void loadDiff();
}, {immediate: true});
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
          <!-- 只有带编辑上下文的标签才出现「差异/源码」切换，普通预览行为完全不变 -->
          <div v-if="hasEdit" class="mode-switch" role="group" :aria-label="t('filePreview.viewDiff')">
            <button type="button" :aria-pressed="diffView === 'diff'" @click="diffView = 'diff'">{{ t('filePreview.viewDiff') }}</button>
            <button type="button" :aria-pressed="diffView === 'source'" @click="diffView = 'source'">{{ t('filePreview.viewSource') }}</button>
          </div>
          <button
            v-if="hasEdit && active.request.edit"
            type="button"
            :disabled="reverting || reverted"
            :title="reverted ? t('filePreview.revertedHint') : t('filePreview.revertTitle')"
            class="revert-button"
            @click="revertEdit"
          >{{ reverting ? t('filePreview.reverting') : reverted ? t('filePreview.reverted') : t('filePreview.revert') }}</button>
          <button type="button" :disabled="!active.data" @click="copy(active.data?.content ?? '')">{{ isCopied ? t('common.copied') : t('common.copy') }}</button>
          <button type="button" :disabled="active.loading" @click="emit('refresh', active)">{{ t('common.refresh') }}</button>
          <button type="button" :title="t('filePreview.openWithSystem')" @click="emit('open')">{{ t('common.open') }}</button>
          <button type="button" :title="t('filePreview.revealInFolder')" @click="emit('reveal')">{{ t('filePreview.reveal') }}</button>
        </div>
      </div>
      <div v-if="revertMessage" class="revert-notice" :class="{ 'is-done': reverted }" role="status">
        <span>{{ revertMessage }}</span>
        <button type="button" @click="revertMessage = ''">×</button>
      </div>
      <div v-if="active?.error" class="preview-error" role="alert">
        <span>{{ active.error }}</span>
        <button type="button" :disabled="active.loading" @click="emit('refresh', active)">{{ t('common.retry') }}</button>
      </div>
      <div class="code-preview" :role="active ? 'tabpanel' : undefined" :aria-label="t('filePreview.codeAria')">
        <template v-if="active">
          <!-- 差异视图：完整文件逐行渲染，本次改动行红绿标注 -->
          <div v-if="hasEdit && diffView === 'diff'" class="diff-preview">
            <div v-if="diffLoading" class="preview-placeholder" role="status">{{ t('filePreview.diffLoading') }}</div>
            <div v-else-if="diffError" class="preview-placeholder">{{ diffError }}</div>
            <div v-else-if="!active.data" class="preview-placeholder">{{ t('filePreview.noContent') }}</div>
            <div v-else class="diff-lines">
              <div v-for="(line, index) in mergedLines" :key="index" class="diff-line" :class="`is-${line.kind}`">
                <span class="diff-no">{{ line.lineNumber ?? '' }}</span>
                <span class="diff-sigil">{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : '' }}</span>
                <span class="diff-text" v-html="highlightLine(line.text)"></span>
              </div>
            </div>
          </div>
          <CodePreview
            v-show="!!active.data && !(hasEdit && diffView === 'diff')"
            :tabs="tabs" :activeId="activeId" :isDark="isDark"
          />
          <div v-if="active.loading && !active.data" class="preview-placeholder" role="status">{{ t('filePreview.reading') }}</div>
          <div v-else-if="!active.data" class="preview-placeholder">{{ t('filePreview.noContent') }}</div>
        </template>
        <div v-else class="preview-placeholder">{{ t('filePreview.noOpenFile') }}</div>
      </div>
      <div v-if="hasEdit && diffTruncated && diffView === 'diff'" class="preview-truncated">{{ t('filePreview.diffTruncated') }}</div>
      <footer v-if="active" class="preview-status">
        <span>{{ active.loading ? t('filePreview.refreshing') : active.error && active.data ? t('filePreview.showLastContent') : active.data?.watchId ? t('filePreview.autoRefresh') : t('filePreview.readOnly') }}</span>
        <span v-if="active.data">{{ active.data.encoding }} · {{ Math.ceil(active.data.size / 1024) }} KB</span>
      </footer>
      <div v-if="active?.data?.truncated" class="preview-truncated">{{ t('filePreview.truncated') }}</div>
    </template>
    <!-- 隐藏只暂停显示，页面状态由主进程保留；拖拽时让指针事件留在主页面。 -->
    <ProjectPagePreview v-show="isPageMode" :active="isPageMode && !resizing" class="page-preview-frame" />
    <DesignCanvasPreview
      v-if="isDesignMode"
      :active="isDesignMode"
      :initialContent="active?.name.endsWith('.html') || active?.name.endsWith('.htm') ? active.data?.content : undefined"
      :initialFileName="active?.name.endsWith('.html') || active?.name.endsWith('.htm') ? active.name : undefined"
      class="design-preview-frame"
    />
  </aside>
</template>

<style scoped>
/*
 * 预览面板配色令牌（唯一来源）：面板与两个子视图（ProjectPagePreview / DesignCanvasPreview）
 * 一律消费这组变量，禁止在组件里再写字面色值。
 *  - `--file-*`：面板表面 / 分隔线 / 弱化文字（中性灰阶）
 *  - `--file-ink*`：强调面（主按钮、选中胶囊），亮色是深墨，暗色反转成浅墨
 *  - `--file-focus`：键盘焦点环，取中性灰（历史上这里曾是 indigo，与面板中性色语言冲突）
 * 子视图挂在面板外时（独立挂载 / 冒烟）用 var() 的第二参数兜底亮色值。
 */
.file-preview-panel { --file-bg: #fff; --file-muted: #71717a; --file-line: #e4e4e7; --file-tab: #f4f4f5; --file-ink: #18181b; --file-ink-hover: #27272a; --file-ink-contrast: #ffffff; --file-focus: #a1a1aa; position: relative; flex: none; display: flex; flex-direction: column; height: 100%; min-width: 0; max-width: calc(100vw - 360px); color: #27272a; background: var(--file-bg); border-left: 1px solid var(--file-line); }
.file-preview-panel.is-dark { --file-bg: #0c0e13; --file-muted: #8b92a1; --file-line: #252933; --file-tab: #1b1f29; --file-ink: #f5f5f5; --file-ink-hover: #e4e4e7; --file-ink-contrast: #18181b; --file-focus: #6b7280; color: #e4e4e7; }
.file-preview-panel.is-maximized { position: absolute; inset: 0; z-index: 40; width: 100%; max-width: none; }
.resize-handle { position: absolute; top: 0; bottom: 0; left: -4px; width: 8px; cursor: col-resize; z-index: 5; touch-action: none; }
.resize-handle:hover, .resize-handle:focus-visible { background: var(--file-line); }
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
button:focus-visible { outline: 2px solid var(--file-focus); outline-offset: -2px; }
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
.revert-button { color: #dc2626 !important; font-weight: 500; }
.revert-button:hover:not(:disabled) { background: #ef444415 !important; }
.revert-notice { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 16px; font-size: var(--lx-font-size-sm); color: #dc2626; background: #ef444410; border-bottom: 1px solid var(--file-line); }
.revert-notice.is-done { color: #16a34a; background: #22c55e10; }
.preview-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px; font-size: var(--lx-font-size-md); color: #dc2626; background: #ef444410; }
.preview-status { font-size: var(--lx-font-size-sm); color: var(--file-muted); padding: 9px 14px; border-top: 1px solid var(--file-line); }
.preview-truncated { padding: 6px 14px; font-size: var(--lx-font-size-sm); color: #b45309; background: #f59e0b10; }
/* 差异视图：行号列定宽右对齐并带分隔线，增删行区分淡色背景与指示符，正文走规范代码字体与语法高亮。 */
.diff-preview {
  height: 100%;
  overflow: auto;
  font-family: var(--font-lx-code, 'JetBrains Mono', 'Cascadia Mono', 'Fira Code', 'SF Mono', Consolas, Menlo, Monaco, 'Courier New', monospace);
  font-size: 13px;
  line-height: 1.6;
  tab-size: 4;
  -moz-tab-size: 4;
}
.diff-lines { min-width: max-content; }
.diff-line { display: flex; align-items: flex-start; white-space: pre; }
.diff-line:hover { background-color: rgba(128, 128, 128, 0.05); }
.diff-line.is-add { background: var(--lx-diff-add-bg, rgba(34, 197, 94, 0.12)); }
.diff-line.is-del { background: var(--lx-diff-del-bg, rgba(239, 68, 68, 0.12)); }
.diff-no {
  flex: none;
  width: 50px;
  padding-right: 10px;
  text-align: right;
  opacity: .45;
  user-select: none;
  border-right: 1px solid var(--file-line);
  margin-right: 8px;
}
.diff-sigil {
  flex: none;
  width: 16px;
  text-align: center;
  user-select: none;
  font-weight: 600;
}
.diff-line.is-add .diff-sigil { color: #16a34a; }
.diff-line.is-del .diff-sigil { color: #dc2626; }
.diff-text { flex: 1 1 auto; padding-right: 16px; min-width: 0; }

/* 语法高亮（浅色） */
.diff-preview :deep(.hljs-keyword),
.diff-preview :deep(.hljs-selector-tag),
.diff-preview :deep(.hljs-subst) { color: #cf222e; font-weight: 600; }
.diff-preview :deep(.hljs-string),
.diff-preview :deep(.hljs-section),
.diff-preview :deep(.hljs-attribute) { color: #0a3069; }
.diff-preview :deep(.hljs-title),
.diff-preview :deep(.hljs-title.function_) { color: #8250df; }
.diff-preview :deep(.hljs-type),
.diff-preview :deep(.hljs-title.class_),
.diff-preview :deep(.hljs-class) { color: #953800; font-weight: 500; }
.diff-preview :deep(.hljs-comment),
.diff-preview :deep(.hljs-quote) { color: #6e7781; font-style: italic; }
.diff-preview :deep(.hljs-number),
.diff-preview :deep(.hljs-literal) { color: #0550ae; }

/* 语法高亮（深色） */
.file-preview-panel.is-dark .diff-preview :deep(.hljs-keyword),
.file-preview-panel.is-dark .diff-preview :deep(.hljs-selector-tag),
.file-preview-panel.is-dark .diff-preview :deep(.hljs-subst) { color: #ff7b72; font-weight: 600; }
.file-preview-panel.is-dark .diff-preview :deep(.hljs-string),
.file-preview-panel.is-dark .diff-preview :deep(.hljs-section),
.file-preview-panel.is-dark .diff-preview :deep(.hljs-attribute) { color: #a5d6ff; }
.file-preview-panel.is-dark .diff-preview :deep(.hljs-title),
.file-preview-panel.is-dark .diff-preview :deep(.hljs-title.function_) { color: #d2a8ff; }
.file-preview-panel.is-dark .diff-preview :deep(.hljs-type),
.file-preview-panel.is-dark .diff-preview :deep(.hljs-title.class_),
.file-preview-panel.is-dark .diff-preview :deep(.hljs-class) { color: #ffa657; font-weight: 500; }
.file-preview-panel.is-dark .diff-preview :deep(.hljs-comment),
.file-preview-panel.is-dark .diff-preview :deep(.hljs-quote) { color: #8b949e; font-style: italic; }
.file-preview-panel.is-dark .diff-preview :deep(.hljs-number),
.file-preview-panel.is-dark .diff-preview :deep(.hljs-literal) { color: #79c0ff; }
@media (max-width: 900px) { .file-preview-panel { position: absolute; inset: 0; z-index: 40; width: 100% !important; max-width: none; } .resize-handle { display: none; } }
</style>
