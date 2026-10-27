const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { parse, compileScript } = require('@vue/compiler-sfc');
const { createRenderer, h, ref, reactive, nextTick, watch } = require('vue');
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
        if (/(?:ChatProcessSegment|ProcessDetails)\.vue$/.test(request)) return load(resolved);
        if (request.endsWith('ApprovalCardGroup.vue') || request.endsWith('ChoiceQuestionGroup.vue')) return load(resolved);
        if (request.endsWith('CardHeader.vue')) return load(resolved);
        // 插槽化试点（B 档）：正文与底栏内容已抽成独立组件，必须递归进来，
        // 否则通用的「透传 slots」桩会把它当成空实现，正文与工具条一起消失。
        if (request.endsWith('MessageBodyDefault.vue') || request.endsWith('MessageActionsBar.vue')) return load(resolved);
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
      // 相对依赖解析：优先 <path>.ts，其次目录模块 <path>/index.ts（如 ../i18n）。
      if (resolved.endsWith('.ts')) return load(resolved);
      if (fs.existsSync(resolved + '.ts')) return load(resolved + '.ts');
      return load(path.join(resolved, 'index.ts'));
    };
    let source = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('.vue')) {
      const descriptor = parse(source, { filename }).descriptor;
      source = compileScript(descriptor, {
        id: 'chat-process-collapse',
        inlineTemplate: true,
        // 插槽化试点后，正文/底栏的 props 类型来自 `types/chatMessageSlots.ts`，
        // defineProps<T>() 需要 fs 才能解析导入类型（否则 compileScript 直接报错）。
        fs: { fileExists: file => fs.existsSync(file), readFile: file => fs.readFileSync(file, 'utf8') }
      }).content;
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
  return { tag, text, props: {}, style: {}, children: [], parent: null, addEventListener() {}, removeEventListener() {} };
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

function findAll(root, predicate) {
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => findAll(child, predicate))];
}
function toggleProcess(root) {
  const button = find(root, node => node.props?.['data-testid'] === 'process-segment-toggle');
  assert.ok(button, '应提供过程段展开入口');
  button.props.onClick();
}

