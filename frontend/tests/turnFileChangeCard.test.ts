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

interface Captured {
  url: string;
  method: string;
}

/** 一次真实挂载：桩 fetch 记录请求，返回可断言的根节点与请求列表。 */
async function mountCard(t: test.TestContext, paths: string[] = []) {
  const component = (await loadComponent('components/chat/TurnFileChangeCard.vue', t)) as DefineComponent;
  const requests: Captured[] = [];
  const responses: Record<string, unknown> = {
    summary: {code: 1, data: [
      {filePath: '/ws/src/a.ts', plusLines: 5, minusLines: 2, edits: 2, created: false,
        executionId: 'e1', recordId: 'r1'},
      {filePath: '/ws/README.md', plusLines: 3, minusLines: 0, edits: 1, created: true,
        executionId: 'e1', recordId: 'r2'}
    ]},
    reject: {code: 1, data: 2}
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    requests.push({url, method: init?.method ?? 'GET'});
    const body = url.includes('/reject') ? responses.reject : responses.summary;
    return {ok: true, status: 200, json: async () => body} as any;
  }) as any;
  t.after(() => { globalThis.fetch = previousFetch; });

  const opened: {path: string; edit: any}[] = [];
  const app = renderer().createApp(component, {turnId: '9001', sessionId: 's1', isDark: true});
  app.provide(FILE_PREVIEW_KEY, (_sessionId: any, path: string, edit: any) => opened.push({path, edit}));
  const root = element('root');
  app.mount(root);
  t.after(() => app.unmount());
  // onMounted 里的 await 链需要多轮微任务才落地。
  await nextTick();
  await Promise.resolve();
  await nextTick();
  return {root, requests, opened};
}

test('TurnFileChangeCard：拉取本轮汇总，同一文件只渲染一行并显示净改动', async (t) => {
  const {root, requests} = await mountCard(t);

  assert.ok(requests[0].url.endsWith('/a/file-edits/turns/9001/summary'), `实际请求 ${requests[0].url}`);
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

test('TurnFileChangeCard：点行带着记录定位打开差异视图', async (t) => {
  const {root, opened} = await mountCard(t);

  const rows = findAll(root, node => node.props['data-testid'] === 'turn-file-changes-row');
  rows[0].props.onClick();

  assert.deepEqual(opened, [{path: '/ws/src/a.ts', edit: {executionId: 'e1', recordId: 'r1'}}]);
});

test('TurnFileChangeCard：整轮撤销走 POST 并带上会话，成功后给出反馈而不是静默消失', async (t) => {
  // 桩一个「像浏览器」的 window：组件走 resolveApiUrl → getApiBaseUrl，
  // 那里在有 window 时会读 localStorage，缺了它等于把宿主环境当成半残浏览器。
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', {
    value: {confirm: () => true}, configurable: true
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: {getItem: () => null, setItem() {}, removeItem() {}}, configurable: true
  });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  const {root, requests} = await mountCard(t);
  const undo = findAll(root, node => node.props['data-testid'] === 'turn-file-changes-undo')[0];
  assert.ok(undo, '有改动时必须提供整轮撤销入口');

  await undo.props.onClick();
  await nextTick();
  await Promise.resolve();
  await nextTick();

  const reject = requests.find(request => request.url.includes('/reject'))!;
  assert.equal(reject.method, 'POST', '撤销不能退化成 GET');
  // 还原目标工作空间由后端按轮次归属判定：客户端传 sessionId 等于允许把 A 会话的改动还原到 B 的工作空间。
  assert.ok(!reject.url.includes('sessionId'), `撤销请求不接受客户端指定会话：${reject.url}`);
  assert.ok(reject.url.endsWith('/a/file-edits/turns/9001/reject'), `实际请求 ${reject.url}`);

  const card = findAll(root, node => node.props['data-testid'] === 'turn-file-changes')[0];
  assert.match(text(card), /已撤销本轮 2 个文件的改动/, '点完就整块消失会让人以为没生效');
  assert.equal(findAll(root, node => node.props['data-testid'] === 'turn-file-changes-row').length, 0);
});
