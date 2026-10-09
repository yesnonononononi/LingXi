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
              { blockId: `text:${message.id}`, type: 'TEXT', order: 0, status: 'COMPLETE', placement: 'BODY', text: message.content },
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
    responseId: 'r2', order: 1001, offset: 0, content: '实时正文' });
  reducer.consume({ type: 'TOOL_CALL', executionId: 'e', timestamp: '', metaData: metadata,
    responseId: 'r1', requestId: 'c1', toolName: AgentToolName.ReadFile, order: 2, args: '{"path":"a.md"}' });
  const live = originalMessages[0];
  resolvePage({ ok: true, data: { records: [], messages: [], turns: {}, hasMore: false, nextCursor: null,
    turnViews: { '900': { sessionId: 'sub-1', turnId: '900', status: 'RUNNING', viewVersion: '1', blocks: [
      { blockId: 'text:r0', responseId: 'r0', type: 'TEXT', order: 1, status: 'COMPLETE', placement: 'BODY', text: '历史正文' },
    ] } } } });
  await loading;
  assert.equal(sub.activeSubSessionMessages.value.length, 1);
  assert.equal(sub.activeSubSessionMessages.value[0], live);
  assert.equal(live.content, '实时正文');
  assert.equal(live.toolCalls[0].id, 'c1');
  assert.equal(live.turnState.texts['text:r0'].text, '历史正文');
  assert.equal(live.turnState.texts['text:r2'].text, '实时正文');
});
