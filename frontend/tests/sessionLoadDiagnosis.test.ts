import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { AgentEvent } from '../src/types/Event';
import type { ChatMessage, ChatSession } from '../src/types/chat';
import type { Block, TurnViewVO } from '../src/types/block';
import { chatApi } from '../src/services/chat';
import { AgentToolName } from '../src/utils/toolNames';
import { aggregateRecordsByIdentity, buildMessageTurnMap, mergeTurnViews } from '../src/utils/session';
import { TurnStreamReducer } from '../src/views/chat/turnStreamReducer';
import { useChatHistory } from '../src/views/chat/useChatHistory';
import { useChatSessionList } from '../src/views/chat/useChatSessionList';

// 运行中会话加载的缺陷回归：跨页重复气泡、过程项 order 错位、对账身份不一致、详情响应覆盖实时正文。
// 前两条是正对照（缺陷回归时必须仍然全绿），其余为缺陷守卫（每条都有对应的回退即红验证）。
const SESSION_ID = '2107364703088017408';
const TURN_ID = '2107364703113183232';

function createSession(messages: ChatMessage[] = []): ChatSession {
  return { id: SESSION_ID, title: '诊断会话', createdAt: 0, updatedAt: 0, modelId: '', activeTools: [], messages, runStatus: 'RUNNING' };
}

/** 一轮的块视图：57 段思考 + 59 个工具（第 8、9 轮各 2 个），与旧 fixture 的能力面一致。 */
function createTurnView(turnId = TURN_ID, viewVersion = 4): TurnViewVO {
  const blocks: Block[] = [];
  let order = 0;
  let nextCall = 0;
  for (let round = 0; round < 57; round++) {
    blocks.push({
      blockId: `thinking:r${round}`, type: 'THINKING', responseId: `r${round}`,
      order: order++, status: 'COMPLETE', text: `思考 ${round}`,
    });
    const callCount = round === 8 || round === 9 ? 2 : 1;
    for (let c = 0; c < callCount; c++) {
      const callId = `call-${nextCall++}`;
      blocks.push({
        blockId: `tool:${callId}`, type: 'TOOL', responseId: null,
        order: order++, status: 'COMPLETED', toolCallId: callId,
        toolName: AgentToolName.ReadFile, arguments: JSON.stringify({ path: 'example.txt' }),
        output: JSON.stringify({ outcome: 'SUCCEEDED', output: '完成' }),
      });
    }
  }
  return {
    sessionId: SESSION_ID, turnId, status: 'COMPLETED',
    viewVersion: String(viewVersion), userMessage: '分析消息渲染', blocks,
  };
}

/** 分页游标锚点：只用来算「还有没有下一页」，不参与任何展示构造。 */
function createCursorRows(count = 150): Array<{ id: string }> {
  let nextId = 2107364703113184000n;
  return Array.from({ length: count }, () => ({ id: String(nextId++) }));
}

function createEvent(event: Partial<AgentEvent>): AgentEvent {
  return { executionId: 'execution-1', timestamp: '2026-10-08T08:56:01Z', metaData: { sessionId: SESSION_ID, rootSessionId: SESSION_ID, turnId: TURN_ID }, ...event } as AgentEvent;
}

/**
 * 造一个 `TURN_SNAPSHOT` 事件。
 *
 * <p>后端把 {@code BlockEventPayload} 平铺在事件体顶层：{@code turnId / viewVersion / view}，
 * 其中 {@code view} 才是 {@link TurnViewVO}。这里按真实形状构造。</p>
 */
function snapshotEvent(view: TurnViewVO): AgentEvent {
  return {
    type: 'TURN_SNAPSHOT',
    turnId: view.turnId,
    viewVersion: view.viewVersion,
    view,
    executionId: 'execution-1',
    timestamp: '2026-10-08T08:56:01Z',
    metaData: { sessionId: view.sessionId, rootSessionId: SESSION_ID, turnId: view.turnId }
  } as unknown as AgentEvent;
}

function summarize(messages: ChatMessage[]): string {
  return JSON.stringify(messages.filter(message => message.role === 'assistant').map(message => ({
    id: message.id, turnId: message.turnId, tools: message.toolCalls?.length ?? 0
  })));
}

