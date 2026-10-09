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
function loadChatModule(filename) {
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
  return load(filename);
}

function loadComponent() {
  return loadChatModule(path.resolve(__dirname, '../src/components/chat/ChatMessageItem.vue')).default;
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

function streamFixture() {
  const { TurnStreamReducer } = loadChatModule(path.resolve(__dirname, '../src/views/chat/turnStreamReducer.ts'));
  const { AgentToolName } = loadChatModule(path.resolve(__dirname, '../src/utils/toolNames.ts'));
  const messages = reactive([]);
  const reducer = new TurnStreamReducer(() => messages, { sessionId: '7' });
  const event = data => ({ executionId: 'e', timestamp: '', metaData: { sessionId: '7', turnId: '900' }, ...data });
  reducer.consume(event({ type: 'EXECUTION_STARTED' }));
  return { reducer, event, answer: messages[0], AgentToolName };
}

test('实测回归：已有历史工具之后，新思考在过程末尾即时追加', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  reducer.consume({ type: 'TURN_SNAPSHOT', sessionId: '7', turnId: '900', viewVersion: '1', view: {
    sessionId: '7', turnId: '900', viewVersion: '1', status: 'RUNNING', blocks: [
      { blockId: 'thinking:r1', responseId: 'r1', type: 'THINKING', order: 1000, status: 'COMPLETE', text: '旧思考' },
      { blockId: 'tool:old-call', type: 'TOOL', order: 1002, status: 'COMPLETED', toolCallId: 'old-call',
        toolName: AgentToolName.ReadFile, arguments: '{"path":"old-tool.md"}' },
    ],
  } });
  const root = mount(t, answer);
  reducer.consume(event({ type: 'PARTIAL_THINKING', responseId: 'r2', offset: 0, order: 2000, content: '末尾实时思考' }));
  await nextTick();
  let rendered = text(root);
  assert.ok(rendered.includes('old-tool.md'));
  assert.ok(rendered.indexOf('末尾实时思考') > rendered.indexOf('old-tool.md'), rendered);
  reducer.consume(event({ type: 'PARTIAL_THINKING', responseId: 'r2', offset: 6, order: 2000, content: '继续打印' }));
  await nextTick();
  rendered = text(root);
  assert.ok(rendered.indexOf('末尾实时思考继续打印') > rendered.indexOf('old-tool.md'), rendered);
  assert.equal(answer.thoughtSteps.filter(step => step.id === 'thinking:r2').length, 1);
});

test('实测回归：没有快照时工具开始即渲染，收尾和重复事件不增行', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  const root = mount(t, answer);
  const call = { type: 'TOOL_CALL', requestId: 'c1', responseId: 'r1', order: 2,
    toolName: AgentToolName.ReadFile, args: '{"path":"live-tool.md"}', resultStatus: 'STARTED' };
  reducer.consume(event(call));
  await nextTick();
  assert.match(text(root), /live-tool\.md/, '执行未结束，工具名称与参数已经可见');
  assert.equal(answer.toolCalls[0].status, 'calling');
  reducer.consume(event({ ...call, type: 'TOOL_COMPLETED', resultStatus: 'COMPLETED', output: '工具结果' }));
  reducer.consume(event(call));
  reducer.consume(event({ type: 'PARTIAL_THINKING', responseId: 'r2', offset: 0, order: 1000, content: '工具后的新思考' }));
  await nextTick();
  assert.equal(answer.toolCalls.length, 1);
  assert.equal(answer.toolCalls[0].status, 'success');
  assert.equal(answer.toolCalls[0].result, '工具结果');
  const rendered = text(root);
  assert.equal(rendered.split('live-tool.md').length - 1, 1);
  assert.ok(rendered.indexOf('工具后的新思考') > rendered.indexOf('live-tool.md'), rendered);
});

test('第二版真实组件：工具先到的文本持续追加在过程区，旧快照不搬回正文', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  const root = mount(t, answer);
  reducer.consume(event({ type: 'TOOL_CALL', requestId: 'c1', responseId: 'r1', order: 2,
    toolName: AgentToolName.ReadFile, args: '{"path":"a.md"}' }));
  reducer.consume(event({ type: 'PARTIAL_TEXT', responseId: 'r1', offset: 0, order: 1, content: '先读' }));
  await nextTick();
  assert.match(text(root), /先读/);
  assert.equal(answer.content, '');
  reducer.consume(event({ type: 'PARTIAL_TEXT', responseId: 'r1', offset: 2, order: 1, content: '文件' }));
  await nextTick();
  assert.match(text(root), /先读文件/);
  reducer.consume(event({ type: 'PARTIAL_TEXT', responseId: 'r2', offset: 0, order: 1001, content: '最终结论' }));
  reducer.consume({ type: 'TURN_SNAPSHOT', sessionId: '7', turnId: '900', viewVersion: '1', view: {
    sessionId: '7', turnId: '900', viewVersion: '1', status: 'RUNNING', blocks: [
      { blockId: 'text:r1', responseId: 'r1', type: 'TEXT', order: 1, status: 'COMPLETE', placement: 'BODY', text: '先读文件' },
    ],
  } });
  await nextTick();
  assert.equal(answer.content, '最终结论');
  assert.equal(text(root).split('先读文件').length - 1, 1);
  assert.match(text(root), /a\.md/);
  reducer.consume(event({ type: 'TOOL_COMPLETED', requestId: 'c1', responseId: 'r1', order: 2,
    toolName: AgentToolName.ReadFile, args: '{"path":"a.md"}', output: '文件内容', resultStatus: 'COMPLETED' }));
  await nextTick();
  reducer.consume(event({ type: 'EXECUTION_COMPLETED' }));
  await nextTick();
  assert.doesNotMatch(text(root), /先读文件/);
  assert.match(text(root), /最终结论/);
  toggleProcess(root);
  await nextTick();
  assert.match(text(root), /先读文件/);
});

