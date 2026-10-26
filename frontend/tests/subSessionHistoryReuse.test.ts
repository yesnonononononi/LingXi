import test from 'node:test';
import assert from 'node:assert/strict';
import { ref, computed } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { chatApi } from '../src/services/chat';
import { mergeSubSessionTree } from '../src/utils/session';
import { useChatSubSession } from '../src/views/chat/useChatSubSession';
import { useChatHistory } from '../src/views/chat/useChatHistory';
import type { ChatMessage, ChatSession, ChatTurn } from '../src/types/chat';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import { AgentToolName } from '../src/utils/toolNames';
import { useChatSessionList } from '../src/views/chat/useChatSessionList';
import { StreamSessionRouter } from '../src/views/chat/streamSessionRouter';
import { readFileSync } from 'node:fs';
import { absorbSubSessionHistory } from '../src/views/chat/subSessionHistory';

/**
 * 缺陷：点击子会话卡片不加载 / 不渲染其历史消息。
 *
 * <p>根因（已复现）：子会话历史被写进 {@code SubSessionVO.messages}，而流结束对账
 * （{@code useChatHistory#reconcileSessionAfterStream}）用会话树下发的新 VO 整体替换
 * {@code subSessions}（新 VO 的 messages 为空）→ 已加载历史整段丢失；再叠加
 * {@code useChatSubSession} 的一次性分页守卫，后续点击不再重拉 → 面板永远「暂无消息」。</p>
 *
 * <p>另外 {@code SubSessionDetailDrawer} 曾走第二套加载/解析，
 * 与根会话（{@code chatApi.fetchSessionMessages}）重复，已统一。</p>
 */

const subMessage: ChatMessage = {
  id: 'm-sub-1',
  role: 'assistant',
  content: '子会话历史正文',
  timestamp: 1,
  turnId: 't-1'
};

/**
 * 打桩：让 fetchSessionMessages 返回固定的一页子会话历史（一块视图），并统计调用次数。
 *
 * <p>子会话与主会话同一口径：唯一展示链路是「轮次视图 → reducer」，
 * 因此这里必须下发 turnViews（只给 messages/records 会渲染出空列表）。</p>
 */
function stubSessionMessages(message: ChatMessage = subMessage): () => number {
  let calls = 0;
  (chatApi as any).fetchSessionMessages = async () => {
    calls += 1;
    return {
      ok: true,
      data: {
        records: [],
        messages: [],
        turns: {},
        turnViews: {
          [String(message.turnId)]: {
            sessionId: 'sub-1',
            turnId: message.turnId,
            status: 'COMPLETED',
            viewVersion: 1,
            blocks: [
              { blockId: `text:${message.id}`, type: 'TEXT', order: 0, status: 'COMPLETE', isBody: true, text: message.content },
            ],
          },
        },
        nextCursor: null,
        hasMore: false
      }
    };
  };
  return () => calls;
}

test('1. mergeSubSessionTree：按 id 保留已加载消息（同一数组引用），轮次逐页 union，元数据以树为准', () => {
  const loadedMessages: ChatMessage[] = [subMessage];
  const oldTurns: Record<string, ChatTurn> = { 't-1': { turnId: 't-1', status: 'RUNNING', totalTokens: 5 } };
  const previous = [
    { id: 'sub-1', name: '旧名', runStatus: 'RUNNING', messages: loadedMessages, turns: oldTurns },
    { id: 'sub-gone', name: '已移除', messages: [subMessage] }
  ];
  const incoming = [
    { id: 'sub-1', name: '产品经理', runStatus: 'IDLE' },
    { id: 'sub-new', name: '新成员' }
  ];

  const merged = mergeSubSessionTree(previous as any, incoming as any);

  assert.equal(merged.length, 2, '被移除的子会话不再保留');
  assert.equal(merged[0].id, 'sub-1');
  assert.equal(merged[0].name, '产品经理', '元数据以树为准');
  assert.equal(merged[0].runStatus, 'IDLE');
  assert.equal(merged[0].messages, loadedMessages, '必须保留同一个消息数组引用（实时 reducer 继续写它）');
  assert.equal(merged[0].messages?.length, 1, '已加载历史不能丢');
  assert.equal(merged[0].turns?.['t-1']?.totalTokens, 5, '轮次摘要保留');
  assert.equal(merged[1].messages, undefined, '新增子会话无历史，保持空');
});