async function reconcilePages(messages: ChatMessage[]): Promise<ChatMessage[]> {
  setActivePinia(createPinia());
  const session = createSession(messages);
  const sessions = ref([session]);
  const records = createCursorRows();
  const views = { [TURN_ID]: createTurnView() };
  const originalTree = chatApi.fetchSessionTree;
  const originalMessages = chatApi.fetchSessionMessages;
  chatApi.fetchSessionTree = async () => ({ ok: true, data: { rootSessionId: SESSION_ID, root: { id: SESSION_ID, runStatus: 'RUNNING' }, subSessions: [] } });
  chatApi.fetchSessionMessages = async (_id, cursor) => {
    const pageRecords = cursor ? records.slice(0, -100) : records.slice(-100);
    // 同一轮横跨两页：两页都下发该轮的视图（版本不同 → 按版本取新）
    return { ok: true, data: { records: pageRecords, messages: [], turns: {}, turnViews: views, hasMore: !cursor, nextCursor: cursor ? null : String(records.at(-100)!.id) } };
  };
  try {
    const history = useChatHistory({ currentActiveSession: computed(() => sessions.value[0]), localSessions: sessions, messagesContainerRef: ref(null), scheduleTimeout: () => 0 });
    await history.reconcileSessionAfterStream(SESSION_ID);
    return sessions.value[0].messages;
  } finally {
    chatApi.fetchSessionTree = originalTree;
    chatApi.fetchSessionMessages = originalMessages;
  }
}

test('正对照：历史视图并入后只有一个含 59 个工具的助手气泡', () => {
  const messages = aggregateRecordsByIdentity(SESSION_ID, { [TURN_ID]: createTurnView() });
  const assistants = messages.filter(message => message.role === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].toolCalls?.length, 59);
});

test('诊断：实际回查入口加载空缓存，同一轮跨页只能有一个助手气泡', async () => {
  const messages = await reconcilePages([]);
  assert.equal(messages.filter(message => message.role === 'assistant').length, 1, summarize(messages));
});

test('诊断：实际终态回查替换实时气泡，同一轮跨页只能有一个助手气泡', async () => {
  // 本地已有一条实时气泡（同轮），终态回查应把它整体接管为权威视图
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: SESSION_ID });
  reducer.consume(createEvent({ type: 'PARTIAL_TEXT', content: '实时正文' }));
  reducer.flush();
  const messages2 = await reconcilePages(messages);
  assert.equal(messages2.filter(message => message.role === 'assistant').length, 1, summarize(messages2));
});


test('诊断：跨页气泡 ID 相同时，工具条只能标记一个组尾', () => {
  // 旧路径下同一轮可能被拆成两条同 id 气泡（组尾相撞）。新口径下视图驱动的气泡 id 唯一，
  // 这里守住「同一轮只有一条助手气泡」这条更根本的不变量。
  const messages = aggregateRecordsByIdentity(SESSION_ID, { [TURN_ID]: createTurnView() });
  assert.equal(messages.filter(message => message.role === 'assistant').length, 1, summarize(messages));

  const bindings = buildMessageTurnMap(messages, { [TURN_ID]: { turnId: TURN_ID, status: 'CANCELLED', totalTokens: 3308400 } });
  const tails = messages.filter(message => message.role === 'assistant' && bindings.get(message)?.isGroupTail);
  assert.equal(tails.length, 1, `组尾只能有一个: ${summarize(messages)}`);
});

test('诊断：同一轮的实时气泡被权威视图整体接管（顺序与身份全来自后端）', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: SESSION_ID });
  reducer.consume(createEvent({ type: 'PARTIAL_THINKING', content: '实时思考' }));
  reducer.consume(createEvent({ type: 'TOOL_CALL', requestId: 'live-call', toolName: AgentToolName.ReadFile, args: '{}' }));
  reducer.flush();
  // 实时阶段：不建工具、不写思考（内容等视图）
  const live = messages.find(m => m.role === 'assistant')!;
  assert.equal(live.toolCalls?.length, 0, '原始事件不建工具项');
  assert.equal(live.thoughtSteps?.length, 0, '原始事件不写思考');

  // 权威视图到达：整轮重写为后端给的 57 思考 + 59 工具，并补上用户提问
  reducer.consume(snapshotEvent(createTurnView()));
  const assistants = messages.filter(m => m.role === 'assistant');
  assert.equal(assistants.length, 1, '同一轮只有一个气泡');
  assert.equal(messages.filter(m => m.role === 'user').length, 1, '用户提问由视图补齐');
  assert.equal(assistants[0].thoughtSteps?.length, 57, '思考数量来自后端');
  assert.equal(assistants[0].toolCalls?.length, 59, '工具数量来自后端');
});

