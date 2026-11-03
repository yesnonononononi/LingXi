import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {nextTick, reactive} from 'vue';
import {parse} from 'vue/compiler-sfc';
import {t, setPreference} from '../src/i18n';
import type {AwaitModelResponseState} from '../src/utils/awaitModelResponse';
import type {ChatMessage} from '../src/types/chat';
import {AgentToolName} from '../src/utils/toolNames';
import {
  cleanupMutantTemp,
  importMutantModule,
  readMutantSource,
  readMutationFlag,
  replaceExportedFunction,
  type MutationTable,
} from './support/mutantSource';

const requireCjs = createRequire(import.meta.url);
/** 真实 SFC 挂载 harness（内存 renderer + 唯一 stub 清单）。 */
const harness = requireCjs('./support/chatProcessHarness.cjs') as {
  componentFromSrc: (relative: string, options?: Record<string, unknown>) => unknown;
  mountComponent: (t: unknown, component: unknown, props: Record<string, unknown>) => MemoryNode;
  findAll: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode[];
  find: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode | undefined;
};

interface MemoryNode {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: MemoryNode[];
}

/**
 * 缺陷 1 回归用例：「执行命令 → 模型下一轮响应」空窗占位的判据与呈现形态。
 *
 * <p>两件事都必须钉死：<b>判据</b>（工具执行中 / 有正文 / 重试中 / 历史消息一律不出占位）
 * 与<b>形态</b>（空窗期把过程段标题行原地变成扫光占位，是「替代」而非「追加」，
 * 且整组只有最后一段进入占位态）。只断言「存在」会放过形态回归。</p>
 *
 * <p>变异自检：`--mutation=thinking-only`（判据退回"isThinking 就显示"）、
 * `--mutation=standalone-row`（改回独立插入一行）、
 * `--mutation=append-not-replace`（占位与标题同时渲染）、
 * `--mutation=ignore-mode`（定位规则去掉「该段仍在增长」）、
 * `--mutation=ignore-idle`（定位规则去掉「段内无在跑步骤」）。</p>
 */

const MESSAGE_ITEM = 'src/components/chat/ChatMessageItem.vue';
const SEGMENT_COMPONENT = 'src/components/chat/ChatProcessSegment.vue';
const PREDICATE = 'src/utils/awaitModelResponse.ts';
const MESSAGES_I18N = 'src/i18n/messages.ts';

const MUTATIONS: MutationTable = {
  // 注回原始缺陷：只要有 isThinking 就显示（工具执行中、已有正文、重试中全部误报）
  'thinking-only': source => replaceExportedFunction(source, 'resolveAwaitModelResponse',
    'export function resolveAwaitModelResponse(state: AwaitModelResponseState): boolean {\n'
    + '  return state.isThinking === true;\n'
    + '}\n'),
  // 注回旧形态：在「执行命令」卡片行之后又插一条独立占位行（用户明确否掉的那个做法）
  'standalone-row': source => {
    const normalized = source.replace(/\r\n/g, '\n');
    const anchor = '      <InteractionCards :entries="cardItems" :tool-calls="props.message.toolCalls"';
    assert.ok(normalized.includes(anchor), '补丁锚点失效：找不到 InteractionCards');
    const injected = '<div v-if="awaitModelResponse" role="status" data-testid="await-model-response">\n'
      + '        {{ t(\'chat.message.awaitModelResponse\') }}\n      </div>\n\n      ';
    return normalized.replace(anchor, `${injected}${anchor.trimStart()}`);
  },
  // 摘要失去交接样式后，长等待时会与占位同时可见。
  'append-not-replace': source => {
    assert.ok(source.includes('lx-process-summary flex'), '补丁锚点失效：找不到摘要样式');
    return source.replace('lx-process-summary flex', 'flex');
  },
  // 注回定位缺陷之一：去掉「该段仍在增长」判据 → 无条件替换最后一段（概览段被等待文案盖掉）
  'ignore-mode': source => {
    const anchor = 'return isGrowing && idle ? index : -1;';
    assert.ok(source.includes(anchor), '补丁锚点失效：找不到定位规则的返回语句');
    return source.replace(anchor, 'return idle ? index : -1;');
  },
  // 注回定位缺陷之二：去掉「段内无在跑步骤」判据 → 思考 token 还在流时也替换（「在动」被当成「在等」）
  'ignore-idle': source => {
    const anchor = 'return isGrowing && idle ? index : -1;';
    assert.ok(source.includes(anchor), '补丁锚点失效：找不到定位规则的返回语句');
    return source.replace(anchor, 'return isGrowing ? index : -1;');
  },
};