test('2. useChatSubSession：对账替换 subSessions 后再次点击仍会重拉并恢复渲染（不再被一次性守卫钉死）', async () => {
  const fetchCount = stubSessionMessages();
  const session = ref<any>({
    id: 'root-1',
    messages: [],
    subSessions: [{ id: 'sub-1', agentName: '产品经理', runStatus: 'RUNNING', messages: [] }]
  });
  const sub = useChatSubSession({ currentActiveSession: computed(() => session.value) });

  // 首次点击：加载成功，并展开侧边面板（否则从主会话协同条点击「点了没反应」）
  await sub.handleSelectSubSessionOption('sub-1');
  assert.equal(fetchCount(), 1);
  assert.equal(sub.activeSubSessionMessages.value.length, 1);
  assert.equal(sub.isSubPanelOpen.value, true, '选中子会话即展开面板');

  // 已有消息时短路，不重复拉取
  await sub.handleSelectSubSessionOption('sub-1');
  assert.equal(fetchCount(), 1, '已加载且有消息时不应重复拉取');

  // 模拟流结束对账：subSessions 被树下发的新 VO 整体替换（messages 为空）
  session.value.subSessions = [{ id: 'sub-1', agentName: '产品经理', runStatus: 'IDLE', messages: [] }];
  assert.equal(sub.activeSubSessionMessages.value.length, 0, '对账后（未合并前）历史会丢');

  // 再次点击：必须重拉，把历史恢复回来
  await sub.handleSelectSubSessionOption('sub-1');
  assert.equal(fetchCount(), 2, '对账清空后再次点击必须重拉');
  assert.equal(sub.activeSubSessionMessages.value.length, 1, '历史恢复渲染');
});

test('3. useChatHistory.reconcileSessionAfterStream：树对账不丢子会话已加载历史', async () => {
  setActivePinia(createPinia());

  const localSessions = ref<ChatSession[]>([
    {
      id: 'root-1',
      title: '会话',
      createdAt: 0,
      updatedAt: 0,
      modelId: 'm',
      activeTools: [],
      messages: [],
      subSessions: [{ id: 'sub-1', name: '产品经理', runStatus: 'RUNNING', messages: [subMessage] }]
    }
  ]);
  const currentActiveSession = computed(() => localSessions.value[0]);
  const history = useChatHistory({
    currentActiveSession,
    localSessions,
    messagesContainerRef: ref(null),
    scheduleTimeout: ((handler: () => void) => setTimeout(handler, 0)) as any
  });

  // 打桩 tree：子会话只带元数据、不带 messages（与后端契约一致）
  (chatApi as any).fetchSessionTree = async () => ({
    ok: true,
    data: {
      rootSessionId: 'root-1',
      root: { id: 'root-1', runStatus: 'IDLE', lastOutcome: 'COMPLETED' },
      subSessions: [{ id: 'sub-1', name: '产品经理', runStatus: 'IDLE' }]
    }
  });
  (chatApi as any).fetchSessionMessages = async () => ({
    ok: true,
    data: { records: [], messages: [], turns: {}, nextCursor: null, hasMore: false }
  });

  await history.reconcileSessionAfterStream('root-1');

  const sub = localSessions.value[0].subSessions?.[0];
  assert.ok(sub);
  assert.equal(sub.messages?.length, 1, '子会话已加载历史必须在对账后保留');
  assert.equal(sub.messages?.[0].content, '子会话历史正文');
  assert.equal(sub.runStatus, 'IDLE', '元数据仍以树为准');
});

