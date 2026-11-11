import assert from 'node:assert/strict';
import test from 'node:test';
import type {DefineComponent} from 'vue';
import {createRenderer, nextTick} from 'vue';
import {loadComponent} from './helpers/sfcModule';
import {setPreference} from '../src/i18n';
import {FILE_PREVIEW_KEY} from '../src/types/filePreview';

setPreference('zh-CN');

interface Element {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Element[];
  parent: Element | null;
  addEventListener: (...args: any[]) => void;
  removeEventListener: (...args: any[]) => void;
}

function element(tag: string, text = ''): Element {
  return {tag, text, props: {}, children: [], parent: null,
    addEventListener() {}, removeEventListener() {}};
}

function text(node: Element): string {
  if (node.tag === '#comment') return '';
  return node.text + node.children.map(text).join('');
}

function findAll(node: Element, predicate: (value: Element) => boolean, out: Element[] = []): Element[] {
  if (predicate(node)) out.push(node);
  for (const child of node.children) findAll(child, predicate, out);
  return out;
}

function renderer() {
  return createRenderer<Element, Element>({
    createElement: tag => element(tag),
    createText: value => element('#text', value),
    createComment: value => element('#comment', value),
    setText: (node, value) => { node.text = value; },
    setElementText: (node, value) => { node.text = value; node.children = []; },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp: (node, key, _old, value) => { node.props[key] = value; Object.assign(node, {[key]: value}); },
    insert: (node, parent, anchor = null) => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
    },
    remove: node => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = null;
    }
  });
}

/** 后端随轮次视图下发的清单（`TurnViewVO.fileChanges` 同形）。 */
const ITEMS = [
  {filePath: '/ws/src/a.ts', plusLines: 5, minusLines: 2, edits: 2, created: false,
    executionId: 'e1', recordId: 'r1', diffAvailable: true},
  {filePath: '/ws/README.md', plusLines: 3, minusLines: 0, edits: 1, created: true,
    executionId: 'e1', recordId: 'r2', diffAvailable: false}
];

interface Mounted {
  root: Element;
  opened: {path: string; edit: any}[];
  requests: string[];
}

/**
 * 一次真实挂载：清单**只从 props 来**。
 *
 * <p>桩住的 {@code fetch} 不是装饰 —— 它记录「卡片有没有偷偷发请求」。
 * 曾经这里挂载后自己请求 `/a/file-edits/turns/{id}/summary`，于是加载会话时卡片迟到、
 * 列表高度二次增长，视图被强行顶走一段。这条契约必须在用例里钉住。</p>
 */
async function mountCard(t: test.TestContext, items: any[] | null = ITEMS): Promise<Mounted> {
  const component = (await loadComponent('components/chat/TurnFileChangeCard.vue', t)) as DefineComponent;
  const requests: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    requests.push(String(input));
    throw new Error('卡片不得自行发请求：清单必须随轮次视图同帧到达');
  }) as any;
  t.after(() => { globalThis.fetch = previousFetch; });

  const opened: {path: string; edit: any}[] = [];
  const app = renderer().createApp(component, {items, sessionId: 's1', isDark: true});
  app.provide(FILE_PREVIEW_KEY, (_sessionId: any, path: string, edit: any) => opened.push({path, edit}));
  const root = element('root');
  app.mount(root);
  t.after(() => app.unmount());
  await nextTick();
  return {root, opened, requests};
}

test('TurnFileChangeCard：清单来自 props，同一文件只渲染一行并显示净改动', async (t) => {
  const {root} = await mountCard(t);

  const rows = findAll(root, node => node.props['data-testid'] === 'turn-file-changes-row');
  assert.equal(rows.length, 2, '后端已合并同文件，前端不得再拆行');
  assert.match(text(rows[0]), /a\.ts/);
  assert.match(text(rows[0]), /\+5/);
  assert.match(text(rows[0]), /-2/);
  // 编辑次数 > 1 才提示「合并了几次编辑」。
  assert.match(text(rows[0]), /2 次编辑/);
  assert.doesNotMatch(text(rows[1]), /次编辑/);
  // 新建文件给单独徽标，避免和「改了很多行」混为一谈。
  assert.match(text(rows[1]), /新建/);
});

test('TurnFileChangeCard：不自行请求汇总，数据只走 props', async (t) => {
  const {requests} = await mountCard(t);

  assert.deepEqual(requests, [], '卡片挂载后不得再发任何请求（否则清单会迟到并二次撑高列表）');
});

test('TurnFileChangeCard：点行带着记录定位打开差异视图，不可点开的行没有入口', async (t) => {
  const {root, opened} = await mountCard(t);

  const rows = findAll(root, node => node.props['data-testid'] === 'turn-file-changes-row');
  rows[0].props.onClick();
  assert.deepEqual(opened, [{path: '/ws/src/a.ts', edit: {executionId: 'e1', recordId: 'r1'}}],
    '最新轮次有差异正文，点行必须带着两个标识');

  // 第二行 diffAvailable=false（历史轮次没有正文）：点了也不能打开一个空白面板。
  rows[1].props.onClick?.();
  assert.equal(opened.length, 1, '差异不可用的行不得打开预览');
});

test('TurnFileChangeCard：空清单整卡不渲染，不占位', async (t) => {
  const {root} = await mountCard(t, []);

  assert.equal(findAll(root, node => node.props['data-testid'] === 'turn-file-changes').length, 0);
});