/** 只作用于判据模块的变异。 */
const PREDICATE_MUTATIONS: MutationTable = {
  'thinking-only': MUTATIONS['thinking-only']!,
};
/** 只作用于消息组件的变异。 */
const MESSAGE_ITEM_MUTATIONS: MutationTable = {
  'standalone-row': MUTATIONS['standalone-row']!,
  'ignore-mode': MUTATIONS['ignore-mode']!,
  'ignore-idle': MUTATIONS['ignore-idle']!,
};
/** 只作用于段组件的变异。 */
const SEGMENT_MUTATIONS: MutationTable = {
  'append-not-replace': MUTATIONS['append-not-replace']!,
};

const mutation = readMutationFlag();

let cachedPredicate: typeof import('../src/utils/awaitModelResponse') | null = null;
async function loadPredicate(): Promise<typeof import('../src/utils/awaitModelResponse')> {
  if (!cachedPredicate) {
    cachedPredicate = await importMutantModule<typeof import('../src/utils/awaitModelResponse')>(
      PREDICATE, mutation, PREDICATE_MUTATIONS);
  }
  return cachedPredicate;
}

test.after(() => {
  cleanupMutantTemp();
});

/** 正常窗口：工具已跑完、下一轮首个 token 未到。 */
function runningWindow(overrides: Partial<AwaitModelResponseState> = {}): AwaitModelResponseState {
  return {
    isThinking: true,
    content: '',
    processPartCount: 2,
    isTurnRunning: true,
    processIsOngoing: true,
    hasPendingTool: false,
    isComplete: false,
    failed: false,
    cancelled: false,
    isSuspended: false,
    hasModelRetry: false,
    ...overrides,
  };
}

test('空窗窗口内显示占位：实时思考态 + 过程区非空 + 正文为空', async () => {
  const {resolveAwaitModelResponse} = await loadPredicate();
  assert.equal(resolveAwaitModelResponse(runningWindow()), true, '工具跑完、下一轮 token 未到应显示占位');
  // 首轮探索期（过程区为空）走既有 chat.message.thinking，占位不得抢跑
  assert.equal(resolveAwaitModelResponse(runningWindow({processPartCount: 0})), false, '过程区为空时只能有思考占位');
});

test('工具仍在执行 / 待收尾时不显示「等待模型响应」', async () => {
  const {resolveAwaitModelResponse} = await loadPredicate();
  assert.equal(resolveAwaitModelResponse(runningWindow({hasPendingTool: true})), false, '工具执行中不得显示');
});

test('已有正文（含流式增量）时不显示', async () => {
  const {resolveAwaitModelResponse} = await loadPredicate();
  assert.equal(resolveAwaitModelResponse(runningWindow({content: '这是已经到达的正文'})), false,
    '正文已到（流式输出中）不得显示「等待模型响应」');
  assert.equal(resolveAwaitModelResponse(runningWindow({content: '  \n '})), true, '纯空白不算正文');
});

test('终态（完成 / 失败 / 取消 / 挂起）一律不显示', async () => {
  const {resolveAwaitModelResponse} = await loadPredicate();
  for (const patch of [
    {isComplete: true},
    {failed: true},
    {cancelled: true},
    {isSuspended: true},
    {isTurnRunning: false},
    {processIsOngoing: false},
  ]) {
    assert.equal(resolveAwaitModelResponse(runningWindow(patch)), false, `终态不得显示：${JSON.stringify(patch)}`);
  }
});

