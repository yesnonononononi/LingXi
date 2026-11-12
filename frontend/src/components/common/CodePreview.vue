<script setup lang="ts">
import {computed, onUnmounted, shallowRef, watch} from 'vue';
import {t} from '../../i18n';
import {loader, VueMonacoEditor} from '@guolao/vue-monaco-editor';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/features/register.all.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/languages/features/json/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker&inline';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker&inline';
import type {FilePreviewTab} from '../../types/filePreview';

// 本地模块和内嵌 Worker 让 file:// 桌面窗口无需访问 CDN。
self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === 'json') return new JsonWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });

const props = defineProps<{ tabs: FilePreviewTab[]; activeId: string; isDark: boolean }>();
const active = computed(() => props.tabs.find(tab => tab.id === props.activeId));
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>();
/** 当前标签的行定位请求（本地文件链接带过来的）。 */
const lineAnchor = computed(() => active.value?.lineAnchor);
/** 已经定位过的请求序号：后台刷新会换掉 `data`，不能因此把用户又拽回那一行。 */
let revealedSeq = 0;
let flashDecorations: string[] = [];
let flashTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 把视图滚到 anchor 指定的行并短暂高亮。
 *
 * <p>面板可能是刚被唤起（`v-show` 由隐藏切到可见），首帧布局高度是 0，此时算出来的滚动位置不可靠。
 * 高度为 0 就等下一帧重试，而不是先滚一个错位置再指望 automaticLayout 事后纠正。</p>
 */
const revealAnchorLine = (attempt = 0): void => {
  const instance = editor.value;
  const anchor = lineAnchor.value;
  if (!instance || !anchor) return;
  const model = instance.getModel();
  if (!model) return;
  if (instance.getLayoutInfo().height <= 0 && attempt < 10) {
    requestAnimationFrame(() => revealAnchorLine(attempt + 1));
    return;
  }
  // 行号来自 Markdown 文本，可能指到文件末尾之外（文件刚被改短），一律夹到有效范围。
  const line = Math.min(Math.max(1, anchor.line), model.getLineCount());
  instance.revealLineInCenter(line);
  instance.setPosition({lineNumber: line, column: 1});
  flashDecorations = instance.deltaDecorations(flashDecorations, [{
    range: new monaco.Range(line, 1, line, 1),
    options: { isWholeLine: true, className: 'lx-preview-line-flash' }
  }]);
  clearTimeout(flashTimer);
  // 高亮只是「看这里」的一次性提示，停留够久就撤掉，别把只读视图染成常驻底色。
  flashTimer = setTimeout(() => {
    flashTimer = undefined;
    flashDecorations = editor.value?.deltaDecorations(flashDecorations, []) ?? [];
  }, 1800);
};

/** 内容与编辑器都到位后才定位；同一个请求序号只定位一次。 */
const revealIfReady = (): void => {
  const seq = lineAnchor.value?.seq;
  if (!seq || seq === revealedSeq || !editor.value || !active.value?.data) return;
  revealedSeq = seq;
  revealAnchorLine();
};

const buildModelPath = (tab: FilePreviewTab) => `lingxi-preview:///${tab.request.watchKey}/${encodeURIComponent(tab.name)}`;
const modelPaths = computed(() => props.tabs.map(buildModelPath));
const ownedModels = new Set(modelPaths.value);
const modelPath = computed(() => active.value ? buildModelPath(active.value) : undefined);
const language = computed(() => {
  const name = active.value?.name.toLowerCase() ?? '';
  if (name.endsWith('.vue')) return 'html';
  return monaco.languages.getLanguages().find(language =>
    language.filenames?.some(file => file.toLowerCase() === name)
    || language.extensions?.some(extension => name.endsWith(extension.toLowerCase()))
  )?.id ?? 'plaintext';
});
const options = computed<monaco.editor.IStandaloneEditorConstructionOptions>(() => ({
  readOnly: true,
  domReadOnly: true,
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 13,
  tabSize: 4,
  scrollBeyondLastLine: false,
  renderValidationDecorations: 'off',
  padding: { top: 8, bottom: 16 },
  ariaLabel: t('filePreview.codeAria'),
}));

const disposeModel = (path: string) => monaco.editor.getModel(monaco.Uri.parse(path))?.dispose();
// 后台刷新的标签也要更新模型；保留当前视图，避免内容变化把阅读位置重置。
watch(() => props.tabs.map(tab => ({ path: buildModelPath(tab), content: tab.data?.content })), snapshots => {
  for (const snapshot of snapshots) {
    const model = monaco.editor.getModel(monaco.Uri.parse(snapshot.path));
    if (!model || snapshot.content === undefined || model.getValue() === snapshot.content) continue;
    const view = editor.value?.getModel() === model ? editor.value.saveViewState() : null;
    model.setValue(snapshot.content);
    if (view) editor.value?.restoreViewState(view);
  }
}, { flush: 'sync' });
// Vue 封装只释放当前模型，关闭其他标签时也要释放对应文件内容。
watch(modelPaths, (paths, previous) => {
  paths.forEach(path => ownedModels.add(path));
  for (const path of previous) if (!paths.includes(path)) {
    disposeModel(path);
    ownedModels.delete(path);
  }
}, { flush: 'post' });
// 定位时机有三个：编辑器挂载、新的行定位请求、目标内容到位。三者谁后到都能补上这一次定位。
watch(
  [editor, lineAnchor, () => active.value?.data],
  () => revealIfReady(),
  { flush: 'post' }
);
onUnmounted(() => {
  clearTimeout(flashTimer);
  ownedModels.forEach(disposeModel);
});
</script>

<template>
  <VueMonacoEditor
    :value="active?.data?.content ?? ''"
    :path="modelPath"
    :language="language"
    :theme="isDark ? 'vs-dark' : 'vs'"
    :options="options"
    :saveViewState="true"
    height="100%"
    @mount="editor = $event"
  >
    <span role="status">{{ t('filePreview.loadingCode') }}</span>
    <template #failure>{{ t('filePreview.loadFailed') }}</template>
  </VueMonacoEditor>
</template>

<style>
/*
 * 行定位高亮：装饰的类名挂在 Monaco 自己生成的 DOM 上，scoped 样式够不到，只能全局声明。
 * 只影响带这个类名的整行装饰，不碰编辑器其他部分。
 */
.monaco-editor .lx-preview-line-flash {
  background-color: rgba(56, 189, 248, 0.18);
}
</style>
