import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { AgentEvent } from '../src/types/Event';
import type { ChatMessage, ChatSession, SessionMessageVO } from '../src/types/chat';
import type { Block, TurnViewVO } from '../src/types/block';
import { chatApi } from '../src/services/chat';
import { AgentToolName } from '../src/utils/toolNames';
import { aggregateRecordsByIdentity, aggregateSessionMessages, buildMessageTurnMap, mergeMessagesByTurn, mergeRawRecords, mergeTurnViews } from '../src/utils/session';
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

/** 兼容旧用例：保留原始消息行 fixture（仅用于 mergeRawRecords 等纯函数用例）。 */
function createRecords(): SessionMessageVO[] {
  const records: SessionMessageVO[] = [];
  let nextRecordId = 2107364703113184000n;
  let nextCall = 0;
  const append = (record: Omit<SessionMessageVO, 'id' | 'turnId'>): void => {
    records.push({ ...record, id: String(nextRecordId++), turnId: TURN_ID, createTime: '2026-10-08T08:56:00Z' });
  };
  append({ type: 'USER', text: '分析消息渲染' });
  for (let round = 0; round < 57; round++) {
    const calls = Array.from({ length: round === 8 || round === 9 ? 2 : 1 }, () => ({
      id: `call-${nextCall++}`, name: AgentToolName.ReadFile, arguments: JSON.stringify({ path: 'example.txt' })
    }));
    append({ type: 'AI', thinking: `思考 ${round}`, toolCalls: calls });
    for (const call of calls) {
      append({ type: 'TOOL', toolCallId: call.id, toolCall: {
        id: call.id, toolName: AgentToolName.ReadFile, type: 'EXECUTE', status: 'completed',
        rawOutput: { outcome: 'SUCCEEDED', output: '完成' }
      } });
    }
  }
  return records;
}

function createEvent(event: Partial<AgentEvent>): AgentEvent {
  return { executionId: 'execution-1', timestamp: '2026-10-08T08:56:01Z', metaData: { sessionId: SESSION_ID, rootSessionId: SESSION_ID, turnId: TURN_ID }, ...event } as AgentEvent;
}

function summarize(messages: ChatMessage[]): string {
  return JSON.stringify(messages.filter(message => message.role === 'assistant').map(message => ({
    id: message.id, turnId: message.turnId, tools: message.toolCalls?.length ?? 0
  })));
}

async function reconcilePages(messages: ChatMessage[], terminal: boolean): Promise<ChatMessage[]> {
  setActivePinia(createPinia());
  const session = createSession(messages);
  const sessions = ref([session]);
  const records = createRecords();
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
    await history.reconcileSessionAfterStream(SESSION_ID, terminal ? [TURN_ID] : null);
    return sessions.value[0].messages;
  } finally {
    chatApi.fetchSessionTree = originalTree;
    chatApi.fetchSessionMessages = originalMessages;
  }
}

test('正对照：历史视图并入后只有一个含 59 个工具的助手气泡', () => {
  const messages = aggregateRecordsByIdentity(undefined, undefined, SESSION_ID, { [TURN_ID]: createTurnView() });
  const assistants = messages.filter(message => message.role === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].toolCalls?.length, 59);
});

test('诊断：实际回查入口加载空缓存，同一轮跨页只能有一个助手气泡', async () => {
  const messages = await reconcilePages([], false);
  assert.equal(messages.filter(message => message.role === 'assistant').length, 1, summarize(messages));
});

test('诊断：实际终态回查替换实时气泡，同一轮跨页只能有一个助手气泡', async () => {
  const local = aggregateSessionMessages(createRecords().slice(-100), SESSION_ID);
  const messages = await reconcilePages(local, true);
  assert.equal(messages.filter(message => message.role === 'assistant').length, 1, summarize(messages));
});

test('诊断：回查期间已有实时气泡，同一轮应补齐所有分页的工具', async () => {
  const local: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(local, { sessionId: SESSION_ID });
  reducer.consume(createEvent({ type: 'PARTIAL_THINKING', content: '当前思考' }));
  // 实时气泡必须被认定为「已终结」才会走「用权威历史替换」这条路，否则对账会把它当
  // 「仍在生成」而只做补齐。工具结果事件是「本轮工具已收尾」的唯一实时凭据，因此这里补上
  // TOOL_CALL + TOOL_COMPLETED —— 本用例模拟的是「一轮跑完、终结事件在订阅建立前就已发生」。
  reducer.consume(createEvent({ type: 'TOOL_CALL', requestId: 'live-call', toolName: AgentToolName.ReadFile, args: '{}' }));
  reducer.consume(createEvent({ type: 'TOOL_COMPLETED', requestId: 'live-call', toolName: AgentToolName.ReadFile, output: '完成', resultStatus: 'COMPLETED' }));
  reducer.flush();
  const messages = await reconcilePages(local, true);
  // 该轮已终结：权威历史整体接管，工具集合恰为落库的 59 个（实时那条也在历史里，不重复计）
  assert.equal(messages.find(message => message.role === 'assistant')?.toolCalls?.length, 59, summarize(messages));
});