// 详情回归先显式展开新段；默认折叠与手动状态由下方独立用例验证。
async function mountExpanded(t, answer, props = {}) {
  const root = mount(t, answer, props);
  const whole = find(root, node => node.props?.['data-testid'] === 'whole-process-toggle');
  if (whole && !whole.props['aria-expanded']) whole.props.onClick();
  const seen = new Set();
  const reveal = () => {
    for (const segment of findAll(root, node => node.props?.['data-testid'] === 'process-segment')) {
      const id = segment.props['data-segment-id'];
      if (seen.has(id)) continue;
      seen.add(id);
      find(segment, node => node.props?.['data-testid'] === 'process-segment-toggle')?.props.onClick();
    }
  };
  reveal();
  const stop = watch(answer, reveal, { deep: true, flush: 'post' });
  t.after(stop);
  await nextTick();
  return root;
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

test('已决提问收成摘要，展开可回看答案，关闭和重进均保留摘要入口', async t => {
  const { AgentToolName } = loadChatModule(path.resolve(__dirname, '../src/utils/toolNames.ts'));
  const answer = message({ aiMessages: [], toolCalls: [0, 1].map(index => ({
    id: `q${index}`, toolName: AgentToolName.RequireChoice, status: 'success', order: index,
    responseId: String(100 + index),
  })), promptCards: [0, 1].map(index => ({
    id: `q${index}`, conversationId: '7', type: 'PROMISE', status: 'completed', version: '2', allowedActions: [],
    content: { kind: 'CHOICE', question: `问题 ${index}：选择存储方式？`, options: ['会话', '数据库'] },
    rawOutput: { outcome: 'ANSWERED', answer: `权威答案 ${index}` },
  })) });
  const root = mount(t, answer);
  const summaries = findAll(root, node => node.props?.['data-testid'] === 'choice-summary-toggle');
  assert.equal(summaries.length, 2);
  assert.ok(summaries.every(node => node.props['aria-expanded'] === false));
  assert.equal(findAll(root, node => node.props?.['data-testid'] === 'choice-question-group').length, 0);
  assert.match(text(summaries[0]), /问题 0.*已答复/);
  summaries[0].props.onClick();
  await nextTick();
  assert.equal(findAll(root, node => node.props?.['data-testid'] === 'choice-question-group').length, 1);
  assert.match(text(root), /权威答案 0/);
  find(root, node => node.props?.['data-testid'] === 'choice-dismiss').props.onClick();
  await nextTick();
  assert.equal(summaries[0].props['aria-expanded'], false);
  assert.equal(findAll(root, node => node.props?.['data-testid'] === 'choice-summary-toggle').length, 2);
  const reopened = mount(t, answer);
  assert.equal(findAll(reopened, node => node.props?.['data-testid'] === 'choice-question-group').length, 0);
});

test('问题尚未收齐或仍有待答时保留作答卡，全部已决后自动收成组摘要', async t => {
  const component = loadChatModule(path.resolve(__dirname, '../src/components/chat/ChoiceQuestionGroup.vue')).default;
  const entries = reactive([{ id: 'q1', card: { toolCallId: 'q1', conversationId: '7', kind: 'CHOICE',
    title: '', content: '第一问', status: 'completed', pending: false, outcome: 'ANSWERED', answer: '会话' } }]);
  const root = mountComponent(t, component, { entries, responseId: '101', expectedCount: 2, isDark: true });
  const resolveSummary = () => find(root, node => node.props?.['data-testid'] === 'choice-summary-toggle');
  assert.equal(Boolean(resolveSummary()), false, '缺题不能误判为全部结束');
  entries.push({ id: 'q2', card: { toolCallId: 'q2', conversationId: '7', kind: 'CHOICE', title: '',
    content: '第二问', status: 'pending', pending: true, version: '1', allowedActions: ['ANSWER'] } });
  await nextTick();
  assert.equal(Boolean(resolveSummary()), false, '仍待回答时不得收起入口');
  entries[1].card.status = 'completed';
  entries[1].card.pending = false;
  entries[1].card.outcome = 'ANSWERED';
  entries[1].card.answer = '数据库';
  await nextTick();
  assert.equal(resolveSummary().props['aria-expanded'], false);
  assert.match(text(resolveSummary()), /2 个问题/);
  resolveSummary().props.onClick();
  await nextTick();
  assert.ok(find(root, node => node.props?.['data-testid'] === 'choice-question-group'));
});

test('计划按组收敛，待审批计划置顶并直接露出审批卡，命令保留独立组', async t => {
  const answer = message({ aiMessages: [], promptCards: [
    ...[0, 1].map(index => ({ id: `p${index}`, conversationId: '7', type: 'PROMISE', status: 'completed',
      content: { kind: 'PLAN', title: `计划 ${index}`, text: `计划正文 ${index}` }, rawOutput: { outcome: 'APPROVED' } })),
    { id: 'cmd', conversationId: '7', type: 'PROMISE', status: 'completed', content: { kind: 'COMMAND', command: 'npm test' } },
  ] });
  const root = mount(t, answer);
  const planToggle = find(root, node => node.props?.['data-testid'] === 'plan-approval-toggle');
  assert.ok(planToggle);
  assert.match(text(planToggle), /计划审批.*2 条/);
  assert.equal(planToggle.props['aria-expanded'], false);
  assert.equal(findAll(root, node => node.props?.['data-testid'] === 'command-approval-group').length, 1);
  planToggle.props.onClick();
  await nextTick();
  const entries = findAll(root, node => node.props?.['data-testid'] === 'plan-approval-entry-toggle');
  assert.equal(entries.length, 2);
  assert.ok(entries.every(node => node.props['aria-expanded'] === false));
  entries[0].props.onClick();
  await nextTick();
  assert.equal(findAll(root, node => node.tag === 'prompt-card').length, 1);
  planToggle.props.onClick();
  await nextTick();
  answer.promptCards.push({ id: 'p2', conversationId: '7', type: 'PROMISE', status: 'pending', version: '3',
    allowedActions: ['APPROVE', 'REJECT'], content: { kind: 'PLAN', title: '新计划', text: '新计划正文' } });
  await nextTick();
  assert.equal(planToggle.props['aria-expanded'], true);
  const list = find(root, node => node.props?.['data-testid'] === 'plan-approval-list');
  const first = find(list, node => node.props?.['data-approval-id']);
  assert.equal(first.props['data-approval-id'], 'p2');
  assert.ok(find(first, node => node.tag === 'prompt-card'));
});

test('整轮过程可折叠：历史默认收起，文本与分段一起隐藏，审批和最终正文保留', async t => {
  const { AgentToolName } = loadChatModule(path.resolve(__dirname, '../src/utils/toolNames.ts'));
  const answer = message({
    thoughtSteps: [{ id: 's1', title: '思考', content: '内部推理', order: 0, status: 'success' }],
    toolCalls: [{ id: 'c1', toolName: AgentToolName.ReadFile, order: 2, status: 'failed', args: { path: 'a.md' } }],
    aiMessages: [{ id: 't1', text: '先检查配置', order: 1 }, { id: 't2', text: '再确认结果', order: 3 }],
    promptCards: [{ id: 'approval', type: 'PROMISE', status: 'pending', content: { kind: 'COMMAND' } }],
  });
  const root = mount(t, answer);
  const whole = find(root, node => node.props?.['data-testid'] === 'whole-process-toggle');
  assert.ok(whole, '整轮必须有独立于分段的折叠入口');
  const content = () => find(root, node => node.props?.['data-testid'] === 'whole-process-content');
  assert.equal(whole.props['aria-expanded'], false);
  assert.equal(content().style.display, 'none');
  assert.equal(findAll(root, node => node.tag === 'markdown' && node.props.processText).length, 0);
  assert.equal(text(whole), '执行过程', '失败无需在整轮入口额外显示');
  assert.ok(find(root, node => node.tag === 'prompt-card'));
  assert.match(text(root), /最终正文/);
  whole.props.onClick();
  await nextTick();
  assert.notEqual(content().style.display, 'none');
  assert.equal(findAll(root, node => node.tag === 'markdown' && node.props.processText).length, 2);
  const segment = find(root, node => node.props?.['data-testid'] === 'process-segment-toggle');
  segment.props.onClick();
  await nextTick();
  assert.equal(findAll(root, node => node.props?.['data-testid'] === 'process-segment-details').length, 1);
  whole.props.onClick();
  await nextTick();
  assert.equal(content().style.display, 'none');
  assert.equal(findAll(root, node => node.props?.['data-testid'] === 'process-segment-details').length, 0);
  assert.equal(findAll(root, node => node.tag === 'markdown' && node.props.processText).length, 0);
  whole.props.onClick();
  await nextTick();
  assert.equal(segment.props['aria-expanded'], true, '整轮重新展开时保留分段的手动选择');
  assert.equal(findAll(root, node => node.props?.['data-testid'] === 'process-segment-details').length, 1);
});

test('整轮默认跟随执行阶段，用户手动选择不被流式增长和终态覆盖', async t => {
  const answer = message({ content: '', isComplete: false, isThinking: true, aiMessages: [],
    thoughtSteps: [{ id: 's1', title: '思考', content: '推理', order: 0, status: 'running' }] });
  const root = mount(t, answer);
  const whole = find(root, node => node.props?.['data-testid'] === 'whole-process-toggle');
  assert.ok(whole);
  assert.equal(whole.props['aria-expanded'], true);
  whole.props.onClick();
  await nextTick();
  answer.thoughtSteps[0].content += '继续增长';
  await nextTick();
  assert.equal(whole.props['aria-expanded'], false);
  answer.isThinking = false;
  answer.isComplete = true;
  await nextTick();
  assert.equal(whole.props['aria-expanded'], false);
  whole.props.onClick();
  await nextTick();
  assert.equal(whole.props['aria-expanded'], true);

  const untouched = message({ content: '', isComplete: false, isThinking: true,
    thoughtSteps: [{ id: 's2', title: '思考', content: '推理', order: 0, status: 'running' }] });
  const second = mount(t, untouched);
  const automatic = find(second, node => node.props?.['data-testid'] === 'whole-process-toggle');
  assert.equal(automatic.props['aria-expanded'], true);
  untouched.isThinking = false;
  untouched.isComplete = true;
  await nextTick();
  assert.equal(automatic.props['aria-expanded'], false, '用户没操作过时，终态自动收起整轮过程');
});

test('切入未结束会话时展开整轮过程，挂起与等待审批也直接显示过程文本', t => {
  const { aggregateRecordsByIdentity } = loadChatModule(path.resolve(__dirname, '../src/utils/session.ts'));
  const { AgentToolName } = loadChatModule(path.resolve(__dirname, '../src/utils/toolNames.ts'));
  for (const status of ['ACCEPTED', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED']) {
    for (const withTurn of [false, true]) {
      const [answer] = aggregateRecordsByIdentity('7', { '900': {
        sessionId: '7', turnId: '900', status, viewVersion: '1', blocks: [
          { blockId: 'text:101', responseId: '101', order: 1, type: 'TEXT', status: 'COMPLETE',
            isBody: false, text: '已检查配置，正在准备下一步' },
          { blockId: 'tool:approval', responseId: '102', order: 2, type: 'TOOL', status: 'PROMISED',
            toolCallId: 'approval', toolName: AgentToolName.ExecuteCommand, arguments: '{"command":"npm test"}' },
        ],
      } });
      const root = mount(t, reactive(answer), withTurn ? { turn: { status } } : {});
      const whole = find(root, node => node.props?.['data-testid'] === 'whole-process-toggle');
      const content = find(root, node => node.props?.['data-testid'] === 'whole-process-content');
      const active = ['ACCEPTED', 'RUNNING', 'WAITING'].includes(status);
      const context = `${status}, withTurn=${withTurn}`;
      assert.equal(whole.props['aria-expanded'], active, context);
      assert.equal(content.style.display === 'none', !active, context);
      assert.equal(findAll(root, node => node.tag === 'markdown' && node.props.processText).length,
        active ? 1 : 0, context);
      if (status === 'WAITING') {
        assert.match(text(root), /已检查配置，正在准备下一步/);
        const title = find(root, node => node.props?.['data-testid'] === 'process-segment-title');
        assert.doesNotMatch(title.props.class, /lx-sweep-text/, '挂起保持展开，但不能伪装成正在输出');
      }
    }
  }
});

test('整轮过程在挂起和恢复间保持展开，手动折叠后仍尊重用户选择', async t => {
  for (const withTurn of [false, true]) {
    const answer = message({ content: '', isComplete: false, isThinking: true });
    const turn = reactive({ status: 'RUNNING' });
    const root = mount(t, answer, withTurn ? { turn } : {});
    const whole = find(root, node => node.props?.['data-testid'] === 'whole-process-toggle');
    assert.equal(whole.props['aria-expanded'], true);

    answer.isThinking = false;
    answer.isSuspended = true;
    turn.status = 'WAITING';
    await nextTick();
    assert.equal(whole.props['aria-expanded'], true, '挂起不能把正在阅读的过程收起来');
    whole.props.onClick();
    await nextTick();
    answer.aiMessages[0].text += '补充说明';
    answer.isSuspended = false;
    answer.isThinking = true;
    turn.status = 'RUNNING';
    await nextTick();
    assert.equal(whole.props['aria-expanded'], false, '恢复执行不能覆盖手动折叠');
  }
});

test('分段折叠：文本直接展示，各段默认收起，思考与工具详情不提前挂载', async t => {
  const { AgentToolName } = loadChatModule(path.resolve(__dirname, '../src/utils/toolNames.ts'));
  const answer = message({ isComplete: false, isThinking: true, content: '',
    thoughtSteps: [{ id: 's1', order: 0, title: '思考', content: '详情正文', status: 'running' }],
    aiMessages: [{ id: 't1', text: '开始修改', order: 1 }, { id: 't2', text: '继续检查', order: 3 }],
    toolCalls: [{ id: 'c1', toolName: AgentToolName.EditFile, order: 2, status: 'success', args: { path: 'C:\\project\\mcp.json' } }] });
  const root = mount(t, answer);
  const headers = findAll(root, node => node.props?.['data-testid'] === 'process-segment-toggle');
  assert.equal(headers.length, 2);
  assert.ok(headers.every(node => node.props['aria-expanded'] === false));
  assert.equal(findAll(root, node => node.props?.['data-testid'] === 'process-segment-details').length, 0);
  assert.equal(findAll(root, node => node.tag === 'markdown' && node.props.thinkingText).length, 0);
  assert.match(text(root), /开始修改/);
  assert.match(text(root), /继续检查/);
  assert.match(text(headers[1]), /写入.*mcp\.json/);
  assert.doesNotMatch(text(root), /C:\\project/);
  headers[0].props.onClick();
  await nextTick();
  assert.equal(headers[0].props['aria-expanded'], true);
  assert.equal(headers[1].props['aria-expanded'], false);
  assert.match(text(root), /详情正文/);
});

test('实时预览：思考显示最新尾部，迟到工具收尾不抢位置，后续工具沿用原渲染名', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  reducer.consume(event({ type: 'TOOL_CALL', requestId: 'old', responseId: '101', order: 2,
    toolName: AgentToolName.ReadFile, args: '{"path":"old.md"}' }));
  reducer.consume(event({ type: 'PARTIAL_THINKING', responseId: '102', order: 0, offset: 0,
    content: '不应保留的开头' + '推理'.repeat(200) + '最新尾部' }));
  const root = mount(t, answer);
  const preview = () => find(root, node => node.props?.['data-testid'] === 'process-segment-preview');
  assert.match(text(preview()), /最新尾部$/);
  assert.doesNotMatch(text(preview()), /不应保留的开头/);
  assert.match(preview().props.class, /overflow-hidden.*whitespace-nowrap/);
  assert.equal(findAll(root, node => node.props?.['data-testid'] === 'process-segment-details').length, 0);
  reducer.consume(event({ type: 'TOOL_COMPLETED', requestId: 'old', responseId: '101', order: 2,
    toolName: AgentToolName.ReadFile, resultStatus: 'COMPLETED', output: '旧收尾' }));
  await nextTick();
  assert.match(text(preview()), /最新尾部$/);
  reducer.consume(event({ type: 'TOOL_CALL', requestId: 'new', responseId: '102', order: 2,
    toolName: AgentToolName.WebSearch, args: '{}' }));
  await nextTick();
  assert.equal(text(find(root, node => node.props?.['data-testid'] === 'process-segment-title')), '检索网络资源');
  reducer.dispose();
});

test('手动展开按段身份保留，流式增长、历史替换和终态不会自动折叠，新段仍默认收起', async t => {
  const answer = message({ content: '', isComplete: false, isThinking: true, aiMessages: [],
    thoughtSteps: [{ id: 's1', title: '思考', content: '初始内容', order: 0, status: 'running' }] });
  const root = mount(t, answer);
  const header = find(root, node => node.props?.['data-testid'] === 'process-segment-toggle');
  header.props.onClick();
  await nextTick();
  answer.thoughtSteps = [{ ...answer.thoughtSteps[0], content: '历史与实时补齐后的内容' }];
  await nextTick();
  assert.equal(find(root, node => node.props?.['data-testid'] === 'process-segment-toggle'), header);
  assert.equal(header.props['aria-expanded'], true);
  answer.isThinking = false;
  answer.isComplete = true;
  await nextTick();
  assert.equal(header.props['aria-expanded'], true);
  answer.aiMessages = [{ id: 't1', text: '下一步', order: 1 }];
  answer.thoughtSteps.push({ id: 's2', title: '思考', content: '下一段', order: 2, status: 'running' });
  await nextTick();
  const headers = findAll(root, node => node.props?.['data-testid'] === 'process-segment-toggle');
  assert.deepEqual(headers.map(node => node.props['aria-expanded']), [true, false]);
});

test('历史摘要使用原操作名和目标，待确认与未知状态保留，失败不额外计数', async t => {
  const { AgentToolName } = loadChatModule(path.resolve(__dirname, '../src/utils/toolNames.ts'));
  const answer = message({ aiMessages: [], toolCalls: [
    { id: 'read', toolName: AgentToolName.ReadFile, order: 0, status: 'failed', args: { path: '/repo/mcp.json' } },
    { id: 'edit', toolName: AgentToolName.EditFile, order: 1, status: 'pending', args: { path: '/repo/mcp.json' } },
    { id: 'run', toolName: AgentToolName.ExecuteCommand, order: 2, status: 'unknown' },
  ], promptCards: [{ id: 'approval', type: 'PROMISE', status: 'pending', content: { kind: 'COMMAND' } }] });
  const root = mount(t, answer);
  const header = () => find(root, node => node.props?.['data-testid'] === 'process-segment-toggle');
  const title = () => find(root, node => node.props?.['data-testid'] === 'process-segment-title');
  assert.equal(text(title()), '读取、写入、执行命令');
  assert.equal(text(find(root, node => node.props?.['data-testid'] === 'process-segment-status')), '1 项待确认、1 项状态未知');
  assert.equal(answer.toolCalls[0].status, 'failed', '工具自身的失败状态保留');
  assert.ok(find(root, node => node.tag === 'prompt-card'), '审批卡片不进入过程折叠');
  assert.equal(header().props['aria-expanded'], false);
  answer.toolCalls.push({ id: 'search', toolName: AgentToolName.WebSearch, order: 3, status: 'success' });
  await nextTick();
  assert.equal(text(title()), '读取、写入、执行命令等 4 类操作');
  assert.equal(text(find(root, node => node.props?.['data-testid'] === 'process-segment-preview')), 'mcp.json');
});

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

test('过程区行样式统一：终端描述与工具行同字号同色，深度思考标题仍低一档', async t => {
  const { AgentToolName } = loadChatModule(path.resolve(__dirname, '../src/utils/toolNames.ts'));
  for (const isDark of [false, true]) {
    const answer = message({ isComplete: false, aiMessages: [], thoughtSteps: [
      { id: 'thinking-size', title: '思考', content: '检查当前目录', status: 'running', order: 0 },
    ], toolCalls: [
      { id: 'command-size', toolName: AgentToolName.ExecuteCommand, status: 'calling',
        query: JSON.stringify({ command: 'git status', intention: '检查工作目录' }), order: 1 },
    ] });
    const root = await mountExpanded(t, answer, { isDark });
    for (const status of ['calling', 'success']) {
      answer.toolCalls[0].status = status;
      answer.thoughtSteps[0].status = status === 'calling' ? 'running' : 'success';
      await nextTick();
      const description = find(root, node => node.tag === 'button' && text(node) === '检查工作目录');
      const thinking = find(root, node => node.tag === 'button' && text(node) === '深度思考');
      assert.ok(description);
      assert.ok(thinking);
      // 过程区同一层级的行必须同字号：13px 是工具行与思考标题的共同取值（2026-10-21 统一）。
      assert.match(description.props.class, /text-\[13px\]/, '终端描述必须与工具行/思考标题同为 13px');
      assert.match(thinking.parent.props.class, /text-\[13px\]/, '思考标题行必须同为 13px');
      // 工具行容器是"读取/查看"这类工具标题的唯一字号来源（标题本身不带字号类），一并锁住。
      assert.match(description.parent.props.class, /text-\[13px\]/, '工具行容器必须为 13px');
      const colors = isDark ? ['text-zinc-100', 'text-glow-white'] : ['text-zinc-700'];
      for (const color of colors) {
        assert.equal(description.props.class.split(' ').includes(color), true, `终端描述必须与工具行同色：${color}`);
      }
      assert.equal(description.props.class.split(' ').includes('[text-shadow:none]'), false, '终端描述不得再单独关掉发光');
      // 深度思考标题刻意低一档：同字号、不同色，用它把「思考」和「工具动作」分开。
      const thinkingColor = isDark ? 'text-zinc-400' : 'text-zinc-500';
      assert.equal(thinking.props.class.split(' ').includes(thinkingColor), true, '思考标题必须保持低一档颜色');
    }
  }
});

test('工具执行提示：仅显示静态灰字，结束后替换为真实输出', async t => {
  const { AgentToolName } = loadChatModule(path.resolve(__dirname, '../src/utils/toolNames.ts'));
  const answer = message({ isComplete: false, aiMessages: [], toolCalls: [
    { id: 'command-running', toolName: AgentToolName.ExecuteCommand, status: 'calling',
      query: JSON.stringify({ command: 'git status' }), order: 0 },
  ] });
  const root = await mountExpanded(t, answer);
  const toggle = find(root, node => node.tag === 'button' && /查看.*详情/.test(node.props['aria-label'] ?? ''));
  assert.ok(toggle);
  toggle.props.onClick({ stopPropagation() {} });
  await nextTick();
  const hint = find(root, node => node.tag === 'div' && String(node.props.class ?? '').includes('font-mono') && text(node).trim() === '正在执行中...');
  assert.ok(hint);
  assert.match(hint.props.class, /text-zinc-400/);
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
  const root = await mountExpanded(t, answer);
  const title = find(root, node => node.tag === 'gradient-text' && text(node) === '深度思考');
  assert.ok(title, '思考标题应使用 GradientText 组件');
  assert.equal(title.props.animationSpeed, 3);
  assert.equal(title.props.showBorder, false);
  const header = find(root, node => node.tag === 'button' && text(node).includes('深度思考'));
  assert.equal(Boolean(find(header, node => String(node.props.class ?? '').includes('animate-ping'))), false);
  assert.match(text(find(root, node => node.props?.['data-testid'] === 'process-segment-details')), /思考正文/);

  answer.thoughtSteps[0].status = 'success';
  await nextTick();
  assert.doesNotMatch(text(find(root, node => node.props?.['data-testid'] === 'process-segment-details')), /思考正文/);
  const toggle = find(root, node => node.tag === 'button' && text(node).includes('深度思考'));
  assert.ok(toggle);
  toggle.props.onClick();
  await nextTick();
  assert.match(text(find(root, node => node.props?.['data-testid'] === 'process-segment-details')), /思考正文/);
  assert.equal(Boolean(find(root, node => node.tag === 'gradient-text' && text(node) === '深度思考')), false);
  toggle.props.onClick();
  await nextTick();
  assert.doesNotMatch(text(find(root, node => node.props?.['data-testid'] === 'process-segment-details')), /思考正文/);
});

test('深度思考动效：挂起、终态和历史不加载，运行中的对账消息仍可加载', async t => {
  const answer = message({ isComplete: false, aiMessages: [], thoughtSteps: [
    { id: 'thinking-current', title: '思考', content: '当前思考', status: 'running', order: 0 },
    { id: 'thinking-old', title: '旧思考', content: '历史思考', status: 'success', order: 1 },
  ] });
  const turn = reactive({ status: 'RUNNING' });
  const root = await mountExpanded(t, answer, { turn });
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
  assert.ok(resolveAnimation());

  const history = await mountExpanded(t, message({ aiMessages: [], thoughtSteps: [
    { id: 'history-step', title: '思考', content: '旧记录', status: 'running', order: 0 },
  ] }));
  assert.match(text(history), /深度思考/);
  assert.equal(Boolean(find(history, node => node.tag === 'gradient-text')), false);
});

test('思考正文：引用块内使用 Markdown，逐段追加保留完整内容', async t => {
  const answer = message({ isComplete: false, aiMessages: [], thoughtSteps: [
    { id: 'thinking-markdown', title: '思考', content: '**原因**\n\n- 第一条', status: 'running', order: 0 },
  ] });
  const root = await mountExpanded(t, answer, { isDark: false });
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
    const root = await mountExpanded(t, answer, { isDark });
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
  const root = await mountExpanded(t, answer);
  reducer.consume(event({ type: 'PARTIAL_THINKING', responseId: '102', offset: 0, order: 2000, content: '末尾实时思考' }));
  await nextTick();
  let rendered = text(find(root, node => node.props?.['data-testid'] === 'process-segment-details'));
  assert.ok(rendered.includes('old-tool.md'));
  assert.ok(rendered.indexOf('末尾实时思考') > rendered.indexOf('old-tool.md'), rendered);
  reducer.consume(event({ type: 'PARTIAL_THINKING', responseId: '102', offset: 6, order: 2000, content: '继续打印' }));
  await nextTick();
  rendered = text(find(root, node => node.props?.['data-testid'] === 'process-segment-details'));
  assert.ok(rendered.indexOf('末尾实时思考继续打印') > rendered.indexOf('old-tool.md'), rendered);
  assert.equal(answer.thoughtSteps.filter(step => step.id === 'thinking:102').length, 1);
});

test('实测回归：没有快照时工具开始即渲染，收尾和重复事件不增行', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  const root = await mountExpanded(t, answer);
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
  const rendered = text(find(root, node => node.props?.['data-testid'] === 'process-segment-details'));
  assert.equal(rendered.split('live-tool.md').length - 1, 1);
  assert.ok(rendered.indexOf('工具后的新思考') > rendered.indexOf('live-tool.md'), rendered);
});

