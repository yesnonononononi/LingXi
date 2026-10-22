/**
 * 契约回归：`CHAT_INPUT_FOCUS_KEY` 的 provider / consumer 接线不能悬空。
 *
 * <p>缺陷现场：`PlanCard` 用 `v-if="isPending && focusChatInput"` 渲染「去聊天里说」入口，
 * 而 `ChatView` **从未调用** `provideChatInputFocus()`，于是消费方永远 inject 到 null，
 * 入口永久不渲染且不报错（静默失效）。本文件同时锁住两侧：</p>
 * <ol>
 *   <li>provider 侧（静态）：`ChatView.vue` setup 必须在 `inputAreaRef` 声明之后调用
 *       `provideChatInputFocus(() => inputAreaRef.value?.focusInput?.())`；</li>
 *   <li>consumer 侧（挂载）：路径 A 有 provider → 入口渲染且点击真的调到 focus 回调；
 *       路径 B 无 provider → 入口不渲染（杜绝死按钮）。</li>
 * </ol>
 *
 * <p>路径 A 的 provider **直接取自 `ChatView.vue` 源码表达式**，因此「provider 缺失」时它同样会变红，
 * 而不是靠测试自己造一个 provider 自我满足。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Module, { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';

const requireFromHere = createRequire(import.meta.url);
/** 与模板内编译产物共用同一份 vue 运行时（否则 provide/inject 与渲染器不是一套实例）。 */
const vue = requireFromHere('vue') as any;
const { createRenderer, defineComponent, h, ref } = vue;

/** 以本测试文件为锚点解析被测源码路径（ESM 下没有 __dirname）。 */
const resolveFromHere = (relativePath: string): string => fileURLToPath(new URL(relativePath, import.meta.url));
/** 被检视的视图文件（provider 侧）。 */
const CHAT_VIEW_PATH = resolveFromHere('../src/views/chat/ChatView.vue');
/** consumer 侧卡片组件。 */
const PLAN_CARD_PATH = resolveFromHere('../src/components/chat/PlanCard.vue');
/** 被测的组合式函数实现。 */
const FOCUS_COMPOSABLE_PATH = resolveFromHere('../src/composables/useChatInputFocus.ts');

/** 伪 DOM 节点：自定义渲染器的产物，只保留断言需要的最小字段。 */
interface FakeNode {
  tag: string;
  text: string;
  props: Record<string, any>;
  children: FakeNode[];
  parent: FakeNode | null;
  addEventListener(): void;
  removeEventListener(): void;
}

/**
 * 创建伪节点。
 *
 * @param tag 节点标签。
 * @param text 文本内容（文本节点专用）。
 * @returns 伪节点。
 */
function element(tag: string, text = ''): FakeNode {
  return { tag, text, props: {}, children: [], parent: null, addEventListener() {}, removeEventListener() {} };
}

/**
 * 递归拼接节点文本。
 *
 * @param node 起始节点。
 * @returns 该子树全部文本。
 */
function text(node: FakeNode): string {
  return node.text + node.children.map(text).join('');
}

/**
 * 深度优先查找第一个满足条件的节点。
 *
 * @param node 起始节点。
 * @param predicate 判定函数。
 * @returns 命中节点，未命中返回 undefined。
 */
function find(node: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return undefined;
}

/**
 * 造一个最小渲染器：把 VNode 树物化成 {@link FakeNode}，便于断言模板产物。
 */
function createFakeRenderer(): any {
  return createRenderer({
    createElement: (tag: string) => element(tag),
    createText: (value: string) => element('#text', value),
    createComment: () => element('#comment'),
    setText: (node: FakeNode, value: string) => { node.text = value; },
    setElementText: (node: FakeNode, value: string) => { node.text = value; node.children = []; },
    parentNode: (node: FakeNode) => node.parent,
    nextSibling: (node: FakeNode) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp: (node: FakeNode, key: string, _old: unknown, value: unknown) => { node.props[key] = value; },
    insert: (node: FakeNode, parent: FakeNode, anchor: FakeNode | null = null) => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node);
    },
    remove: (node: FakeNode) => {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      node.parent = null;
    },
  });
}

/**
 * 模块加载器：真实编译 `.vue` 模板与 `.ts` 模块，只替换展示型子组件与 i18n 文案。
 *
 * @returns 加载函数：传入文件路径返回该模块的 exports。
 */
