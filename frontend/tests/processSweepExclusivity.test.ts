import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {nextTick, reactive} from 'vue';
import {parse} from 'vue/compiler-sfc';
import {buildProcessSegments} from '../src/utils/processSegments';
import type {ProcessDerivedView, ProcessSegmentView} from '../src/utils/processViewModel';
import {buildProcessTimeline} from '../src/utils/processTimeline';
import {AgentToolName} from '../src/utils/toolNames';
import type {ChatMessage} from '../src/types/chat';
import {
  cleanupMutantTemp,
  importMutantModuleWithDeps,
  readMutantSource,
  readMutationFlag,
  type MutationTable,
} from './support/mutantSource';

/**
 * 缺陷回归：同一回答里**只能有一处**过程段扫光。
 *
 * <p>缺陷链路：段级 `mode` 被各段独立判定（旧段只要段内还有 running/pending 就仍是 live），
 * 而扫光直接绑在 `mode === 'live'` 上 —— 于是「三段并存」时三处一起扫光。修法是语义分离：
 * `mode` 保留每段真实状态，新增**回答级**的唯一扫光位（最后一个 live 段）。</p>
 *
 * <p>三层断言缺一不可：视图层（真实 build/derive 装配）、组件层（真实 ChatMessageItem 挂载后数
 * 扫光节点）、渲染层源码（绑定只认 sweep，防止回潮）。</p>
 */

const requireCjs = createRequire(import.meta.url);
/** 真实 SFC 挂载 harness（内存 renderer + 唯一 stub 清单）。 */
const harness = requireCjs('./support/chatProcessHarness.cjs') as {
  componentFromSrc: (relative: string, options?: {compileId?: string}) => unknown;
  mountComponent: (t: unknown, component: unknown, props: Record<string, unknown>) => MemoryNode;
  findAll: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode[];
};

interface MemoryNode {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: MemoryNode[];
}

const VIEW_MODEL = 'src/utils/processViewModel.ts';
const SEGMENT_COMPONENT = 'src/components/chat/ChatProcessSegment.vue';
const MESSAGE_ITEM = 'src/components/chat/ChatMessageItem.vue';

const MUTATIONS: MutationTable = {
  // 注回原始缺陷：每段各自 live 就各自扫光（回到「多段同时扫光」）
  'per-segment-sweep': source => {
    assert.ok(source.includes("sweep: false,"), '补丁锚点失效：找不到 sweep 初始值');
    const perSegment = source.replace("sweep: false,", "sweep: mode === 'live',");
    const withoutSelection = perSegment.replace(/if \(liveIndex >= 0\) \{[\s\S]*?\n {2}\}/,
      'void liveIndex;');
    assert.notEqual(withoutSelection, perSegment, '补丁锚点失效：找不到唯一扫光位选择块');
    return withoutSelection;
  },
  // 注回「选错了段」：把扫光位定成第一个 live 段而不是最后一个
  'first-live-sweep': source => {
    assert.ok(source.includes('if (mode === \'live\') liveIndex = views.length;'),
      '补丁锚点失效：找不到扫光位选择语句');
    return source.replace('if (mode === \'live\') liveIndex = views.length;',
      'if (mode === \'live\' && liveIndex < 0) liveIndex = views.length;');
  },
  // 注回渲染层缺陷：扫光重新直接绑 mode（绕过回答级 sweep）
  'sweep-from-mode': source => {
    assert.ok(source.includes(":class=\"{ 'lx-sweep-text': sweep }\""), '补丁锚点失效：找不到 sweep 绑定');
    return source.replace(":class=\"{ 'lx-sweep-text': sweep }\"", ":class=\"{ 'lx-sweep-text': mode === 'live' }\"");
  },
};

/** 各文件适用的变异集合（其余变异名按正常源码返回）。 */
const VIEW_MODEL_MUTATIONS: MutationTable = {
  'per-segment-sweep': MUTATIONS['per-segment-sweep']!,
  'first-live-sweep': MUTATIONS['first-live-sweep']!,
};
const SEGMENT_MUTATIONS: MutationTable = {
  'sweep-from-mode': MUTATIONS['sweep-from-mode']!,
};
const MESSAGE_ITEM_MUTATIONS: MutationTable = {};

const mutation = readMutationFlag();

/** 层二模块：**必须**经变异加载器载入，否则改视图裁决的变异根本不会生效。 */
let viewModelCache: typeof import('../src/utils/processViewModel') | null = null;
async function loadViewModel(): Promise<typeof import('../src/utils/processViewModel')> {
  if (!viewModelCache) {
    viewModelCache = await importMutantModuleWithDeps<typeof import('../src/utils/processViewModel')>(
      VIEW_MODEL, mutation, VIEW_MODEL_MUTATIONS);
  }
  return viewModelCache;
}

test.after(() => {
  cleanupMutantTemp();
});

test('变异名必须在变异表内（防止变异静默失效）', () => {
  if (!mutation) {
    return;
  }
  assert.ok(MUTATIONS[mutation], `未知变异: ${mutation}`);
});

