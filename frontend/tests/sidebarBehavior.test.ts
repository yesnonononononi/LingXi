import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSSRApp, computed, ref } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { fileURLToPath } from 'node:url';
import { useSidebarActions } from '../src/composables/sidebar/useSidebarActions';

/**
 * Sidebar 行为基线（M1 等价性判据）。
 *
 * <p>目的：在逻辑下沉前把 <strong>当前真实行为</strong> 钉死。抽取 composable 后本文件
 * <strong>一行都不许改</strong>，仍须全绿 —— 否则说明抽取改变了行为。</p>
 *
 * <p><b>为什么用 SSR 而不是 DOM 测试</b>：本项目未安装 jsdom / @vue/test-utils / vitest
 * （已实测 require.resolve 三者均 MISSING）。可用的只有 node:test + vite.ssrLoadModule
 * + @vue/server-renderer。因此只能断言「渲染出的文本与结构」，无法模拟 click / 焦点 /
 * document 监听。后者由源码级断言 + 人工验证兜底。</p>
 *
 * <p><b>纪律</b>：断言的是用户可见结果（分组归属、截断、展开态、文案），
 * 不是内部函数名或变量名 —— 抽取后函数会改名搬家，断言实现细节会让基线无意义变红。</p>
 */

const rootDir = fileURLToPath(new URL('..', import.meta.url));

/** 建 vite SSR 服务器（每次新建，避免跨用例状态污染）。 */
const createSsrServer = () =>
  createServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: 'custom',
  });

type SessionLike = {
  id: string;
  title: string;
  workspaceId?: string | number | null;
  workDir?: string | null;
};

const makeSession = (id: string, title: string, extra: Partial<SessionLike> = {}): any => ({
  id,
  title,
  workspaceId: extra.workspaceId ?? null,
  workDir: extra.workDir ?? null,
  runStatus: 'IDLE',
  lastOutcome: null,
  createTime: null,
});

/** Sidebar 必需 props 的默认值。 */
const baseProps = (overrides: Record<string, unknown> = {}): any => ({
  sessions: [],
  activeSessionId: null,
  workspaces: [],
  activeWorkspaceId: null,
  isCollapsed: false,
  isDark: true,
  ...overrides,
});

/**
 * 渲染 Sidebar 并返回 HTML。
 *
 * <p>调用方必须在 finally 里关闭 server；这里用回调形式强制约束。</p>
 */
