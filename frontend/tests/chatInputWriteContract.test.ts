import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {h, nextTick, ref} from 'vue';
import {
  cleanupMutantTemp,
  readMutantSource,
  readMutationFlag,
  type MutationTable,
} from './support/mutantSource';

/**
 * 程序写入通道的回归用例（QA 复验发现的 L-1 / L-2）。
 *
 * <ul>
 *   <li><b>L-1</b>：`writeInputText` 写入与旧值相同的文本时 Vue 的 ref 判等不会触发 watch，
 *       标记于是残留 —— 用户紧接着敲的第一个 `/` 被当成程序写入，快捷指令菜单不弹。</li>
 *   <li><b>L-2</b>：`usePromptOptimization.optimize()` 剥掉 `/optimize-prompt` 前缀时直接写 ref，
 *       绕过了第四个形参 `replaceInput`（组件传入的就是 `writeInputText`）。剩余文本以 `/` 开头时
 *       会被当成用户打字而弹出菜单。</li>
 * </ul>
 *
 * <p>两条都用**真实组件挂载**验证：内存 renderer 里派发真实的 `beforeinput` + `input`，
 * 走 Vue 的 v-model 指令链路，断言的是「快捷指令菜单到底弹没弹」这个可观察结果。</p>
 */

const requireCjs = createRequire(import.meta.url);
interface MemoryNode {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  listeners: Record<string, Array<(event: unknown) => void>>;
  value?: string;
  children: MemoryNode[];
  __vm?: Record<string, (...args: never[]) => unknown>;
}

const harness = requireCjs('./support/chatProcessHarness.cjs') as {
  componentFromSrc: (relative: string, options?: HarnessOptions) => unknown;
  loadFromSrc: (relative: string, options?: HarnessOptions) => Record<string, unknown>;
  mountComponent: (t: unknown, component: unknown, props: Record<string, unknown>) => MemoryNode;
  find: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode | undefined;
  findAll: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode[];
};

interface HarnessOptions {
  compileId?: string;
  moduleStubs?: Array<{test: RegExp; exports: Record<string, unknown>}>;
  sourceOverrides?: Array<{test: RegExp; source: string}>;
}

const INPUT_AREA = 'src/components/chat/ChatInputArea.vue';
const PROMPT_OPTIMIZATION = 'src/composables/usePromptOptimization.ts';

const MUTATIONS: MutationTable = {
  // L-1 注回：同值写入也置标记（旧实现），标记残留到下一次真实输入
  'marker-on-same-value': source => {
    // 源码是 CRLF：先归一成 LF 再按带换行的锚点做手术（否则锚点永远匹配不上）。
    const normalized = source.replace(/\r\n/g, '\n');
    assert.ok(normalized.includes('if (inputText.value === text) {\n    return;\n  }\n'),
      '补丁锚点失效：找不到 writeInputText 的同值早返回');
    return normalized.replace('if (inputText.value === text) {\n    return;\n  }\n', '');
  },
  // L-1 注回：完全去掉标记（程序写入会被当成用户打字）
  'no-programmatic-marker': source => {
    assert.ok(source.includes('programmaticWrite = true;'), '补丁锚点失效：找不到标记赋值');
    return source.replace('programmaticWrite = true;', 'programmaticWrite = false;');
  },
  // L-2 注回：剥前缀直接写 ref，绕过 replaceInput 通道
  'bypass-replace-input': source => {
    assert.ok(source.includes('replaceInput(input.value.slice(OPTIMIZE_PROMPT_COMMAND.length)'),
      '补丁锚点失效：找不到剥前缀的 replaceInput 调用');
    return source.replace(
      'replaceInput(input.value.slice(OPTIMIZE_PROMPT_COMMAND.length).replace(/^\\s+/, \'\'));',
      'input.value = input.value.slice(OPTIMIZE_PROMPT_COMMAND.length).replace(/^\\s+/, \'\');');
  },
  // 入队流程注回：输入框有内容时主按钮仍保持暂停/停止态
  'keep-stop-when-input-present': source => {
    assert.ok(source.includes('const showStop = computed(() => !!props.isSending && !hasQueueableInput.value);'),
      '补丁锚点失效：找不到 showStop 计算属性');
    return source.replace(
      'const showStop = computed(() => !!props.isSending && !hasQueueableInput.value);',
      'const showStop = computed(() => !!props.isSending);');
  },
};

/** 各文件适用的变异集合（其余变异名按正常源码返回）。 */
const INPUT_AREA_MUTATIONS: MutationTable = {
  'marker-on-same-value': MUTATIONS['marker-on-same-value']!,
  'no-programmatic-marker': MUTATIONS['no-programmatic-marker']!,
  'keep-stop-when-input-present': MUTATIONS['keep-stop-when-input-present']!,
};
const OPTIMIZATION_MUTATIONS: MutationTable = {
  'bypass-replace-input': MUTATIONS['bypass-replace-input']!,
};