test('模型重试提示优先，不得叠加等待占位', async () => {
  const {resolveAwaitModelResponse} = await loadPredicate();
  assert.equal(resolveAwaitModelResponse(runningWindow({hasModelRetry: true})), false,
    '模型重试提示存在时只显示 ModelRetryNotice，不得叠加等待占位');
});

test('历史消息（isThinking 从未置位）不显示占位', async () => {
  const {resolveAwaitModelResponse} = await loadPredicate();
  const historical: AwaitModelResponseState = {
    isThinking: undefined,
    content: '',
    processPartCount: 3,
    isTurnRunning: false,
    processIsOngoing: false,
    hasPendingTool: false,
    isComplete: true,
    hasModelRetry: false,
  };
  assert.equal(resolveAwaitModelResponse(historical), false, '历史轮次不得冒出「正在等待模型响应」');
});

/** 模板 AST 节点（只声明本文件用到的字段）。 */
interface TemplateProp {
  type: number;
  name: string;
  arg?: {content?: string} | null;
  value?: {content: string} | null;
  exp?: {content: string} | null;
}

interface TemplateNode {
  type: number;
  tag?: string;
  props?: TemplateProp[];
  children?: TemplateNode[];
  content?: unknown;
}

interface LocatedNode {
  node: TemplateNode;
  ancestors: TemplateNode[];
  siblings: TemplateNode[];
  index: number;
}

/** 模板断言按文件取变异表：补丁只作用于它对应的文件，避免跨文件误打（会误报「锚点失效」）。 */
function templateMutationsFor(relativePath: string): MutationTable {
  if (relativePath === SEGMENT_COMPONENT) return SEGMENT_MUTATIONS;
  if (relativePath === MESSAGE_ITEM) return MESSAGE_ITEM_MUTATIONS;
  return {};
}

function attrValue(node: TemplateNode, name: string): string {
  const matched = (node.props ?? []).find(prop => prop.name === name && prop.type !== 7);
  return matched?.value?.content ?? '';
}

/** 读取 `v-if` / `v-show` / `v-for` 这类指令的表达式（AST 里指令的 name 不带 `v-` 前缀）。 */
function directiveValue(node: TemplateNode, name: string): string {
  const matched = (node.props ?? []).find(prop => prop.type === 7 && prop.name === name);
  return matched?.exp?.content ?? '';
}

function collect(node: TemplateNode, ancestors: TemplateNode[], found: LocatedNode[], matcher: (n: TemplateNode) => boolean): void {
  const siblings = node.children ?? [];
  siblings.forEach((child, index) => {
    if (matcher(child)) {
      found.push({node: child, ancestors, siblings, index});
    }
    collect(child, [...ancestors, child], found, matcher);
  });
}

function locate(nodes: TemplateNode[], matcher: (n: TemplateNode) => boolean): LocatedNode[] {
  const found: LocatedNode[] = [];
  for (const node of nodes) {
    collect(node, [], found, matcher);
  }
  return found;
}

/** 插值节点（`{{ ... }}`）里的表达式文本。 */
function interpolationExpression(node: TemplateNode): string {
  const holder = node.content as {content?: unknown} | undefined;
  return typeof holder?.content === 'string' ? holder.content : '';
}

function parseTemplate(relativePath: string): TemplateNode[] {
  const source = readMutantSource(relativePath, mutation, templateMutationsFor(relativePath));
  const parsed = parse(source, {filename: relativePath});
  assert.ok(parsed.descriptor.template, `${relativePath} 缺少 template 块`);
  return (parsed.descriptor.template!.ast as unknown as {children: TemplateNode[]}).children;
}

/**
 * 空窗窗口的真实回答：工具已跑完（无 pending/calling）、正文未到、轮次仍在跑。
 *
 * @returns 满足判据 7 条守卫的消息
 */