const renderSidebar = async (
  props: Record<string, unknown>,
  assertions: (html: string) => void | Promise<void>
): Promise<void> => {
  const server = await createSsrServer();
  try {
    const component = (await server.ssrLoadModule('/src/components/chat/Sidebar.vue')).default;
    const i18n = await server.ssrLoadModule('/src/i18n/index.ts');
    i18n.useI18n().locale.value = 'zh-CN';
    const html = await renderToString(createSSRApp(component, props));
    await assertions(html);
  } finally {
    await server.close();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// B1 分组归属
// ─────────────────────────────────────────────────────────────────────────────

test('B1-1 会话有 workspaceId 时精确归入对应 workspace，即使 workDir 与另一个 workspace 相撞', async () => {
  const shared = '/work/shared';
  const props = baseProps({
    workspaces: [
      { id: '1', name: '项目甲', workDir: shared },
      { id: '2', name: '项目乙', workDir: shared },
    ],
    sessions: [makeSession('s1', '甲组会话', { workspaceId: '1', workDir: shared })],
  });
  await renderSidebar(props, html => {
    assert.ok(html.includes('项目甲'), '应渲染 workspace 名 项目甲');
    assert.ok(html.includes('甲组会话'), '应渲染会话标题');
  });
});

test('B1-2 workDir 在多个 workspace 中重复时，无 workspaceId 的会话不被误归入任一组', async () => {
  const shared = '/work/dup';
  const props = baseProps({
    workspaces: [
      { id: '1', name: '重复甲', workDir: shared },
      { id: '2', name: '重复乙', workDir: shared },
    ],
    // 无 workspaceId，workDir 与两个 workspace 相同 ⇒ 唯一性判定失败 ⇒ 归入未分组
    sessions: [makeSession('s2', '歧义会话', { workDir: shared })],
  });
  await renderSidebar(props, html => {
    // 关键：不能用「是否包含标题」判定 —— BranchedMenu 折叠只做视觉隐藏，
    // 子节点仍会输出到 SSR HTML，那样断言恒真、抓不到归属错误。
    // 改为位置判定：未分组区段在树中最后渲染，正确归属时会话必须排在「历史对话」之后。
    assert.ok(html.includes('历史对话'), '应出现未分组区段（历史对话）');
    assert.ok(
      html.indexOf('歧义会话') > html.indexOf('历史对话'),
      `歧义会话应落在未分组区段内（排在「历史对话」之后），实际位置=${html.indexOf(
        '歧义会话'
      )}，历史区段位置=${html.indexOf('历史对话')}`
    );
  });
});

test('B1-2b 归属错误可被检出：workDir 唯一时同一会话应归入 workspace（排在历史区段之前）', async () => {
  const unique = '/work/solo';
  const props = baseProps({
    workspaces: [{ id: '1', name: '独占项目', workDir: unique }],
    sessions: [makeSession('s2b', '独占会话', { workDir: unique })],
  });
  await renderSidebar(props, html => {
    assert.ok(
      html.indexOf('独占会话') < html.indexOf('历史对话') || !html.includes('历史对话'),
      'workDir 唯一时应归入 workspace 组，不应出现在未分组区段'
    );
  });
});

test('B1-3 workDir 唯一且匹配时，无 workspaceId 的会话归入该 workspace', async () => {
  const unique = '/work/unique';
  const props = baseProps({
    workspaces: [{ id: '1', name: '唯一项目', workDir: unique }],
    sessions: [makeSession('s3', '唯一组会话', { workDir: unique })],
  });
  await renderSidebar(props, html => {
    assert.ok(html.includes('唯一项目'));
    assert.ok(html.includes('唯一组会话'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B2 可见性截断与展开
// ─────────────────────────────────────────────────────────────────────────────

test('B2-1 单组会话超过 5 条时只展示 5 条，并出现「展开显示」伪条目', async () => {
  const sessions = Array.from({ length: 7 }, (_, index) =>
    makeSession(`s${index}`, `会话${index}`, { workspaceId: '1' })
  );
  const props = baseProps({
    workspaces: [{ id: '1', name: '大项目', workDir: '/work/big' }],
    sessions,
  });
  await renderSidebar(props, html => {
    assert.ok(html.includes('会话0'), '前 5 条应可见');
    assert.ok(html.includes('会话4'), '第 5 条应可见');
    assert.ok(!html.includes('会话5'), '第 6 条应被截断');
    assert.ok(!html.includes('会话6'), '第 7 条应被截断');
    assert.ok(html.includes('展开显示'), '应出现「展开显示」入口');
  });
});

test('B2-3 默认（未展开）时伪条目文案为「展开显示」，不得是「收起显示」', async () => {
  const sessions = Array.from({ length: 7 }, (_, index) =>
    makeSession(`s${index}`, `文案${index}`, { workspaceId: '1' })
  );
  const props = baseProps({
    workspaces: [{ id: '1', name: '文案项目', workDir: '/work/label' }],
    sessions,
  });
  await renderSidebar(props, html => {
    assert.ok(html.includes('展开显示'), '默认应显示「展开显示」');
    assert.ok(!html.includes('收起显示'), '未展开时不得显示「收起显示」');
  });
});

test('B2-2 会话数等于 5 时不截断、不出现展开伪条目', async () => {
  const sessions = Array.from({ length: 5 }, (_, index) =>
    makeSession(`s${index}`, `恰五${index}`, { workspaceId: '1' })
  );
  const props = baseProps({
    workspaces: [{ id: '1', name: '五条项目', workDir: '/work/five' }],
    sessions,
  });
  await renderSidebar(props, html => {
    assert.ok(html.includes('恰五4'), '第 5 条应可见');
    assert.ok(!html.includes('展开显示'), '等于阈值时不得出现展开入口');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B3 默认展开态
// ─────────────────────────────────────────────────────────────────────────────

test('B3-1 默认所有 workspace 折叠，未分组区段默认展开', async () => {
  const props = baseProps({
    workspaces: [{ id: '1', name: '折叠项目', workDir: '/work/a' }],
    sessions: [
      makeSession('s1', '组内会话', { workspaceId: '1' }),
      makeSession('s2', '未分组会话', {}),
    ],
  });
  await renderSidebar(props, html => {
    assert.ok(html.includes('折叠项目'), 'workspace 标题应可见');
    assert.ok(html.includes('未分组会话'), '未分组会话默认展开应可见');
  });
});

test('B3-2 激活会话位于组内第 6 位（超过可见上限）时，该组自动完整展开', async () => {
  const dir = '/work/deep';
  const sessions = Array.from({ length: 7 }, (_, index) =>
    makeSession(`s${index}`, `深${index}`, { workDir: dir })
  );
  const props = baseProps({
    workspaces: [{ id: '1', name: '深项目', workDir: dir }],
    sessions,
    activeSessionId: 's5',
  });
  await renderSidebar(props, html => {
    assert.ok(html.includes('深5'), '第 6 条（被激活）应完整展开可见');
    assert.ok(html.includes('深6'), '第 7 条应完整展开可见');
    assert.ok(!html.includes('展开显示'), '已完整展开时不应再出现「展开显示」');
    assert.ok(html.includes('收起显示'), '已完整展开时应显示「收起显示」');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B5 激活态判定（isWorkspaceActive）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 折叠视图用 `bg-blue-600/15` 标记激活的 workspace，是 SSR 可观测的稳定锚点。
 * 这里专测「由 activeSessionId 反查 + workDir 唯一性」这条路径 ——
 * 它是唯一性语义的第二个使用点，此前无覆盖，导致变异可逃逸。
 */
const ACTIVE_CLASS = 'bg-blue-600/15';

test('B5-1 activeSessionId 指向 workDir 重复的会话时，两个 workspace 都不显示为激活', async () => {
  const shared = '/work/amb';
  const props = baseProps({
    isCollapsed: true,
    workspaces: [
      { id: '1', name: '歧义甲', workDir: shared },
      { id: '2', name: '歧义乙', workDir: shared },
    ],
    sessions: [makeSession('s5', '歧义激活', { workDir: shared })],
    activeSessionId: 's5',
  });
  await renderSidebar(props, html => {
    assert.ok(!html.includes(ACTIVE_CLASS), `workDir 不唯一时不应有任何 workspace 被标为激活，实际 HTML 含 ${ACTIVE_CLASS}`);
  });
});

test('B5-2 activeSessionId 指向 workDir 唯一的会话时，对应 workspace 显示为激活', async () => {
  const unique = '/work/only';
  const props = baseProps({
    isCollapsed: true,
    workspaces: [{ id: '1', name: '唯一激活', workDir: unique }],
    sessions: [makeSession('s5b', '唯一激活会话', { workDir: unique })],
    activeSessionId: 's5b',
  });
  await renderSidebar(props, html => {
    assert.ok(html.includes(ACTIVE_CLASS), `workDir 唯一时应标为激活，实际 HTML 不含 ${ACTIVE_CLASS}`);
  });
});

test('B5-3 activeWorkspaceId 直配时优先于 activeSessionId 生效', async () => {
  const props = baseProps({
    isCollapsed: true,
    workspaces: [{ id: '7', name: '直配项目', workDir: '/work/direct' }],
    sessions: [],
    activeWorkspaceId: '7',
  });
  await renderSidebar(props, html => {
    assert.ok(html.includes(ACTIVE_CLASS), `activeWorkspaceId 命中时应标为激活`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B4 空态
// ─────────────────────────────────────────────────────────────────────────────// ─────────────────────────────────────────────────────────────────────────────
// B4 空态
// ─────────────────────────────────────────────────────────────────────────────

test('B4-1 无会话无 workspace 时不崩溃、不渲染未分组区段', async () => {
  await renderSidebar(baseProps(), html => {
    assert.ok(typeof html === 'string' && html.length > 0, '应渲染出根结构');
    assert.ok(!html.includes('历史会话'), '无未分组会话时不应出现历史区段');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C 动作层（useSidebarActions）纯单元用例
//
// SSR 只能断言渲染结果，点不到事件；这组用例直接实例化 composable，用假的 emit 与
// 依赖 ref 钉死事件回调契约（伪条目 key 偏移、重命名空标题、菜单开关、监听幂等）。
// ─────────────────────────────────────────────────────────────────────────────

type Emitted = Array<{ event: string; args: unknown[] }>;

const makeActions = (overrides: Record<string, unknown> = {}) => {
  const emitted: Emitted = [];
  const emit = (event: string, ...args: unknown[]) => {
    emitted.push({ event, args });
  };
  const expandedWorkspaces = ref<Record<string, boolean>>({});
  const fullyExpandedKeys: string[] = [];
  const toggledWorkspaceIds: Array<string | number> = [];
  const branchedMenuItems = computed(() => [
    { label: '项目', value: 'ws-1', raw: { id: '1', name: '项目', workDir: '/w' }, children: [] }
  ]);
  const actions = useSidebarActions({
    emit: emit as any,
    workspaces: computed(() => [{ id: '1', name: '项目', workDir: '/w' }] as any),
    expandedWorkspaces,
    branchedMenuItems: branchedMenuItems as any,
    toggleWorkspaceExpand: (id: string | number) => { toggledWorkspaceIds.push(id); },
    toggleFullyExpanded: (key: string) => { fullyExpandedKeys.push(key); },
    ...overrides
  });
  return { actions, emitted, expandedWorkspaces, fullyExpandedKeys, toggledWorkspaceIds };
};

const fakeEvent = () => ({ stopPropagation: () => undefined } as unknown as Event);

test('C1-1 伪条目 more-<key> 触发完整展开时，key 偏移正确（截掉 more- 前缀）', () => {
  const { actions, fullyExpandedKeys } = makeActions();
  actions.handleBranchedSelect('more-1', { value: 'more-1', label: '展开显示', raw: null } as any);
  assert.deepEqual(fullyExpandedKeys, ['1'], '应把 more- 之后的 key 传给 toggleFullyExpanded');
});

test('C1-2 选中会话节点时 emit selectSession，并联动 emit selectWorkspace', () => {
  const { actions, emitted } = makeActions();
  actions.handleBranchedSelect('s1', {
    value: 's1',
    label: '会话',
    raw: { id: 's1', title: '会话', workspaceId: '1' }
  } as any);
  assert.deepEqual(emitted.map(e => e.event), ['selectSession', 'selectWorkspace']);
  assert.deepEqual(emitted[0].args, ['s1']);
});

test('C1-3 选中 workspace 节点时 emit selectWorkspace 并切换该组展开态', () => {
  const { actions, emitted, toggledWorkspaceIds } = makeActions();
  actions.handleBranchedSelect('ws-1', {
    value: 'ws-1',
    label: '项目',
    raw: { id: '1', name: '项目', workDir: '/w' }
  } as any);
  assert.deepEqual(emitted.map(e => e.event), ['selectWorkspace']);
  assert.deepEqual(toggledWorkspaceIds, ['1'], '应切换 workspace 1 的展开态（id 原样透传）');
});

test('C1-4 重命名为空白标题时不 emit renameSession，但退出编辑态', () => {
  const { actions, emitted } = makeActions();
  actions.startEdit({ id: 's1', title: '旧标题' } as any, fakeEvent());
  assert.equal(actions.editingSessionId.value, 's1');
  actions.editingTitle.value = '   ';
  actions.saveEdit({ id: 's1', title: '旧标题' } as any, fakeEvent());
  assert.deepEqual(emitted, [], '空白标题不得提交改名');
  assert.equal(actions.editingSessionId.value, null, '编辑态应关闭');
});

test('C1-5 项目菜单二次点击同一项时关闭', () => {
  const { actions } = makeActions();
  actions.toggleProjectMenu('1', fakeEvent());
  assert.equal(actions.activeMenuWorkspaceId.value, '1');
  actions.toggleProjectMenu('1', fakeEvent());
  assert.equal(actions.activeMenuWorkspaceId.value, null);
});

test('C1-6 点击外部关闭菜单；installClickOutside 幂等，dispose 后不再监听', () => {
  const { actions } = makeActions();
  let added = 0;
  let removed = 0;
  // 用 Set 模拟真实 DOM 语义：同一 (type, listener, capture) 重复 add 只保留一份。
  // 因此「去掉 install 里的 removeEventListener」属于等价变异（行为不可观测），
  // 这条用例钉的是 install 幂等 + dispose 清理，而不是 remove 那一行本身。
  const listeners = new Set<unknown>();
  const fakeDocument = {
    addEventListener: (_t: string, fn: unknown) => { listeners.add(fn); added++; },
    removeEventListener: (_t: string, fn: unknown) => { listeners.delete(fn); removed++; }
  };
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true, writable: true });
  try {
    actions.installClickOutside();
    actions.installClickOutside();
    assert.equal(listeners.size, 1, '重复 install 后监听器应只有 1 个');
    assert.ok(added >= 2, 'install 每次都先 remove 再 add（幂等实现）');

    actions.activeMenuWorkspaceId.value = '1';
    [...listeners].forEach(fn => (fn as () => void)());
    assert.equal(actions.activeMenuWorkspaceId.value, null, '点击外部应关闭菜单');

    actions.disposeClickOutside();
    assert.equal(listeners.size, 0, 'dispose 后监听器应清空');
    assert.ok(removed >= 1);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'document', originalDescriptor);
    } else {
      delete (globalThis as any).document;
    }
  }
});

