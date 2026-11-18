import test from 'node:test';
import assert from 'node:assert/strict';
import type {DefineComponent} from 'vue';
import {createRenderer, nextTick} from 'vue';
import {loadComponent} from './helpers/sfcModule';
import type {ContextFactCard} from '../src/utils/contextFacts';

/**
 * 左上角事实卡的渲染契约。
 *
 * <p>只断「用户看得见的东西」：标题 / 正文说了哪几类 / 关得掉。「事实怎么翻译成卡片」由
 * contextFacts.test.ts 覆盖，这里不重复判定逻辑。</p>
 */

interface Element {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: Element[];
  parent: Element | null;
  addEventListener: (...args: any[]) => void;
  removeEventListener: (...args: any[]) => void;
  getRootNode: () => {activeElement: null};
}

function element(tag: string, text = ''): Element {
  return {tag, text, props: {}, children: [], parent: null,
    addEventListener() {}, removeEventListener() {}, getRootNode() { return {activeElement: null}; }};
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

function insertNode(node: Element, parent: Element, anchor: Element | null): void {
  if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
  node.parent = parent;
  const index = anchor ? parent.children.indexOf(anchor) : -1;
  if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
}

function mount(component: DefineComponent, props: Record<string, unknown>): Element {
  const renderer = createRenderer<Element, Element>({
    createElement: tag => element(tag),
    createText: value => element('#text', value),
    createComment: value => element('#comment', value),
    setText: (node, value) => { node.text = value; },
    setElementText: (node, value) => { node.text = value; node.children = []; },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp: (node, key, _old, value) => { node.props[key] = value; Object.assign(node, {[key]: value}); },
    insert: (node, parent, anchor = null) => insertNode(node, parent, anchor),
    remove: node => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = null;
    },
    // 模板里的静态片段（图标 svg、纯文本）走这条：没有 DOM 时由测试自己造一个节点并返回首尾。
    insertStaticContent: (content, parent, anchor = null) => {
      const node = element('#static', content);
      insertNode(node, parent, anchor);
      return [node, node];
    },
  });
  const root = element('root');
  renderer.createApp(component, props).mount(root);
  return root;
}

function cardOf(overrides: Partial<ContextFactCard> = {}): ContextFactCard {
  return {
    id: 'changed:exec-1:1',
    kind: 'changed',
    changedKinds: ['MEMORY'],
    reasons: ['DYNAMIC_SECTIONS_CHANGED'],
    prefixPreserved: true,
    liveBlocks: {current: 3, max: 8},
    summaryGeneration: null,
    messageCount: null,
    createdAt: 1,
    ...overrides,
  };
}

test('变更卡：标题说「上下文被改变」，正文点名被改写的类别', async (t) => {
  const component = (await loadComponent('components/chat/ContextEventCard.vue', t)) as DefineComponent;
  const root = mount(component, {card: cardOf({changedKinds: ['MEMORY', 'TASK']})});
  await nextTick();

  assert.equal(find(root, node => node.props['data-test'] === 'context-fact-card')?.props['data-kind'], 'changed');
  assert.match(text(root), /上下文被改变/);
  const body = find(root, node => node.props['data-test'] === 'context-fact-body');
  assert.ok(body, '正文必须存在：不点名类别，用户只能猜');
  assert.match(text(body as Element), /项目记忆、任务进度/);
  assert.match(text(body as Element), /已改写/);
  // 活片段是事实自带的元信息，读不到就不该编出来
  assert.match(text(root), /活片段 3\/8/);
});

test('不再提供「查看差异」入口：明细已舍弃，留着按钮就是骗点击', async (t) => {
  const component = (await loadComponent('components/chat/ContextEventCard.vue', t)) as DefineComponent;
  const root = mount(component, {card: cardOf({changedKinds: ['MEMORY']})});
  await nextTick();
  assert.equal(find(root, node => node.props['data-test'] === 'context-fact-open-diff'), undefined);
  assert.equal(text(root).includes('查看差异'), false);
});

test('重建卡：只说重建事实，不说「改了哪几类」', async (t) => {
  const component = (await loadComponent('components/chat/ContextEventCard.vue', t)) as DefineComponent;
  const root = mount(component, {
    card: cardOf({
      id: 'rebuilt:exec-2:2', kind: 'rebuilt', changedKinds: [], reasons: [],
      prefixPreserved: false, liveBlocks: null, summaryGeneration: 2, messageCount: 7,
    }),
  });
  await nextTick();

  assert.match(text(root), /上下文被重建/);
  assert.match(text(root), /摘要 #2/);
  assert.match(text(root), /7 条消息/);
});

test('前缀失效优先于「哪几类改了」：这是唯一让缓存整段作废的变化', async (t) => {
  const component = (await loadComponent('components/chat/ContextEventCard.vue', t)) as DefineComponent;
  const root = mount(component, {card: cardOf({prefixPreserved: false})});
  await nextTick();
  assert.match(text(root), /系统提示词已重写，缓存前缀失效/);
});

test('没有段明细时退到「动态片段被改写」，不渲染空正文', async (t) => {
  const component = (await loadComponent('components/chat/ContextEventCard.vue', t)) as DefineComponent;
  const root = mount(component, {card: cardOf({changedKinds: []})});
  await nextTick();
  assert.match(text(find(root, node => node.props['data-test'] === 'context-fact-body') as Element), /动态片段被改写/);
});

test('关闭按钮只上报自己的卡片 id，不连带别的事实', async (t) => {
  const component = (await loadComponent('components/chat/ContextEventCard.vue', t)) as DefineComponent;
  const dismissed: string[] = [];
  const root = mount(component, {card: cardOf(), onDismiss: (id: string) => { dismissed.push(id); }});
  await nextTick();
  find(root, node => node.props['data-test'] === 'context-fact-close')?.props.onClick({stopPropagation() {}});
  assert.deepEqual(dismissed, [cardOf().id]);
});