test('语法护栏：非法变异产物会被当场判为自检无效', () => {
  const message = captureFailure(() => readMutantSource(VIEW_MODEL, 'syntax-broken',
    {'syntax-broken': source => `${source}\n}\n`}));
  assert.match(message, /补丁生成了非法代码，自检无效/, '非法变异产物必须当场判为自检无效');
});

/** 执行一次必然失败的调用，返回失败消息文本。 */
function captureFailure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

/**
 * 「三段并存」的真实回答：前两段已被后续文本收尾但段内有调用中的工具，第三段仍在增长。
 *
 * @returns 真实 ChatMessage（组件层与视图层共用同一份事实）
 */
function threeLiveSegmentsMessage(): ChatMessage {
  return {
    id: 'answer-sweep', role: 'assistant', turnId: '900', timestamp: 0, content: '',
    isComplete: false, isThinking: true,
    aiMessages: [
      { id: 'text:1', responseId: '900', order: 2, text: '第一段说明' },
      { id: 'text:2', responseId: '900', order: 4, text: '第二段说明' },
    ],
    thoughtSteps: [],
    toolCalls: [
      { id: 'tool-a', responseId: '900', order: 1, toolName: AgentToolName.ReadFile, status: 'calling',
        args: { path: 'a.md' } },
      { id: 'tool-b', responseId: '900', order: 3, toolName: AgentToolName.EditFile, status: 'calling',
        args: { path: 'b.md' } },
      { id: 'tool-c', responseId: '900', order: 5, toolName: AgentToolName.ExecuteCommand, status: 'calling',
        query: JSON.stringify({ command: 'npm test' }) },
    ],
  };
}

/** 真实装配：时间线 → 分段 → 摘要 → 视图（分段/摘要走生产实现，层二经变异加载器）。 */
async function deriveRealViews(message: ChatMessage, ongoing: boolean): Promise<ProcessDerivedView> {
  const viewModel = await loadViewModel();
  const parts = buildProcessSegments(buildProcessTimeline(message), [], undefined);
  const summaries = viewModel.deriveProcessSummaries(parts, []);
  return viewModel.deriveProcessViews(parts, summaries, ongoing);
}

/** 只取过程段视图。 */
function segmentViews(derived: ProcessDerivedView): ProcessSegmentView[] {
  return derived.parts.filter((part): part is ProcessSegmentView => part.kind === 'segment');
}

test('三段并存：扫光恰好 1 处，且落在最后一个 live 段', async () => {
  const views = segmentViews(await deriveRealViews(threeLiveSegmentsMessage(), true));
  assert.equal(views.length, 3, '必须先复现出三段并存，否则后续断言无意义');
  assert.deepEqual(views.map(view => view.mode), ['live', 'live', 'live'],
    '三段的真实状态都是 live（前两段已 closed 但段内仍有调用中的工具）');
  const swept = views.filter(view => view.sweep);
  assert.equal(swept.length, 1, `同一回答只允许一处扫光，实际 ${swept.length} 处`);
  assert.equal(views[2]!.sweep, true, '扫光必须落在最后一个 live 段（当前仍在增长的那一段）');
  assert.equal(views[0]!.sweep, false, '已被收尾的旧段不得扫光');
  assert.equal(views[1]!.sweep, false, '已被收尾的旧段不得扫光');
});

test('mode 仍按原规则独立判定，不为消灭扫光而降级', async () => {
  const views = segmentViews(await deriveRealViews(threeLiveSegmentsMessage(), true));
  // 已收尾 + 段内仍有 running → 仍必须是 live（「最新一步」文案依赖它）
  assert.equal(views[0]!.mode, 'live', '旧段段内仍有 running 时 mode 必须是 live，不得为省扫光而降级');
  assert.equal(views[1]!.mode, 'live', '同上');
  assert.equal(views[2]!.mode, 'live', '未收尾且轮次进行中必须是 live');
  // mode 与 sweep 是两个事实：live 段未必扫光，扫光段必然是 live
  assert.equal(views.filter(view => view.mode === 'live').length, 3, 'live 段数量不受扫光互斥影响');
  assert.equal(views.filter(view => view.sweep).every(view => view.mode === 'live'), true,
    '扫光只能出现在 live 段上');
});

