const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { parse, compileScript } = require('@vue/compiler-sfc');
const { createRenderer, h, ref, reactive, nextTick } = require('vue');
const previewKey = Symbol('file-preview');

// 编译真实模板，只替换子组件和浏览器依赖，折叠状态与事件使用组件自身逻辑。
function loadComponent() {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = new Module(filename);
    cache.set(filename, module);
    module.filename = filename;
    module.paths = Module._nodeModulePaths(path.dirname(filename));
    module.require = request => {
      if (!request.startsWith('.')) return require(request);
      const resolved = path.resolve(path.dirname(filename), request);
      if (request.endsWith('.vue')) {
        if (request.endsWith('MarkdownRenderer.vue')) {
          return { __esModule: true, default: { props: ['content'], setup: props => () => h('markdown', props.content) } };
        }
        if (request.endsWith('PromptCard.vue')) {
          return { __esModule: true, default: { setup: () => () => h('prompt-card', '审批卡片') } };
        }
        return { __esModule: true, default: { setup: (_props, { slots }) => () => slots.default?.() } };
      }
      if (request.endsWith('/filePreview')) return { FILE_PREVIEW_KEY: previewKey };
      if (request.endsWith('/useTheme')) return { useTheme: () => ({ isDark: ref(true) }) };
      if (request.endsWith('/useCopyFeedback')) {
        return { useCopyFeedback: () => ({ isCopied: ref(false), copiedKey: ref(null), copy() {} }) };
      }
      return load(resolved.endsWith('.ts') ? resolved : resolved + '.ts');
    };
    let source = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('.vue')) {
      const descriptor = parse(source, { filename }).descriptor;
      source = compileScript(descriptor, { id: 'chat-process-collapse', inlineTemplate: true }).content;
    }
    module._compile(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, filename);
    return module.exports;
  }
  return load(path.resolve(__dirname, '../src/components/chat/ChatMessageItem.vue')).default;
}

function element(tag, text = '') {
  return { tag, text, props: {}, children: [], parent: null };
}

function text(node) {
  return node.text + node.children.map(text).join('');
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
}