function awaitWindowMessage(): ChatMessage {
  return {
    id: 'await-window', role: 'assistant', turnId: '700', timestamp: 0, content: '',
    isComplete: false, isThinking: true, thoughtSteps: [],
    toolCalls: [{
      id: 'tool-1', responseId: '700', order: 1, toolName: AgentToolName.ExecuteCommand,
      status: 'success', query: JSON.stringify({command: 'npm test'}),
    }],
  };
}

/**
 * 三段并存的真实回答：段内有文本（构段），工具全部已定型，正文未到。
 *
 * @returns 三段过程 + content 为空的回答
 */
function multiAwaitWindowMessage(): ChatMessage {
  return {
    id: 'await-multi', role: 'assistant', turnId: '701', timestamp: 0, content: '',
    isComplete: false, isThinking: true, thoughtSteps: [],
    aiMessages: [
      {id: 'text:1', responseId: '701', order: 2, text: '第一段说明'},
      {id: 'text:2', responseId: '701', order: 4, text: '第二段说明'},
    ],
    toolCalls: [
      {id: 'tool-a', responseId: '701', order: 1, toolName: AgentToolName.ReadFile, status: 'success',
        args: {path: 'a.md'}},
      {id: 'tool-b', responseId: '701', order: 3, toolName: AgentToolName.EditFile, status: 'success',
        args: {path: 'b.md'}},
      {id: 'tool-c', responseId: '701', order: 5, toolName: AgentToolName.ExecuteCommand, status: 'success',
        query: JSON.stringify({command: 'npm test'})},
    ],
  };
}

/**
 * 挂载真实 ChatMessageItem（模板与段组件均按当前变异重写后的源码求值）。
 *
 * @param t 用例上下文
 * @param message 回答消息
 * @returns 内存根节点
 */
function mountMessageItem(t: unknown, message: ChatMessage): MemoryNode {
  const itemSource = readMutantSource(MESSAGE_ITEM, mutation, MESSAGE_ITEM_MUTATIONS);
  const segmentSource = readMutantSource(SEGMENT_COMPONENT, mutation, SEGMENT_MUTATIONS);
  const component = harness.componentFromSrc('components/chat/ChatMessageItem.vue', {
    compileId: 'await-model-response',
    sourceOverrides: [
      {test: /ChatMessageItem\.vue$/, source: itemSource},
      {test: /ChatProcessSegment\.vue$/, source: segmentSource},
    ],
  });
  return harness.mountComponent(t, component, {message: reactive(message), isDark: true, sessionId: '9'});
}

/** 某个元素的 class 是否含指定类名。 */
function hasClass(node: MemoryNode, className: string): boolean {
  return String(node.props.class ?? '').split(/\s+/).includes(className);
}

/** 取某个节点的完整文本。 */
function nodeText(node: MemoryNode): string {
  return node.text + node.children.map(nodeText).join('');
}

test('空窗提示与摘要共用原行，显示交接由 CSS 处理', async t => {
  const root = mountMessageItem(t, awaitWindowMessage());
  await nextTick();

  // 1. 独立插入的占位行必须不复存在（用户明确否掉的那个做法）
  const standalone = harness.findAll(root, node => node.props['data-testid'] === 'await-model-response');
  assert.equal(standalone.length, 0,
    '不得再出现 data-testid="await-model-response" 这类独立占位行');

  // 扫光只裁切实际文字，不能由父容器重新绘出溢出的预览。
  const placeholders = harness.findAll(root, node => node.props['data-testid'] === 'process-segment-await');
  assert.equal(placeholders.length, 1, `空窗期必须恰有一处行内占位，实际 ${placeholders.length} 处`);
  const placeholder = placeholders[0]!;
  assert.equal(nodeText(placeholder), '正在等待模型响应', '占位文案必须是「正在等待模型响应」');
  assert.ok(harness.find(placeholder, node => hasClass(node, 'lx-sweep-text')), '占位的文字节点必须使用扫光');
  const title = harness.find(root, node => node.props['data-testid'] === 'process-segment-title');
  assert.ok(title && hasClass(title, 'lx-sweep-text'), '延迟前保留标题自身的扫光');
  assert.equal(placeholder.props['role'], 'status', '占位必须带 role=status');

  // 摘要留在 DOM 中供延迟前展示，实际可见性由浏览器回归验证。
  const toggle = harness.find(root, node => node.props['data-testid'] === 'process-segment-toggle');
  assert.ok(toggle, '折叠箭头所在的标题行必须仍在（交互保留）');
  for (const testId of ['process-segment-title', 'process-segment-preview']) {
    assert.equal(harness.findAll(toggle!, node => node.props['data-testid'] === testId).length, 1,
      `延迟前必须保留当前 ${testId}`);
  }
  const chevron = harness.findAll(toggle!, node => node.tag === 'svg');
  assert.ok(chevron.length >= 1, '折叠箭头必须保留');
});

