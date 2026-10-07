import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import { createRenderer, nextTick } from 'vue';
import type { DefineComponent } from 'vue';
import { McpAPI } from '../src/services/mcp';
import type { McpConnectionVO } from '../src/types/chat';
import type { Result } from '../src/services/types';

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
  const directory = dirname(fileURLToPath(import.meta.url));
  const componentPath = resolve(directory, '../src/views/settings/tabs/McpTab.vue');
  const descriptor = parse(readFileSync(componentPath, 'utf8'), { filename: componentPath }).descriptor;
  const script = compileScript(descriptor, { id: 'mcp-connect-test', inlineTemplate: true });
  const source = script.content.replace(/from ['"](\.[^'"]+)['"]/g, (_match, path: string) =>
    `from '${pathToFileURL(resolve(dirname(componentPath), path + '.ts')).href}'`);
  const modulePath = resolve(directory, '../node_modules/.tmp/mcp-connect-component.mjs');
  mkdirSync(dirname(modulePath), { recursive: true });
  writeFileSync(modulePath, ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText);
  const component = (await import(pathToFileURL(modulePath).href)).default as DefineComponent;
  t.after(() => unlinkSync(modulePath));

  t.mock.method(McpAPI, 'list', async () => ({ code: 1, data: { records: [], total: 0, current: 1, size: 100 } }));
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
    createElement: tag => element(tag),
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
