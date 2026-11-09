import test from 'node:test';
import assert from 'node:assert/strict';
import {computed, createSSRApp, ref, type Ref} from 'vue';
import {renderToString} from '@vue/server-renderer';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {useSessionBranchExpansion} from '../src/composables/sidebar/useSessionBranchExpansion';
import type {ChatSession} from '../src/types/chat';

/**
 * 侧边栏「会话 → 子代理分支」展开态回归守卫。
 *
 * <p><b>钉住的用户可见契约：</b>一打开侧边栏，会话行下面的子代理分支必须是**折叠**的（默认折叠），
 * 只有「当前正在看的那个分支」自动展开；用户手动点开/收起要生效，且不会被激活态反复弹回。
 * 旧实现把状态记成「折叠集合」（默认不在集合 ⇒ 默认展开），是这次返工的直接原因。</p>
 *
 * <p>两层断言：① composable 单元（语义、覆盖优先级、切换激活后的回落）；② SSR 真实渲染 Sidebar
 * （亮色列表分支 + 暗色 BranchedMenu 分支），证明模板确实消费了这套语义 —— 只测 composable
 * 会漏掉「模板没接线」这种最常见的假绿。</p>
 */

const rootDir = fileURLToPath(new URL('..', import.meta.url));

const makeSession = (id: string, title: string, subs: { id: string; name: string }[] = []): ChatSession => ({
  id,
  title,
  workspaceId: null,
  workDir: null,
  runStatus: 'IDLE',
  lastOutcome: null,
  createTime: null,
  subSessions: subs.map(sub => ({id: sub.id, name: sub.name}))
} as unknown as ChatSession);

type Sources = {
  sessions: Ref<ChatSession[]>;
  active: Ref<string | null>;
  activeSub: Ref<string | null>;
};

const makeSources = (sessions: ChatSession[], active: string | null = null, activeSub: string | null = null): Sources => ({
  sessions: ref(sessions),
  active: ref(active),
  activeSub: ref(activeSub)
});

const mount = (sources: Sources) => useSessionBranchExpansion({
  sessions: computed(() => sources.sessions.value),
  activeSessionId: computed(() => sources.active.value),
  activeSubSessionId: computed(() => sources.activeSub.value)
});

/** 四个会话：s1 有子代理，s2 有子代理，s3/s4 无子代理。 */
const fixture = () => [
  makeSession('s1', '会话一', [{id: 'sub-1a', name: '工程师 A'}, {id: 'sub-1b', name: '工程师 B'}]),
  makeSession('s2', '会话二', [{id: 'sub-2a', name: '工程师 C'}]),
  makeSession('s3', '会话三'),
  makeSession('s4', '会话四', [{id: 'sub-4a', name: '工程师 D'}])
];

test('SBE-1 没有激活会话时，所有分支默认折叠（旧实现这里是全展开）', () => {
  const {isBranchExpanded, autoExpandedSessionId} = mount(makeSources(fixture()));
  assert.equal(autoExpandedSessionId.value, null);
  for (const id of ['s1', 's2', 's4']) {
    assert.equal(isBranchExpanded(id), false, `${id} 的分支应为折叠`);
  }
});

test('SBE-2 激活根会话时只展开该会话的分支，其余保持折叠', () => {
  const {isBranchExpanded} = mount(makeSources(fixture(), 's2'));
  assert.equal(isBranchExpanded('s2'), true);
  assert.equal(isBranchExpanded('s1'), false, '非激活会话不得自动展开');
  assert.equal(isBranchExpanded('s4'), false, '非激活会话不得自动展开');
});

test('SBE-3 激活子会话时展开其所属根会话的分支（否则用户在侧边栏里看不到自己）', () => {
  const {isBranchExpanded, autoExpandedSessionId} = mount(makeSources(fixture(), 's3', 'sub-4a'));
  assert.equal(autoExpandedSessionId.value, 's4', '应由子会话 id 反查到所属根会话');
  assert.equal(isBranchExpanded('s4'), true);
  assert.equal(isBranchExpanded('s3'), false, '停在子会话时不应顺手展开另一个根会话');
});

test('SBE-4 子会话 id 找不到所属会话时回退到 activeSessionId，不得整棵树都不展开', () => {
  const {isBranchExpanded, autoExpandedSessionId} = mount(makeSources(fixture(), 's2', 'ghost-sub'));
  assert.equal(autoExpandedSessionId.value, 's2');
  assert.equal(isBranchExpanded('s2'), true);
});

test('SBE-5 手动展开非激活会话的分支生效（覆盖态优先于派生态）', () => {
  const {isBranchExpanded, toggleBranch} = mount(makeSources(fixture(), 's1'));
  assert.equal(isBranchExpanded('s4'), false);
  toggleBranch('s4');
  assert.equal(isBranchExpanded('s4'), true, '手动点开必须生效');
  assert.equal(isBranchExpanded('s1'), true, '不得影响激活分支');
});

