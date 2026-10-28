'use strict';
/**
 * 过程区测试共享挂载 harness（唯一 stub 清单）。
 *
 * <p>历史问题：三个 Electron-free 套件各自维护一份 `.vue` 白名单，**只列举要真实加载的组件**，
 * 其余一律桩成「只透传 slots」的空壳。于是 `components/chat/process/` 下新建的 renderer 会被
 * 静默吞成空壳 —— 断言表现为「找不到节点」，更糟的是断言数量不变而测试假绿。</p>
 *
 * <p>本 harness 把规则反过来：**`src/components/chat/**`（含 `chat/process/`）下的 `.vue` 默认递归
 * 真实加载**，只有 {@link EXPLICIT_VUE_STUBS} 里显式列出的才走桩；`components/` 之外的 `.vue`
 * （如 `common/CollapseTransition.vue`）沿用「默认桩」的历史语义，避免顺手改变既有套件的行为。
 * 新增 renderer 因此天然可加载，无需再改白名单。</p>
 *
 * <p>同时收敛浏览器环境替身（`window` / `requestAnimationFrame`）、`filePreview` / `useTheme` /
 * `useCopyFeedback` 三个模块桩，以及 `createRenderer` 的内存视图助手 `find/findAll/text`。</p>
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { parse, compileScript } = require('@vue/compiler-sfc');
const { createRenderer, h, ref } = require('vue');

/** `src/` 绝对路径，供调用方以相对 `src` 的路径加载模块。 */
const SRC_DIR = path.resolve(__dirname, '../../src');
/** 允许递归真实加载组件的目录前缀（其余目录沿用「默认桩」）。 */
const REAL_LOAD_DIRS = [path.join(SRC_DIR, 'components', 'chat')];

const previewKey = Symbol('file-preview');

/** 通用空壳：显式桩掉的 SFC 返回它，`slots.default?.()` 透传。 */
const STUB_SHELL_COMPONENT = Object.freeze({
  setup: (_props, { slots }) => () => slots.default?.(),
});

/** 浅层标记桩：只需证明「这里渲染过一个外部组件」，不承载任何业务断言。 */
const GRADIENT_TEXT_COMPONENT = Object.freeze({
  props: ['colors', 'animationSpeed', 'showBorder'],
  setup: (props, { slots }) => () => h('gradient-text', { ...props }, slots.default?.()),
});
const MARKDOWN_RENDERER_COMPONENT = Object.freeze({
  props: ['content', 'thinkingText', 'processText'],
  setup: props => () => h('markdown', {
    thinkingText: props.thinkingText,
    processText: props.processText,
  }, props.content),
});
const PROMPT_CARD_COMPONENT = Object.freeze({ setup: () => () => h('prompt-card', '审批卡片') });

/**
 * 显式桩名单（**唯一**一份）。
 *
 * <p>原则：只有「与过程区无关 / 需要真实布局或网络 / 有独立套件覆盖」的组件才进这份名单；
 * 过程区自身的 renderer 一律真实加载。</p>
 */
const EXPLICIT_VUE_STUBS = [
  { name: 'GradientText', test: /GradientText\.vue$/, component: GRADIENT_TEXT_COMPONENT },
  { name: 'MarkdownRenderer', test: /MarkdownRenderer\.vue$/, component: MARKDOWN_RENDERER_COMPONENT },
  { name: 'PromptCard', test: /PromptCard\.vue$/, component: PROMPT_CARD_COMPONENT },
  { name: 'PlanCard', test: /PlanCard\.vue$/, component: STUB_SHELL_COMPONENT },
  { name: 'CardActionButton', test: /CardActionButton\.vue$/, component: STUB_SHELL_COMPONENT },
];

/** `realPlanCards` 时**取消**桩的组件：审批卡与计划卡需要真实渲染的用例才会打开。 */
const PLAN_CARD_STUBS = new Set(['PromptCard', 'PlanCard', 'CardActionButton']);

