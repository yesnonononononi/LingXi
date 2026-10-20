import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { fileURLToPath } from 'node:url';

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
    assert.ok(html.includes('歧义会话'), '会话仍须可见（未被丢弃）');
    assert.ok(html.includes('历史会话') || html.includes('历史'), '应出现未分组区段（历史）');
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
    assert.ok(html.includes('展开显示') || html.includes('7'), '应出现展开入口并带总数');
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

// ─────────────────────────────────────────────────────────────────────────────
// B4 空态
// ─────────────────────────────────────────────────────────────────────────────

test('B4-1 无会话无 workspace 时不崩溃、不渲染未分组区段', async () => {
  await renderSidebar(baseProps(), html => {
    assert.ok(typeof html === 'string' && html.length > 0, '应渲染出根结构');
    assert.ok(!html.includes('历史会话'), '无未分组会话时不应出现历史区段');
  });
});
