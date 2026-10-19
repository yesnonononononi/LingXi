const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { parse, compileScript } = require('@vue/compiler-sfc');
const { createRenderer, reactive } = require('vue');

// 编译真实模板，只替换子组件与浏览器依赖，渲染结果用组件自身逻辑产出。
function loadChatModule(filename) {
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
        // 卡片外壳 / 头部 / 按钮 / 折叠动画都是与本断言无关的展示件，统一透传默认插槽。
        return { __esModule: true, default: { setup: (_props, { slots }) => () => slots.default?.() } };
      }
      if (resolved.endsWith('.ts')) return load(resolved);
      if (fs.existsSync(resolved + '.ts')) return load(resolved + '.ts');
      return load(path.join(resolved, 'index.ts'));
    };
    let source = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('.vue')) {
      const descriptor = parse(source, { filename }).descriptor;
      source = compileScript(descriptor, { id: 'choice-card-newline', inlineTemplate: true }).content;
    }
    module._compile(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, filename);
    return module.exports;
  }
  return load(filename);
}

function element(tag, text = '') {
  // v-model 的 created 钩子会往元素上挂事件监听，伪元素必须能接住（只挂不收）。
  return { tag, text, props: {}, children: [], parent: null, addEventListener() {}, removeEventListener() {} };
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

function mount(t, promptCard) {
  const component = loadChatModule(path.resolve(__dirname, '../src/components/chat/RequireChoiceCard.vue')).default;
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
  global.window = { setInterval, matchMedia: undefined };
  const root = element('root');
  const app = renderer.createApp(component, { promptCard, isDark: true, sessionId: 'sess-1' });
  app.mount(root);
  t.after(() => {
    app.unmount();
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });
  return root;
}

/** 与截图同构的多行问题：选项说明分段落，后端 question 原样带 \n。 */
const MULTILINE_QUESTION = '桌宠落地形态选哪个？（决定了改哪个目录、怎么验证）\n\n'
  + '补充说明：现在 frontend 是 Vue3 + Electron。\n\n'
  + 'A) 集成进现有 LingXi Electron 应用\nB) 独立最小 Electron 桌宠工程\nC) 先做浏览器交互原型';

function choiceCard(overrides = {}) {
  return reactive({
    kind: 'CHOICE',
    toolCallId: 'call-choice',
    conversationId: 'sess-1',
    title: '提问',
    content: MULTILINE_QUESTION,
    options: ['方案A', '方案B'],
    status: 'pending',
    version: '1',
    allowedActions: ['ANSWER'],
    pending: true,
    ...overrides,
  });
}

test('★ 选择卡片问题正文必须保留换行（多行 question 不能挤成一段）', t => {
  const root = mount(t, choiceCard());

  // 金丝雀：先证明查找器确实能命中问题节点，否则类名断言会在「节点找不到」时假绿。
  const heading = find(root, node =>
    node.tag === 'h3' && text(node).includes('桌宠落地形态选哪个'));
  assert.ok(heading, '未找到问题标题节点，断言不成立');
  assert.ok(text(heading).includes('C) 先做浏览器交互原型'), '问题正文应完整渲染（含多行内容）');

  // 问题正文是纯文本插值：没有 whitespace-pre-wrap 时 HTML 会把 \n 折叠成空格，
  // 截图里的 A/B/C 选项就全挤成一段。这里锁死换行保留。
  assert.match(
    String(heading.props.class ?? ''),
    /whitespace-pre-wrap/,
    '问题标题必须带 whitespace-pre-wrap，否则后端多行 question 的换行会被 HTML 空白折叠吞掉'
  );

  // 选项文案同样按纯文本渲染，同一条规则一并锁死。
  const option = find(root, node => node.tag === 'span' && text(node) === '方案A');
  assert.ok(option, '未找到选项节点，断言不成立');
  assert.match(
    String(option.props.class ?? ''),
    /whitespace-pre-wrap/,
    '候选项文案必须带 whitespace-pre-wrap，多行选项同样不能被折叠'
  );
});
