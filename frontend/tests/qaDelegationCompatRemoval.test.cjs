/**
 * 独立验证（QA）：历史遗留 `kind="DELEGATION"` 行进入前端卡片管线后的端到端行为。
 *
 * <p>这是「删除 DELEGATION 兼容分支」实现者的覆盖盲区：后端 R1 护栏只验到 Java 侧的
 * `resolveKind → null` / `resolveActions` 降级，**没有**把一条历史遗留行走完
 * `toPromptCardData → PromptCard.vue` 的完整前端管线。本文件补上这条。</p>
 *
 * <p>编译真实 `PromptCard.vue`（内联模板），仅把三个子卡片与浏览器依赖替换成可判定的标记组件；
 * 断言历史行：不崩、降级为「不可用」态、**不出任何审批按钮**、不落到任何审批子卡片。</p>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { parse, compileScript } = require('@vue/compiler-sfc');
const { createRenderer, h, nextTick } = require('vue');

/** 只编译真实 PromptCard，子卡片用标记组件替代（历史行本就不应命中它们）。 */
function loadModule(filename) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = new Module(file);
    cache.set(file, module);
    module.filename = file;
    module.paths = Module._nodeModulePaths(path.dirname(file));
    module.require = request => {
      if (request === 'vue') return { ...require('vue') };
      if (!request.startsWith('.')) return require(request);
      const resolved = path.resolve(path.dirname(file), request);
      if (request.endsWith('.vue')) {
        const marker = {
          'PlanCard.vue': 'plan-card',
          'RequireChoiceCard.vue': 'require-choice-card',
          'ApprovalCard.vue': 'approval-card',
        }[request.slice(request.lastIndexOf('/') + 1)];
        if (marker) return { __esModule: true, default: { setup: () => () => h(marker) } };
        return load(resolved);
      }
      return load(resolved.endsWith('.ts') ? resolved : resolved + '.ts');
    };
    let source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.vue')) {
      const descriptor = parse(source, { filename: file }).descriptor;
      source = compileScript(descriptor, { id: 'qa-delegation-card', inlineTemplate: true }).content;
    }
    module._compile(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText, file);
    return module.exports;
  }
  return load(filename);
}

const src = relative => path.resolve(__dirname, '../src', relative);
const component = relative => loadModule(src(relative)).default;
const util = relative => loadModule(src(relative));

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

function mountPromptCard(t, promptCard) {
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
  const app = renderer.createApp(component('components/chat/PromptCard.vue'), { promptCard, isDark: false });
  app.mount(root);
  t.after(() => {
    app.unmount();
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });
  return root;
}

/** 改造前遗留的委派槽位 VO（后端 toVO 会原样下发 content，pending 仍为 true：未终结）。 */
function legacyDelegationVO(overrides = {}) {
  return {
    id: 'call-child',
    type: 'PROMISE',
    status: 'pending',
    pending: true,
    toolName: 'call_sub_agent',
    title: '子代理委派',
    content: { kind: 'DELEGATION', subExecutionId: '7001', text: '写代码' },
    unavailableReason: '互动数据不可用，请刷新状态',
    allowedActions: [],
    ...overrides,
  };
}

test('B4 遗留 DELEGATION 行：toPromptCardData 降级为 UNAVAILABLE，绝不回落成可审批卡片', () => {
  const { toPromptCardData, resolveCardKind, canDecideCard } = util('utils/toolCallCard.ts');

  const data = toPromptCardData(legacyDelegationVO());

  assert.equal(resolveCardKind({ kind: 'DELEGATION' }), 'UNAVAILABLE', '后端已不产生的 kind 必须判为不可用');
  assert.equal(data.kind, 'UNAVAILABLE');
  assert.equal(data.unavailable, true, '降级标记置位，供视图渲染「状态不可用」');
  // 三态动作全部不可用（纵深防御：即使 allowedActions 被脏数据塞了东西，也须叠加 pending+形态门控）。
  for (const action of ['APPROVE', 'REJECT', 'ANSWER']) {
    assert.equal(canDecideCard(data, action), false, `${action} 不得在遗留卡片上可用`);
  }
});

test('B4 遗留 DELEGATION 行经真实 PromptCard.vue：渲染不可用态，且无任何审批按钮 / 审批子卡片', async t => {
  const data = util('utils/toolCallCard.ts').toPromptCardData(legacyDelegationVO());
  const root = mountPromptCard(t, data);
  await nextTick();

  assert.match(text(root), /卡片状态不可用/, '必须渲染「状态不可用」分支');

  const buttons = [];
  (function collect(node) {
    if (node.tag === 'button') buttons.push(text(node));
    node.children.forEach(collect);
  })(root);
  assert.equal(buttons.length, 0, `不可用卡片不得出现任何按钮，实际=${JSON.stringify(buttons)}`);

  for (const marker of ['plan-card', 'require-choice-card', 'approval-card']) {
    assert.equal(Boolean(find(root, node => node.tag === marker)), false, `不得渲染 ${marker}`);
  }
});

test('B4 对照：真实 PLAN 卡片仍走 PLAN 分支（确认不可用态不是「全部走同一分支」的假象）', async t => {
  const { toPromptCardData } = util('utils/toolCallCard.ts');
  const data = toPromptCardData({
    id: 'call-plan', type: 'PROMISE', status: 'pending', pending: true,
    toolName: 'create_plan', title: '方案',
    content: { kind: 'PLAN', title: '方案', text: '正文' },
    allowedActions: ['APPROVE', 'REJECT'],
  });
  assert.equal(data.kind, 'PLAN');
  const root = mountPromptCard(t, data);
  await nextTick();
  assert.equal(Boolean(find(root, node => node.tag === 'plan-card')), true, 'PLAN 行必须命中 PlanCard');
  assert.doesNotMatch(text(root), /卡片状态不可用/);
});

test('B5 isCardToolName：仅三种 PROMISE 工具建卡；call_sub_agent 不再建卡', () => {
  const { isCardToolName } = util('utils/toolCallCard.ts');
  const { AgentToolName } = util('utils/toolNames.ts');
  assert.equal(isCardToolName(AgentToolName.CreatePlan), true);
  assert.equal(isCardToolName(AgentToolName.RequireChoice), true);
  assert.equal(isCardToolName(AgentToolName.ExecuteCommand), true);
  assert.equal(isCardToolName(AgentToolName.CallSubAgent), false, '异步委派不产生 PROMISE 槽位，不得建卡');
  assert.equal(isCardToolName(AgentToolName.ReadFile), false);
  assert.equal(isCardToolName(undefined), false);
});