const mutation = readMutationFlag();

test.after(() => {
  cleanupMutantTemp();
});

test('变异名必须在变异表内（防止变异静默失效）', () => {
  if (!mutation) {
    return;
  }
  assert.ok(MUTATIONS[mutation], `未知变异: ${mutation}`);
});

/**
 * 装上最小 `document` / `localStorage` / `URL` / `Document` / `ShadowRoot` 替身。
 *
 * <p>为什么是**文件级**安装而不是每个用例各自安装：组件卸载钩子（`onBeforeUnmount` 里的
 * `document.removeEventListener`）走的是 `t.after`，而 `t.after` 按注册顺序执行 —— 替身若在
 * 挂载之前注册清理，就会先于卸载执行，卸载阶段直接抛 `document is not defined`，用例被环境
 * 错误判红。文件级 `after` 一定晚于各组件的卸载钩子。</p>
 */
type DomStubScope = {
  document?: unknown; URL?: unknown; localStorage?: unknown; Document?: unknown; ShadowRoot?: unknown;
};
const domStubScope = globalThis as unknown as DomStubScope;
const previousDomStubs: DomStubScope = {
  document: domStubScope.document,
  URL: domStubScope.URL,
  localStorage: domStubScope.localStorage,
  Document: domStubScope.Document,
  ShadowRoot: domStubScope.ShadowRoot,
};

function installDomStubs(): void {
  domStubScope.document = {
    addEventListener() {},
    removeEventListener() {},
  };
  domStubScope.URL = {createObjectURL: () => 'blob:stub', revokeObjectURL() {}};
  domStubScope.localStorage = {getItem: () => null, setItem() {}, removeItem() {}};
  // Vue 3.5 的 v-model 指令会做 `rootNode instanceof Document`：Node 里没有这两个全局构造器，
  // 不补的话每次文本更新都会抛 ReferenceError（错误出在框架层，会把用例判成环境问题）。
  domStubScope.Document = class DocumentStub {};
  domStubScope.ShadowRoot = class ShadowRootStub {};
}

/** 还原全局替身（文件级 after 钩子调用，必须晚于各组件的卸载钩子）。 */
function restoreDomStubs(): void {
  for (const key of Object.keys(previousDomStubs) as Array<keyof DomStubScope>) {
    if (previousDomStubs[key] === undefined) delete domStubScope[key];
    else domStubScope[key] = previousDomStubs[key];
  }
}

installDomStubs();
test.after(() => {
  restoreDomStubs();
});

/** 挂载真实的 ChatInputArea（可选注入变异源码）。 */
function mountInputArea(t: unknown, componentSource: string, mutationOptions: HarnessOptions = {}, props = {}) {
  const component = harness.componentFromSrc('components/chat/ChatInputArea.vue', {
    compileId: 'chat-input-write-contract',
    // 子组件走桩：本用例只关心输入框自己的行为，避免拉起下拉/菜单等无关依赖。
    extraStubs: [/ChatInputModelSelector\.vue$/, /ChatInputContextUsage\.vue$/],
    // 服务层走桩：挂载时会拉团队/Agent 列表，用例不触网。
    moduleStubs: [
      {
        test: /ChatInputSendButton\.vue$/,
        exports: {
          __esModule: true,
          default: {
            props: ['isSending', 'armed', 'isDark', 'colors', 'onSend'],
            setup: (slotProps: {isSending?: boolean; armed?: boolean; onSend?: () => void}) => () => h('button', {
              type: 'button',
              'data-testid': 'chat-send-button',
              'data-sending': String(!!slotProps.isSending),
              disabled: !slotProps.armed,
              onClick: () => slotProps.onSend?.(),
            }),
          },
        },
      },
      {
        test: /services[/\\](interceptor|team|agent|skill)$/,
        exports: {
          default: {get: async () => ({code: 0, errMsg: 'stub'}), post: async () => ({code: 0, errMsg: 'stub'})},
          TeamAPI: {list: async () => ({code: 0, errMsg: 'stub'})},
          AgentAPI: {list: async () => ({code: 0, errMsg: 'stub'}), chatLimits: async () => ({code: 0, errMsg: 'stub'})},
          SkillAPI: {list: async () => ({code: 0, errMsg: 'stub'})},
        },
      },
      {
        // 星光粒子层：模板 ref 会调用 `ping()`，桩必须提供同名方法，否则 watch 里会抛。
        test: /SparkTrail\.vue$/,
        exports: {
          __esModule: true,
          default: {setup: (_props: unknown, context: {expose: (api: object) => void}) => {
            context.expose({ping() {}});
            return () => null;
          }},
        },
      },
    ],
    ...mutationOptions,
    sourceOverrides: [{test: /ChatInputArea\.vue$/, source: componentSource}, ...(mutationOptions.sourceOverrides ?? [])],
  });
  return harness.mountComponent(t, component, {isDark: false, hasActiveSession: true, ...props});
}