test('没有任何 live 段时不扫光（静止状态不放动画）', async () => {
  // 1) 轮次已结束：残留 running 只是陈旧事实，全部段变 summary
  const finished = segmentViews(await deriveRealViews(threeLiveSegmentsMessage(), false));
  assert.deepEqual(finished.map(view => view.mode), ['summary', 'summary', 'summary'], '轮次结束后全部段为概览');
  assert.equal(finished.filter(view => view.sweep).length, 0, '没有 live 段时不得扫最后一段凑数');

  // 2) 轮次仍在跑，但所有段都收尾且步骤全定型：全部 summary
  const settled: ChatMessage = {
    ...threeLiveSegmentsMessage(),
    aiMessages: [
      { id: 'text:1', responseId: '900', order: 2, text: '第一段说明' },
      { id: 'text:2', responseId: '900', order: 4, text: '第二段说明' },
      { id: 'text:3', responseId: '900', order: 6, text: '第三段说明' },
    ],
    toolCalls: [
      { id: 'tool-a', responseId: '900', order: 1, toolName: AgentToolName.ReadFile, status: 'success',
        args: { path: 'a.md' } },
      { id: 'tool-b', responseId: '900', order: 3, toolName: AgentToolName.EditFile, status: 'success',
        args: { path: 'b.md' } },
      { id: 'tool-c', responseId: '900', order: 5, toolName: AgentToolName.ExecuteCommand, status: 'success',
        query: JSON.stringify({ command: 'npm test' }) },
    ],
  };
  const stillRunning = segmentViews(await deriveRealViews(settled, true));
  assert.deepEqual(stillRunning.map(view => view.mode), ['summary', 'summary', 'summary'],
    '步骤全定型且全部收尾后三段都是概览');
  assert.equal(stillRunning.filter(view => view.sweep).length, 0, '静止状态一个扫光都不许有');
});

test('真实组件渲染：扫光节点恰好 1 个，且只在最后一个 live 段的标题上', async t => {
  const component = harness.componentFromSrc('components/chat/ChatMessageItem.vue',
    {compileId: 'process-sweep-exclusivity'});
  const message = reactive(threeLiveSegmentsMessage());
  const root = harness.mountComponent(t, component, {message, isDark: true, sessionId: '7'});
  await nextTick();

  const sections = harness.findAll(root, node => node.props['data-testid'] === 'process-segment');
  assert.equal(sections.length, 3, `必须真实渲染出三段过程段，实际 ${sections.length}`);
  assert.deepEqual(sections.map(section => section.props['data-process-mode']), ['live', 'live', 'live'],
    '三段真实状态都是 live');

  const sweptTitles = harness.findAll(root, node =>
    node.props['data-testid'] === 'process-segment-headline'
    && String(node.props.class ?? '').split(/\s+/).includes('lx-sweep-text'));
  assert.equal(sweptTitles.length, 1, `同一回答里只允许一个扫光标题，实际 ${sweptTitles.length} 个`);
  const lastSection = sections[2]!;
  assert.equal(harness.findAll(lastSection, node => node === sweptTitles[0]).length, 1,
    '扫光标题必须落在最后一个 live 段内');

  // 轮次收尾后：无 live 段 → 一个扫光都不剩（静止状态不放动画）
  message.isComplete = true;
  message.isThinking = false;
  await nextTick();
  const sweptAfterFinish = harness.findAll(root, node =>
    node.props['data-testid'] === 'process-segment-headline'
    && String(node.props.class ?? '').split(/\s+/).includes('lx-sweep-text'));
  assert.equal(sweptAfterFinish.length, 0, '轮次结束后不得残留扫光');
});

test('渲染层只认 sweep：lx-sweep-text 不得再绑 mode', () => {
  const source = readMutantSource(SEGMENT_COMPONENT, mutation, SEGMENT_MUTATIONS);
  assert.ok(/sweep\??:\s*boolean/.test(source), 'ChatProcessSegment 必须声明 sweep prop');
  const parsed = parse(source, {filename: SEGMENT_COMPONENT});
  const ast = parsed.descriptor.template!.ast as unknown as {children: AstNode[]};
  const sweepBindings: string[] = [];
  walk(ast.children, node => {
    const expression = classBindingExpression(node);
    if (expression.includes('lx-sweep-text')) {
      sweepBindings.push(expression);
    }
  });
  assert.equal(sweepBindings.length, 1,
    `lx-sweep-text 只允许出现在一处 class 绑定上，实际 ${sweepBindings.length} 处`);
  assert.equal(sweepBindings[0], "{ 'lx-sweep-text': sweep }", '扫光必须只由回答级 sweep 驱动');
  assert.ok(!sweepBindings[0]!.includes('mode'),
    '扫光不得再直接读 mode（那正是多段同时扫光的成因）');
});

/** 读取节点的 `:class` 绑定表达式（`v-bind:class` 在 AST 里是 name=bind + arg=class）。 */
function classBindingExpression(node: AstNode): string {
  const binding = (node.props ?? []).find(prop => prop.type === 7
    && prop.name === 'bind' && prop.arg?.content === 'class');
  return String(binding?.exp?.content ?? '');
}

test('ChatMessageItem 把回答级 sweep 传给每个段', () => {
  const source = readMutantSource(MESSAGE_ITEM, mutation, MESSAGE_ITEM_MUTATIONS);
  assert.ok(source.includes(':sweep="part.sweep"'), 'ChatMessageItem 必须把 part.sweep 传进段组件');
});

/** 模板 AST 节点（只声明本文件用到的字段）。 */
interface AstNode {
  tag?: string;
  props?: Array<{
    type: number;
    name: string;
    arg?: {content?: string} | null;
    exp?: {content?: string} | null;
    value?: {content?: string} | null;
  }>;
  children?: AstNode[];
}

/** 深度遍历模板 AST 的模板节点。 */
function walk(nodes: AstNode[], visit: (node: AstNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.children?.length) {
      walk(node.children, visit);
    }
  }
}