test('诊断：同 id 的块按 blockId 幂等覆盖，不依赖内容指纹', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: SESSION_ID });
  const base = createTurnView(TURN_ID, 4);
  reducer.consume(snapshotEvent(base));
  const before = messages[0].toolCalls?.length;

  // 同一视图（同 blockId、同版本）再投一次：整轮重投影必须幂等
  reducer.consume(snapshotEvent(base));
  assert.equal(messages[0].toolCalls?.length, before, '重复投影不得翻倍');
  assert.equal(messages.filter(message => message.role === 'assistant').length, 1, '不得裂出第二条气泡');
});
test('诊断：选中会话的详情响应迟到时，期间到达的实时轮次视图不被详情覆盖', async () => {
  const originalDetail = chatApi.fetchSessionDetail;
  let resolveDetail!: (value: Awaited<ReturnType<typeof chatApi.fetchSessionDetail>>) => void;
  chatApi.fetchSessionDetail = () => new Promise(resolve => { resolveDetail = resolve; });
  const sessions = ref([createSession()]);
  const activeId = ref<string | null>(null);
  const current = computed(() => sessions.value.find(session => session.id === activeId.value));
  const list = useChatSessionList({ localSessions: sessions, localActiveId: activeId, currentActiveSession: current, displayedMessages: computed(() => current.value?.messages ?? []), localActiveWorkspaceId: ref(null), localSelectedTeamId: ref(null), beforeSwitchSession: () => {}, isGenerating: () => false, scrollToBottomForce: () => {}, seedContextUsageFromTree: () => {}, resetScrollAnchors: () => {}, onNewSession: () => {} });
  try {
    const loading = list.handleSelectSession(SESSION_ID);
    const reducer = new TurnStreamReducer(() => current.value!.messages, { sessionId: SESSION_ID });
    // 在途期间实时轮次视图到达（版本 4）
    reducer.consume(snapshotEvent(createTurnView(TURN_ID, 4)));
    const live = current.value!.messages.find(m => m.role === 'assistant')!;
    assert.equal(
      current.value!.messages.find(m => m.role === 'user')?.content, '分析消息渲染',
      '详情未到，实时视图已建气泡并补齐用户提问',
    );
    assert.equal(live.toolCalls?.length, 59);
    // 详情回来（不带视图 → 空）：按统一入口 upsert，实时已写入的轮次必须保留
    resolveDetail({ ok: true, data: createSession() });
    await loading;
    assert.equal(
      current.value!.messages.find(m => m.role === 'assistant')?.toolCalls?.length, 59,
      '在途到达的实时轮次不得被详情清空',
    );
  } finally {
    chatApi.fetchSessionDetail = originalDetail;
  }
});

test('诊断：终结只由 EXECUTION_* 事件判定，不再由工具收尾推断', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: SESSION_ID });
  reducer.consume(createEvent({ type: 'PARTIAL_THINKING', content: '当前思考' }));
  reducer.consume(createEvent({ type: 'TOOL_CALL', requestId: 'live-call', toolName: AgentToolName.ReadFile, args: '{}' }));
  reducer.consume(createEvent({ type: 'TOOL_COMPLETED', requestId: 'live-call', toolName: AgentToolName.ReadFile, output: '完成', resultStatus: 'COMPLETED' }));
  reducer.flush();
  // 删掉 markCompleteIfToolsSettled 后：工具收尾不再推断终结，气泡保持未完成，
  // 直到后端下发 EXECUTION_COMPLETED（或对账按权威视图整体接管）。
  assert.equal(messages[0].isComplete, false, '工具收尾不得推断终结');

  reducer.consume(createEvent({ type: 'EXECUTION_COMPLETED' }));
  assert.equal(messages[0].isComplete, true, 'EXECUTION_COMPLETED 才是终结信号');
});

