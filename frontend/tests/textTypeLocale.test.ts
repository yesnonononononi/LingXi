import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import { createRenderer, nextTick, h, reactive, defineComponent } from 'vue';
import type { DefineComponent } from 'vue';

interface Element {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Element[];
  parent: Element | null;
}

function element(tag: string, text = ''): Element {
  return { tag, text, props: {}, children: [], parent: null };
}

function text(node: Element): string {
  if (node.tag === '#comment') return '';
  return node.text + node.children.map(text).join('');
}

/** 与 mcpConnectComponent.test.ts 同一套 SFC 编译挂载手法 */
async function compileComponent(relativePath: string, id: string): Promise<DefineComponent> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const componentPath = resolve(directory, relativePath);
  const descriptor = parse(readFileSync(componentPath, 'utf8'), { filename: componentPath }).descriptor;
  const script = compileScript(descriptor, { id, inlineTemplate: true });
  const source = script.content.replace(/from ['"](\.[^'"]+)['"]/g, (_match, path: string) => {
    const base = resolve(dirname(componentPath), path);
    const target = base.endsWith('.ts') ? base : base + '.ts';
    return `from '${pathToFileURL(target).href}'`;
  });
  const modulePath = resolve(directory, `../node_modules/.tmp/${id}.mjs`);
  mkdirSync(dirname(modulePath), { recursive: true });
  writeFileSync(modulePath, ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText);
  const component = (await import(pathToFileURL(modulePath).href)).default as DefineComponent;
  return component;
}

test('TextType：外部文本变化后重置打字机并重放新文案（语言切换回归）', async (t) => {
  const TextType = await compileComponent('../src/components/common/TextType.vue', 'text-type-test');

  const renderer = createRenderer<Element, Element>({
    createElement: tag => element(tag),
    createText: value => element('#text', value),
    createComment: value => element('#comment', value),
    setText: (node, value) => { node.text = value; },
    setElementText: (node, value) => { node.text = value; node.children = []; },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp: (node, key, _old, value) => { node.props[key] = value; },
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

  // 外部状态模拟 i18n locale：变化后传给 TextType 的 text 随之改变
  const state = reactive({ text: 'AB' });
  const wrapper = defineComponent({
    setup: () => () => h(TextType, { text: state.text, typingSpeed: 1, pauseDuration: 1, loop: false, showCursor: false, as: 'span' })
  });
  const root = element('root');
  const app = renderer.createApp(wrapper);
  app.mount(root);
  t.after(() => app.unmount());
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  await sleep(80);
  await nextTick();
  assert.match(text(root), /AB/, '首段文案应完整打出');

  // 语言切换：外部文案 AB → 今天想构建什么
  state.text = '今天想构建什么';
  await nextTick();
  await sleep(400);
  await nextTick();
  assert.match(text(root), /今天想构建什么/, '文本变化后必须重放新文案');
  assert.doesNotMatch(text(root), /AB/, '旧文案不得残留');

  // 连续再切一次（EN → ZH → EN 场景），确保不是只支持一次重放
  state.text = 'What do you want to build today?';
  await nextTick();
  await sleep(800);
  await nextTick();
  assert.match(text(root), /What do you want to build today\?/);
  assert.doesNotMatch(text(root), /今天想构建什么/);
});