test('SBE-6 手动折叠「当前激活会话」的分支要留住，不能被激活态弹回展开', () => {
  const sources = makeSources(fixture(), 's1');
  const {isBranchExpanded, toggleBranch} = mount(sources);
  assert.equal(isBranchExpanded('s1'), true);
  toggleBranch('s1');
  assert.equal(isBranchExpanded('s1'), false, '手动折叠后应立即折叠');
  // 触发一次无关的响应式重算（同一激活会话），折叠必须保持
  sources.active.value = 's1';
  assert.equal(isBranchExpanded('s1'), false, '激活态重算不得把用户折叠弹回展开');
});

test('SBE-7 切换激活会话后，上一个自动展开的分支回落为折叠', () => {
  const sources = makeSources(fixture(), 's1');
  const {isBranchExpanded} = mount(sources);
  assert.equal(isBranchExpanded('s1'), true);
  sources.active.value = 's2';
  assert.equal(isBranchExpanded('s1'), false, '切走后应回落折叠，避免越点越满');
  assert.equal(isBranchExpanded('s2'), true);
});

test('SBE-8 setBranchExpanded 接受「目标态」而非「取反」（BranchedMenu 的 toggleChild 语义）', () => {
  const {isBranchExpanded, setBranchExpanded} = mount(makeSources(fixture(), 's1'));
  setBranchExpanded('s4', true);
  assert.equal(isBranchExpanded('s4'), true);
  setBranchExpanded('s4', true);
  assert.equal(isBranchExpanded('s4'), true, '重复设置同一目标态必须幂等，不能取反');
  setBranchExpanded('s4', false);
  assert.equal(isBranchExpanded('s4'), false);
});

test('SBE-9 子会话用字符串 id 比较（超过 2^53 的雪花 id 走 Number 会串号）', () => {
  const owner = makeSession('9007199254740995', '父会话', [{id: '9007199254740997', name: '审查工程师'}]);
  const {isBranchExpanded, autoExpandedSessionId} = mount(
    makeSources([owner, makeSession('s2', '会话二')], '9007199254740995', '9007199254740997')
  );
  assert.equal(autoExpandedSessionId.value, '9007199254740995');
  assert.equal(isBranchExpanded('9007199254740995'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// SSR 真实渲染：证明模板确实消费了这套语义（亮色列表分支 + 暗色 BranchedMenu 分支）
// ─────────────────────────────────────────────────────────────────────────────

const renderSidebar = async (
  mode: 'light' | 'dark',
  props: Record<string, unknown>,
  assertions: (html: string) => void
): Promise<void> => {
  const server = await createServer({root: rootDir, server: {middlewareMode: true}, appType: 'custom'});
  try {
    const component = (await server.ssrLoadModule('/src/components/chat/Sidebar.vue')).default;
    // i18n 与主题都是模块级单例：必须从同一个 SSR 模块图里取，直接 import 会拿到另一份实例，
    // 于是 setTheme 写不到组件读的那份（表现为「亮色用例实际渲染的是暗色分支」的假绿）。
    const i18n = await server.ssrLoadModule('/src/i18n/index.ts');
    i18n.useI18n().locale.value = 'zh-CN';
    const theme = await server.ssrLoadModule('/src/composables/useTheme.ts');
    theme.useTheme().setTheme(mode);
    const html = await renderToString(createSSRApp(component, props));
    assertions(html);
  } finally {
    await server.close();
  }
};

const sidebarProps = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  sessions: [],
  activeSessionId: null,
  workspaces: [],
  activeWorkspaceId: null,
  isCollapsed: false,
  ...overrides
});

const ownerWithSubs = () => makeSession('s1', '父会话', [{id: 'sub-1', name: '子代理-甲'}]);

for (const mode of ['light', 'dark'] as const) {
  const modeLabel = mode === 'dark' ? '暗色 BranchedMenu 分支' : '亮色列表分支';

  test(`SBE-SSR-1 ${modeLabel}：无激活会话时子代理名不渲染（默认折叠）`, async () => {
    await renderSidebar(mode, sidebarProps({sessions: [ownerWithSubs()]}), html => {
      assert.ok(html.includes('父会话'), '根会话必须照常渲染');
      assert.ok(!html.includes('子代理-甲'), `默认折叠时子代理名不得出现在 DOM 中（${modeLabel}）`);
    });
  });

  test(`SBE-SSR-2 ${modeLabel}：激活父会话时该分支展开，子代理名可见`, async () => {
    await renderSidebar(mode, sidebarProps({sessions: [ownerWithSubs()], activeSessionId: 's1'}), html => {
      assert.ok(html.includes('子代理-甲'), `激活分支必须自动展开（${modeLabel}）`);
      // 顺手钉住「确实渲染的是目标分支」：主题是模块级单例，切不过去时两条用例会同时跑同一分支，
      // 亮色那半就成了假绿。`group/section` 只出现在 BranchedMenu（暗色分支）的区块根节点上。
      assert.equal(html.includes('group/section'), mode === 'dark', `渲染的应是 ${modeLabel}`);
    });
  });
}