test('诊断：跨页气泡 ID 相同时，工具条只能标记一个组尾', () => {
  const records = createRecords();
  const messages = [...aggregateSessionMessages(records.slice(0, -100), SESSION_ID), ...aggregateSessionMessages(records.slice(-100), SESSION_ID)];
  // 跨页拆出的两条助手气泡必须能同时存在于渲染列表里（否则「组尾相撞」根本不会发生，
  // 断言也就测不到东西）。这里显式构造两条同 id 不同对象的气泡。
  assert.equal(messages.filter(message => message.role === 'assistant').length, 2, summarize(messages));
  const bindings = buildMessageTurnMap(messages, { [TURN_ID]: { turnId: TURN_ID, status: 'CANCELLED', totalTokens: 3308400 } });
  const tails = messages.filter(message => message.role === 'assistant' && bindings.get(message)?.isGroupTail);
  assert.equal(tails.length, 1, `两条气泡复用了相同的 Map 键: ${summarize(tails)}`);
});

test('诊断：历史气泡续写的新思考必须排在所有旧过程之后', () => {
  const messages = aggregateSessionMessages(createRecords(), SESSION_ID);
  const bubble = messages.find(message => message.role === 'assistant')!;
  const maxOrder = Math.max(...(bubble.thoughtSteps ?? []).map(step => step.order ?? 0), ...(bubble.toolCalls ?? []).map(call => call.order ?? 0));
  const reducer = new TurnStreamReducer(messages, { sessionId: SESSION_ID });
  reducer.consume(createEvent({ type: 'PARTIAL_THINKING', content: '新思考' }));
  reducer.flush();
  const newOrder = bubble.thoughtSteps!.at(-1)!.order!;
  assert.ok(newOrder > maxOrder, `newOrder=${newOrder}, 历史最大 order=${maxOrder}`);
});

test('诊断：同 id 的过程项按 id 归并，不再依赖内容指纹', () => {
  // 接入 Block 契约后两侧身份同源（thinking:<responseId> / tool:<toolCallId>），
  // 同一块在历史与实时两侧取同一个 id，按 id 归并即幂等。
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: SESSION_ID });
  reducer.consume(createEvent({ type: 'PARTIAL_THINKING', content: '同一段思考' }));
  reducer.consume(createEvent({ type: 'PARTIAL_TEXT', content: '读取说明' }));
  reducer.consume(createEvent({ type: 'TOOL_CALL', requestId: 'same-call', toolName: AgentToolName.ReadFile, args: '{}' }));
  reducer.flush();
  // 历史侧给的是「权威 blockId」形状的 id，与实时侧（step-<bubbleId>-<n>）不同 ——
  // 这正是接入契约前的真实形态；按 id 归并下它们各保留一份，是契约落地后的预期行为。
  const history = aggregateSessionMessages([{ id: '2107364703113185000', turnId: TURN_ID, type: 'AI', thinking: '同一段思考', text: '读取说明', toolCalls: [{ id: 'same-call', name: AgentToolName.ReadFile, arguments: '{}' }] }], SESSION_ID);
  const merged = mergeMessagesByTurn({ local: messages, history });
  const bubble = merged[0];
  // 工具按裸 toolCallId 去重（两侧同源）→ 必须只剩 1 条，这是真正的不变量。
  assert.equal(bubble.toolCalls?.length, 1, `工具 ID=${bubble.toolCalls?.map(call => call.id)}`);
  // 合并结果按 order 升序，渲染层不会看到错位。
  const orders = (bubble.processTimeline ?? []).map(item => item.order ?? 0);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), `时间线 order 未升序: ${orders}`);
});

test('诊断：合并结果的时间线必须按 order 升序（不能依赖「本地在前」的拼接顺序）', () => {
  // 本地实时项 order 由 nextOrderFor 从气泡最大值续写；历史权威项 order 来自后端千位槽。
  // 若合并只做「本地在前、历史在后」的拼接，而历史里存在 order 更大的项（分页补齐的更晚块），
  // 渲染层升序排序就会把历史项插到本地项之前 —— 用户看到「刚续写的思考跑到旧过程里」。
  const local: ChatMessage[] = [{
    id: 'bubble-merge-order',
    role: 'assistant',
    content: '',
    timestamp: 1,
    turnId: 'turn-merge-order',
    thoughtSteps: [
      { id: 'thinking:resp-later', title: '思考', content: '本地更晚的思考', status: 'running', order: 7000 }
    ],
    toolCalls: [],
    aiMessages: []
  }];
  const history: ChatMessage[] = [{
    id: 'srv-merge-order',
    role: 'assistant',
    content: '',
    timestamp: 2,
    turnId: 'turn-merge-order',
    thoughtSteps: [
      { id: 'thinking:resp-earlier', title: '思考', content: '历史更早的思考', status: 'success', order: 5000 }
    ],
    toolCalls: [],
    aiMessages: []
  }];

  const merged = mergeMessagesByTurn({ local, history });
  const orders = (merged[0].thoughtSteps ?? []).map(step => step.order ?? 0);
  // 插入序是「本地在前」，而历史项 order 更小 —— 只有真正按 order 排序才能得到 [5000, 7000]。
  assert.deepEqual(orders, [5000, 7000], `过程项未按 order 升序合并: ${JSON.stringify(orders)}`);
});