/**
 * 「只关心过程区」的最小加载集：交互卡片、正文/底栏插槽、审批卡等按历史语义走桩。
 *
 * <p>这些组件在 Electron-free 套件里从来没有被真实加载过（它们各自有独立套件，且会拉起
 * Pinia store 与网络服务）。协作式委派/QA 对抗两个套件只断言过程段的呈现，用
 * `restrictToRealPrefixes` 保持与改造前完全一致的加载面。</p>
 */
const PROCESS_AREA_REAL_PREFIXES = Object.freeze([
  // 目录前缀规则：以后新增的 renderer 自动落进真实加载，不需要再改白名单。
  /components[/\\]chat[/\\]process[/\\]/,
  /ChatProcessSegment\.vue$/,
  /ProcessDetails\.vue$/,
  /ChatMessageItem\.vue$/,
  /CardHeader\.vue$/,
]);

function isUnderRealLoadDir(file) {
  return REAL_LOAD_DIRS.some(dir => file.startsWith(dir + path.sep));
}

/**
 * 判定一个 `.vue` 请求该不该真实加载。
 *
 * @param {string} resolved 已解析的绝对路径
 * @param {string} request 原始请求串（供显式名单匹配）
 * @param {{ realPlanCards: boolean, extraStubs: RegExp[] }} options
 * @returns {object|null} 桩组件；`null` 表示「递归真实加载」
 */
function resolveVueStub(resolved, request, options) {
  const inRealDir = isUnderRealLoadDir(resolved);
  // 1. 调用方追加的桩（用于「证明桩掉会变红」这类自证用例）。
  for (const pattern of options.extraStubs) {
    if (pattern.test(request) || pattern.test(resolved)) return STUB_SHELL_COMPONENT;
  }
  // 2. 显式名单：始终桩（realPlanCards 时豁免审批/计划卡）。
  for (const stub of EXPLICIT_VUE_STUBS) {
    if (!stub.test.test(request) && !stub.test.test(resolved)) continue;
    if (options.realPlanCards && PLAN_CARD_STUBS.has(stub.name)) return null;
    return stub.component;
  }
  // 3. 最小加载集模式：只有过程区自身（目录前缀 + 段组件）真实加载，其余按历史语义走桩。
  if (options.restrictToRealPrefixes) {
    const isProcessArea = PROCESS_AREA_REAL_PREFIXES
      .some(pattern => pattern.test(request) || pattern.test(resolved));
    return isProcessArea ? null : STUB_SHELL_COMPONENT;
  }
  // 4. 目录规则：过程区组件默认真实加载；其余目录沿用历史「默认桩」。
  return inRealDir ? null : STUB_SHELL_COMPONENT;
}

/**
 * 编译并求值一个真实模块（`.ts` / `.vue`）。
 *
 * @param {string} filename 绝对路径
 * @param {{ realPlanCards?: boolean, extraStubs?: RegExp[], compileId?: string }} [options]
 * @returns {object} 模块导出
 */
function loadModule(filename, options = {}) {
  const settings = {
    realPlanCards: options.realPlanCards === true,
    extraStubs: options.extraStubs ?? [],
    restrictToRealPrefixes: options.restrictToRealPrefixes === true,
    compileId: options.compileId ?? 'chat-process-harness',
  };
  const cache = new Map();

  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = new Module(file);
    cache.set(file, module);
    module.filename = file;
    module.paths = Module._nodeModulePaths(path.dirname(file));
    module.require = request => requestModule(file, request);
    let source = fs.readFileSync(file, 'utf8');
    // `import.meta` 在 CJS 下是语法错误：Node 会把该模块回退成 ESM 执行，随后报
    // 「exports is not defined」。测试环境里换成等价的静态对象，保持 CJS 执行语义。
    source = source.replace(/\bimport\.meta\b/g, '({ env: {}, url: "" })');
    if (file.endsWith('.vue')) {
      const descriptor = parse(source, { filename: file }).descriptor;
      source = compileScript(descriptor, {
        id: settings.compileId,
        inlineTemplate: true,
        // defineProps<T>() 的导入类型需要 fs 才能解析（如 types/chatMessageSlots.ts）。
        fs: {
          fileExists: target => fs.existsSync(target),
          readFile: target => fs.readFileSync(target, 'utf8'),
        },
      }).content;
    }
    module._compile(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    } }).outputText, file);
    return module.exports;
  }

  /**
   * 解析一个 `require` 请求：浏览器依赖、服务层与 `.vue` 走桩/目录规则，其余按相对路径真实加载。
   */
  function requestModule(fromFile, request) {
    if (request === 'vue') {
      return {
        ...require('vue'),
        // 过渡与传送门只是渲染容器；Teleport 需要真实 DOM 目标，测试里直接渲染默认插槽。
        Transition: { setup: (_props, { slots }) => () => slots.default?.() },
        Teleport: { setup: (_props, { slots }) => () => slots.default?.() },
      };
    }
    if (!request.startsWith('.')) return require(request);
    // 子会话详情会拉取历史消息，测试中不触网：统一返回「加载失败」的可判定结果。
    if (request.includes('services/chat')) {
      return { chatApi: { fetchSessionMessages: async () => ({ ok: false }) } };
    }
    const resolved = path.resolve(path.dirname(fromFile), request);
    if (request.endsWith('.vue')) {
      const stubbed = resolveVueStub(resolved, request, settings);
      if (stubbed) return { __esModule: true, default: stubbed };
      return load(resolved);
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
  }

  return load(filename);
}

