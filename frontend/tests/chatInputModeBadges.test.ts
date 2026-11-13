import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {h, nextTick} from 'vue';

/**
 * 输入行「意图徽标」的守护用例（真实组件挂载）。
 *
 * <p>需求现场（2026-11-13）：协作模式选中团队后，输入框左侧只有一个橙色 `/plan` 徽标，
 * 用户看不到本轮到底跑在哪个团队里。这里盯住三件事：</p>
 * <ol>
 *   <li>选中团队 → 输入行出现团队徽标，文案是团队名；</li>
 *   <li>`/plan` 与团队徽标**同一套蓝色底色**，不许再出现琥珀色（两套颜色等于让用户记颜色含义）；</li>
 *   <li>点徽标上的 × → `updateTeam(null)`，只退协作、不动模式。</li>
 * </ol>
 *
 * <p>为什么用组件挂载而不是源码字符串匹配：徽标的可见条件是「有 selectedTeamId 且能解析出团队名」，
 * 只匹配 class 串的话，把 `v-if` 写错也照样绿。等价变异（改颜色但漏改一个徽标）同样只有渲染结果能抓。</p>
 */

const requireCjs = createRequire(import.meta.url);

interface MemoryNode {
  tag: string;
  text: string;
  props: Record<string, unknown>;
  children: MemoryNode[];
}

interface HarnessOptions {
  compileId?: string;
  extraStubs?: RegExp[];
  moduleStubs?: Array<{test: RegExp; exports: Record<string, unknown>}>;
}

const harness = requireCjs('./support/chatProcessHarness.cjs') as {
  componentFromSrc: (relative: string, options?: HarnessOptions) => unknown;
  mountComponent: (t: unknown, component: unknown, props: Record<string, unknown>) => MemoryNode;
  find: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode | undefined;
  findAll: (node: MemoryNode, predicate: (node: MemoryNode) => boolean) => MemoryNode[];
};

const text = (node: MemoryNode): string => node.text + node.children.map(text).join('');
const classOf = (node: MemoryNode): string => String(node.props.class ?? '');

type DomStubScope = {
  document?: unknown;
  URL?: unknown;
  localStorage?: unknown;
  Document?: unknown;
  ShadowRoot?: unknown;
};
const domStubScope = globalThis as unknown as DomStubScope;
const previousDomStubs: DomStubScope = {
  document: domStubScope.document,
  URL: domStubScope.URL,
  localStorage: domStubScope.localStorage,
  Document: domStubScope.Document,
  ShadowRoot: domStubScope.ShadowRoot,
};
domStubScope.document = {addEventListener() {}, removeEventListener() {}};
domStubScope.URL = {createObjectURL: () => 'blob:stub', revokeObjectURL() {}};
domStubScope.localStorage = {getItem: () => null, setItem() {}, removeItem() {}};
// Vue 3.5 的 v-model 指令会做 `rootNode instanceof Document`，Node 里没有这两个构造器。
domStubScope.Document = class DocumentStub {};
domStubScope.ShadowRoot = class ShadowRootStub {};

test.after(() => {
  for (const key of Object.keys(previousDomStubs) as Array<keyof DomStubScope>) {
    if (previousDomStubs[key] === undefined) delete domStubScope[key];
    else domStubScope[key] = previousDomStubs[key];
  }
});

const TEAM = {id: 7, name: '阿尔法小队', agents: []};

/** 挂载真实 ChatInputArea：子组件与服务层全部走桩，本用例只看徽标。 */
function mountInputArea(t: unknown, props: Record<string, unknown> = {}): MemoryNode {
  const component = harness.componentFromSrc('components/chat/ChatInputArea.vue', {
    compileId: 'chat-input-mode-badges',
    extraStubs: [/ChatInputModelSelector\.vue$/, /ChatInputContextUsage\.vue$/],
    moduleStubs: [
      {
        test: /ChatInputSendButton\.vue$/,
        exports: {
          __esModule: true,
          default: {
            props: ['isSending', 'armed', 'isDark', 'colors', 'onSend'],
            setup: () => () => h('button', {type: 'button', 'data-testid': 'chat-send-button'}),
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
  });
  return harness.mountComponent(t, component, {isDark: false, hasActiveSession: true, teams: [TEAM], ...props});
}

const byTestId = (root: MemoryNode, id: string): MemoryNode | undefined =>
  harness.find(root, node => node.props['data-testid'] === id);

/** 点击带 `.stop` 修饰符的元素：事件对象要能 stopPropagation。 */
function click(node: MemoryNode): void {
  const handler = node.props.onClick as ((event: unknown) => void) | undefined;
  assert.ok(typeof handler === 'function', '节点上没有点击处理器（徽标交互被拆掉了？）');
  handler.call(node, {stopPropagation() {}, preventDefault() {}});
}

test('选中团队：输入行出现团队徽标，文案是团队名', async t => {
  const root = mountInputArea(t, {selectedTeamId: 7});
  await nextTick();
  const badge = byTestId(root, 'chat-input-team-badge');
  assert.ok(badge, '选中团队后必须出现协作徽标');
  assert.ok(text(badge!).includes(TEAM.name), `协作徽标必须显示团队名，实际「${text(badge!)}」`);
});

test('未选团队：不渲染协作徽标（不靠占位文案撑场面）', async t => {
  const root = mountInputArea(t, {selectedTeamId: null});
  await nextTick();
  assert.equal(byTestId(root, 'chat-input-team-badge'), undefined, '没选团队就不该有协作徽标');
});

test('/plan 与团队徽标同一套蓝色底色，且都不再是琥珀色', async t => {
  const root = mountInputArea(t, {selectedTeamId: 7, mode: 'plan'});
  await nextTick();

  const planBadge = byTestId(root, 'chat-input-plan-badge');
  assert.ok(planBadge, 'plan 模式必须有 /plan 徽标');
  const teamBadge = byTestId(root, 'chat-input-team-badge');
  assert.ok(teamBadge, '协作模式必须有团队徽标');

  for (const [name, node] of [['/plan', planBadge!], ['团队', teamBadge!]] as const) {
    const cls = classOf(node);
    assert.ok(cls.includes('bg-blue-500/15'), `${name} 徽标底色必须是蓝色，实际「${cls}」`);
    assert.ok(!cls.includes('amber'), `${name} 徽标不得残留琥珀色，实际「${cls}」`);
  }
});

test('点协作徽标的 × 只退协作：updateTeam(null)，模式不动', async t => {
  const updates: unknown[] = [];
  const modeUpdates: unknown[] = [];
  const root = mountInputArea(t, {
    selectedTeamId: 7,
    mode: 'plan',
    onUpdateTeam: (value: unknown) => { updates.push(value); },
    onUpdateMode: (value: unknown) => { modeUpdates.push(value); },
  });
  await nextTick();

  const badge = byTestId(root, 'chat-input-team-badge');
  assert.ok(badge, '协作徽标没渲染出来');
  const exitButton = harness.find(badge!, node => typeof node.props.onClick === 'function'
    && String(node.props.title ?? '').includes('退出协作模式'));
  assert.ok(exitButton, '协作徽标上找不到 × 退出按钮（title 文案变了请同步本用例）');

  click(exitButton!);
  await nextTick();
  assert.deepEqual(updates, [null], `× 必须派发 updateTeam(null)，实际 ${JSON.stringify(updates)}`);
  assert.deepEqual(modeUpdates, [], '退出协作不得顺手改模式');
});