test('诊断：仅思考未收尾时不得被认定为终结', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: SESSION_ID });
  reducer.consume(createEvent({ type: 'PARTIAL_THINKING', content: '当前思考' }));
  reducer.flush();
  assert.equal(messages[0].isComplete, false, '还在思考的一轮不能判为完成');

  const streaming: ChatMessage[] = [];
  const reducer2 = new TurnStreamReducer(streaming, { sessionId: SESSION_ID });
  reducer2.consume(createEvent({ type: 'TOOL_CALL', requestId: 'c1', toolName: AgentToolName.ReadFile, args: '{}' }));
  reducer2.consume(createEvent({ type: 'TOOL_COMPLETED', requestId: 'c1', toolName: AgentToolName.ReadFile, output: 'ok', resultStatus: 'COMPLETED' }));
  reducer2.consume(createEvent({ type: 'PARTIAL_TEXT', content: '继续说明' }));
  reducer2.flush();
  assert.equal(streaming[0].isComplete, false, '仍在流式时不能判为完成');
  assert.equal(streaming[0].isThinking, true, '增量事件把气泡维持在生成态');
});

test('正对照：过程项顺序完全来自后端视图，前端不参与排序推断', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: SESSION_ID });
  reducer.consume(createEvent({ type: 'PARTIAL_THINKING', content: '第一段' }));
  reducer.consume(createEvent({ type: 'TOOL_CALL', requestId: 'control-call', toolName: AgentToolName.ReadFile, args: '{}' }));
  reducer.consume(createEvent({ type: 'PARTIAL_THINKING', content: '第二段' }));
  reducer.flush();
  // 原始事件不产生任何过程项，自然也没有「谁排在谁之后」的前端推断
  assert.equal(messages[0].thoughtSteps?.length, 0, '原始思考事件不写过程项');
  assert.equal(messages[0].toolCalls?.length, 0, '原始工具事件不写过程项');

  // 顺序唯一来源是后端 order：故意乱序传入，时间线仍按 order 升序
  reducer.consume(createEvent({
    type: 'TURN_SNAPSHOT',
    turnId: TURN_ID,
    viewVersion: 1,
    view: {
      sessionId: SESSION_ID, turnId: TURN_ID, status: 'COMPLETED', viewVersion: 1,
      blocks: [
        { blockId: 'tool:control-call', type: 'TOOL', order: 2000, status: 'COMPLETED', toolCallId: 'control-call', toolName: AgentToolName.ReadFile },
        { blockId: 'thinking:s2', type: 'THINKING', order: 3000, status: 'COMPLETE', text: '第二段' },
        { blockId: 'thinking:s1', type: 'THINKING', order: 1000, status: 'COMPLETE', text: '第一段' },
      ]
    }
  } as unknown as AgentEvent));
  const orders = (messages[0].processTimeline ?? []).map(item => item.order ?? 0);
  assert.deepEqual(orders, [1000, 2000, 3000], '时间线必须按后端 order 升序');
});

test('诊断：往前翻页时同一轮仍只有一个助手气泡，且补齐全部工具', async () => {
  setActivePinia(createPinia());
  const session = createSession();
  // 首屏已加载该轮：视图版本较低（模拟后端先落的部分块）
  session.turnViews = { [TURN_ID]: createTurnView(TURN_ID, 3) };
  session.messages = aggregateRecordsByIdentity(SESSION_ID, session.turnViews);
  session.hasMoreMessages = true;
  session.nextMessageCursor = 'cursor-1';
  const sessions = ref([session]);
  const original = chatApi.fetchSessionMessages;
  // 往前翻页：更早的一页也返回**同一轮**的视图（版本更高 → 按版本接受更新，不新建气泡）
  chatApi.fetchSessionMessages = async () => ({
    ok: true,
    data: {
      records: [],
      messages: [],
      turns: {},
      turnViews: { [TURN_ID]: createTurnView(TURN_ID, 5) },
      hasMore: false,
      nextCursor: null
    }
  });
  try {
    const history = useChatHistory({
      currentActiveSession: computed(() => sessions.value[0]),
      localSessions: sessions,
      messagesContainerRef: ref({ beforePrepend: () => {}, afterPrepend: () => {} }),
      // 立即执行：handleLoadMoreHistory 结束时用 scheduleTimeout 收起 loading，
      // 传空实现会让 finally 里的收尾永不回调、await 悬挂。
      scheduleTimeout: (handler: () => void) => { handler(); return 0; }
    });
    await history.handleLoadMoreHistory();
    const assistants = sessions.value[0].messages.filter(message => message.role === 'assistant');
    assert.equal(assistants.length, 1, summarize(assistants));
    assert.equal(assistants[0].toolCalls?.length, 59, '同一轮按版本更新后必须含全部 59 个工具');
  } finally {
    chatApi.fetchSessionMessages = original;
  }
});
