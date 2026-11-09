import test from 'node:test';
import assert from 'node:assert/strict';
import type {DefineComponent} from 'vue';
import {createRenderer, nextTick} from 'vue';
import {loadComponent} from './helpers/sfcModule';
import {McpAPI} from '../src/services/mcp';
import type {McpConnectionVO} from '../src/types/chat';
import type {Result} from '../src/services/types';

interface Element {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Element[];
  parent: Element | null;
  addEventListener: (...args: any[]) => void;
  removeEventListener: (...args: any[]) => void;
  getRootNode: () => { activeElement: null };
}

function element(tag: string, text = ''): Element {
  return { tag, text, props: {}, children: [], parent: null,
    addEventListener() {}, removeEventListener() {}, getRootNode() { return { activeElement: null }; } };
}

function text(node: Element): string {
  if (node.tag === '#comment') return '';
  return node.text + node.children.map(text).join('');
}

function find(node: Element, predicate: (value: Element) => boolean): Element | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
}

test('实际新增 MCP 组件：按钮可点击，连接中禁用保存，成功和失败结果可见', async (t) => {
  // SFC 编译与相对导入改写统一走 tests/helpers/sfcModule（支持 .vue 子组件递归编译），
  // 卡片拆成 McpServiceCard 后，本地那份「只认 .ts」的解析逻辑已经不够用。
  const component = (await loadComponent('views/settings/tabs/McpTab.vue', t)) as DefineComponent;

  t.mock.method(McpAPI, 'list', async () => ({ code: 1, data: { records: [{ id: '42', name: 'saved', url: 'http://saved/mcp', status: 0 }], total: 1, current: 1, size: 100 } }));
  let finish!: (result: Result<McpConnectionVO>) => void;
  const connect = t.mock.method(McpAPI, 'connect', () => new Promise<Result<McpConnectionVO>>(resolve => { finish = resolve; }));
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousDocumentType = Object.getOwnPropertyDescriptor(globalThis, 'Document');
  const previousShadowRootType = Object.getOwnPropertyDescriptor(globalThis, 'ShadowRoot');
  Object.defineProperty(globalThis, 'document', { value: { activeElement: null }, configurable: true });
  Object.defineProperty(globalThis, 'Document', { value: class TestDocument {}, configurable: true });
  Object.defineProperty(globalThis, 'ShadowRoot', { value: class TestShadowRoot {}, configurable: true });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (previousDocumentType) Object.defineProperty(globalThis, 'Document', previousDocumentType);
    else Reflect.deleteProperty(globalThis, 'Document');
    if (previousShadowRootType) Object.defineProperty(globalThis, 'ShadowRoot', previousShadowRootType);
    else Reflect.deleteProperty(globalThis, 'ShadowRoot');
  });

  const renderer = createRenderer<Element, Element>({
    // select 的 v-model 走 runtime-dom 的 vModelSelect 指令，它会读 el.options / el.multiple，
    // 假元素不补这几个字段就会在挂载阶段的 directive hook 里抛 TypeError（既有隐患，顺手补齐）。
    createElement: tag => {
      const node = element(tag);
      if (tag === 'select') Object.assign(node, { options: [], multiple: false, selectedIndex: -1, value: '' });
      return node;
    },
    createText: value => element('#text', value),
    createComment: value => element('#comment', value),
    setText: (node, value) => { node.text = value; },
    setElementText: (node, value) => { node.text = value; node.children = []; },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp: (node, key, _old, value) => { node.props[key] = value; Object.assign(node, { [key]: value }); },
    insert: (node, parent, anchor = null) => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
    },
    remove: node => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = null;
    },
  });
  const root = element('root');
  const app = renderer.createApp(component, { isDark: true });
  app.mount(root);
  t.after(() => app.unmount());
  await nextTick();
  await Promise.resolve();
  await nextTick();
  const rowButton = find(root, node => node.tag === 'button' && text(node).includes('测试连接'))!;
  assert.ok(rowButton, '停用服务也必须能测试连接');
  assert.match(rowButton.props.class, /text-emerald/);
  const rowPending = rowButton.props.onClick();
  await nextTick();
  assert.equal(rowButton.props.disabled, true);
  assert.equal(rowButton.props['aria-busy'], true);
  assert.match(text(rowButton), /正在连接/);
  finish({ code: 1, data: { toolCount: 0, toolNames: [], elapsedMillis: 10 } });
  await rowPending;
  await nextTick();
  assert.equal(text(rowButton).trim(), '连接成功');
  find(root, node => node.tag === 'button' && text(node).trim() === '编辑')!.props.onClick();
  await nextTick();
  assert.ok(find(root, node => node.tag === 'button' && text(node).includes('测试连接')), '编辑页面必须渲染测试连接按钮');
  find(root, node => node.tag === 'button' && text(node).trim() === '取消')!.props.onClick();
  await nextTick();
  find(root, node => node.tag === 'button' && text(node).includes('新建服务'))!.props.onClick();
  await nextTick();
  const name = find(root, node => node.tag === 'input' && node.props.placeholder?.includes('需全局唯一'))!;
  const url = find(root, node => node.tag === 'input' && node.props.placeholder?.startsWith('https://'))!;
  assert.ok(name);
  assert.ok(url);
  name.props['onUpdate:modelValue']('draft');
  url.props['onUpdate:modelValue']('http://localhost:9000/mcp');
  await nextTick();
  const button = find(root, node => node.tag === 'button' && text(node).includes('测试连接'))!;
  assert.ok(button, '新增页面必须渲染测试连接按钮');
  const pending = button.props.onClick();
  await nextTick();
  assert.match(text(button), /正在连接/);
  assert.equal(button.props.disabled, true);
  assert.equal(find(root, node => node.tag === 'button' && text(node).trim() === '保存')!.props.disabled, true);
  finish({ code: 1, data: { toolCount: 1, toolNames: ['echo'], elapsedMillis: 25 } });
  await pending;
  await nextTick();
  assert.match(text(find(root, node => node.props.role === 'status')!), /连接成功，发现 1 个工具/);
  assert.match(text(root), /echo/);
  assert.equal(button.props.disabled, false);
  url.props['onUpdate:modelValue']('http://changed/mcp');
  await nextTick();
  assert.equal(find(root, node => node.props.role === 'status'), undefined);
  connect.mock.mockImplementation(async () => ({ code: 0, errMsg: 'MCP 连接测试失败' }));
  await button.props.onClick();
  await nextTick();
  assert.equal(text(find(root, node => node.props.role === 'alert')!), 'MCP 连接测试失败');
});