/** 找到文本输入框。 */
function findTextarea(root: MemoryNode): MemoryNode {
  const textarea = harness.find(root, node => node.tag === 'textarea');
  assert.ok(textarea, '未找到输入框（组件未渲染或结构变了）');
  return textarea;
}

/**
 * 模拟用户在输入框里敲一个字符：`beforeinput` 先行、`input` 交给 v-model 指令。
 *
 * @param textarea 文本输入框节点
 * @param next 敲入后的完整文本
 */
async function typeInto(textarea: MemoryNode, next: string): Promise<void> {
  textarea.value = next;
  const beforeInput = textarea.props.onBeforeinput as ((event: unknown) => void) | undefined;
  beforeInput?.call(textarea, {inputType: 'insertText'});
  // v-model 的指令监听读的是 `event.target.composing` 与 `el.value`，派发时两者都要给。
  for (const handler of textarea.listeners.input ?? []) {
    handler.call(textarea, {type: 'input', inputType: 'insertText', target: textarea});
  }
  await nextTick();
}

/** 快捷指令菜单是否展开（`+` 按钮的 aria-expanded 就是它）。 */
function commandMenuOpen(root: MemoryNode): boolean {
  const trigger = harness.find(root, node => node.tag === 'button'
    && String(node.props['aria-expanded'] ?? '') !== '' && String(node.props['aria-label'] ?? '').includes('指令'));
  if (!trigger) {
    // 兜底：按 title 找同一个按钮（文案本地化后 aria-label 可能变）
    const byTitle = harness.find(root, node => node.tag === 'button'
      && String(node.props['aria-expanded'] ?? '') !== '');
    assert.ok(byTitle, '未找到快捷指令触发按钮，断言不成立');
    return byTitle.props['aria-expanded'] === true;
  }
  return trigger.props['aria-expanded'] === true;
}

test('运行时按 Enter 进入待发送队列，后端确认前保留草稿', async t => {
  let accepted = false;
  const queued: string[] = [];
  const root = mountInputArea(t, readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS), {}, {
    isSending: true,
    queueMessage: async (text: string) => { queued.push(text); return accepted; },
  });
  const textarea = findTextarea(root);
  const enter = textarea.props.onKeydown as (event: object) => void;
  const pressEnter = async () => {
    enter({key: 'Enter', preventDefault() {}});
    await Promise.resolve();
    await nextTick();
    await nextTick();
  };

  await typeInto(textarea, '下一条需求');
  await pressEnter();
  assert.deepEqual(queued, ['下一条需求']);
  assert.equal(textarea.value, '下一条需求');

  accepted = true;
  await pressEnter();
  assert.deepEqual(queued, ['下一条需求', '下一条需求']);
  assert.equal(textarea.value, '');
});

test('运行时无独立待发送按钮：输入框有内容时主按钮切换为可发送态并点击入队', async t => {
  let accepted = true;
  let stopped = 0;
  const queued: string[] = [];
  const root = mountInputArea(t, readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS), {}, {
    isSending: true,
    queueMessage: async (text: string) => { queued.push(text); return accepted; },
    onStopGeneration: () => { stopped += 1; },
  });
  const textarea = findTextarea(root);
  const findSendButton = () => {
    const btn = harness.find(root, node => node.props['data-testid'] === 'chat-send-button');
    assert.ok(btn, '未找到主发送/停止按钮');
    return btn;
  };
  const clickSendButton = async () => {
    const btn = findSendButton();
    (btn.props.onClick as () => void)();
    await Promise.resolve();
    await nextTick();
    await nextTick();
  };

  // 1. 输入框为空时：主按钮处于暂停/停止态，点击触发 stopGeneration
  assert.equal(findSendButton().props['data-sending'], 'true', '输入框为空时主按钮应处于暂停/停止态');
  assert.equal(findSendButton().props.disabled, false);
  await clickSendButton();
  assert.equal(stopped, 1, '空输入点击应触发停止生成');
  assert.deepEqual(queued, []);

  // 2. 输入框存在内容时：独立「加入待发送」按钮不存在，主按钮切换为可发送状态
  await typeInto(textarea, '入队需求 A');
  const legacyAddBtn = harness.find(root, node => node.tag === 'button' && node.text.includes('加入待发送'));
  assert.equal(legacyAddBtn, undefined, '独立的「加入待发送」按钮应已移除');
  assert.equal(findSendButton().props['data-sending'], 'false', '输入框有内容时主按钮应变为可发送态');
  assert.equal(findSendButton().props.disabled, false);

  // 3. 点击主按钮存入待发送队列，成功后清空输入框并回到暂停/停止态
  await clickSendButton();
  assert.deepEqual(queued, ['入队需求 A']);
  assert.equal(stopped, 1, '入队点击不得误触发停止生成');
  assert.equal(textarea.value, '');
  assert.equal(findSendButton().props['data-sending'], 'true', '入队清空后主按钮应回到暂停/停止态');

  // 4. 若后端拒绝入队，保留草稿且主按钮维持可发送态
  accepted = false;
  await typeInto(textarea, '入队需求 B');
  assert.equal(findSendButton().props['data-sending'], 'false');
  await clickSendButton();
  assert.deepEqual(queued, ['入队需求 A', '入队需求 B']);
  assert.equal(textarea.value, '入队需求 B');
  assert.equal(findSendButton().props['data-sending'], 'false', '入队失败保留草稿时主按钮仍应维持可发送态');
});