test('判据转假后标题行恢复显示 title / preview，占位消失', async t => {
  // 必须持有 reactive 代理本体：直接改原始对象不会触发渲染更新。
  const state = reactive(awaitWindowMessage());
  const root = mountMessageItem(t, state);
  await nextTick();
  assert.equal(harness.findAll(root, node => node.props['data-testid'] === 'process-segment-await').length, 1,
    '前置条件：进入空窗期必须先出现占位');
  const previousTitle = harness.find(root, node => node.props['data-testid'] === 'process-segment-title');
  const previousHeadline = harness.find(root, node => node.props['data-testid'] === 'process-segment-headline');

  // 下一轮 token 到达：正文非空 → 判据转假
  state.content = '模型开始说话了';
  await nextTick();

  assert.equal(harness.findAll(root, node => node.props['data-testid'] === 'process-segment-await').length, 0,
    '判据转假后占位必须立刻消失（不做残留动画）');
  const title = harness.find(root, node => node.props['data-testid'] === 'process-segment-title');
  assert.ok(title, '判据转假后标题行必须恢复渲染 title');
  assert.equal(title, previousTitle, '恢复活动不应重建标题');
  assert.equal(harness.find(root, node => node.props['data-testid'] === 'process-segment-headline'), previousHeadline,
    '恢复活动不应重启扫光容器');
  assert.equal(harness.findAll(root, node => node.props['data-testid'] === 'process-segment-preview').length, 1,
    '判据转假后标题行必须恢复渲染 preview（「执行命令 - intention」原样回来）');
  // 标题必须恢复成原来的命令文案，而不是残留占位文案。
  // 注意：此处标题可能带 lx-sweep-text —— 那是**过程段自身的持续扫光**（段仍在增长），
  // 与「空窗占位」是两件事，不能混为一谈。
  assert.notEqual(nodeText(title!), '正在等待模型响应', '标题必须恢复成原命令文案，不得残留占位文案');
  assert.ok(nodeText(title!).trim().length > 0, '恢复后的标题文案不得为空');
});

test('整组只有最后一段进入占位态：多段并存时不得每段都替换', async t => {
  const root = mountMessageItem(t, multiAwaitWindowMessage());
  await nextTick();

  const segments = harness.findAll(root, node => node.props['data-testid'] === 'process-segment');
  assert.equal(segments.length, 3, `必须先渲染出三段过程，实际 ${segments.length} 段`);
  const placeholders = harness.findAll(root, node => node.props['data-testid'] === 'process-segment-await');
  assert.equal(placeholders.length, 1, `整组只允许一处占位，实际 ${placeholders.length} 处`);
  const lastSegment = segments[2]!;
  assert.equal(harness.findAll(lastSegment, node => node === placeholders[0]).length, 1,
    '占位必须落在最后一个过程段上，不得挂在旧段');
  // 旧段照旧显示自己的 title（没有被占位抢走槽位）
  assert.equal(harness.findAll(segments[0]!, node => node.props['data-testid'] === 'process-segment-title').length, 1,
    '旧段标题必须照旧渲染，不得被占位替换');
});