function createLoader(): (filename: string) => any {
  const cache = new Map<string, any>();
  /** 展示型子组件：与本次契约无关，统一透传默认插槽。 */
  const passthrough = { setup: (_props: unknown, { slots }: any) => () => slots.default?.() };
  /** i18n 桩：把 key 渲染成 `[[key]]`，便于按文案精确定位节点。 */
  const i18nStub = () => {
    const translate = (key: string) => `[[${key}]]`;
    return { __esModule: true, t: translate, useI18n: () => ({ t: translate, locale: ref('zh-CN') }) };
  };

  const load = (filename: string): any => {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module: any = new Module(filename);
    cache.set(filename, module);
    module.filename = filename;
    module.paths = (Module as any)._nodeModulePaths(path.dirname(filename));
    module.require = (request: string) => {
      if (request === 'vue') {
        return { ...requireFromHere('vue'), Transition: { setup: (_p: unknown, { slots }: any) => () => slots.default?.() } };
      }
      if (!request.startsWith('.')) return requireFromHere(request);
      if (request.endsWith('.vue')) return { __esModule: true, default: passthrough };
      const resolved = path.resolve(path.dirname(filename), request);
      if (resolved.endsWith('.ts')) return load(resolved);
      if (fs.existsSync(resolved + '.ts')) return load(resolved + '.ts');
      if (fs.existsSync(path.join(resolved, 'index.ts'))) {
        if (/[/\\]i18n$/.test(resolved)) return i18nStub();
        return load(path.join(resolved, 'index.ts'));
      }
      throw new Error(`未解析的模块：${request}（来自 ${filename}）`);
    };
    let source = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('.vue')) {
      const descriptor = parse(source, { filename }).descriptor;
      source = compileScript(descriptor, { id: 'chat-input-focus', inlineTemplate: true }).content;
    }
    module._compile(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, filename);
    return module.exports;
  };
  return load;
}

/**
 * 去掉注释并归一化空白，避免「同一语义、不同格式」造成假红或注释掉的代码造成假绿。
 *
 * @param source 源文件内容。
 * @returns 可直接用于匹配的代码文本。
 */
function normalizeCode(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const withoutLines = withoutBlocks
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
  return withoutLines.replace(/\s+/g, ' ');
}

/**
 * 从 `ChatView.vue` 源码里抠出 provider 侧传入的聚焦回调表达式。
 *
 * @returns 形如 `() => inputAreaRef.value?.focusInput?.()` 的表达式；未接线时返回 null。
 */
function extractFocusProviderExpression(): string | null {
  const source = normalizeCode(fs.readFileSync(CHAT_VIEW_PATH, 'utf8'));
  const matched = source.match(/provideChatInputFocus\(\s*(\(\s*\)\s*=>[^;]*?)\s*\)\s*;/);
  return matched ? matched[1] : null;
}

/** 一张「待审」PLAN 卡片：`canDecideCard(card,'APPROVE') === true`，入口才有渲染前提。 */
function pendingPlanCard(): Record<string, unknown> {
  return {
    kind: 'PLAN',
    toolCallId: 'call-input-focus',
    conversationId: 'sess-input-focus',
    title: '任务计划',
    content: '## 目标\n\n核验「去聊天里说」入口的接线。',
    status: 'pending',
    version: '1',
    allowedActions: ['APPROVE', 'REJECT'],
    pending: true,
  };
}

interface MountResult {
  root: FakeNode;
  calls: { focus: number };
  unmount(): void;
}

/**
 * 挂载 `PlanCard`（可选装上 ChatView 同款 provider）。
 *
 * @param t node:test 上下文，用于注册清理。
 * @param options.withProvider 是否提供 `CHAT_INPUT_FOCUS_KEY`。
 * @param options.focusExpression provider 传入的回调表达式（取自 ChatView 源码）。
 * @returns 渲染根节点与 focus 调用计数。
 */
function mountPlanCard(
  t: any,
  options: { withProvider: boolean; focusExpression: string | null },
): MountResult {
  const load = createLoader();
  const focusModule = load(FOCUS_COMPOSABLE_PATH);
  const planCardComponent = load(PLAN_CARD_PATH).default;
  const calls = { focus: 0 };

  // 假输入框：与 ChatInputArea 的 defineExpose 同形，focusInput 被打点即计数。
  const FakeInputArea = defineComponent({
    name: 'FakeChatInputArea',
    setup(_props: unknown, { expose }: any) {
      expose({
        focus: () => { calls.focus += 1; },
        focusInput: () => { calls.focus += 1; },
      });
      return () => h('chat-input-area');
    },
  });

  const Host = defineComponent({
    name: 'ChatViewFocusHost',
    setup() {
      const inputAreaRef = ref(null);
      if (options.withProvider) {
        assert.ok(options.focusExpression, 'provider 表达式缺失，无法建立真实接线');
        // 用 ChatView 源码里的表达式建立 provider：provider 一旦被删掉/注释，这里就无表达式可用。
        const build = new Function('inputAreaRef', `return (${options.focusExpression});`);
        focusModule.provideChatInputFocus(build(inputAreaRef) as () => void);
      }
      return () => h('focus-host', [
        h(FakeInputArea, { ref: inputAreaRef }),
        h(planCardComponent, {
          promptCard: pendingPlanCard(),
          sessionId: 'sess-input-focus',
          isDark: false,
        }),
      ]);
    },
  });

  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = { setInterval, matchMedia: undefined };
  const renderer = createFakeRenderer();
  const root = element('root');
  const app = renderer.createApp(Host);
  // 展示型子组件是插槽透传桩，会刷与本契约无关的透传告警；断言只看节点树。
  app.config.warnHandler = () => {};
  app.mount(root);
  const unmount = () => {
    app.unmount();
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;
  };
  t.after(unmount);
  return { root, calls, unmount };
}