test('第二版：子会话首次历史请求在途时收到的文本和工具不能被替换', async t => {
  type PageResult = Awaited<ReturnType<typeof chatApi.fetchSessionMessages>>;
  let resolvePage!: (value: PageResult) => void;
  t.mock.method(chatApi, 'fetchSessionMessages', () => new Promise<PageResult>(resolve => { resolvePage = resolve; }));
  const session = ref<any>({ id: 'root-1', messages: [],
    subSessions: [{ id: 'sub-1', agentName: '产品经理', runStatus: 'RUNNING', messages: [] }] });
  const sub = useChatSubSession({ currentActiveSession: computed(() => session.value) });
  const loading = sub.handleSelectSubSessionOption('sub-1');
  const originalMessages = session.value.subSessions[0].messages;
  const reducer = new TurnStreamReducer(() => session.value.subSessions[0].messages, { sessionId: 'sub-1' });
  const metadata = { sessionId: 'sub-1', turnId: '900' };
  reducer.consume({ type: 'PARTIAL_TEXT', executionId: 'e', timestamp: '', metaData: metadata,
    responseId: '102', order: 1001, offset: 0, content: '实时正文' });
  reducer.consume({ type: 'TOOL_CALL', executionId: 'e', timestamp: '', metaData: metadata,
    responseId: '101', requestId: 'c1', toolName: AgentToolName.ReadFile, order: 2, args: '{"path":"a.md"}' });
  const live = originalMessages[0];
  resolvePage({ ok: true, data: { records: [], messages: [], turns: {}, hasMore: false, nextCursor: null,
    turnViews: { '900': { sessionId: 'sub-1', turnId: '900', status: 'RUNNING', viewVersion: '1', blocks: [
      { blockId: 'text:100', responseId: '100', type: 'TEXT', order: 1, status: 'COMPLETE', isBody: true, text: '历史正文' },
    ] } } } });
  await loading;
  assert.equal(sub.activeSubSessionMessages.value.length, 1);
  assert.equal(sub.activeSubSessionMessages.value[0], live);
  assert.equal(live.content, '历史正文', '历史已确认正文保留，新响应尚未确认用途');
  assert.equal(live.aiMessages.find(item => item.id === 'text:102')?.text, '实时正文', '在途历史不能抹掉实时过程文本');
  assert.equal(live.toolCalls[0].id, 'c1');
  assert.equal(live.turnState.texts['text:100'].text, '历史正文');
  assert.equal(live.turnState.texts['text:102'].text, '实时正文');
  reducer.consume({ type: 'AI_MESSAGE', executionId: 'e', timestamp: '', metaData: metadata,
    responseId: '102', order: 1, text: '实时正文', isBody: true });
  assert.equal(live.content, '实时正文', '确认用途后按响应身份归位到正文');
});

type PageResult = Awaited<ReturnType<typeof chatApi.fetchSessionMessages>>;