/**
 * 最后一段已被后续 intermediate 文本收尾的回答：段内步骤全部定型、正文未到、轮次仍在跑。
 *
 * <p>此时整组仍处空窗判据为真（`isThinking` / 轮次运行 / 无待收尾工具 / 正文为空 / 过程段非空），
 * 但最后一段的 `mode` 已是 `summary` —— 它展示的是整段概览，不是「刚跑完那一行」。</p>
 *
 * @returns 最后一段为概览段的回答
 */
function closedTailMessage(): ChatMessage {
  return {
    id: 'await-closed-tail', role: 'assistant', turnId: '702', timestamp: 0, content: '',
    isComplete: false, isThinking: true, thoughtSteps: [],
    aiMessages: [{id: 'text:1', responseId: '702', order: 2, text: '这段已经收尾'}],
    toolCalls: [{
      id: 'tool-1', responseId: '702', order: 1, toolName: AgentToolName.EditFile,
      status: 'success', args: {path: 'C:\\project\\mcp.json'},
    }],
  };
}

/**
 * 最后一段内仍有 running 思考步骤的回答：正文未到、无工具在调、轮次仍在跑。
 *
 * @returns 段内「在动」的回答
 */
function runningStepMessage(): ChatMessage {
  return {
    id: 'await-running-step', role: 'assistant', turnId: '703', timestamp: 0, content: '',
    isComplete: false, isThinking: true,
    thoughtSteps: [{id: 'th1', order: 0, title: '思考', content: '正在推理细节', status: 'running'}],
    toolCalls: [],
  };
}

test('最后一段是 summary（已被后续文本收尾）时不替换：概览信息不得被等待文案盖掉', async t => {
  // 前置条件：空窗判据本身为真，否则本用例证明不了「定位规则」这一层
  const {resolveAwaitModelResponse} = await loadPredicate();
  assert.equal(resolveAwaitModelResponse({
    isThinking: true, content: '', processPartCount: 1, isTurnRunning: true, processIsOngoing: true,
    hasPendingTool: false, isComplete: false, hasModelRetry: false,
  }), true, '前置条件：空窗判据必须为真（本用例守的是定位规则，不是判据）');

  const root = mountMessageItem(t, closedTailMessage());
  await nextTick();

  const segments = harness.findAll(root, node => node.props['data-testid'] === 'process-segment');
  assert.equal(segments.length, 1, `必须先渲染出过程段，实际 ${segments.length} 段`);
  assert.equal(segments[0]!.props['data-process-mode'], 'summary',
    '前置条件：最后一段已被后续文本收尾，mode 必须是 summary');

  // 1. 概览段不得被替换：拿等待文案盖掉整段概览是丢信息，不是「那一行原地变成占位」
  assert.equal(harness.findAll(root, node => node.props['data-testid'] === 'process-segment-await').length, 0,
    '最后一段是概览段时不得出现 process-segment-await 占位');

  // 2. 该段标题与 preview 必须照常渲染（「执行命令 - intention」的概览信息还在）
  const title = harness.find(segments[0]!, node => node.props['data-testid'] === 'process-segment-title');
  assert.ok(title, '概览段必须照常渲染标题');
  assert.ok(nodeText(title!).trim().length > 0, '概览段标题不得为空');
  assert.notEqual(nodeText(title!), '正在等待模型响应', '概览段标题不得被等待文案盖掉');
  const preview = harness.find(segments[0]!, node => node.props['data-testid'] === 'process-segment-preview');
  assert.ok(preview, '概览段必须照常渲染 preview（概览信息没被吞掉）');
  assert.match(nodeText(preview!), /mcp\.json/, '概述目标必须照旧展示');
});