/** 「去聊天里说」按钮的文案（i18n 桩把 key 渲染成 [[key]]）。 */
const GO_TO_CHAT_LABEL = '[[chat.plan.goToChat]]';

test('★ provider 接线：ChatView 必须在 inputAreaRef 声明之后提供 CHAT_INPUT_FOCUS_KEY', () => {
  const code = normalizeCode(fs.readFileSync(CHAT_VIEW_PATH, 'utf8'));

  // 1) 必须真的引入 provider 函数：只留注释 / 只留消费方都不算接线。
  assert.match(
    code,
    /import \{[^}]*\bprovideChatInputFocus\b[^}]*\} from '[^']*composables\/useChatInputFocus'/,
    'ChatView 必须从 composables/useChatInputFocus 导入 provideChatInputFocus',
  );

  // 2) 必须有一条真实调用（注释已在上一步被剔除，注释掉调用会命中失败）。
  const callIndex = code.search(/provideChatInputFocus\(\s*\(\s*\)\s*=>/);
  assert.ok(callIndex >= 0, 'ChatView 未调用 provideChatInputFocus()：CHAT_INPUT_FOCUS_KEY 悬空，入口永久不渲染');

  // 3) 必须在 ref 声明之后调用（setup 顶层顺序错会在未声明变量上取 ref）。
  const declarationIndex = code.indexOf('const inputAreaRef = ref');
  assert.ok(declarationIndex >= 0, '未找到 inputAreaRef 声明');
  assert.ok(callIndex > declarationIndex, 'provideChatInputFocus 必须在 inputAreaRef 声明之后调用');

  // 4) 回调必须走可选链，避免输入框未挂载/已卸载时点出异常。
  const expression = extractFocusProviderExpression();
  assert.equal(expression, '() => inputAreaRef.value?.focusInput?.()', 'provider 回调必须写成可选链形式');
});

test('★ 路径 A（有 provider）：入口渲染出来，点击调用 focus 回调', t => {
  const { root, calls } = mountPlanCard(t, { withProvider: true, focusExpression: extractFocusProviderExpression() });

  // 金丝雀：先证明卡片确实渲染成「待审」态（批准动作在位），否则「按钮找不到」可能是整卡没渲染导致的假红。
  assert.ok(text(root).includes('[[chat.plan.approveAction]]'), '待审卡片必须渲染批准动作（卡身未渲染时本用例不成立）');

  const entry = find(root, node => node.tag === 'button' && text(node).includes(GO_TO_CHAT_LABEL));
  assert.ok(entry, '有 provider 时必须渲染「去聊天里说」入口');

  entry.props.onClick();
  assert.equal(calls.focus, 1, '点击入口必须调用一次聚焦回调');
});

test('★ 路径 A2（有 provider 但输入框未挂载）：点击不抛错（可选链兜底）', t => {
  const load = createLoader();
  const focusModule = load(FOCUS_COMPOSABLE_PATH);
  const planCardComponent = load(PLAN_CARD_PATH).default;
  const expression = extractFocusProviderExpression();
  assert.ok(expression, 'provider 表达式缺失，ChatView 未接线');

  const Host = defineComponent({
    name: 'ChatViewUnmountedInputHost',
    setup() {
      const inputAreaRef = ref(null);
      const build = new Function('inputAreaRef', `return (${expression});`);
      focusModule.provideChatInputFocus(build(inputAreaRef) as () => void);
      return () => h('focus-host', [h(planCardComponent, {
        promptCard: pendingPlanCard(), sessionId: 'sess-input-focus', isDark: false,
      })]);
    },
  });

  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = { setInterval, matchMedia: undefined };
  const renderer = createFakeRenderer();
  const root = element('root');
  const app = renderer.createApp(Host);
  app.config.warnHandler = () => {};
  app.mount(root);
  t.after(() => {
    app.unmount();
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;
  });

  const entry = find(root, node => node.tag === 'button' && text(node).includes(GO_TO_CHAT_LABEL));
  assert.ok(entry, '有 provider 时入口应当渲染');
  assert.doesNotThrow(() => entry.props.onClick(), '输入框未挂载时点击不得抛错');
});

test('★ 路径 B（无 provider）：入口不渲染，但卡片其余部分照常渲染', t => {
  const { root } = mountPlanCard(t, { withProvider: false, focusExpression: null });

  // 金丝雀：整卡渲染成功且处于「待审」态（批准动作在位），
  // 排除「因为什么都没渲染所以找不到入口」这种假绿——入口缺失只能归因于 provider 缺席。
  assert.ok(text(root).includes('[[chat.plan.approveAction]]'), '无 provider 不影响卡片其余渲染');
  const shell = find(root, node => String(node.props?.class ?? '').includes('rounded-2xl border'));
  assert.ok(shell, '卡片外壳必须渲染');

  const entry = find(root, node => node.tag === 'button' && text(node).includes(GO_TO_CHAT_LABEL));
  assert.equal(entry, undefined, '无 provider 时「去聊天里说」入口不得渲染（避免死按钮）');
});