/** 加载 `src/` 下的模块（相对 `src` 的路径）。 */
function loadFromSrc(relative, options) {
  return loadModule(path.resolve(SRC_DIR, relative), options);
}

/** 加载 `src/` 下的单文件组件，返回组件定义本身。 */
function componentFromSrc(relative, options) {
  return loadFromSrc(relative, options).default;
}

/** 内存树节点；滚动几何默认值让「贴底」相关用例无需额外初始化。 */
function element(tag, text = '') {
  return {
    tag,
    text,
    props: {},
    style: {},
    children: [],
    parent: null,
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    addEventListener() {},
    removeEventListener() {},
    scrollTo({ top }) { this.scrollTop = Math.max(0, top - this.clientHeight); },
  };
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
  return undefined;
}

function findAll(node, predicate) {
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => findAll(child, predicate))];
}

/**
 * 用 Vue 官方 `createRenderer` 把真实组件挂到内存树上。
 *
 * @param {import('node:test').TestContext} t 用例上下文（负责卸载与环境还原）
 * @param {object} componentDefinition 组件定义
 * @param {object} props 根 props
 * @param {{ raf?: boolean }} [options] `raf: true` 时补上 requestAnimationFrame（贴底调度需要）
 * @returns {object} 根内存节点
 */
function mountComponent(t, componentDefinition, props, options = {}) {
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
  const previousFrame = global.requestAnimationFrame;
  const previousCancelFrame = global.cancelAnimationFrame;
  global.window = { setInterval, setTimeout, clearTimeout };
  if (options.raf === true) {
    global.requestAnimationFrame = callback => setTimeout(callback, 0);
    global.cancelAnimationFrame = clearTimeout;
  }

  const root = element('root');
  const app = renderer.createApp(componentDefinition, props);
  app.provide(previewKey, undefined);
  app.mount(root);
  t.after(async () => {
    await require('vue').nextTick();
    app.unmount();
    if (previousFrame === undefined) delete global.requestAnimationFrame;
    else global.requestAnimationFrame = previousFrame;
    if (previousCancelFrame === undefined) delete global.cancelAnimationFrame;
    else global.cancelAnimationFrame = previousCancelFrame;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  });
  return root;
}

/** 读源码（供源码级契约断言使用）。 */
function readSource(relativeFromTests) {
  return fs.readFileSync(path.resolve(__dirname, '..', relativeFromTests), 'utf8');
}

module.exports = {
  SRC_DIR,
  previewKey,
  STUB_SHELL_COMPONENT,
  EXPLICIT_VUE_STUBS,
  PROCESS_AREA_REAL_PREFIXES,
  loadModule,
  loadFromSrc,
  componentFromSrc,
  isStubbed: component => component === STUB_SHELL_COMPONENT,
  element,
  text,
  find,
  findAll,
  mountComponent,
  readSource,
};