test('段内仍有在跑步骤时不替换：此刻是「在动」不是「在等」', async t => {
  // 前置条件：空窗判据为真（无待收尾工具、正文为空、轮次运行中）
  const {resolveAwaitModelResponse} = await loadPredicate();
  assert.equal(resolveAwaitModelResponse({
    isThinking: true, content: '', processPartCount: 1, isTurnRunning: true, processIsOngoing: true,
    hasPendingTool: false, isComplete: false, hasModelRetry: false,
  }), true, '前置条件：空窗判据必须为真（本用例守的是定位规则，不是判据）');

  const root = mountMessageItem(t, runningStepMessage());
  await nextTick();

  const segments = harness.findAll(root, node => node.props['data-testid'] === 'process-segment');
  assert.equal(segments.length, 1, `必须先渲染出过程段，实际 ${segments.length} 段`);
  assert.equal(segments[0]!.props['data-process-mode'], 'live', '段未收尾且整轮进行中，mode 是 live');

  // 思考 token 还在流 = 模型正在产出，语义上是「在动」不是「在等」：
  // 换成等待文案会把「正在推理」误报成「卡住了」，所以这里必须保留原样。
  assert.equal(harness.findAll(root, node => node.props['data-testid'] === 'process-segment-await').length, 0,
    '段内仍有 running 步骤时不得出现 process-segment-await 占位');

  // 标题行照常显示（最新一步），不得被替换成等待文案
  const title = harness.find(segments[0]!, node => node.props['data-testid'] === 'process-segment-title');
  assert.ok(title, '段内仍在跑时标题行必须照常显示');
  assert.equal(nodeText(title!), '思考', '纯思考段的标题必须保留「思考」，不得被等待文案盖掉');
});