test('读取摘要：缺省范围显示全文，单边范围按后端默认边界显示', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  const root = mount(t, answer);
  for (const [index, args] of [
    { path: 'whole.json' }, { path: 'range.json', startLine: 2, endLine: 5 },
    { path: 'head.json', endLine: 3 }, { path: 'tail.json', startLine: 4 },
  ].entries()) {
    reducer.consume(event({ type: 'TOOL_CALL', requestId: `read-${index}`, responseId: 'r1', order: index + 2,
      toolName: AgentToolName.ReadFile, args: JSON.stringify(args) }));
  }
  await nextTick();
  const rendered = text(root);
  assert.match(rendered, /whole\.json\s*全文/);
  assert.match(rendered, /range\.json\s*L2-5/);
  assert.match(rendered, /head\.json\s*L0-3/);
  assert.match(rendered, /tail\.json\s*L4-末尾/);
});

test('实时编辑摘要：从元数据读取统计，未展开也显示 +N -0，旧快照不得清除统计', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  const root = mount(t, answer);
  const call = { requestId: 'edit-1', responseId: 'r1', order: 2,
    toolName: AgentToolName.EditFile, args: '{"path":"memory.md"}' };
  reducer.consume(event({ ...call, type: 'TOOL_CALL' }));
  await nextTick();
  assert.doesNotMatch(text(root), /\+0|-0/, '收尾前统计未知，不冒充零改动');
  reducer.consume(event({ ...call, type: 'TOOL_COMPLETED', resultStatus: 'COMPLETED', output: '',
    metaData: { sessionId: '7', turnId: '900', fileEdit: { filePath: 'memory.md', plusLines: 7, minusLines: 0 } } }));
  await nextTick();
  assert.match(text(root), /memory\.md\s*\+7-0/);
  reducer.consume({ type: 'TURN_SNAPSHOT', sessionId: '7', turnId: '900', viewVersion: '1', view: {
    sessionId: '7', turnId: '900', viewVersion: '1', status: 'RUNNING', blocks: [
      { blockId: 'tool:edit-1', type: 'TOOL', order: 2, status: 'STARTED', toolCallId: 'edit-1',
        toolName: AgentToolName.EditFile, arguments: call.args },
    ],
  } });
  await nextTick();
  assert.match(text(root), /memory\.md\s*\+7-0/);
});

test('历史编辑摘要：解析持久化结果的 output，工具收起时显示增删行', async t => {
  const { reducer, answer, AgentToolName } = streamFixture();
  reducer.consume({ type: 'TURN_SNAPSHOT', sessionId: '7', turnId: '900', viewVersion: '1', view: {
    sessionId: '7', turnId: '900', viewVersion: '1', status: 'RUNNING', blocks: [
      { blockId: 'tool:edit-history', type: 'TOOL', order: 2, status: 'COMPLETED', toolCallId: 'edit-history',
        toolName: AgentToolName.EditFile, arguments: '{"path":"history.md"}',
        output: JSON.stringify({ outcome: 'SUCCEEDED', output: JSON.stringify({ plusLines: 3, minusLines: 2 }) }) },
      { blockId: 'tool:create-history', type: 'TOOL', order: 3, status: 'COMPLETED', toolCallId: 'create-history',
        toolName: AgentToolName.EditFile, arguments: '{"path":"created.md"}',
        output: JSON.stringify({ plusLines: 5, minusLines: 0 }) },
    ],
  } });
  const root = mount(t, answer);
  assert.match(text(root), /history\.md\s*\+3-2/);
  assert.match(text(root), /created\.md\s*\+5-0/);
  const button = find(root, node => node.tag === 'button' && node.props['aria-label'] === '查看写入详情');
  button.props.onClick({ stopPropagation() {} });
  await nextTick();
  assert.equal(text(root).split('+3-2').length - 1, 2, '展开详情也保留相同统计');
});

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

