import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { SessionAPI } from '../src/services/session';
import { chatApi } from '../src/services/chat';
import { AgentToolName } from '../src/utils/toolNames';
import { attachPromptCards, canDecideCard, toPromptCardData } from '../src/utils/toolCallCard';
import { aggregateRecordsByIdentity } from '../src/utils/session';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import { useChatHistory } from '../src/views/chat/useChatHistory';
import { useChatSessionList } from '../src/views/chat/useChatSessionList';
import { useChatSubSession } from '../src/views/chat/useChatSubSession';
import type { ChatMessage, ChatSession, SessionMessageVO, ToolCallVO } from '../src/types/chat';
import type { BlockStatus, TurnViewVO } from '../src/types/block';
import type { AgentEvent } from '../src/types/Event';

const SESSION_ID = '2108854642652921856';
const TURN_ID = '2108854643462422528';
const CALL_ID = 'call-plan-loading';
const PLAN_TEXT = '## 目标\n\n核验真实产物与回归结果。';
const plan = (overrides: Partial<ToolCallVO> = {}): ToolCallVO => ({
  id: CALL_ID, conversationId: SESSION_ID, type: 'PROMISE', status: 'pending', version: '4',
  toolName: AgentToolName.CreatePlan, content: { kind: 'PLAN', title: '任务计划', text: PLAN_TEXT },
  pending: true, allowedActions: ['APPROVE', 'REJECT'], ...overrides,
});
const view = (sessionId = SESSION_ID, status: BlockStatus = 'PROMISED'): TurnViewVO => ({
  sessionId, turnId: TURN_ID, status: 'WAITING', viewVersion: '4', blocks: [{
    blockId: `tool:${CALL_ID}`, responseId: '896693207532830720', order: 2,
    type: 'TOOL', status, toolCallId: CALL_ID, toolName: AgentToolName.CreatePlan,
    arguments: JSON.stringify({ title: '参数中的标题', text: '参数不能替代权威计划' }),
  }],
});
const records = (card = plan()): SessionMessageVO[] => [{
  id: '2108854746151567361', turnId: TURN_ID, type: 'TOOL', toolCallId: CALL_ID, toolCall: card,
}];
const page = (sessionId = SESSION_ID, card = plan()) => ({
  records: records(card), messages: [], turns: {}, turnViews: { [TURN_ID]: view(sessionId) },
  hasMore: false, nextCursor: null,
});
const session = (messages: ChatMessage[] = []): ChatSession => ({
  id: SESSION_ID, title: '测试会话', messages, createdAt: 0, updatedAt: 0,
  modelId: '', activeTools: [], runStatus: 'SUSPENDED',
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const assertPlan = (messages: ChatMessage[]) => {
  const cards = messages.find(message => message.role === 'assistant')?.promptCards;
  assert.equal(cards?.length, 1, '计划卡必须挂到工具块所属气泡');
  assert.equal(cards[0].id, CALL_ID);
  const data = toPromptCardData(cards[0]);
  assert.equal(data.content, PLAN_TEXT, '正文取自权威工具调用，不能从参数补造');
  assert.equal(canDecideCard(data, 'APPROVE'), true);
};

test('历史首屏：后端 TOOL 行的权威 PLAN 挂到块气泡，正文和审批动作齐全', async t => {
  t.mock.method(SessionAPI, 'messages', async () => ({ code: 1, data: page() }));
  const result = await chatApi.fetchSessionMessages(SESSION_ID);
  assert.equal(result.ok, true);
  if (result.ok) assertPlan(result.data.messages);
});

test('卡片归属：只关联块中确实存在的调用，缺行不造卡，普通工具不入卡', () => {
  const messages = aggregateRecordsByIdentity(SESSION_ID, { [TURN_ID]: view() });
  attachPromptCards(messages, [plan({ id: 'unknown-call' }), plan({ type: 'EXECUTE' })]);
  assert.equal(messages.find(message => message.role === 'assistant')?.promptCards, undefined);
  attachPromptCards(messages, [plan(), plan()]);
  assertPlan(messages);
});

test('进入已有根会话：详情重新投影后仍保留加载到的计划卡', async t => {
  const current = session();
  const detailMessages = aggregateRecordsByIdentity(SESSION_ID, { [TURN_ID]: view() });
  attachPromptCards(detailMessages, [plan()]);
  t.mock.method(chatApi, 'fetchSessionDetail', async () => ({ ok: true, data: {
    ...session(detailMessages), turnViews: { [TURN_ID]: view() }, turns: {},
  } }));
  const localSessions = ref([current]);
  const currentActiveSession = computed(() => localSessions.value[0]);
  const list = useChatSessionList({
    localSessions, localActiveId: ref(SESSION_ID), currentActiveSession,
    displayedMessages: computed(() => currentActiveSession.value.messages),
    localActiveWorkspaceId: ref(null), localSelectedTeamId: ref(null),
    beforeSwitchSession() {}, isGenerating: () => false, scrollToBottomForce() {},
    seedContextUsageFromTree() {}, resetScrollAnchors() {}, onNewSession() {},
  });
  await list.handleSelectSession(SESSION_ID);
  assertPlan(localSessions.value[0].messages);
});

test('挂起后对账与历史翻页：重新投影的根气泡补齐计划正文', async t => {
  setActivePinia(createPinia());
  const current = session();
  const localSessions = ref([current]);
  t.mock.method(chatApi, 'fetchSessionTree', async () => ({ ok: true, data: { rootSessionId: SESSION_ID, root: null, subSessions: [] } }));
  t.mock.method(chatApi, 'fetchSessionMessages', async () => ({ ok: true, data: page() }));
  const history = useChatHistory({
    localSessions, currentActiveSession: computed(() => localSessions.value[0]),
    messagesContainerRef: ref(null), scheduleTimeout: handler => { handler(); return 1; },
  });
  await history.reconcileSessionAfterStream(SESSION_ID);
  assertPlan(localSessions.value[0].messages);
  localSessions.value[0].messages = [];
  localSessions.value[0].hasMoreMessages = true;
  localSessions.value[0].nextMessageCursor = 'older-page';
  await history.handleLoadMoreHistory();
  assertPlan(localSessions.value[0].messages);
});

test('子会话首屏与翻页：各自工具块加载自身计划卡', async t => {
  const childId = '2108854642652921857';
  const local = ref(session());
  local.value.subSessions = [{ id: childId, name: '成员', rootSessionId: SESSION_ID, messages: [] }];
  let hasMore = true;
  t.mock.method(chatApi, 'fetchSessionMessages', async () => ({ ok: true, data: {
    ...page(childId, plan({ conversationId: childId })), hasMore, nextCursor: hasMore ? 'older-page' : null,
  } }));
  const sub = useChatSubSession({ currentActiveSession: computed(() => local.value) });
  await sub.handleSelectSubSessionOption(childId);
  assertPlan(local.value.subSessions![0].messages!);
  local.value.subSessions![0].messages = [];
  hasMore = false;
  await sub.handleLoadMoreSubSessionHistory();
  assertPlan(local.value.subSessions![0].messages!);
});

for (const eventType of ['TURN_SNAPSHOT', 'BLOCK_UPSERT']) {
  test(`实时 ${eventType}：错过框架工具事件也能按权威调用 ID 加载 PLAN`, async () => {
    const messages: ChatMessage[] = [];
    const requested: string[] = [];
    const reducer = new TurnStreamReducer(messages, {
      sessionId: SESSION_ID, onResolveCard: async id => { requested.push(id); return plan(); },
    });
    if (eventType === 'BLOCK_UPSERT') {
      reducer.consume({ type: 'TURN_SNAPSHOT', view: { ...view(), blocks: [] },
        sessionId: SESSION_ID, turnId: TURN_ID, viewVersion: '3' } as unknown as AgentEvent);
    }
    reducer.consume({ type: eventType, view: view(), sessionId: SESSION_ID,
      turnId: TURN_ID, viewVersion: '4' } as unknown as AgentEvent);
    await tick();
    assert.deepEqual(requested, [CALL_ID]);
    assertPlan(messages);
    reducer.consume({ type: eventType, view: view(), sessionId: SESSION_ID,
      turnId: TURN_ID, viewVersion: '4' } as unknown as AgentEvent);
    await tick();
    assert.deepEqual(requested, [CALL_ID], '重放就绪块不重复查询卡片');
    assertPlan(messages);
    reducer.dispose();
  });
}

test('实时卡片已决：工具终态块刷新原计划卡，不继续提供审批动作', async () => {
  const messages: ChatMessage[] = [];
  let card = plan();
  const reducer = new TurnStreamReducer(messages, { sessionId: SESSION_ID, onResolveCard: async () => card });
  reducer.consume({ type: 'TURN_SNAPSHOT', view: view(), sessionId: SESSION_ID,
    turnId: TURN_ID, viewVersion: '4' } as unknown as AgentEvent);
  await tick();
  assertPlan(messages);
  card = plan({ status: 'completed', pending: false, allowedActions: [], rawOutput: { outcome: 'APPROVED' } });
  reducer.consume({ type: 'BLOCK_UPSERT', view: view(SESSION_ID, 'COMPLETED'), sessionId: SESSION_ID,
    turnId: TURN_ID, viewVersion: '4' } as unknown as AgentEvent);
  await tick();
  const cards = messages.find(message => message.role === 'assistant')!.promptCards!;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, 'completed');
  assert.equal(canDecideCard(toPromptCardData(cards[0]), 'APPROVE'), false);
  reducer.dispose();
});