test('模板契约：等待只创建静态节点，摘要与等待由同一槽位交接', () => {
  const itemBranch = parseTemplate(MESSAGE_ITEM);
  assert.equal(locate(itemBranch, node => attrValue(node, 'data-testid') === 'await-model-response').length, 0,
    'ChatMessageItem 模板里不得再出现 await-model-response 独立行');
  const segmentUsages = locate(itemBranch, node => node.tag === 'ChatProcessSegment');
  assert.equal(segmentUsages.length, 1, 'ChatMessageItem 必须渲染且只渲染一处 ChatProcessSegment');
  const awaitProp = (segmentUsages[0]!.node.props ?? [])
    .find(prop => prop.type === 7 && prop.name === 'bind' && prop.arg?.content === 'await-model');
  assert.equal(awaitProp?.exp?.content, 'partIndex === awaitModelSegmentIndex',
    '必须由「最后一段」下标驱动 awaitModel，整组只有一处');

  const segmentBranch = parseTemplate(SEGMENT_COMPONENT);
  const placeholders = locate(segmentBranch, node => attrValue(node, 'data-testid') === 'process-segment-await');
  assert.equal(placeholders.length, 1, '段组件里必须恰有一处行内占位');
  const placeholder = placeholders[0]!;
  const holder = placeholder.ancestors[placeholder.ancestors.length - 1]!;
  assert.match(attrValue(holder, 'class'), /\blx-process-headline\b/, '占位必须位于同一标题槽位');
  assert.equal(directiveValue(placeholder.node, 'if'), 'awaitModel', '占位必须只由 awaitModel 驱动');
  const className = attrValue(placeholder.node, 'class');
  assert.ok(!/\bbg-/.test(className), '占位不得新增背景块');
  assert.ok(!/\bmax-w-3xl\b/.test(className), '对话列宽度只能用既有 max-w-lx-chat');
  assert.ok(!/\b[wm][a-z]?-\[/.test(className), '占位不得写死宽度');

  const titleSlots = locate(segmentBranch, node => attrValue(node, 'data-testid') === 'process-segment-title');
  assert.equal(titleSlots.length, 1, '段组件里必须恰有一处 title 槽');
  const titleTemplate = titleSlots[0]!.ancestors[titleSlots[0]!.ancestors.length - 1]!;
  assert.match(attrValue(titleTemplate, 'class'), /\blx-process-summary\b/, '摘要必须具有延迟让位样式');
  assert.equal(titleSlots[0]!.ancestors[titleSlots[0]!.ancestors.length - 2], holder,
    '摘要和占位必须叠放在同一网格槽位');
});

test('过程区为空时的「思考中」占位仍留在折叠内容里，两条提示不并列', () => {
  const branch = parseTemplate(MESSAGE_ITEM);
  const thinking = locate(branch, node => interpolationExpression(node).includes('chat.message.thinking'));
  assert.equal(thinking.length, 1, '既有「思考中」占位必须唯一存在');
  const insideProcess = thinking[0]!.ancestors.some(ancestor =>
    attrValue(ancestor, 'data-testid') === 'whole-process-content');
  assert.ok(insideProcess, '「思考中」占位必须留在过程折叠内容里');
});

/** 执行一次必然失败的调用，返回失败消息文本（用于证明护栏确实拦得住）。 */
function captureFailure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

test('语法护栏：非法变异产物会被当场判为「自检无效」，不会冒充断言失败', () => {
  // 补丁多一个收尾大括号（历史假红的真实形态）：必须被解析护栏拦下
  assert.match(captureFailure(() => readMutantSource(PREDICATE, 'syntax-broken',
    {'syntax-broken': source => `${source}\n}\n`})), /补丁生成了非法代码，自检无效/,
  '非法 TS 变异产物必须当场判为自检无效');
  // 模板未闭合同样必须被拦下
  assert.match(captureFailure(() => readMutantSource(MESSAGE_ITEM, 'syntax-broken',
    {'syntax-broken': source => `${source}\n<div>`})), /补丁生成了非法代码，自检无效/,
  '非法模板变异产物同样必须当场判为自检无效');
});

test('变异名必须在变异表内（防止变异静默失效）', () => {
  if (!mutation) {
    return;
  }
  assert.ok(MUTATIONS[mutation], `未知变异: ${mutation}`);
});

test('占位判据把「轮次运行中」交给既有判据，不另起一套', () => {
  const source = readMutantSource(MESSAGE_ITEM, mutation, MESSAGE_ITEM_MUTATIONS);
  const call = source.indexOf('resolveAwaitModelResponse({');
  assert.ok(call >= 0, 'ChatMessageItem 必须调用 resolveAwaitModelResponse');
  const callBlock = source.slice(call, source.indexOf('}));', call));
  for (const field of ['isThinking', 'content', 'processPartCount', 'isTurnRunning', 'processIsOngoing',
    'hasPendingTool', 'isComplete', 'hasModelRetry']) {
    assert.ok(callBlock.includes(`${field}:`), `判据入参必须包含 ${field}`);
  }
  assert.ok(source.includes('isTurnRunning: isTurnRunning.value'), '轮次是否运行必须复用既有 isTurnRunning');
  assert.ok(source.includes('processIsOngoing: processIsOngoing.value'), '必须复用既有 processIsOngoing');
  assert.ok(source.includes('hasPendingTool: hasPendingTool(props.message.toolCalls)'), '必须复用既有 hasPendingTool');
});

test('占位文案中英双语齐全，且「执行中」死键已删除', async () => {
  const messagesSource = readMutantSource(MESSAGES_I18N, mutation, {});
  assert.ok(!messagesSource.includes('awaitModelResponseLabel'),
    'awaitModelResponseLabel（执行中）已不再使用，必须连同中英两份一起删除，不留死键');
  assert.equal(readMutantSource(MESSAGES_I18N, mutation, {}).split("awaitModelResponse:").length - 1, 2,
    'awaitModelResponse 必须中英各一份');
  setPreference('zh-CN');
  await nextTick();
  assert.equal(t('chat.message.awaitModelResponse'), '正在等待模型响应');
  setPreference('en-US');
  await nextTick();
  assert.equal(t('chat.message.awaitModelResponse'), 'Waiting for model response');
  setPreference('zh-CN');
  await nextTick();
});