test('诊断：选中会话的详情响应迟到时，保留已收到的实时正文', async () => {
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
    reducer.consume(createEvent({ type: 'PARTIAL_TEXT', content: '详情请求期间已到达的正文' }));
    reducer.flush();
    resolveDetail({ ok: true, data: createSession() });
    await loading;
    assert.equal(current.value!.messages[0]?.content, '详情请求期间已到达的正文');
  } finally {
    chatApi.fetchSessionDetail = originalDetail;
  }
});

test('诊断：终结事件在订阅建立前已发生，工具收尾后本轮必须被认定为终结', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: SESSION_ID });
  reducer.consume(createEvent({ type: 'PARTIAL_THINKING', content: '当前思考' }));
  reducer.consume(createEvent({ type: 'TOOL_CALL', requestId: 'live-call', toolName: AgentToolName.ReadFile, args: '{}' }));
  reducer.consume(createEvent({ type: 'TOOL_COMPLETED', requestId: 'live-call', toolName: AgentToolName.ReadFile, output: '完成', resultStatus: 'COMPLETED' }));
  // 没有 EXECUTION_COMPLETED：用户是在执行跑完之后才进入这个会话的
  reducer.flush();
  // 不认终结 → 对账永远只「补齐」不「替换」，该轮工具条永不出现、状态永远停在运行中
  assert.equal(messages[0].isComplete, true, '全部工具已收尾即本轮已终结');
});

test('诊断：仅思考未收尾时不得被认定为终结', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: SESSION_ID });
  reducer.consume(createEvent({ type: 'PARTIAL_THINKING', content: '当前思考' }));
  reducer.flush();
  assert.equal(messages[0].isComplete, false, '还在思考的一轮不能判为完成');

  // 中间叙述帧会把 isThinking / isExploring 都置为 false，据此判终结会把仍在跑的一轮提前钉死
  const streaming: ChatMessage[] = [];
  const reducer2 = new TurnStreamReducer(streaming, { sessionId: SESSION_ID });
  reducer2.consume(createEvent({ type: 'TOOL_CALL', requestId: 'c1', toolName: AgentToolName.ReadFile, args: '{}' }));
  reducer2.consume(createEvent({ type: 'TOOL_COMPLETED', requestId: 'c1', toolName: AgentToolName.ReadFile, output: 'ok', resultStatus: 'COMPLETED' }));
  reducer2.consume(createEvent({ type: 'PARTIAL_TEXT', content: '继续说明' }));
  reducer2.flush();
  assert.equal(streaming[0].isComplete, false, '仍有正文在流式时不能判为完成');
  // 前提确认：isThinking 在工具收尾后仍为 true（工具收尾不改变思考态），
  // 因此「用 isThinking/isExploring 推断终结」会在本轮仍要继续时误判 —— 判据只能看工具结果。
  assert.equal(streaming[0].isThinking, true, '（前提确认：isThinking 与工具收尾无关，不能当终结判据）');
});

test('正对照：仅实时路径连续新增思考时，新过程排在旧工具之后', () => {
  const messages: ChatMessage[] = [];
  const reducer = new TurnStreamReducer(messages, { sessionId: SESSION_ID });
  reducer.consume(createEvent({ type: 'PARTIAL_THINKING', content: '第一段' }));
  reducer.consume(createEvent({ type: 'TOOL_CALL', requestId: 'control-call', toolName: AgentToolName.ReadFile, args: '{}' }));
  reducer.consume(createEvent({ type: 'PARTIAL_THINKING', content: '第二段' }));
  reducer.flush();
  assert.ok(messages[0].thoughtSteps![1].order! > messages[0].toolCalls![0].order!);
});

test('诊断：往前翻页时同一轮仍只有一个助手气泡，且补齐全部工具', async () => {
  setActivePinia(createPinia());
  const session = createSession();
  // 首屏已加载该轮：视图版本较低（模拟后端先落的部分块）
  session.turnViews = { [TURN_ID]: createTurnView(TURN_ID, 3) };
  session.messages = aggregateRecordsByIdentity(undefined, undefined, SESSION_ID, session.turnViews);
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
