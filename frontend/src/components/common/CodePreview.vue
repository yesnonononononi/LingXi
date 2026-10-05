<script setup lang="ts">
import { computed, onUnmounted, shallowRef, watch } from 'vue';
import { loader, VueMonacoEditor } from '@guolao/vue-monaco-editor';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/features/register.all.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import 'monaco-editor/languages/features/json/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker&inline';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker&inline';
import type { FilePreviewTab } from '../../types/filePreview';

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
const options: monaco.editor.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  domReadOnly: true,
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 13,
  tabSize: 4,
  scrollBeyondLastLine: false,
  renderValidationDecorations: 'off',
  padding: { top: 8, bottom: 16 },
  ariaLabel: '文件代码',
};

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
onUnmounted(() => ownedModels.forEach(disposeModel));
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
    <span role="status">正在加载代码预览…</span>
    <template #failure>代码预览加载失败，请重新打开面板</template>
  </VueMonacoEditor>
</template>
