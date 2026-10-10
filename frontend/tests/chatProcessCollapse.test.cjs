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
function loadChatModule(filename, realPlanCards = false) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = new Module(filename);
    cache.set(filename, module);
    module.filename = filename;
    module.paths = Module._nodeModulePaths(path.dirname(filename));
    module.require = request => {
      if (request === 'vue') {
        return { ...require('vue'), Transition: { setup: (_props, { slots }) => () => slots.default?.() } };
      }
      if (!request.startsWith('.')) return require(request);
      const resolved = path.resolve(path.dirname(filename), request);
      if (request.endsWith('.vue')) {
        if (request.endsWith('CardHeader.vue')) return load(resolved);
        if (realPlanCards && /(?:PromptCard|PlanCard|CardActionButton)\.vue$/.test(request)) return load(resolved);
        if (request.endsWith('GradientText.vue')) {
          return { __esModule: true, default: {
            props: ['colors', 'animationSpeed', 'showBorder'],
            setup: (props, { slots }) => () => h('gradient-text', { ...props }, slots.default?.()),
          } };
        }
        if (request.endsWith('MarkdownRenderer.vue')) {
          return { __esModule: true, default: { props: ['content', 'thinkingText', 'processText'], setup: props => () => h('markdown', { thinkingText: props.thinkingText, processText: props.processText }, props.content) } };
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

/** 按内容定位某个思考步骤的滚动框（一个消息里可能同时有多段思考）。 */
function resolveThinkingBox(root, marker) {
  return find(root, node =>
    String(node.props?.class ?? '').includes('thinking-content') && text(node).includes(marker));
}

/** 伪元素没有布局，手动给出滚动几何：`overflow` 为内容高度超出可视高度的部分。 */
function layoutThinkingBox(box, contentHeight, viewportHeight, scrollTop = 0) {
  box.scrollHeight = contentHeight;
  box.clientHeight = viewportHeight;
  box.scrollTop = scrollTop;
  return box;
}

function mount(t, message, props = {}) {
  return mountComponent(t, loadComponent(), { message, isDark: true, ...props });
}

function mountComponent(t, component, props) {
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
  const app = renderer.createApp(component, props);
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

test('历史计划书：权威卡片经真实消息和计划组件显示完整正文与审批按钮', t => {
  const load = filename => loadChatModule(path.resolve(__dirname, filename), true);
  const { AgentToolName } = load('../src/utils/toolNames.ts');
  const { aggregateRecordsByIdentity } = load('../src/utils/session.ts');
  const { attachPromptCards } = load('../src/utils/toolCallCard.ts');
  const body = '## 目标\n\n核验真实产物。\n\n## 任务\n\n新增统计能力并独立验收。';
  const callId = 'call-render-plan';
  const messages = aggregateRecordsByIdentity('2108854642652921856', { '2108854643462422528': {
    sessionId: '2108854642652921856', turnId: '2108854643462422528', status: 'WAITING', viewVersion: '4',
    blocks: [{ blockId: `tool:${callId}`, responseId: '896693207532830720', order: 1,
      type: 'TOOL', status: 'PROMISED', toolCallId: callId, toolName: AgentToolName.CreatePlan,
      arguments: JSON.stringify({ title: '参数标题', text: '参数不能替代权威正文' }) }],
  } });
  attachPromptCards(messages, [{ id: callId, conversationId: '2108854642652921856',
    type: 'PROMISE', status: 'pending', version: '4', pending: true, allowedActions: ['APPROVE', 'REJECT'],
    content: { kind: 'PLAN', title: '协作式演示计划', text: body }, toolName: AgentToolName.CreatePlan }]);
  const component = load('../src/components/chat/ChatMessageItem.vue').default;
  for (const isDark of [false, true]) {
    const root = mountComponent(t, component, { message: reactive(messages.find(item => item.role === 'assistant')),
      sessionId: '2108854642652921856', isDark, isSuspended: true });
    assert.ok(text(root).includes(body), '完整正文应显示在真正的计划组件中');
    assert.ok(find(root, node => node.tag === 'button' && text(node).includes('批准')));
    assert.ok(find(root, node => node.tag === 'button' && text(node).includes('拒绝执行')));
    assert.doesNotMatch(text(root), /恢复执行|当前轮次已挂起/);
  }
});

test('终端描述样式：与深度思考标题字号和颜色一致，明暗主题及结束状态保持一致', async t => {
  const { AgentToolName } = loadChatModule(path.resolve(__dirname, '../src/utils/toolNames.ts'));
  for (const isDark of [false, true]) {
    const answer = message({ isComplete: false, aiMessages: [], thoughtSteps: [
      { id: 'thinking-size', title: '思考', content: '检查当前目录', status: 'running', order: 0 },
    ], toolCalls: [
      { id: 'command-size', toolName: AgentToolName.ExecuteCommand, status: 'calling',
        query: JSON.stringify({ command: 'git status', intention: '检查工作目录' }), order: 1 },
    ] });
    const root = mount(t, answer, { isDark });
    for (const status of ['calling', 'success']) {
      answer.toolCalls[0].status = status;
      answer.thoughtSteps[0].status = status === 'calling' ? 'running' : 'success';
      await nextTick();
      const description = find(root, node => node.tag === 'button' && text(node) === '检查工作目录');
      const thinking = find(root, node => node.tag === 'button' && text(node) === '深度思考');
      assert.ok(description);
      assert.ok(thinking);
      assert.match(description.props.class, /\btext-xs\b/, '终端描述使用与思考相同的字号');
      assert.match(thinking.parent.props.class, /\btext-xs\b/);
      const colors = isDark ? ['text-zinc-400', 'hover:text-zinc-200'] : ['text-zinc-500', 'hover:text-zinc-700'];
      for (const color of colors) {
        assert.equal(description.props.class.split(' ').includes(color), true, `终端描述颜色应与思考一致：${color}`);
        assert.equal(thinking.props.class.split(' ').includes(color), true);
      }
      assert.equal(description.props.class.split(' ').includes('[text-shadow:none]'), true, '终端描述不继承工具行的发光');
    }
  }
});

test('工具执行提示：仅显示静态灰字，结束后替换为真实输出', async t => {
  const { AgentToolName } = loadChatModule(path.resolve(__dirname, '../src/utils/toolNames.ts'));
  const answer = message({ isComplete: false, aiMessages: [], toolCalls: [
    { id: 'command-running', toolName: AgentToolName.ExecuteCommand, status: 'calling',
      query: JSON.stringify({ command: 'git status' }), order: 0 },
  ] });
  const root = mount(t, answer);
  const toggle = find(root, node => node.tag === 'button' && /查看.*详情/.test(node.props['aria-label'] ?? ''));
  assert.ok(toggle);
  toggle.props.onClick({ stopPropagation() {} });
  await nextTick();
  const hint = find(root, node => node.tag === 'div' && String(node.props.class ?? '').includes('font-mono') && text(node).trim() === '正在执行中...');
  assert.ok(hint);
  assert.match(hint.props.class, /text-gray-400/);
  assert.doesNotMatch(hint.props.class, /animate-|text-amber/);
  assert.equal(Boolean(find(hint, node => String(node.props.class ?? '').includes('rounded-full'))), false);

  answer.toolCalls[0].status = 'success';
  answer.toolCalls[0].result = '执行完成';
  await nextTick();
  assert.doesNotMatch(text(root), /正在执行中/);
  assert.match(text(root), /执行完成/);
});

test('深度思考标题：只在运行时加载渐变，结束后静态标题仍可折叠正文', async t => {
  const answer = message({ isComplete: false, aiMessages: [], thoughtSteps: [
    { id: 'thinking-gradient', title: '思考', content: '思考正文', status: 'running', order: 0 },
  ] });
  const root = mount(t, answer);
  const title = find(root, node => node.tag === 'gradient-text' && text(node) === '深度思考');
  assert.ok(title, '思考标题应使用 GradientText 组件');
  assert.equal(title.props.animationSpeed, 3);
  assert.equal(title.props.showBorder, false);
  const header = find(root, node => node.tag === 'button' && text(node).includes('深度思考'));
  assert.equal(Boolean(find(header, node => String(node.props.class ?? '').includes('animate-ping'))), false);
  assert.match(text(root), /思考正文/);

  answer.thoughtSteps[0].status = 'success';
  await nextTick();
  assert.doesNotMatch(text(root), /思考正文/);
  const toggle = find(root, node => node.tag === 'button' && text(node).includes('深度思考'));
  assert.ok(toggle);
  toggle.props.onClick();
  await nextTick();
  assert.match(text(root), /思考正文/);
  assert.equal(Boolean(find(root, node => node.tag === 'gradient-text' && text(node) === '深度思考')), false);
  toggle.props.onClick();
  await nextTick();
  assert.doesNotMatch(text(root), /思考正文/);
});

test('深度思考动效：挂起、终态和历史不加载，运行中的对账消息仍可加载', async t => {
  const answer = message({ isComplete: false, aiMessages: [], thoughtSteps: [
    { id: 'thinking-current', title: '思考', content: '当前思考', status: 'running', order: 0 },
    { id: 'thinking-old', title: '旧思考', content: '历史思考', status: 'success', order: 1 },
  ] });
  const turn = reactive({ status: 'RUNNING' });
  const root = mount(t, answer, { turn });
  const resolveAnimation = () => find(root, node => node.tag === 'gradient-text' && text(node) === '深度思考');
  assert.ok(resolveAnimation());
  assert.equal(Boolean(find(root, node => node.tag === 'gradient-text' && text(node) === '旧思考')), false);

  answer.isSuspended = true;
  await nextTick();
  assert.equal(Boolean(resolveAnimation()), false);
  answer.isSuspended = false;
  answer.isComplete = true;
  await nextTick();
  assert.ok(resolveAnimation(), '对账行已完整不等于运行轮次已结束');

  for (const status of ['WAITING', 'COMPLETED', 'FAILED', 'CANCELLED']) {
    turn.status = status;
    await nextTick();
    assert.equal(Boolean(resolveAnimation()), false, status);
  }
  turn.status = 'RUNNING';
  answer.isComplete = false;
  await nextTick();
  toggleProcess(root);
  await nextTick();
  assert.ok(resolveAnimation());

  const history = mount(t, message({ aiMessages: [], thoughtSteps: [
    { id: 'history-step', title: '思考', content: '旧记录', status: 'running', order: 0 },
  ] }));
  toggleProcess(history);
  await nextTick();
  assert.match(text(history), /深度思考/);
  assert.equal(Boolean(find(history, node => node.tag === 'gradient-text')), false);
});

test('思考正文：引用块内使用 Markdown，逐段追加保留完整内容', async t => {
  const answer = message({ isComplete: false, aiMessages: [], thoughtSteps: [
    { id: 'thinking-markdown', title: '思考', content: '**原因**\n\n- 第一条', status: 'running', order: 0 },
  ] });
  const root = mount(t, answer, { isDark: false });
  const resolveBody = () => find(root, node => node.tag === 'markdown' && node.props.thinkingText === true);
  assert.ok(resolveBody(), '思考内容使用独立 Markdown 样式');
  assert.equal(text(resolveBody()), answer.thoughtSteps[0].content);
  const box = find(root, node => String(node.props.class ?? '').includes('thinking-content'));
  assert.ok(box);
  assert.match(box.props.class, /border-l-\[3px\]/);
  answer.thoughtSteps[0].content += '\n- 第二条';
  await nextTick();
  assert.equal(text(resolveBody()), answer.thoughtSteps[0].content);
});

test('挂起消息不显示黄色恢复条，计划与命令审批卡仍保留', async t => {
  for (const isDark of [false, true]) {
    const answer = message({ isSuspended: true, isComplete: false, aiMessages: [] });
    const root = mount(t, answer, { isDark });
    const assertNoResumeBar = () => {
      assert.doesNotMatch(text(root), /当前轮次已挂起|等待人工决策或继续操作|恢复执行/);
      assert.equal(Boolean(find(root, node => node.tag === 'button' && text(node).trim() === '恢复执行')), false);
    };
    assertNoResumeBar();

    for (const kind of ['PLAN', 'COMMAND']) {
      answer.promptCards = [{ id: `card-${kind}`, type: 'PROMISE', status: 'pending',
        content: { kind, text: '任务正文', command: 'git status', subSessionId: '8' },
        allowedActions: ['APPROVE', 'REJECT'] }];
      await nextTick();
      assertNoResumeBar();
      assert.ok(find(root, node => node.tag === 'prompt-card'), `${kind} 审批卡仍保留`);
    }

    answer.isSuspended = false;
    answer.isComplete = true;
    await nextTick();
    assertNoResumeBar();
    assert.match(text(root), /最终正文/);
  }
});

test('实测回归：已有历史工具之后，新思考在过程末尾即时追加', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  reducer.consume({ type: 'TURN_SNAPSHOT', sessionId: '7', turnId: '900', viewVersion: '1', view: {
    sessionId: '7', turnId: '900', viewVersion: '1', status: 'RUNNING', blocks: [
      { blockId: 'thinking:101', responseId: '101', type: 'THINKING', order: 1000, status: 'COMPLETE', text: '旧思考' },
      { blockId: 'tool:old-call', type: 'TOOL', order: 1002, status: 'COMPLETED', toolCallId: 'old-call',
        toolName: AgentToolName.ReadFile, arguments: '{"path":"old-tool.md"}' },
    ],
  } });
  const root = mount(t, answer);
  reducer.consume(event({ type: 'PARTIAL_THINKING', responseId: '102', offset: 0, order: 2000, content: '末尾实时思考' }));
  await nextTick();
  let rendered = text(root);
  assert.ok(rendered.includes('old-tool.md'));
  assert.ok(rendered.indexOf('末尾实时思考') > rendered.indexOf('old-tool.md'), rendered);
  reducer.consume(event({ type: 'PARTIAL_THINKING', responseId: '102', offset: 6, order: 2000, content: '继续打印' }));
  await nextTick();
  rendered = text(root);
  assert.ok(rendered.indexOf('末尾实时思考继续打印') > rendered.indexOf('old-tool.md'), rendered);
  assert.equal(answer.thoughtSteps.filter(step => step.id === 'thinking:102').length, 1);
});

test('实测回归：没有快照时工具开始即渲染，收尾和重复事件不增行', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  const root = mount(t, answer);
  const call = { type: 'TOOL_CALL', requestId: 'c1', responseId: '101', order: 2,
    toolName: AgentToolName.ReadFile, args: '{"path":"live-tool.md"}', resultStatus: 'STARTED' };
  reducer.consume(event(call));
  await nextTick();
  assert.match(text(root), /live-tool\.md/, '执行未结束，工具名称与参数已经可见');
  assert.equal(answer.toolCalls[0].status, 'calling');
  reducer.consume(event({ ...call, type: 'TOOL_COMPLETED', resultStatus: 'COMPLETED', output: '工具结果' }));
  reducer.consume(event(call));
  reducer.consume(event({ type: 'PARTIAL_THINKING', responseId: '102', offset: 0, order: 1000, content: '工具后的新思考' }));
  await nextTick();
  assert.equal(answer.toolCalls.length, 1);
  assert.equal(answer.toolCalls[0].status, 'success');
  assert.equal(answer.toolCalls[0].result, '工具结果');
  const rendered = text(root);
  assert.equal(rendered.split('live-tool.md').length - 1, 1);
  assert.ok(rendered.indexOf('工具后的新思考') > rendered.indexOf('live-tool.md'), rendered);
});

test('过程文本不跳正文：首片段即时打印，用途确认和工具开始保持同一过程节点', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  const root = mount(t, answer);
  const resolveProcessText = () => find(root, node => node.tag === 'markdown' && node.props.processText === true);
  for (const [offset, content, expected] of [[0, '检索', '检索'], [2, '完成', '检索完成'], [4, '。', '检索完成。']]) {
    reducer.consume(event({ type: 'PARTIAL_TEXT', responseId: '101', offset, order: 1, content }));
    await nextTick();
    assert.equal(answer.content, '', '用途未确认的文本不能先进入正文');
    assert.ok(resolveProcessText(), '每个片段都必须在过程区即时可见');
    assert.equal(text(resolveProcessText()), expected);
    assert.equal(answer.turnState.texts['text:101'].isBody, undefined, '展示位置不伪造后端用途');
  }
  const initialNode = resolveProcessText();
  reducer.consume(event({ type: 'COMPLETE_TEXT', responseId: '101', order: 1, content: '检索完成。' }));
  await nextTick();
  assert.equal(answer.content, '');
  assert.equal(resolveProcessText() === initialNode, true);
  reducer.consume(event({ type: 'AI_MESSAGE', responseId: '101', order: 1, text: '检索完成。', isBody: false }));
  reducer.consume(event({ type: 'TOOL_CALL', requestId: 'c1', responseId: '101', order: 2,
    toolName: AgentToolName.ReadFile, args: '{"path":"a.md"}' }));
  await nextTick();
  assert.equal(answer.content, '');
  assert.equal(resolveProcessText() === initialNode, true, '确认 PROCESS 后不搬动或重建文本节点');
  assert.equal(text(root).split('检索完成。').length - 1, 1);

  reducer.consume(event({ type: 'PARTIAL_TEXT', responseId: '102', offset: 0, order: 1, content: '最终结论' }));
  await nextTick();
  assert.equal(answer.content, '');
  assert.equal(text(root).split('最终结论').length - 1, 1);
  reducer.consume(event({ type: 'AI_MESSAGE', responseId: '102', order: 1, text: '最终结论', isBody: true }));
  await nextTick();
  assert.equal(answer.content, '最终结论');
  assert.deepEqual(answer.aiMessages.map(item => item.id), ['text:101']);
  assert.equal(text(root).split('最终结论').length - 1, 1, '正文归位后不能在过程区重复显示');
});

test('第二版真实组件：工具先到的文本持续追加在过程区，isBody:false 的快照把它留在过程区', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  const root = mount(t, answer);
  reducer.consume(event({ type: 'TOOL_CALL', requestId: 'c1', responseId: '101', order: 2, isBody: false,
    toolName: AgentToolName.ReadFile, args: '{"path":"a.md"}' }));
  reducer.consume(event({ type: 'PARTIAL_TEXT', responseId: '101', offset: 0, order: 1, content: '先读' }));
  await nextTick();
  assert.match(text(root), /先读/);
  assert.equal(answer.content, '');
  reducer.consume(event({ type: 'PARTIAL_TEXT', responseId: '101', offset: 2, order: 1, content: '文件' }));
  await nextTick();
  assert.match(text(root), /先读文件/);
  reducer.consume(event({ type: 'PARTIAL_TEXT', responseId: '102', offset: 0, order: 1001, content: '最终结论' }));
  reducer.consume({ type: 'TURN_SNAPSHOT', sessionId: '7', turnId: '900', viewVersion: '1', view: {
    sessionId: '7', turnId: '900', viewVersion: '1', status: 'RUNNING', blocks: [
      { blockId: 'text:101', responseId: '101', type: 'TEXT', order: 1, status: 'COMPLETE', isBody: false, text: '先读文件' },
    ],
  } });
  await nextTick();
  assert.equal(answer.content, '', '快照标过程：该文本不得进入正文');
  // 这条才是本步的不变量：false 的快照必须把该文本留在过程投影里。
  // 只断言 content === '' 是平凡的（TOOL_CALL 事件早已把该响应定为 false），掉出过程区同样会让它成立 —— 那等于内容静默丢失。
  // 注意 text:102 此刻也在过程区：它的用途尚未由后端确认（PARTIAL_TEXT 不带 isBody），故只断言 101 的归属。
  assert.ok(answer.aiMessages.some(item => item.id === 'text:101' && item.text === '先读文件'),
    'isBody:false 的快照必须留在过程区，不能从过程投影里掉出');
  assert.match(text(root), /最终结论/);
  reducer.consume(event({ type: 'AI_MESSAGE', responseId: '102', order: 1001, text: '最终结论', isBody: true }));
  await nextTick();
  assert.equal(answer.content, '最终结论');
  assert.equal(text(root).split('先读文件').length - 1, 1);
  assert.match(text(root), /a\.md/);
  reducer.consume(event({ type: 'TOOL_COMPLETED', requestId: 'c1', responseId: '101', order: 2,
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

test('框架位置真实组件：逐段打印、用途确认和并发工具位置无需快照，后续响应排在末尾', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  const root = mount(t, answer);
  const first = '9007199254740992';
  const second = '9007199254740993';
  reducer.consume(event({ type: 'PARTIAL_TEXT', responseId: first, offset: 0, order: 1, content: '先' }));
  await nextTick();
  assert.match(text(root), /先/);
  reducer.consume(event({ type: 'PARTIAL_TEXT', responseId: first, offset: 1, order: 1, content: '读文件' }));
  await nextTick();
  assert.match(text(root), /先读文件/);
  reducer.consume(event({ type: 'AI_MESSAGE', responseId: first, order: 1, text: '先读文件', isBody: false }));
  await nextTick();
  assert.equal(answer.content, '');
  assert.equal(text(root).split('先读文件').length - 1, 1);
  for (const [id, order, path] of [['c2', 3, 'second.md'], ['c1', 2, 'first.md']]) {
    reducer.consume(event({ type: 'TOOL_CALL', requestId: id, responseId: first, order, isBody: false,
      toolName: AgentToolName.ReadFile, args: JSON.stringify({ path }) }));
  }
  reducer.consume(event({ type: 'AI_MESSAGE', responseId: second, order: 1, text: '再确认', isBody: false }));
  await nextTick();
  const rendered = text(root);
  assert.ok(rendered.indexOf('先读文件') < rendered.indexOf('first.md'), rendered);
  assert.ok(rendered.indexOf('first.md') < rendered.indexOf('second.md'), rendered);
  assert.ok(rendered.indexOf('second.md') < rendered.indexOf('再确认'), rendered);
});

test('读取摘要：缺省范围显示全文，单边范围按后端默认边界显示', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  const root = mount(t, answer);
  for (const [index, args] of [
    { path: 'whole.json' }, { path: 'range.json', startLine: 2, endLine: 5 },
    { path: 'head.json', endLine: 3 }, { path: 'tail.json', startLine: 4 },
  ].entries()) {
    reducer.consume(event({ type: 'TOOL_CALL', requestId: `read-${index}`, responseId: '101', order: index + 2,
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
  const call = { requestId: 'edit-1', responseId: '101', order: 2,
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

/**
 * ★ 实测回归：思考框首屏就超出一屏时，流式增量必须继续贴底。
 *
 * <p>旧实现用「此刻是否贴近底部（< 80px）」决定要不要贴底。思考框是首个分片落地才挂载的，
 * 那一刻 scrollTop 还是 0；只要首屏内容就超出 max-h-72，距离直接判定为「用户已经滚走了」，
 * 之后每个分片只会让距离更大 —— 贴底动作永久失效，用户只能不断手动往底部拖。</p>
 *
 * <p>不变量：只要用户没有自己上滑，流式增量必须把内容钉在底部。</p>
 */
test('★ 思考框首屏超出一屏后，流式增量继续贴底', async t => {
  const answer = message({ isComplete: false, aiMessages: [], thoughtSteps: [
    { id: 'thinking-stick', title: '思考', content: '首屏思考', status: 'running', order: 0 },
  ] });
  const root = mount(t, answer);
  const box = resolveThinkingBox(root, '首屏思考');
  assert.ok(box, '运行中的思考框必须展开渲染');
  // 内容 1000、可视 288：首屏就已经溢出 712px，远超「贴近底部」阈值。
  layoutThinkingBox(box, 1000, 288);

  answer.thoughtSteps[0].content += '继续打印'.repeat(50);
  box.scrollHeight = 1600;
  await nextTick();
  assert.equal(box.scrollTop, 1600 - 288, '流式增量必须贴底，不能因为首屏已溢出就停止跟随');
});

/**
 * ★ 用户主动上滑后，新分片不得再抢滚动位置；滚回底部即恢复跟随。
 *
 * <p>这条锁的是另一半：修复「必须贴底」不能退化成「永远贴底」，否则用户回看前文时会被
 * 每个分片顶回底部。判据只能是用户自己往下滚这一动作，而不是「此刻离底部多远」。</p>
 */
test('★ 用户上滑后新分片不抢位置，滚回底部即恢复跟随', async t => {
  const answer = message({ isComplete: false, aiMessages: [], thoughtSteps: [
    { id: 'thinking-hold', title: '思考', content: '长思考', status: 'running', order: 0 },
  ] });
  const root = mount(t, answer);
  const box = resolveThinkingBox(root, '长思考');
  layoutThinkingBox(box, 1000, 288);
  const resolveBackToBottom = () => find(root, node => node.tag === 'button' && text(node).trim() === '回到底部');

  // 先来一个分片：程序贴底一次，记录下「我们自己滚到哪里」。
  answer.thoughtSteps[0].content += '首个分片'.repeat(50);
  box.scrollHeight = 1600;
  await nextTick();
  assert.equal(box.scrollTop, 1600 - 288, '跟随状态下首个分片必须贴底');
  assert.equal(resolveBackToBottom(), undefined, '跟随中不该出现回到底部的入口');

  // 用户上滑：scrollTop 低于程序上一次贴底写入的位置。
  box.scrollTop = 120;
  box.props.onScroll({ target: box });
  await nextTick();
  assert.ok(resolveBackToBottom(), '停止跟随后必须给出回到底部的入口');

  answer.thoughtSteps[0].content += '新分片'.repeat(50);
  box.scrollHeight = 2000;
  await nextTick();
  assert.equal(box.scrollTop, 120, '用户已经上滑，新分片不得抢走滚动位置');

  // 用户自己滚回底部：恢复跟随，后续分片继续贴底。
  box.scrollTop = 2000 - 288;
  box.props.onScroll({ target: box });
  await nextTick();
  assert.equal(resolveBackToBottom(), undefined, '恢复跟随后入口应收起');
  answer.thoughtSteps[0].content += '后续分片'.repeat(50);
  box.scrollHeight = 2400;
  await nextTick();
  assert.equal(box.scrollTop, 2400 - 288, '滚回底部后必须恢复自动贴底');
});

/**
 * ★ 已定型的思考展开后停在顶部，且不被别处的增量顶到底部。
 *
 * <p>贴底只对「还在流式增长」的内容成立。历史思考展开时应当从头读，也不该被同一消息里
 * 另一段仍在增长的思考顺手顶到底部。</p>
 */
test('★ 已定型的思考展开后停在顶部，不被别处增量顶走', async t => {
  const answer = message({ isComplete: false, aiMessages: [], thoughtSteps: [
    { id: 'thinking-done', title: '旧思考', content: '旧思考正文', status: 'success', order: 0 },
    { id: 'thinking-live', title: '思考', content: '实时思考正文', status: 'running', order: 1000 },
  ] });
  const root = mount(t, answer);
  assert.equal(resolveThinkingBox(root, '旧思考正文'), undefined, '已定型的思考默认折叠');

  find(root, node => node.tag === 'button' && text(node) === '旧思考').props.onClick();
  await nextTick();
  const finished = resolveThinkingBox(root, '旧思考正文');
  assert.ok(finished, '点击标题必须展开已定型的思考');
  layoutThinkingBox(finished, 1000, 288);

  const live = resolveThinkingBox(root, '实时思考正文');
  assert.ok(live, '运行中的思考保持展开');
  layoutThinkingBox(live, 1000, 288);

  answer.thoughtSteps[1].content += '增量'.repeat(50);
  live.scrollHeight = 1600;
  await nextTick();
  assert.equal(live.scrollTop, 1600 - 288, '运行中的思考必须继续贴底');
  assert.equal(finished.scrollTop, 0, '已定型的思考不得被别处的增量顶到底部');
});