test('过程文本不跳正文：首片段即时打印，用途确认和工具开始保持同一过程节点', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  const root = await mountExpanded(t, answer);
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
  const root = await mountExpanded(t, answer);
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
  assert.doesNotMatch(text(root), /先读文件/, '终态默认收起整轮过程');
  assert.match(text(root), /最终结论/);
  find(root, node => node.props?.['data-testid'] === 'whole-process-toggle').props.onClick();
  await nextTick();
  assert.match(text(root), /先读文件/);
  toggleProcess(root);
  await nextTick();
  assert.match(text(root), /先读文件/, '折叠不隐藏过程叙述文本');
});

test('框架位置真实组件：逐段打印、用途确认和并发工具位置无需快照，后续响应排在末尾', async t => {
  const { reducer, event, answer, AgentToolName } = streamFixture();
  const root = await mountExpanded(t, answer);
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
  const root = await mountExpanded(t, answer);
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
  const root = await mountExpanded(t, answer);
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
  const root = await mountExpanded(t, answer);
  assert.match(text(root), /history\.md\s*\+3-2/);
  assert.match(text(root), /created\.md\s*\+5-0/);
  const button = find(root, node => node.tag === 'button' && node.props['aria-label'] === '查看写入详情');
  button.props.onClick({ stopPropagation() {} });
  await nextTick();
  assert.equal(text(root).split('+3-2').length - 1, 2, '展开详情也保留相同统计');
});

test('★ 思考框首屏超出一屏后，流式增量继续贴底', async t => {
  const answer = message({ isComplete: false, aiMessages: [], thoughtSteps: [
    { id: 'thinking-stick', title: '思考', content: '首屏思考', status: 'running', order: 0 },
  ] });
  const root = await mountExpanded(t, answer);
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
  const root = await mountExpanded(t, answer);
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
  const root = await mountExpanded(t, answer);
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