function mount(t, message) {
  const renderer = createRenderer({
    createElement: tag => element(tag),
    createText: value => element('#text', value),
    createComment: value => element('#comment'),
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
  const previousWindow = global.window;
  global.window = { setInterval };
  const root = element('root');
  const app = renderer.createApp(loadComponent(), { message, isDark: true });
  app.provide(previewKey, undefined);
  app.mount(root);
  t.after(() => {
    app.unmount();
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });
  return root;
}

function message(overrides = {}) {
  return reactive({
    id: 'answer-1', role: 'assistant', turnId: '101', timestamp: 0,
    content: '最终正文', isComplete: true,
    aiMessages: [{ id: 'progress-1', text: '先检查是否已安装', order: 1 }],
    ...overrides,
  });
}

function toggleProcess(root) {
  const button = find(root, node => node.tag === 'button' && /执行过程|已思考|已调用/.test(text(node)));
  assert.ok(button, '只有中间文本时也必须提供过程折叠入口');
  button.props.onClick();
}

test('中间文本随过程展开与收起，最终正文始终可见', async t => {
  const root = mount(t, message());
  assert.doesNotMatch(text(root), /先检查是否已安装/);
  assert.match(text(root), /最终正文/);
  toggleProcess(root);
  await nextTick();
  assert.match(text(root), /先检查是否已安装/);
  toggleProcess(root);
  await nextTick();
  assert.doesNotMatch(text(root), /先检查是否已安装/);
  assert.match(text(root), /最终正文/);
});

test('执行终结自动折叠中间文本，结束后仍可手动展开', async t => {
  const answer = message({ isComplete: false });
  const root = mount(t, answer);
  assert.match(text(root), /先检查是否已安装/);
  answer.isComplete = true;
  await nextTick();
  assert.doesNotMatch(text(root), /先检查是否已安装/);
  assert.match(text(root), /最终正文/);
  toggleProcess(root);
  await nextTick();
  assert.match(text(root), /先检查是否已安装/);
});

test('带思考的过程收起后，中间叙述也必须隐藏', async t => {
  const root = mount(t, message({
    thoughtSteps: [{ id: 'thinking-1', title: '深度思考', content: '思考内容', status: 'success', order: 0 }],
  }));
  assert.doesNotMatch(text(root), /先检查是否已安装|深度思考/);
  toggleProcess(root);
  await nextTick();
  assert.match(text(root), /先检查是否已安装/);
  assert.match(text(root), /深度思考/);
  toggleProcess(root);
  await nextTick();
  assert.doesNotMatch(text(root), /先检查是否已安装|深度思考/);
  assert.match(text(root), /最终正文/);
});

test('过程折叠不隐藏审批卡片，也不重复展示正文', t => {
  const root = mount(t, message({
    aiMessages: [
      { id: 'progress-1', text: '先检查是否已安装', order: 0 },
      { id: 'same-body', text: '最终正文', order: 1 },
    ],
    promptCards: [{ id: 'approval-1', type: 'PROMISE', status: 'pending', kind: 'COMMAND' }],
  }));
  assert.match(text(root), /审批卡片/);
  assert.doesNotMatch(text(root), /先检查是否已安装/);
  assert.equal(text(root).split('最终正文').length - 1, 1);
});

/**
 * ★ 未结束的轮次不得收起最外层过程框（用户实测截图回归）。
 *
 * <p>真实场景（截图）：多轮工具调用跑到第 7 个工具时，界面上的「已思考并调用 N 个工具」
 * 已经折叠起来了，且再也不会自动展开。</p>
 *
 * <p>根因：`isMessageCompleted` 第 1 条判据是 `isThinking || isExploring`。多轮工具调用期间
 * `handleToolCall` 会把 `isThinking` 置为 false（工具调用意味着本轮叙述告一段落），
 * 于是「思考中」这条守卫失效；一旦 `isComplete` 不是 false（后台对账重建的行恒为 true），
 * 且 `turn.status` 尚未解析出来（第 4 条守卫拿不到活跃证据），全部守卫穿透 →
 * 判定「已完成」→ `watch(isMessageCompleted)` 的 false→true 跳变把过程框收起。</p>
 *
 * <p>本用例锁定的不变量：<b>只要轮次未终结，过程框保持展开</b>。断言用「展开态下才渲染的
 * 中间叙述文本」是否存在，而不是断言标题文案 —— 标题在思考中会合法地显示为「思考中...」。</p>
 */
test('★ 未结束的轮次（多轮工具调用进行中）过程框必须保持展开', async t => {
  // 还原截图现场：已思考过、已调用若干工具、当前仍在调用工具、轮次未终结。
  // 关键：isThinking=false + isExploring=false（工具调用把它们清了），但 isComplete 也不是 false
  //      （对账行恒 true）—— 正是守卫全部穿透的组合。
  const answer = message({
    isComplete: true,
    isThinking: false,
    isExploring: false,
    isSuspended: false,
    isSending: true,
    isLastAssistant: true,
    thoughtSteps: [
      { id: 'thinking-1', title: '深度思考', content: '先确认是否已安装', status: 'success', order: 0 },
      { id: 'thinking-2', title: '深度思考', content: '再打开它', status: 'success', order: 1000 },
    ],
    toolCalls: [
      { id: 'call-1', toolName: 'search_tool', status: 'success', order: 1 },
      { id: 'call-2', toolName: 'list_mcp_tools', status: 'success', order: 2 },
      { id: 'call-3', toolName: 'mcp_WaitFor', status: 'calling', order: 1002 },
    ],
    aiMessages: [{ id: 'progress-1', text: '先检查是否已安装', order: 1 }],
  });
  const root = mount(t, answer);

  assert.match(text(root), /先检查是否已安装/, '未终结的轮次过程框必须保持展开');
  assert.match(text(root), /已思考并调用/, '过程框标题必须是「已思考并调用 N 个工具」');

  // 追加一个工具调用（第 8 个）—— 过程框不能因此收起。
  answer.toolCalls.push({ id: 'call-4', toolName: 'mcp_WaitFor', status: 'calling', order: 2002 });
  await nextTick();
  assert.match(text(root), /先检查是否已安装/, '追加工具调用不得把过程框收起');
});

/**
 * ★ 对账重建的行（isComplete 恒 true）在轮次仍活跃时也不能收起过程框。
 *
 * <p>这是上一条的另一半：`isMessageCompleted` 的第 4 条守卫按 `turn.status` 判活跃，
 * 但 `turn` 可能还没解析出来（`props.turn` 为 undefined）→ 拿不到活跃证据 →
 * `isComplete === true` 直接穿透，过程框在「后台 reconcile 拉入行」后被收起。</p>
 */
test('★ turn 摘要缺失但仍在发送中的最新回答，过程框不得收起', async t => {
  const answer = message({
    isComplete: false,
    isThinking: true,
    thoughtSteps: [{ id: 'thinking-1', title: '深度思考', content: '先检查是否已安装', status: 'running', order: 0 }],
  });
  const renderer = createRenderer({
    createElement: tag => element(tag),
    createText: value => element('#text', value),
    createComment: value => element('#comment'),
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
  const previousWindow = global.window;
  global.window = { setInterval };
  const root = element('root');
  const app = renderer.createApp(loadComponent(), { message: answer, isDark: true, isSending: true, isLastAssistant: true });
  app.provide(previewKey, undefined);
  app.mount(root);
  t.after(() => {
    app.unmount();
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });

  assert.match(text(root), /先检查是否已安装/, '发送中的最新回答必须是展开的');
});

