import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ref} from 'vue';
import {mergeSessionListSnapshot} from '../src/utils/sessionListMerge';
import {useSessionGrouping} from '../src/composables/sidebar/useSessionGrouping';
import {PINNED_GROUP_KEY, SESSION_VISIBLE_LIMIT, useSessionVisibility} from '../src/composables/sidebar/useSessionVisibility';
import {applySessionState} from '../src/views/chat/useApplicationSessionState';
import {PIN_PATH, UNPIN_PATH} from '../src/utils/sessionPinIcons';
import type {ChatMessage, ChatSession, SessionVO, WorkspaceVO} from '../src/types/chat';

const session = (id: string, extra: Partial<ChatSession> = {}): ChatSession => ({
  id, title: id, createdAt: 0, updatedAt: 0, modelId: '', activeTools: [], messages: [], ...extra
});

const workspace = (id: number): WorkspaceVO => ({id, name: `工作区-${id}`, workDir: `D:/ws/${id}`} as WorkspaceVO);

const state = (version: string, isPinned: boolean): SessionVO => ({
  id: 'a', version, isRead: true, isPinned, renderStatus: null, runStatus: 'IDLE', lastOutcome: null
});

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('SP-1 列表快照重排：顺序取后端，已加载正文不许被清空', () => {
  const message = {content: '已到达的正文'} as ChatMessage;
  const local = [
    session('a', {messages: [message], isPinned: false}),
    session('b', {isPinned: true}),
    session('temp-1')
  ];
  const snapshot = [session('b', {isPinned: true}), session('a', {isPinned: false})];

  const merged = mergeSessionListSnapshot(local, snapshot);

  assert.deepEqual(merged.map(item => item.id), ['b', 'a', 'temp-1'], '次序取后端，快照里没有的本地会话接在后面');
  assert.equal(merged[1]!.messages.length, 1, '列表接口不带正文，合并不得把已加载消息覆盖成空');
});

test('SP-2 置顶会话独立成区：不再落进工作区分组，也不进历史分组', () => {
  const sessions = ref([
    session('a', {isPinned: true, workspaceId: '1'}),
    session('b', {workspaceId: '1'}),
    session('c')
  ]);

  const {pinnedSessions, projectGroups, unassignedSessions} = useSessionGrouping({
    sessions,
    workspaces: ref([workspace(1)]),
    filterQuery: ref(''),
    isSortAsc: ref(false)
  });

  assert.deepEqual(pinnedSessions.value.map(item => item.id), ['a']);
  assert.deepEqual(projectGroups.value[0]!.sessions.map(item => item.id), ['b'], '置顶会话不能在工作区里再出现一次');
  assert.deepEqual(unassignedSessions.value.map(item => item.id), ['c']);
});

test('SP-3 置顶分区不参与截断，暗色分支排在第一项', () => {
  const pinned = Array.from({length: SESSION_VISIBLE_LIMIT + 2}, (_, index) => session(`p${index}`, {isPinned: true}));
  const sessions = ref([...pinned, session('n1')]);
  const grouping = useSessionGrouping({
    sessions,
    workspaces: ref([]),
    filterQuery: ref(''),
    isSortAsc: ref(false)
  });

  const visibility = useSessionVisibility({
    pinnedSessions: grouping.pinnedSessions,
    projectGroups: grouping.projectGroups,
    unassignedSessions: grouping.unassignedSessions,
    expandedWorkspaces: ref({}),
    fullyExpandedWorkspaces: ref({})
  });

  assert.equal(
    visibility.limitSessions(PINNED_GROUP_KEY, grouping.pinnedSessions.value).length,
    SESSION_VISIBLE_LIMIT + 2,
    '置顶是用户亲手挑的，第 6 个不该藏在「展开显示」后面'
  );
  assert.equal(visibility.branchedMenuItems.value[0]!.value, PINNED_GROUP_KEY);
});

test('SP-4 状态帧写回置顶：漏了就等于每来一帧就把 pin 抹掉', () => {
  const target = session('a');

  applySessionState(target, state('1', true));
  assert.equal(target.isPinned, true);

  applySessionState(target, state('2', false));
  assert.equal(target.isPinned, false);
});

test('SP-5 三处 isPinned 映射必须齐（漏一处就是刷新或实时帧之后 pin 消失）', () => {
  const chatService = read('../src/services/chat.ts');
  assert.ok(chatService.includes('isPinned: item.isPinned'), 'fetchSessions 映射缺 isPinned');
  assert.ok(chatService.includes('isPinned: meta?.isPinned'), 'fetchSessionDetail 映射缺 isPinned');

  const applicationState = read('../src/views/chat/useApplicationSessionState.ts');
  assert.ok(applicationState.includes('session.isPinned = state.isPinned'), 'applySessionState 未写回置顶');
  assert.ok(applicationState.includes('isPinned: state.isPinned,'), '状态新建的会话壳未带置顶');

  // 事件链：侧栏 emit → 宿主监听，断任何一节都是「点了没反应」。
  assert.ok(read('../src/components/chat/Sidebar.vue').includes('(e: \'togglePin\', id: string): void;'));
  assert.ok(read('../src/views/chat/ChatView.vue').includes('@togglePin="handleTogglePin"'));
});

test('SP-6 置顶与取消置顶是两个不同的图标（复制粘贴同一份 path 会让按钮永远显示同一态）', () => {
  assert.notEqual(PIN_PATH, UNPIN_PATH);
  assert.ok(PIN_PATH.startsWith('M') && UNPIN_PATH.startsWith('M'));
});

test('SP-7 两套主题都接上了 pin 入口，会话行只剩一份行模板', () => {
  const tree = read('../src/components/chat/SidebarWorkspaceTree.vue');
  assert.ok(tree.includes('data-testid="sidebar-pinned-group"'), '亮色列表缺置顶分区');
  assert.ok(tree.includes("item.value === 'ws-pinned'"), '暗色置顶分区没有专属图标');
  assert.ok(tree.includes(':pinned="item.raw.isPinned === true"'), '暗色行没把置顶态传给 pin 按钮');

  const rowUsages = tree.split('<SidebarSessionRow').length - 1;
  assert.ok(rowUsages >= 3, `会话行都该走 SidebarSessionRow（置顶分区 + 两处既有列表），实际只有 ${rowUsages} 处`);

  const sidebar = read('../src/components/chat/Sidebar.vue');
  assert.ok(sidebar.includes('key: PINNED_GROUP_KEY'), '侧栏没把置顶分区插进树首位');
  assert.ok(sidebar.includes("kind: 'pinned'"), '置顶分区缺 kind 标识');
});
