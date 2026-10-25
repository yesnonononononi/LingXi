import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import { createRenderer, defineComponent, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { ExecutionCleanupAPI } from '../src/services/executionCleanup';
import type { ExecutionCleanupResult } from '../src/services/executionCleanup';
import type { Result } from '../src/services/types';
import http from '../src/services/interceptor';
import { useExecutionCleanup } from '../src/views/settings/tabs/useExecutionCleanup';
import { setPreference, t as translate } from '../src/i18n';
import { useUserConfigStore } from '../src/stores/userConfigStore';

interface Element {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Element[];
  parent: Element | null;
}
const element = (tag: string, text = ''): Element => ({ tag, text, props: {}, children: [], parent: null });
const text = (node: Element): string => node.tag === '#comment' ? '' : node.text + node.children.map(text).join('');
function find(node: Element, predicate: (item: Element) => boolean): Element | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) { const found = find(child, predicate); if (found) return found; }
}
function renderer() {
  return createRenderer<Element, Element>({
    createElement: tag => element(tag), createText: value => element('#text', value),
    createComment: value => element('#comment', value),
    setText: (node, value) => { node.text = value; },
    setElementText: (node, value) => { node.text = value; node.children = []; },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp: (node, key, _previous, value) => { node.props[key] = value; },
    insert: (node, parent, anchor = null) => {
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
    },
    remove: node => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = null;
    },
  });
}
async function settle() { await new Promise(resolve => setImmediate(resolve)); await nextTick(); }
function mount() {
  let state!: ReturnType<typeof useExecutionCleanup>;
  const app = renderer().createApp(defineComponent({ setup() { state = useExecutionCleanup(); return () => null; } }));
  app.mount(element('root'));
  return { state, app };
}

test('预览与清理分别使用只读 GET 和 POST，不携带前端拼接的候选 ID', async t => {
  const read = t.mock.method(http, 'get', async () => ({ code: 1, data: { executionCount: '8' } }));
  const write = t.mock.method(http, 'post', async () => ({ code: 1, data: { deletedCount: '3', remainingCount: '2' } }));
  await ExecutionCleanupAPI.preview(); await ExecutionCleanupAPI.cleanup();
  assert.deepEqual(read.mock.calls[0]?.arguments, ['/execution/cleanup/preview']);
  assert.deepEqual(write.mock.calls[0]?.arguments, ['/execution/cleanup']);
});

test('实际删除数量与剩余数量均以清理接口为准，不把预览数量当成结果', async t => {
  t.mock.method(ExecutionCleanupAPI, 'preview', async () => ({ code: 1, data: { executionCount: '8' } }));
  t.mock.method(ExecutionCleanupAPI, 'cleanup', async () => ({ code: 1, data: { deletedCount: '3', remainingCount: '2' } }));
  const { state, app } = mount(); t.after(() => app.unmount()); await settle();
  assert.equal(state.count.value, '8'); assert.equal(state.canClean.value, true);
  await state.cleanup();
  assert.equal(state.deletedCount.value, '3'); assert.equal(state.count.value, '2');
  assert.equal(state.canClean.value, true);
});

test('预览失败与响应缺失时禁用清理，重新检查后恢复', async t => {
  const preview = t.mock.method(ExecutionCleanupAPI, 'preview', async () => ({ code: 0, errMsg: '检查失败' }));
  const cleanup = t.mock.method(ExecutionCleanupAPI, 'cleanup', async () => ({ code: 1, data: { deletedCount: '1', remainingCount: '0' } }));
  const { state, app } = mount(); t.after(() => app.unmount()); await settle();
  assert.equal(state.count.value, null); assert.equal(state.error.value, '检查失败');
  await state.cleanup(); assert.equal(cleanup.mock.callCount(), 0);
  preview.mock.mockImplementation(async () => ({ code: 1, data: {} }));
  await state.load(); assert.equal(state.count.value, null); assert.ok(state.error.value);
  preview.mock.mockImplementation(async () => ({ code: 1, data: { executionCount: '0' } }));
  await state.load(); assert.equal(state.count.value, '0'); assert.equal(state.error.value, '');
  assert.equal(state.canClean.value, false);
});

test('清理失败或返回缺失时不显示成功，要求重新检查', async t => {
  t.mock.method(ExecutionCleanupAPI, 'preview', async () => ({ code: 1, data: { executionCount: '8' } }));
  const cleanup = t.mock.method(ExecutionCleanupAPI, 'cleanup', async () => ({ code: 0, errMsg: '删除失败' }));
  const { state, app } = mount(); t.after(() => app.unmount()); await settle();
  await state.cleanup(); assert.equal(state.error.value, '删除失败');
  assert.equal(state.deletedCount.value, null); assert.equal(state.canClean.value, false);
  await state.load();
  cleanup.mock.mockImplementation(async () => ({ code: 1, data: { deletedCount: '8' } }));
  await state.cleanup(); assert.equal(state.deletedCount.value, null); assert.equal(state.canClean.value, false);
  assert.ok(state.error.value);
});