// ---------- L-1 ----------

test('程序写入同值文本后，用户敲 / 必须弹出快捷指令菜单', async t => {
  const source = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  const root = mountInputArea(t, source);
  await nextTick();

  // 复现路径：一次「与旧值相同」的程序写入（宿主回填 '' / 发送后清空 '' 都走这条通道）
  const instance = root.__vm;
  assert.ok(instance && typeof instance['setInputText'] === 'function', '组件必须暴露 setInputText');
  (instance['setInputText'] as (text: string) => void)('');
  await nextTick();
  assert.equal(commandMenuOpen(root), false, '程序写入本身不得弹出菜单');

  // 紧接着用户真敲一个 '/'
  await typeInto(findTextarea(root), '/');
  assert.equal(commandMenuOpen(root), true,
    '程序写入同值文本后，用户敲 / 必须弹出快捷指令菜单（标记不得残留到下一次真实输入）');

  // 再敲一个字符仍应保持展开（不是只有第一次侥幸生效）
  await typeInto(findTextarea(root), '/p');
  assert.equal(commandMenuOpen(root), true, '继续输入时菜单必须仍然是展开的');
});

test('程序写入不同值时不触发命令副作用：回填 /plan 文本不得自己弹菜单', async t => {
  const source = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  const root = mountInputArea(t, source);
  await nextTick();

  const instance = root.__vm!;
  (instance['setInputText'] as (text: string) => void)('/plan 把这段重构成策略模式');
  await nextTick();
  assert.equal(commandMenuOpen(root), false,
    '宿主回填以 / 开头的文本不得触发快捷指令菜单（程序写入通道契约）');
});

// ---------- L-2 ----------

test('剥 /optimize-prompt 前缀必须走 replaceInput 通道，不得直接写 ref', async () => {
  const source = readMutantSource(PROMPT_OPTIMIZATION, mutation, OPTIMIZATION_MUTATIONS);
  const loaded = harness.loadFromSrc('composables/usePromptOptimization.ts', {
    compileId: 'prompt-optimization-write-contract',
    // 不触网：优化接口直接返回失败码，用例只关心「前缀剥离走了哪条写入通道」
    moduleStubs: [{
      test: /services[/\\]promptOptimization/,
      exports: {PromptOptimizationAPI: {optimize: async () => ({code: 0, errMsg: 'stub: 用例内不触网'})}},
    }],
    sourceOverrides: [{test: /usePromptOptimization\.ts$/, source}],
  }) as {
    usePromptOptimization: (
      input: {value: string},
      getModelId: () => string | number | undefined,
      focusInput: () => void,
      replaceInput?: (text: string) => void,
    ) => {optimize: () => Promise<void>};
    OPTIMIZE_PROMPT_COMMAND: string;
  };

  const input = ref('/optimize-prompt /plan 写测试');
  const writes: string[] = [];
  const optimized = loaded.usePromptOptimization(input, () => 1, () => {}, text => {
    writes.push(text);
    input.value = text;
  });
  await optimized.optimize();

  assert.deepEqual(writes, ['/plan 写测试'],
    '剥前缀必须交给 replaceInput（组件传入的 writeInputText），不得直接写 ref');
  assert.equal(input.value, '/plan 写测试', '前缀确实被剥掉了（正文一个字不丢）');
});

test('ChatInputArea 把 writeInputText 作为 replaceInput 传给 usePromptOptimization', () => {
  const source = readMutantSource(INPUT_AREA, mutation, INPUT_AREA_MUTATIONS);
  const call = /usePromptOptimization\(inputText,[\s\S]{0,400}?\}\);/.exec(source);
  assert.ok(call, 'ChatInputArea 必须调用 usePromptOptimization');
  assert.match(call[0], /writeInputText\(text\)/,
    'replaceInput 必须是程序写入通道 writeInputText（否则剥前缀会被当成用户打字而弹菜单）');
});