function createPage(sessionId = 'sub-1', text = '历史正文', turnId = '900'): PageResult {
  return { ok: true, data: { records: [], messages: [], turns: {}, hasMore: false, nextCursor: null,
    turnViews: { [turnId]: { sessionId, turnId, status: 'RUNNING', viewVersion: '4', userMessage: '委派任务', blocks: [
      { blockId: `text:${turnId}`, responseId: turnId, type: 'TEXT', order: 1, status: 'COMPLETE', isBody: true, text },
    ] } } } };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function createHarness() {
  setActivePinia(createPinia());
  const sessions = ref<ChatSession[]>([{ id: 'root-1', title: '诊断会话', createdAt: 0, updatedAt: 0,
    modelId: '', activeTools: [], messages: [], runStatus: 'RUNNING',
    subSessions: [{ id: 'sub-1', name: '工程师', runStatus: 'RUNNING', messages: [] },
      { id: 'sub-2', name: '审查员', runStatus: 'RUNNING', messages: [] }] }]);
  const activeId = ref<string | null>('root-1');
  const current = computed(() => sessions.value.find(session => session.id === activeId.value));
  const sub = useChatSubSession({ currentActiveSession: current });
  const list = useChatSessionList({ localSessions: sessions, localActiveId: activeId, currentActiveSession: current,
    displayedMessages: computed(() => current.value?.messages ?? []), localActiveWorkspaceId: ref(null),
    localSelectedTeamId: ref(null), beforeSwitchSession: sub.resetSubSessionView, isGenerating: () => false,
    scrollToBottomForce: () => {}, seedContextUsageFromTree: () => {}, resetScrollAnchors: () => {},
    onNewSession: sub.resetSubSessionView });
  const history = useChatHistory({ currentActiveSession: current, localSessions: sessions, messagesContainerRef: ref(null),
    scheduleTimeout: () => 0, reconcileSubSessions: sub.refreshViewedSubSessionHistory });
  return { sessions, activeId, current, sub, list, history };
}

test('主会话详情迟到时保留子会话历史、实时内容及版本表，详情读取的 VO 不脱离会话树', async t => {
  const detail = createDeferred<Awaited<ReturnType<typeof chatApi.fetchSessionDetail>>>();
  t.mock.method(chatApi, 'fetchSessionDetail', () => detail.promise);
  const messages = t.mock.method(chatApi, 'fetchSessionMessages', async () => createPage());
  const { current, sub, list } = createHarness();
  const freshDetail: ChatSession = { ...current.value!, subSessions: [{ id: 'sub-1', name: '新名称', runStatus: 'IDLE' }] };
  const pendingDetail = list.handleSelectSession('root-1');
  await sub.handleSelectSubSessionOption('sub-1');
  const loaded = current.value!.subSessions![0]!;
  const loadedMessages = loaded.messages;
  const turnState = loaded.messages?.find(message => message.role === 'assistant')?.turnState;
  const views = loaded.turnViews;
  const router = new StreamSessionRouter();
  t.after(() => router.dispose());
  router.bindRootSession(current.value!);
  router.dispatch({ type: 'PARTIAL_THINKING', executionId: 'child', timestamp: '',
    metaData: { sessionId: 'sub-1', rootSessionId: 'root-1', turnId: '900' },
    responseId: '901', offset: 0, order: 2, content: '在途实时思考' });

  detail.resolve({ ok: true, data: freshDetail });
  await pendingDetail;

  assert.equal(current.value!.subSessions![0], loaded, '抽屉在途请求捕获的 VO 仍须属于会话树');
  assert.equal(loaded.messages, loadedMessages);
  assert.equal(loaded.messages?.find(message => message.role === 'assistant')?.turnState, turnState);
  assert.deepEqual(loaded.turnViews, views);
  assert.equal(loaded.name, '新名称');
  assert.ok(sub.activeSubSessionMessages.value.some(message => message.content === '历史正文'));
  assert.ok(sub.activeSubSessionMessages.value.some(message => message.thoughtSteps?.some(step => step.content === '在途实时思考')));
  await sub.handleSelectSubSessionOption('sub-1');
  assert.equal(messages.mock.callCount(), 1, '同一份历史仍有效时不重复请求');
});

test('树对账保留子会话对象和视图版本，旧历史响应不能使轮次状态倒退', () => {
  const page = createPage();
  assert.ok(page.ok);
  const previous = { id: 'sub-1', messages: [] as ChatMessage[] };
  absorbSubSessionHistory(previous, page.data);
  const oldState = previous.messages.find(message => message.role === 'assistant')?.turnState;
  const merged = mergeSubSessionTree([previous], [{ id: 'sub-1', name: '新名称' }]);
  assert.equal(merged[0], previous);
  assert.equal(merged[0]!.messages?.find(message => message.role === 'assistant')?.turnState, oldState);
  assert.equal(merged[0]!.turnViews?.['900']?.viewVersion, '4');
  const stalePage = createPage('sub-1', '过期历史');
  assert.ok(stalePage.ok);
  stalePage.data.turnViews['900']!.viewVersion = '1';
  absorbSubSessionHistory(merged[0], stalePage.data);
  assert.ok(merged[0]!.messages?.some(message => message.content === '历史正文'));
});

test('消息数组已更换且只有实时消息时，旧加载标记不能跳过历史请求', async t => {
  const fetch = t.mock.method(chatApi, 'fetchSessionMessages', async () => createPage());
  const { current, sub } = createHarness();
  await sub.handleSelectSubSessionOption('sub-1');
  current.value!.subSessions![0]!.messages = [{ id: 'live', role: 'assistant', turnId: '901', timestamp: 0, content: '实时消息' }];
  await sub.handleSelectSubSessionOption('sub-1');
  assert.equal(fetch.mock.callCount(), 2);
  assert.ok(sub.activeSubSessionMessages.value.some(message => message.content === '历史正文'));
  assert.ok(sub.activeSubSessionMessages.value.some(message => message.content === '实时消息'));
});

test('切走后重进同一子会话必须重新校验历史，不能沿用旧加载标记', async t => {
  const fetch = t.mock.method(chatApi, 'fetchSessionMessages', async () => createPage());
  const { sub } = createHarness();
  await sub.handleSelectSubSessionOption('sub-1');
  sub.resetSubSessionView();
  await sub.handleSelectSubSessionOption('sub-1');
  assert.equal(fetch.mock.callCount(), 2);
});

test('子会话 A 失败响应迟到时，不能清掉 B 的加载状态或显示 A 的错误', async t => {
  const first = createDeferred<PageResult>();
  const second = createDeferred<PageResult>();
  t.mock.method(chatApi, 'fetchSessionMessages', id => String(id) === 'sub-1' ? first.promise : second.promise);
  const { sub } = createHarness();
  const loadingA = sub.handleSelectSubSessionOption('sub-1');
  const loadingB = sub.handleSelectSubSessionOption('sub-2');
  first.resolve({ ok: false, error: 'A 请求失败' });
  await loadingA;
  assert.equal(sub.isLoadingSubMessages.value, true);
  assert.equal(sub.subMessagesError.value, '');
  second.resolve(createPage('sub-2', 'B 历史'));
  await loadingB;
  assert.equal(sub.isLoadingSubMessages.value, false);
  assert.ok(sub.activeSubSessionMessages.value.some(message => message.content === 'B 历史'));
});

test('切走再返回时，上一次进入的迟到响应不能覆盖新请求或使其提前结束', async t => {
  const first = createDeferred<PageResult>();
  const second = createDeferred<PageResult>();
  let count = 0;
  t.mock.method(chatApi, 'fetchSessionMessages', () => ++count === 1 ? first.promise : second.promise);
  const { sub } = createHarness();
  const oldLoading = sub.handleSelectSubSessionOption('sub-1');
  sub.resetSubSessionView();
  const newLoading = sub.handleSelectSubSessionOption('sub-1');
  first.resolve(createPage('sub-1', '旧请求历史'));
  await oldLoading;
  assert.equal(sub.isLoadingSubMessages.value, true);
  assert.equal(sub.activeSubSessionMessages.value.length, 0);
  second.resolve(createPage('sub-1', '新请求历史'));
  await newLoading;
  assert.ok(sub.activeSubSessionMessages.value.some(message => message.content === '新请求历史'));
});

test('终态或重连回查同时补齐当前子会话历史，并保留已加载的更早轮次', async t => {
  const calls: string[] = [];
  let latest = false;
  t.mock.method(chatApi, 'fetchSessionMessages', async id => {
    calls.push(String(id));
    return String(id) === 'root-1' ? { ok: true, data: { records: [], messages: [], turns: {}, turnViews: {}, hasMore: false, nextCursor: null } }
      : latest ? createPage('sub-1', '断线期间的历史', '901') : createPage();
  });
  t.mock.method(chatApi, 'fetchSessionTree', async () => ({ ok: true, data: { rootSessionId: 'root-1',
    root: { id: 'root-1', runStatus: 'IDLE' }, subSessions: [{ id: 'sub-1', name: '工程师', runStatus: 'IDLE' }] } }));
  const { history, sub } = createHarness();
  await sub.handleSelectSubSessionOption('sub-1');
  latest = true;
  await history.reconcileSessionAfterStream('root-1');
  assert.deepEqual(calls, ['sub-1', 'root-1', 'sub-1']);
  assert.ok(sub.activeSubSessionMessages.value.some(message => message.content === '历史正文'));
  assert.ok(sub.activeSubSessionMessages.value.some(message => message.content === '断线期间的历史'));
});

test('子会话回查失败后保留消息并显示可重试错误，再次点击必须重新请求', async t => {
  let fail = false;
  const fetch = t.mock.method(chatApi, 'fetchSessionMessages', async () => fail ? { ok: false, error: '子会话查询失败' } : createPage());
  const { sub } = createHarness();
  await sub.handleSelectSubSessionOption('sub-1');
  fail = true;
  await sub.refreshViewedSubSessionHistory('root-1');
  assert.equal(sub.subMessagesError.value, '子会话查询失败');
  assert.ok(sub.activeSubSessionMessages.value.some(message => message.content === '历史正文'));
  fail = false;
  await sub.handleSelectSubSessionOption('sub-1');
  assert.equal(fetch.mock.callCount(), 3);
  assert.equal(sub.subMessagesError.value, '');
});

test('子会话分页响应迟到时不能污染新选择，也不能清掉新一轮分页的加载状态', async t => {
  const oldPage = createDeferred<PageResult>();
  const newPage = createDeferred<PageResult>();
  t.mock.method(chatApi, 'fetchSessionMessages', async (id, cursor) => {
    if (cursor) return String(id) === 'sub-1' ? oldPage.promise : newPage.promise;
    const page = createPage(String(id));
    assert.ok(page.ok);
    page.data.hasMore = true;
    page.data.nextCursor = '800';
    return page;
  });
  const { sub } = createHarness();
  await sub.handleSelectSubSessionOption('sub-1');
  const oldLoading = sub.handleLoadMoreSubSessionHistory();
  await sub.handleSelectSubSessionOption('sub-2');
  const newLoading = sub.handleLoadMoreSubSessionHistory();
  oldPage.resolve({ ok: false, error: 'A 分页失败' });
  await oldLoading;
  assert.equal(sub.isLoadingMoreSubMessages.value, true);
  assert.equal(sub.subHistoryLoadError.value, '');
  newPage.resolve(createPage('sub-2', 'B 更早的历史', '800'));
  await newLoading;
  assert.equal(sub.isLoadingMoreSubMessages.value, false);
  assert.ok(sub.activeSubSessionMessages.value.some(message => message.content === 'B 更早的历史'));
});

test('历史版本改变后，旧请求不能恢复被作废的轮次，旧缓存也不能阻止重新请求', async t => {
  const oldPage = createDeferred<PageResult>();
  let delayed = false;
  const fetch = t.mock.method(chatApi, 'fetchSessionMessages', async () => delayed ? oldPage.promise : createPage());
  const { current, sub } = createHarness();
  await sub.handleSelectSubSessionOption('sub-1');
  delayed = true;
  const oldLoading = sub.refreshViewedSubSessionHistory('root-1');
  current.value!.historyRevision = '2';
  oldPage.resolve(createPage('sub-1', '作废轮次', '901'));
  await oldLoading;
  assert.equal(sub.activeSubSessionMessages.value.some(message => message.content === '作废轮次'), false);
  delayed = false;
  await sub.handleSelectSubSessionOption('sub-1');
  assert.equal(fetch.mock.callCount(), 3);
});

test('主会话回查作废后，不能继续发起子会话回查', async t => {
  const rootPage = createDeferred<PageResult>();
  t.mock.method(chatApi, 'fetchSessionTree', async () => ({ ok: true, data: { rootSessionId: 'root-1',
    root: { id: 'root-1' }, subSessions: [{ id: 'sub-1' }] } }));
  const fetch = t.mock.method(chatApi, 'fetchSessionMessages', id => String(id) === 'root-1' ? rootPage.promise : Promise.resolve(createPage()));
  const { history, sub } = createHarness();
  await sub.handleSelectSubSessionOption('sub-1');
  const pending = history.reconcileSessionAfterStream('root-1');
  await Promise.resolve();
  history.invalidateReconcile();
  rootPage.resolve(createPage('root-1'));
  await pending;
  assert.equal(fetch.mock.callCount(), 2, '作废的根会话回查不能继续刷新子会话');
});

test('ChatView 将子会话回查接入统一历史回查入口', () => {
  const source = readFileSync(new URL('../src/views/chat/useChatView.ts', import.meta.url), 'utf8');
  assert.match(source, /reconcileSubSessions:\s*subSession\.refreshViewedSubSessionHistory/);
});

test('后台补齐不隐藏已有轨迹，刷新后的游标仍可加载断线期间遗漏的更早轮次', async t => {
  const latest = createDeferred<PageResult>();
  const cursors: Array<string | null | undefined> = [];
  let refreshing = false;
  t.mock.method(chatApi, 'fetchSessionMessages', async (_id, cursor) => {
    cursors.push(cursor);
    if (cursor) return createPage('sub-1', '缺口中的历史', '950');
    return refreshing ? latest.promise : createPage();
  });
  const { sub } = createHarness();
  await sub.handleSelectSubSessionOption('sub-1');
  refreshing = true;
  const pending = sub.refreshViewedSubSessionHistory('root-1');
  assert.equal(sub.isLoadingSubMessages.value, false);
  const page = createPage('sub-1', '最新历史', '1000');
  assert.ok(page.ok);
  page.data.hasMore = true;
  page.data.nextCursor = '999';
  latest.resolve(page);
  await pending;
  assert.equal(sub.hasMoreSubMessages.value, true);
  await sub.handleLoadMoreSubSessionHistory();
  assert.deepEqual(cursors, [null, null, '999']);
  for (const text of ['历史正文', '最新历史', '缺口中的历史']) {
    assert.ok(sub.activeSubSessionMessages.value.some(message => message.content === text));
  }
});

test('消息数组更换后翻页必须重新获取首屏，不能使用旧数组的分页游标', async t => {
  const cursors: Array<string | null | undefined> = [];
  t.mock.method(chatApi, 'fetchSessionMessages', async (_id, cursor) => {
    cursors.push(cursor);
    const page = createPage();
    assert.ok(page.ok);
    page.data.hasMore = true;
    page.data.nextCursor = '800';
    return page;
  });
  const { current, sub } = createHarness();
  await sub.handleSelectSubSessionOption('sub-1');
  current.value!.subSessions![0]!.messages = [];
  await sub.handleLoadMoreSubSessionHistory();
  assert.deepEqual(cursors, [null, null]);
  assert.ok(sub.activeSubSessionMessages.value.some(message => message.content === '历史正文'));
});