test('检查与清理互斥，重复点击只发送一次请求', async t => {
  let finishPreview!: (value: Result<{ executionCount: string }>) => void;
  const preview = t.mock.method(ExecutionCleanupAPI, 'preview', () => new Promise<Result<{ executionCount: string }>>(resolve => { finishPreview = resolve; }));
  let finishCleanup!: (value: Result<ExecutionCleanupResult>) => void;
  const cleanup = t.mock.method(ExecutionCleanupAPI, 'cleanup', () => new Promise<Result<ExecutionCleanupResult>>(resolve => { finishCleanup = resolve; }));
  const { state, app } = mount(); t.after(() => app.unmount());
  await state.load(); await state.cleanup();
  assert.equal(preview.mock.callCount(), 1); assert.equal(cleanup.mock.callCount(), 0);
  finishPreview({ code: 1, data: { executionCount: '8' } }); await settle();
  const pending = state.cleanup(); await state.cleanup(); await state.load();
  assert.equal(cleanup.mock.callCount(), 1); assert.equal(preview.mock.callCount(), 1);
  finishCleanup({ code: 1, data: { deletedCount: '5', remainingCount: '0' } }); await pending;
  assert.equal(state.busy.value, false); assert.equal(state.canClean.value, false);
});

test('卸载后忽略迟到响应，并保留大整数计数原值', async t => {
  t.mock.method(ExecutionCleanupAPI, 'preview', async () => ({ code: 1, data: { executionCount: '9007199254740993' } }));
  let finish!: (value: Result<ExecutionCleanupResult>) => void;
  t.mock.method(ExecutionCleanupAPI, 'cleanup', () => new Promise<Result<ExecutionCleanupResult>>(resolve => { finish = resolve; }));
  const { state, app } = mount(); await settle();
  assert.equal(state.count.value, '9007199254740993');
  const pending = state.cleanup(); app.unmount();
  finish({ code: 1, data: { deletedCount: '8', remainingCount: '0' } }); await pending;
  assert.equal(state.deletedCount.value, null); assert.equal(state.count.value, '9007199254740993');
});

test('真实数据设置组件渲染数量，清理期间禁用按钮，成功和失败可见', async t => {
  setPreference('zh-CN');
  const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/views/settings/tabs/DataTab.vue');
  const descriptor = parse(readFileSync(componentPath, 'utf8'), { filename: componentPath }).descriptor;
  const script = compileScript(descriptor, { id: 'execution-cleanup-test', inlineTemplate: true });
  const source = script.content.replace(/from ['"](\.[^'"]+)['"]/g, (_match, path: string) => {
    const base = resolve(dirname(componentPath), path);
    return `from '${pathToFileURL(existsSync(base + '.ts') ? base + '.ts' : resolve(base, 'index.ts')).href}'`;
  });
  const modulePath = resolve(dirname(componentPath), '../../../../node_modules/.tmp/execution-cleanup-component.mjs');
  mkdirSync(dirname(modulePath), { recursive: true });
  writeFileSync(modulePath, ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText);
  t.after(() => unlinkSync(modulePath));
  const component = (await import(pathToFileURL(modulePath).href)).default;
  t.mock.method(ExecutionCleanupAPI, 'preview', async () => ({ code: 1, data: { executionCount: '8' } }));
  let finish!: (value: Result<ExecutionCleanupResult>) => void;
  const cleanup = t.mock.method(ExecutionCleanupAPI, 'cleanup', () => new Promise<Result<ExecutionCleanupResult>>(resolve => { finish = resolve; }));
  const root = element('root');
  const pinia = createPinia();
  const app = renderer().createApp(component, { isDark: true }); app.use(pinia);
  app.mount(root); t.after(() => app.unmount()); await settle();
  const button = find(root, node => node.props['data-testid'] === 'execution-cleanup-run')!;
  const refresh = find(root, node => node.props['data-testid'] === 'execution-cleanup-refresh')!;
  assert.ok(button); assert.match(text(root), /预计可清理 8 条/); assert.equal(button.props.disabled, false);
  const userConfig = useUserConfigStore(pinia);
  userConfig.dataDirRestartRequired = true; await nextTick(); assert.equal(button.props.disabled, true);
  userConfig.dataDirRestartRequired = false; await nextTick();
  const pending = button.props.onClick(); await nextTick();
  assert.equal(button.props.disabled, true); assert.equal(refresh.props.disabled, true);
  assert.equal(find(root, node => node.tag === 'button' && text(node).trim() === translate('settings.data.change'))?.props.disabled, true);
  finish({ code: 1, data: { deletedCount: '3', remainingCount: '2' } }); await pending; await nextTick();
  assert.match(text(root), /已清理 3 条执行记录/); assert.match(text(root), /预计可清理 2 条/);
  cleanup.mock.mockImplementation(async () => ({ code: 0, errMsg: '清理失败' }));
  await button.props.onClick(); await nextTick();
  assert.equal(text(find(root, node => node.props.role === 'alert')!), '清理失败');
  assert.equal(find(root, node => node.props.role === 'status'), undefined);
  assert.equal(button.props.disabled, true);
});
