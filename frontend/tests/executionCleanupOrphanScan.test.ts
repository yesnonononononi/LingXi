/**
 * 复核 R4 的独立前端探针：只剩孤儿文件时 UI 必须能发出清理请求，且能连着发第二轮。
 *
 * 与既有 executionCleanup.test.ts 的分工：那边断言「按钮可用 / 文案 / 组件渲染」，
 * 这里把 mock 下沉到 http 层，断言真的发出了 POST /execution/cleanup，
 * 并额外覆盖「清理后 remainingCount=0 但文件侧仍需扫描，能发起第二轮扫描」。
 * 最后一条是反向对照：文件侧干净时必须禁用且不发请求 —— 证明前两条不是恒真。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRenderer, defineComponent, nextTick} from 'vue';
import http from '../src/services/interceptor';
import {useExecutionCleanup} from '../src/views/settings/tabs/useExecutionCleanup';

interface Element {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Element[];
  parent: Element | null;
}

const element = (tag: string, text = ''): Element => ({ tag, text, props: {}, children: [], parent: null });

function renderer() {
  return createRenderer<Element, Element>({
    createElement: tag => element(tag),
    createText: value => element('#text', value),
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

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await nextTick();
}

function mount() {
  let state!: ReturnType<typeof useExecutionCleanup>;
  const app = renderer().createApp(defineComponent({ setup() { state = useExecutionCleanup(); return () => null; } }));
  app.mount(element('root'));
  return { state, app };
}

/** 预览会被多次调用（清理成功后组件会重拉），按顺序吐值，最后一个值兜底。 */
function previewSequence(t: { mock: any },
  ...values: Array<{ executionCount: string; filesNeedScan: boolean; expiredFileRecordCount: string }>) {
  let index = 0;
  return t.mock.method(http, 'get', async () => ({
    code: 1, data: values[Math.min(index++, values.length - 1)],
  }));
}

test('只剩孤儿文件时，清理请求真的从 UI 发得出去（POST 走通）', async t => {
  previewSequence(t, { executionCount: '0', filesNeedScan: true, expiredFileRecordCount: '0' });
  const post = t.mock.method(http, 'post', async () => ({
    code: 1, data: { deletedCount: '0', remainingCount: '0' },
  }));
  const { state, app } = mount();
  t.after(() => app.unmount());
  // 挂载即 load：等这一次预览落地（否则断言会撞在 busy=true 的中间态上）。
  await settle();

  assert.equal(state.count.value, '0');
  assert.equal(state.filesNeedScan.value, true);
  assert.equal(state.canClean.value, true, '没有可回收行但文件侧要扫描时，按钮必须可用');

  await state.cleanup();
  assert.equal(post.mock.callCount(), 1, '点击必须真的发出 POST /execution/cleanup');
  assert.deepEqual(post.mock.calls[0]?.arguments, ['/execution/cleanup']);
  assert.equal(state.deletedCount.value, '0');
});

test('清理后 remainingCount=0 但文件侧仍需扫描时，能发起第二轮扫描', async t => {
  // 前两轮预览都报「文件侧还要扫描」：第一轮目录预算之后的孤儿只能靠第二轮收。
  previewSequence(t,
    { executionCount: '0', filesNeedScan: true, expiredFileRecordCount: '0' },
    { executionCount: '0', filesNeedScan: true, expiredFileRecordCount: '0' },
    { executionCount: '0', filesNeedScan: false, expiredFileRecordCount: '0' });
  const post = t.mock.method(http, 'post', async () => ({
    code: 1, data: { deletedCount: '0', remainingCount: '0' },
  }));
  const { state, app } = mount();
  t.after(() => app.unmount());
  await settle();

  await state.cleanup();
  assert.equal(post.mock.callCount(), 1);
  assert.equal(state.canClean.value, true, 'remainingCount=0 不能把第二轮挡在门外');

  await state.cleanup();
  assert.equal(post.mock.callCount(), 2, '第二轮扫描必须真的再发一次 POST');
  // 第二轮之后预览报「文件侧干净」，这时才允许禁用。
  assert.equal(state.canClean.value, false, '文件侧干净后必须回到禁用');
});

test('反向对照：文件侧干净且没有可回收行时，按钮禁用它不发请求', async t => {
  previewSequence(t, { executionCount: '0', filesNeedScan: false, expiredFileRecordCount: '0' });
  const post = t.mock.method(http, 'post', async () => ({
    code: 1, data: { deletedCount: '0', remainingCount: '0' },
  }));
  const { state, app } = mount();
  t.after(() => app.unmount());
  await settle();

  assert.equal(state.canClean.value, false);
  await state.cleanup();
  assert.equal(post.mock.callCount(), 0, '没有可清理内容时不许发清理请求');
});
