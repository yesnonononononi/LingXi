const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { parse, compileScript } = require('@vue/compiler-sfc');
const { createRenderer, h, ref, reactive, nextTick } = require('vue');
const previewKey = Symbol('file-preview');

/**
 * 交付总监独立验证（QA 严过关）—— AC-5 对抗性用例。
 *
 * <p>锁定工程师用例未覆盖的边界：子会话「等待审批」态、IDLE 态不得被写成完成/失败；
 * 委派等待卡 pending 时不得误报失败；「进行中」时三处都不得出现「执行完成 / 执行失败」。</p>
 */
function loadModule(filename) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = new Module(file);
    cache.set(file, module);
    module.filename = file;
    module.paths = Module._nodeModulePaths(path.dirname(file));
    module.require = request => {
      if (request === 'vue') {
        return {
          ...require('vue'),
          Transition: { setup: (_props, { slots }) => () => slots.default?.() },
          Teleport: { setup: (_props, { slots }) => () => slots.default?.() },
        };
      }
      if (!request.startsWith('.')) return require(request);
      if (request.includes('services/chat')) {
        return { chatApi: { fetchSessionMessages: async () => ({ ok: false }) } };
      }
      const resolved = path.resolve(path.dirname(file), request);
      if (request.endsWith('.vue')) {
        if (request.endsWith('CardHeader.vue')) return load(resolved);
        if (request.endsWith('GradientText.vue')) {
          return { __esModule: true, default: {
            props: ['colors', 'animationSpeed', 'showBorder'],
            setup: (props, { slots }) => () => h('gradient-text', { ...props }, slots.default?.()),
          } };
        }
        if (request.endsWith('MarkdownRenderer.vue')) {
          return { __esModule: true, default: {
            props: ['content', 'thinkingText', 'processText'],
            setup: props => () => h('markdown', {
              thinkingText: props.thinkingText, processText: props.processText,
            }, props.content),
          } };
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
    let source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.vue')) {
      const descriptor = parse(source, { filename: file }).descriptor;
      source = compileScript(descriptor, { id: 'qa-async-delegation', inlineTemplate: true }).content;
    }
    module._compile(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, file);
    return module.exports;
  }
  return load(filename);
}

const component = relative => loadModule(path.resolve(__dirname, '../src', relative)).default;
const util = relative => loadModule(path.resolve(__dirname, '../src', relative));

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

function mountComponent(t, componentDefinition, props) {
  const renderer = createRenderer({
    createElement: tag => element(tag),
    createText: value => element('#text', value),
    createComment: () => element('#comment'),
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
  const app = renderer.createApp(componentDefinition, props);
  app.provide(previewKey, undefined);
  app.mount(root);
  t.after(() => {
    app.unmount();
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });
  return root;
}

test('AC-5 对抗：子会话 RUNNING 时详情状态栏不得出现「执行完成」也不得出现「执行失败」', async t => {
  const subSession = reactive({ id: '88', agentName: '工程师', runStatus: 'RUNNING' });
  const root = mountComponent(t, component('components/chat/SubSessionDetailDrawer.vue'), {
    isOpen: true, subSession, isDark: true,
  });

  assert.match(text(root), /执行中/);
  assert.doesNotMatch(text(root), /执行完成/, '进行中不得显示完成');
  assert.doesNotMatch(text(root), /执行失败/, '进行中不得显示失败');

  subSession.runStatus = 'SUSPENDED';
  await nextTick();
  assert.match(text(root), /等待审批/, '挂起态应显示等待审批');
  assert.doesNotMatch(text(root), /执行完成/);
  assert.doesNotMatch(text(root), /执行失败/);
});

test('AC-5 对抗：子会话 IDLE 且无 outcome 时也不得显示完成/失败', async t => {
  const subSession = reactive({ id: '90', agentName: '工程师', runStatus: 'IDLE' });
  const root = mountComponent(t, component('components/chat/SubSessionDetailDrawer.vue'), {
    isOpen: true, subSession, isDark: true,
  });

  assert.doesNotMatch(text(root), /执行完成/, 'IDLE 无结果不得臆断为完成');
  assert.doesNotMatch(text(root), /执行失败/, 'IDLE 无结果不得臆断为失败');
});

test('AC-5 对抗：委派等待卡仍 pending 且无 outcome 时不得显示失败/完成', async t => {
  const promptCard = reactive({
    kind: 'DELEGATION', toolCallId: 'd2', title: '工程师', content: '任务正文',
    status: 'running', pending: true, outcome: undefined,
  });
  const root = mountComponent(t, component('components/chat/DelegationWaitCard.vue'), { promptCard, isDark: true });

  assert.doesNotMatch(text(root), /子代理执行失败/, 'pending 不得判失败');
  assert.doesNotMatch(text(root), /子代理已完成/, 'pending 不得判完成');
});

test('AC-5 对抗：协同条色点——子会话进行中即便工具 calling 也必须是执行中', async t => {
  const { AgentToolName } = util('utils/toolNames.ts');
  const subSessions = reactive([{ id: '77', agentId: '5', agentName: '工程师', runStatus: 'RUNNING' }]);
  const message = reactive({
    id: 'a2', role: 'assistant', turnId: '102', timestamp: 0,
    content: '', isComplete: false,
    toolCalls: [{
      id: 'tc-delegate-2', toolName: AgentToolName.CallSubAgent, status: 'calling',
      query: JSON.stringify({ agentId: 5, agentName: '工程师', task: '写代码', runtime_mode: 'async' }),
      subSessionId: '77', order: 0,
    }],
  });
  const root = mountComponent(t, component('components/chat/ChatMessageItem.vue'), { message, isDark: true, subSessions });

  const member = find(root, node => node.tag === 'button' && String(node.props.title ?? '').startsWith('协作式委派'));
  assert.ok(member, '协作式委派成员行应存在');
  const dot = find(member, node => {
    const cls = String(node.props.class ?? '');
    return cls.includes('w-1.5') && cls.includes('rounded-full');
  });
  assert.ok(dot, '应有状态色点');
  assert.match(dot.props.class, /bg-amber-400/, '子会话进行中 → 琥珀脉冲');
  assert.doesNotMatch(dot.props.class, /bg-emerald-500/);
});

test('AC-5 对抗：isAsyncDelegation 边界（纯结果标记 / 空白 / 缺项）', () => {
  const { isAsyncDelegation } = util('utils/asyncDelegation.ts');
  assert.equal(isAsyncDelegation({ result: JSON.stringify({ runtimeMode: 'ASYNC', delegated: true }) }), true);
  assert.equal(isAsyncDelegation({ query: JSON.stringify({ runtime_mode: '  async  ' }) }), true, '容忍首尾空白');
  assert.equal(isAsyncDelegation({ query: JSON.stringify({ runtime_mode: '' }) }), false);
  assert.equal(isAsyncDelegation({ query: 'not-json', result: '' }), false, '非法 JSON 不得误判为协作式');
});
