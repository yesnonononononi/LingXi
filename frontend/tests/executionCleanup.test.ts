import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {compileScript, parse} from '@vue/compiler-sfc';
import ts from 'typescript';
import {createRenderer, defineComponent, nextTick} from 'vue';
import {createPinia} from 'pinia';
import type {ExecutionCleanupResult} from '../src/services/executionCleanup';
import {ExecutionCleanupAPI} from '../src/services/executionCleanup';
import type {Result} from '../src/services/types';
import http from '../src/services/interceptor';
import {useExecutionCleanup} from '../src/views/settings/tabs/useExecutionCleanup';
import {setPreference, t as translate} from '../src/i18n';
import {useUserConfigStore} from '../src/stores/userConfigStore';

interface Element {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Element[];
  parent: Element | null;
}
interface PreviewPayload {
  executionCount: string;
  filesNeedScan: boolean;
  expiredFileRecordCount: string;
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

/**
 * 按顺序返回预览结果：清理成功后组件会再拉一次预览（本轮目录预算之后可能还有孤儿文件），
 * 所以同一个用例里预览会被调用多次，不能只给一个固定返回值。
 */
function previewSequence(t: { mock: any }, ...values: PreviewPayload[]) {
  let index = 0;
  return t.mock.method(ExecutionCleanupAPI, 'preview', async () => ({
    code: 1, data: values[Math.min(index++, values.length - 1)],
  }));
}

/** 真组件（DataTab.vue）的装载：沿用现有 node 假渲染风格，不引入新框架。 */
async function loadDataTab(t: { after: (callback: () => void) => void }, name: string) {
  const componentPath = resolve(dirname(fileURLToPath(import.meta.url)), '../src/views/settings/tabs/DataTab.vue');
  const descriptor = parse(readFileSync(componentPath, 'utf8'), { filename: componentPath }).descriptor;
  const script = compileScript(descriptor, { id: 'execution-cleanup-test', inlineTemplate: true });
  const source = script.content.replace(/from ['"](\.[^'"]+)['"]/g, (_match, path: string) => {
    const base = resolve(dirname(componentPath), path);
    return `from '${pathToFileURL(existsSync(base + '.ts') ? base + '.ts' : resolve(base, 'index.ts')).href}'`;
  });
  const modulePath = resolve(dirname(componentPath), `../../../../node_modules/.tmp/${name}.mjs`);
  mkdirSync(dirname(modulePath), { recursive: true });
  writeFileSync(modulePath, ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText);
  t.after(() => unlinkSync(modulePath));
  return (await import(pathToFileURL(modulePath).href)).default;
}

test('预览与清理分别使用只读 GET 和 POST，不携带前端拼接的候选 ID', async t => {
  const read = t.mock.method(http, 'get', async () => ({
    code: 1, data: { executionCount: '8', filesNeedScan: false, expiredFileRecordCount: '0' },
  }));
  const write = t.mock.method(http, 'post', async () => ({ code: 1, data: { deletedCount: '3', remainingCount: '2' } }));
  await ExecutionCleanupAPI.preview(); await ExecutionCleanupAPI.cleanup();
  assert.deepEqual(read.mock.calls[0]?.arguments, ['/execution/cleanup/preview']);
  assert.deepEqual(write.mock.calls[0]?.arguments, ['/execution/cleanup']);
});

test('实际删除数量与剩余数量均以清理接口为准，不把预览数量当成结果', async t => {
  previewSequence(t, { executionCount: '8', filesNeedScan: false, expiredFileRecordCount: '0' }, { executionCount: '2', filesNeedScan: false, expiredFileRecordCount: '0' });
  t.mock.method(ExecutionCleanupAPI, 'cleanup', async () => ({ code: 1, data: { deletedCount: '3', remainingCount: '2' } }));
  const { state, app } = mount(); t.after(() => app.unmount()); await settle();
  assert.equal(state.count.value, '8'); assert.equal(state.canClean.value, true);
  await state.cleanup();
  assert.equal(state.deletedCount.value, '3');
  // 清理后的数量来自重新拉取的预览（权威），不是前端自己减出来的。
  assert.equal(state.count.value, '2');
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
  // 契约校验：缺 filesNeedScan 也算返回不完整 —— 否则界面会把「文件侧还要扫」当成没事干。
  preview.mock.mockImplementation(async () => ({ code: 1, data: { executionCount: '0' } }));
  await state.load(); assert.equal(state.count.value, null); assert.ok(state.error.value);
  // 缺过期记录条数同样算不完整：清理会删它们，预览漏报就是「说没啥可清、点一下却删了东西」。
  preview.mock.mockImplementation(async () => ({ code: 1, data: { executionCount: '0', filesNeedScan: false } }));
  await state.load(); assert.equal(state.count.value, null); assert.ok(state.error.value);
  preview.mock.mockImplementation(async () => ({ code: 1, data: { executionCount: '0', filesNeedScan: false, expiredFileRecordCount: '0' } }));
  await state.load(); assert.equal(state.count.value, '0'); assert.equal(state.error.value, '');
  assert.equal(state.canClean.value, false);
});

test('只剩过期文件编辑记录时也允许清理，并把它报出来', async t => {
  // 行数与文件侧都空，但清理确实会删掉过期的编辑记录：预览必须先说出来，按钮也不能禁用。
  const preview = previewSequence(t, { executionCount: '0', filesNeedScan: false, expiredFileRecordCount: '9' });
  const cleanup = t.mock.method(ExecutionCleanupAPI, 'cleanup', async () => ({
    code: 1, data: { deletedCount: '0', remainingCount: '0' },
  }));
  const { state, app } = mount(); t.after(() => app.unmount()); await settle();
  assert.equal(state.expiredRecordCount.value, '9');
  assert.equal(state.canClean.value, true, '还有过期记录可删时按钮必须可用');
  await state.cleanup();
  assert.equal(cleanup.mock.callCount(), 1);
  // 清理后再拉预览：过期记录已被删掉，按钮随之禁用。
  preview.mock.mockImplementation(async () => ({
    code: 1, data: { executionCount: '0', filesNeedScan: false, expiredFileRecordCount: '0' },
  }));
  await state.load();
  assert.equal(state.expiredRecordCount.value, '0');
  assert.equal(state.canClean.value, false, '三侧都空时才允许禁用');
});

test('只剩孤儿文件时禁用被解除，清理真的发得出去', async t => {
  // 复核 R4 的现场：没有可回收的行，但磁盘上还有孤儿正文 / .part，界面必须还能点。
  const preview = previewSequence(t, { executionCount: '0', filesNeedScan: true, expiredFileRecordCount: '0' });
  const cleanup = t.mock.method(ExecutionCleanupAPI, 'cleanup', async () => ({
    code: 1, data: { deletedCount: '0', remainingCount: '0' },
  }));
  const { state, app } = mount(); t.after(() => app.unmount()); await settle();
  assert.equal(state.count.value, '0');
  assert.equal(state.filesNeedScan.value, true);
  assert.equal(state.canClean.value, true, '文件侧还有东西时不能按行数为 0 禁用');
  await state.cleanup();
  assert.equal(cleanup.mock.callCount(), 1, '只剩孤儿文件时清理请求必须发出去');
  assert.equal(state.deletedCount.value, '0');
  assert.equal(preview.mock.callCount(), 2, '清理后必须重新拉预览，让按钮跟着最新事实走');
  assert.equal(state.canClean.value, true, '预览仍报告有文件要扫描时按钮保持可用');
  // 反面对照：两侧都空才禁用。
  preview.mock.mockImplementation(async () => ({ code: 1, data: { executionCount: '0', filesNeedScan: false, expiredFileRecordCount: '0' } }));
  await state.load();
  assert.equal(state.canClean.value, false, '两侧都空时才允许禁用');
});

test('清理失败或返回缺失时不显示成功，要求重新检查', async t => {
  previewSequence(t, { executionCount: '8', filesNeedScan: false, expiredFileRecordCount: '0' });
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
  let finishPreview!: (value: Result<PreviewPayload>) => void;
  let first = true;
  const preview = t.mock.method(ExecutionCleanupAPI, 'preview', () => {
    if (!first) return Promise.resolve({ code: 1, data: { executionCount: '0', filesNeedScan: false, expiredFileRecordCount: '0' } });
    first = false;
    return new Promise<Result<PreviewPayload>>(resolve => { finishPreview = resolve; });
  });
  let finishCleanup!: (value: Result<ExecutionCleanupResult>) => void;
  const cleanup = t.mock.method(ExecutionCleanupAPI, 'cleanup', () => new Promise<Result<ExecutionCleanupResult>>(resolve => { finishCleanup = resolve; }));
  const { state, app } = mount(); t.after(() => app.unmount());
  await state.load(); await state.cleanup();
  assert.equal(preview.mock.callCount(), 1); assert.equal(cleanup.mock.callCount(), 0);
  finishPreview({ code: 1, data: { executionCount: '8', filesNeedScan: false, expiredFileRecordCount: '0' } }); await settle();
  const pending = state.cleanup(); await state.cleanup(); await state.load();
  assert.equal(cleanup.mock.callCount(), 1); assert.equal(preview.mock.callCount(), 1);
  finishCleanup({ code: 1, data: { deletedCount: '5', remainingCount: '0' } }); await pending;
  assert.equal(state.busy.value, false); assert.equal(state.canClean.value, false);
});

test('卸载后忽略迟到响应，并保留大整数计数原值', async t => {
  previewSequence(t, { executionCount: '9007199254740993', filesNeedScan: false, expiredFileRecordCount: '0' });
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
  const component = await loadDataTab(t, 'execution-cleanup-component');
  previewSequence(t, { executionCount: '8', filesNeedScan: false, expiredFileRecordCount: '0' }, { executionCount: '2', filesNeedScan: false, expiredFileRecordCount: '0' });
  let finish!: (value: Result<ExecutionCleanupResult>) => void;
  t.mock.method(ExecutionCleanupAPI, 'cleanup', () => new Promise<Result<ExecutionCleanupResult>>(resolve => { finish = resolve; }));
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
  t.mock.restoreAll();
  previewSequence(t, { executionCount: '2', filesNeedScan: false, expiredFileRecordCount: '0' });
  t.mock.method(ExecutionCleanupAPI, 'cleanup', async () => ({ code: 0, errMsg: '清理失败' }));
  await button.props.onClick(); await nextTick();
  assert.equal(text(find(root, node => node.props.role === 'alert')!), '清理失败');
  assert.equal(find(root, node => node.props.role === 'status'), undefined);
  assert.equal(button.props.disabled, true);
});

test('真实组件把过期文件编辑记录条数也显示出来', async t => {
  setPreference('zh-CN');
  const component = await loadDataTab(t, 'execution-cleanup-records-component');
  previewSequence(t, { executionCount: '0', filesNeedScan: false, expiredFileRecordCount: '4' });
  const root = element('root');
  const pinia = createPinia();
  const app = renderer().createApp(component, { isDark: true }); app.use(pinia);
  app.mount(root); t.after(() => app.unmount()); await settle();
  const button = find(root, node => node.props['data-testid'] === 'execution-cleanup-run')!;

  assert.match(text(root), /另有 4 条过期文件编辑记录将一并清理/);
  assert.equal(button.props.disabled, false, '只有过期记录可删时按钮不能禁用');
});

test('真实组件在只剩孤儿文件时按钮可用，文案说明文件侧还要扫描', async t => {
  setPreference('zh-CN');
  const component = await loadDataTab(t, 'execution-cleanup-orphan-component');
  previewSequence(t, { executionCount: '0', filesNeedScan: true, expiredFileRecordCount: '0' });
  const cleanup = t.mock.method(ExecutionCleanupAPI, 'cleanup', async () => ({
    code: 1, data: { deletedCount: '0', remainingCount: '0' },
  }));
  const root = element('root');
  const pinia = createPinia();
  const app = renderer().createApp(component, { isDark: true }); app.use(pinia);
  app.mount(root); t.after(() => app.unmount()); await settle();
  const button = find(root, node => node.props['data-testid'] === 'execution-cleanup-run')!;
  assert.equal(button.props.disabled, false, '只剩孤儿文件时按钮必须可用');
  assert.match(text(root), /没有可回收的执行记录，但磁盘上还有检查点文件待扫描/);
  await button.props.onClick(); await settle();
  assert.equal(cleanup.mock.callCount(), 1, '点击必须真的触发清理请求');
});
