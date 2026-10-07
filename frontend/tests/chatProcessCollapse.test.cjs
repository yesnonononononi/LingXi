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
