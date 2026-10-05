import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import {
  parseStreamV3Event,
  resolveExecutionTerminal,
  resolveResponseClosed,
  STREAM_V3_SCHEMA_VERSION,
  isStreamV3EventType,
} from '../src/utils/streamV3';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { fetchBootstrapSnapshot } from '../src/services/streamV3Sync';
import { SessionAPI } from '../src/services/session';
import type { StreamV3Event } from '../src/utils/streamV3';
import type { SessionBootstrapVO, ToolCallVO } from '../src/types/chat';

/** 构造一帧 v3 事件（身份字段缺省为 null，模拟控制帧 / 无归属帧）。 */
function frame(type: StreamV3Event['type'], data: unknown, identity: Partial<StreamV3Event> = {}): StreamV3Event {
  return {
    schemaVersion: STREAM_V3_SCHEMA_VERSION,
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    rootSessionId: identity.rootSessionId ?? '100',
    sessionId: identity.sessionId ?? '100',
    turnId: identity.turnId ?? null,
    executionId: identity.executionId ?? null,
    historyRevision: identity.historyRevision ?? null,
    streamKey: identity.streamKey ?? null,
    type,
    timestamp: identity.timestamp ?? null,
    data,
  };
}

function freshStore() {
  setActivePinia(createPinia());
  return useStreamV3Store();
}

test('卡片版本用 BigInt 精确比较：雪花版本超出 2^53 时旧值不得覆盖', () => {
  const store = freshStore();
  const card = (version: string, status: string, outcome: string | null) => ({
    id: 'call_1', type: 'PROMISE', conversationId: '100', content: { kind: 'PLAN' },
    status, pending: false, allowedActions: [], version, rawOutput: outcome ? { outcome } : null,
  });

  store.ingestToolCall(card('9007199254740993', 'completed', 'APPROVED') as any);
  // 较旧版本（差值在 Number 精度之外，用 Number 比较会误判为相等）
  store.ingestToolCall(card('9007199254740992', 'pending', null) as any);
  assert.equal(store.getTool('call_1')?.version, '9007199254740993', '较旧版本不得覆盖较新值');
  assert.equal((store.getTool('call_1')?.rawOutput as any)?.outcome, 'APPROVED');

  store.ingestToolCall(card('9007199254740994', 'completed', 'CANCELLED') as any);
  assert.equal(store.getTool('call_1')?.version, '9007199254740994', '较新版本必须覆盖');
  assert.equal((store.getTool('call_1')?.rawOutput as any)?.outcome, 'CANCELLED');
});

/* ------------------------------------------------------------------ */
/* A. 帧解析（data.type 分派，非 SSE event: 名；载荷在 data 内不展平）  */
/* ------------------------------------------------------------------ */

test('解析层从 data.type 分派：未知类型记 null（不 fallback 成正文）', () => {
  assert.equal(parseStreamV3Event({ type: 'PARTIAL_TEXT', sessionId: '1' }), null);
  assert.equal(isStreamV3EventType('PARTIAL_TEXT'), false);
  assert.equal(isStreamV3EventType('TEXT_DELTA'), true);
});

test('解析层校验 schemaVersion，非 3 一律拒绝', () => {
  assert.equal(parseStreamV3Event({ schemaVersion: 1, type: 'TEXT_DELTA' }), null);
  assert.equal(parseStreamV3Event({ schemaVersion: 4, type: 'TEXT_DELTA' }), null);
  const ok = parseStreamV3Event({ schemaVersion: 3, type: 'TEXT_DELTA', data: { streamKey: 'k', delta: 'x' } });
  assert.equal(ok?.type, 'TEXT_DELTA');
});

test('解析层不展平载荷：data 保持独立对象', () => {
  const parsed = parseStreamV3Event({
    schemaVersion: 3, type: 'TEXT_DELTA', eventId: 'e1', rootSessionId: '9', sessionId: '9',
    streamKey: 'sk-1', data: { streamKey: 'sk-1', delta: '片段' },
  });
  assert.equal(parsed?.streamKey, 'sk-1');
  assert.deepEqual(parsed?.data, { streamKey: 'sk-1', delta: '片段' });
  // 顶层没有 delta（不展平）
  assert.equal((parsed as unknown as Record<string, unknown>).delta, undefined);
});

/* ------------------------------------------------------------------ */
/* 两个判据：resolveExecutionTerminal（执行收尾） / resolveResponseClosed */
/* （响应停收，含 SUSPENDED）。实时与 bootstrap 两条路径共用同一对谓词。 */
/* ------------------------------------------------------------------ */

test('resolveExecutionTerminal 只认三个真终态，挂起不算本轮收尾', () => {
  for (const state of ['COMPLETED', 'FAILED', 'CANCELLED']) {
    assert.equal(resolveExecutionTerminal(state), true, state);
  }
  // SUSPENDED 之后还会 RUNNING 跑完同一轮次，触发终态对账是白花一次查询。
  for (const state of ['CREATED', 'RUNNING', 'SUSPENDED', '', null, undefined]) {
    assert.equal(resolveExecutionTerminal(state), false, String(state));
  }
});

test('resolveResponseClosed 含 SUSPENDED：挂起也要让当前片段停收增量', () => {
  for (const state of ['COMPLETED', 'FAILED', 'CANCELLED', 'SUSPENDED']) {
    assert.equal(resolveResponseClosed(state), true, state);
  }
  for (const state of ['CREATED', 'RUNNING', '', null, undefined]) {
    assert.equal(resolveResponseClosed(state), false, String(state));
  }
  // 两个判据的差集恰好是 SUSPENDED —— 这是它们必须分开的全部理由。
  assert.equal(resolveResponseClosed('SUSPENDED') && !resolveExecutionTerminal('SUSPENDED'), true);
});

/* ------------------------------------------------------------------ */
/* B. 事件应用规则：11 类型各落唯一槽；未命中忽略                       */
/* ------------------------------------------------------------------ */

test('TEXT_DELTA/THINKING_DELTA 只追加；RESPONSE_FINALIZED 替换全文并定格', () => {
  const store = freshStore();
  store.applyFrame('100', frame('RESPONSE_STARTED', { streamKey: 'sk-1', purpose: 'answer' }, { streamKey: 'sk-1' }));
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-1', delta: '你好' }, { streamKey: 'sk-1' }));
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-1', delta: '，世界' }, { streamKey: 'sk-1' }));
  store.applyFrame('100', frame('THINKING_DELTA', { streamKey: 'sk-1', delta: '思考中' }, { streamKey: 'sk-1' }));

  let slot = store.getResponse('sk-1');
  assert.equal(slot?.text, '你好，世界');
  assert.equal(slot?.thinking, '思考中');
  assert.equal(slot?.finalized, false);

  store.applyFrame('100', frame('RESPONSE_FINALIZED',
    { streamKey: 'sk-1', text: '完整正文', thinking: '完整思考', purpose: 'answer' }, { streamKey: 'sk-1' }));
  slot = store.getResponse('sk-1');
  assert.equal(slot?.text, '完整正文');
  assert.equal(slot?.thinking, '完整思考');
  assert.equal(slot?.finalized, true);
});

test('TOOL_CALL_UPDATED 的 data 即完整 ToolCallVO，按 version 合并进 tools[toolCallId]', () => {
  const store = freshStore();
  const older: ToolCallVO = { id: 'tc-1', version: '10', type: 'PROMISE', status: 'pending', title: '命令审批' };
  const newer: ToolCallVO = { id: 'tc-1', version: '20', type: 'PROMISE', status: 'completed', title: '命令已执行' };
  store.applyFrame('100', frame('TOOL_CALL_UPDATED', older));
  store.applyFrame('100', frame('TOOL_CALL_UPDATED', newer));
  assert.equal(store.getTool('tc-1')?.status, 'completed');

  // 较旧版本不能覆盖较新事件
  store.applyFrame('100', frame('TOOL_CALL_UPDATED', { ...older, version: '5' }));
  assert.equal(store.getTool('tc-1')?.status, 'completed');
});

test('EXECUTION_UPDATED / TURN_UPDATED / SESSION_UPDATED 各自落槽', () => {
  const store = freshStore();
  store.applyFrame('100', frame('EXECUTION_UPDATED', { state: 'RUNNING' }, { executionId: 'ex-1' }));
  assert.equal(store.getExecution('ex-1')?.status, 'RUNNING');

  store.applyFrame('100', frame('TURN_UPDATED',
    { turnId: 't-1', status: 'RUNNING', version: '2' }, { turnId: 't-1' }));
  assert.equal(store.getTurn('t-1')?.status, 'RUNNING');

  store.applyFrame('100', frame('SESSION_UPDATED',
    { id: '100', version: '3', runStatus: 'RUNNING' }));
  assert.equal(store.getSession('100')?.runStatus, 'RUNNING');
});

/* ------------------------------------------------------------------ */
/* D-1. §8.1 路径 1：同 key 的 RESPONSE_FINALIZED / MESSAGE_COMMITTED   */
/* ------------------------------------------------------------------ */

test('路径1：MESSAGE_COMMITTED 绑定落库 ID、替换全文并定格', () => {
  const store = freshStore();
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-a', delta: '半截' }, { streamKey: 'sk-a' }));
  assert.equal(store.getResponse('sk-a')?.finalized, false);

  store.applyFrame('100', frame('MESSAGE_COMMITTED',
    { streamKey: 'sk-a', messageId: 'msg-9', sessionId: '100', turnId: 't-1', text: '权威全文', type: 'AI' },
    { streamKey: 'sk-a' }));

  const slot = store.getResponse('sk-a');
  assert.equal(slot?.messageId, 'msg-9');
  assert.equal(slot?.text, '权威全文');
  assert.equal(slot?.finalized, true);
  assert.equal(slot?.incompleteUntilFinalized, false);
});

/* ------------------------------------------------------------------ */
/* D-2. §8.1 路径 2：执行终态（实时 或 bootstrap 等价，同一谓词）          */
/* ------------------------------------------------------------------ */

test('路径2（实时）：EXECUTION_UPDATED 的终态结束相关响应进行态', () => {
  const store = freshStore();
  store.applyFrame('100', frame('RESPONSE_STARTED', { streamKey: 'sk-b' }, { streamKey: 'sk-b', executionId: 'ex-2' }));
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-b', delta: '进行中' }, { streamKey: 'sk-b', executionId: 'ex-2' }));
  assert.equal(store.getResponse('sk-b')?.finalized, false);

  store.applyFrame('100', frame('EXECUTION_UPDATED', { state: 'COMPLETED' }, { executionId: 'ex-2' }));

  const slot = store.getResponse('sk-b');
  assert.equal(slot?.finalized, true);
  assert.equal(slot?.incompleteUntilFinalized, true);
  // 已收片段保留，不被清空
  assert.equal(slot?.text, '进行中');
});

test('路径2（bootstrap 等价）：executions[].status 终态结束归属该执行的响应，与实时同一谓词', () => {
  const store = freshStore();
  // 先有一个进行中的响应（未见证 STARTED → 接续片段）；帧带 executionId（生产帧顶层就有）。
  store.applyFrame('100', frame('TEXT_DELTA',
    { streamKey: 'sk-c', delta: '断线前片段' }, { streamKey: 'sk-c', sessionId: '100', executionId: 'ex-3' }));
  assert.equal(store.getResponse('sk-c')?.finalized, false);

  const snapshot: SessionBootstrapVO = {
    rootSessionId: '100',
    historyRevision: '7',
    sessions: [],
    history: { records: [], turns: {}, nextCursor: null, hasMore: false },
    toolCalls: [],
    turns: [],
    executions: [{ executionId: 'ex-3', sessionId: '100', status: 'COMPLETED', startedAt: null, completedAt: null }],
  };
  store.applyBootstrap('100', snapshot);

  const slot = store.getResponse('sk-c');
  assert.equal(slot?.finalized, true);
  assert.equal(slot?.incompleteUntilFinalized, true);
  assert.equal(slot?.text, '断线前片段');
});

test('路径2（实时）：SUSPENDED 定格当前片段，拒绝迟到增量（§8.1 路径 2）', () => {
  const store = freshStore();
  store.applyFrame('100', frame('RESPONSE_STARTED', { streamKey: 'sk-e' }, { streamKey: 'sk-e', executionId: 'ex-5' }));
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-e', delta: '暂停前正文' }, { streamKey: 'sk-e', executionId: 'ex-5' }));

  store.applyFrame('100', frame('EXECUTION_UPDATED', { state: 'SUSPENDED' }, { executionId: 'ex-5' }));

  // §8.1 路径 2：挂起也结束这一段响应的进行态 —— 定格为「未接收完整」，保留已收片段。
  // 这不代表执行终结（它还会恢复），只代表「这个 streamKey 不会再收增量」。
  const slot = store.getResponse('sk-e');
  assert.equal(slot?.finalized, true, '挂起后该片段停收增量');
  assert.equal(slot?.incompleteUntilFinalized, true);
  assert.equal(slot?.text, '暂停前正文', '已收片段必须保留');

  // §8.1 路径 4：定格之后的迟到帧不得复活响应。
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-e', delta: '迟到正文' },
    { streamKey: 'sk-e', executionId: 'ex-5' }));
  assert.equal(store.getResponse('sk-e')?.text, '暂停前正文', '迟到增量不得追加');
});

test('路径2（bootstrap 等价）：SUSPENDED 同样定格现有片段，与实时同一谓词', () => {
  const store = freshStore();
  store.applyFrame('100', frame('TEXT_DELTA',
    { streamKey: 'sk-d', delta: '断线前片段' }, { streamKey: 'sk-d', sessionId: '100', executionId: 'ex-4' }));
  assert.equal(store.getResponse('sk-d')?.finalized, false, '接续片段初始是活的');
  const snapshot: SessionBootstrapVO = {
    rootSessionId: '100', historyRevision: '1', sessions: [],
    history: { records: [], turns: {}, nextCursor: null, hasMore: false },
    toolCalls: [], turns: [],
    executions: [{ executionId: 'ex-4', sessionId: '100', status: 'SUSPENDED', startedAt: null, completedAt: null }],
  };
  store.applyBootstrap('100', snapshot);
  // 断线期间执行被挂起：bootstrap 与实时暂停必须给同一种判定 —— 定格、保留片段。
  const slot = store.getResponse('sk-d');
  assert.equal(slot?.finalized, true, 'bootstrap 的挂起也要定格片段');
  assert.equal(slot?.incompleteUntilFinalized, true);
  assert.equal(slot?.text, '断线前片段');
});

/* --- 路径 2 反例：必须按执行精确匹配，不得误伤其他执行 / 归属未知的响应 --- */

test('路径2反例1：同 store 两执行并发，一个终态只定格它自己那条响应', () => {
  const store = freshStore();
  // 执行 ex-a 的响应（见证 STARTED，绑定 ex-a）
  store.applyFrame('100', frame('RESPONSE_STARTED', { streamKey: 'sk-a2' }, { streamKey: 'sk-a2', executionId: 'ex-a' }));
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-a2', delta: 'A进行中' }, { streamKey: 'sk-a2', executionId: 'ex-a' }));
  // 执行 ex-b 的响应（并发，绑定 ex-b）
  store.applyFrame('100', frame('RESPONSE_STARTED', { streamKey: 'sk-b2' }, { streamKey: 'sk-b2', executionId: 'ex-b' }));
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-b2', delta: 'B进行中' }, { streamKey: 'sk-b2', executionId: 'ex-b' }));

  // ex-a 终止 → 只定格 sk-a2
  store.applyFrame('100', frame('EXECUTION_UPDATED', { state: 'COMPLETED' }, { executionId: 'ex-a' }));

  const a = store.getResponse('sk-a2');
  const b = store.getResponse('sk-b2');
  assert.equal(a?.finalized, true);
  assert.equal(a?.incompleteUntilFinalized, true);
  // ex-b 的响应绝不能被误伤
  assert.equal(b?.finalized, false);
  assert.equal(b?.incompleteUntilFinalized, false);

  // ex-b 后续 delta 仍正常追加（未被路径 4 丢弃）
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-b2', delta: '继续' }, { streamKey: 'sk-b2', executionId: 'ex-b' }));
  assert.equal(store.getResponse('sk-b2')?.text, 'B进行中继续');
});

test('路径2反例2：归属未知（无 executionId）的响应不被任意 EXECUTION_UPDATED 误伤', () => {
  const store = freshStore();
  // 帧顶层无 executionId → slot.executionId 为 null
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-unknown', delta: '归属未知' }, { streamKey: 'sk-unknown', sessionId: '100' }));
  assert.equal(store.getResponse('sk-unknown')?.executionId, null);

  store.applyFrame('100', frame('EXECUTION_UPDATED', { state: 'COMPLETED' }, { executionId: 'ex-x' }));
  store.applyFrame('100', frame('EXECUTION_UPDATED', { state: 'FAILED' }, { executionId: 'ex-y' }));

  const slot = store.getResponse('sk-unknown');
  // 关键：不得被任意执行终态误定为已定格（`finalized` 仍为 false）。
  assert.equal(slot?.finalized, false);
  // 收到 delta 却未见 STARTED → 「接续片段」标记为 true 是无关的正常行为（未被终态改动）。
  assert.equal(slot?.text, '归属未知');
});

test('路径2反例3：bootstrap 只带 ex-a 终态 → 只定格 ex-a 的响应，ex-b 与归属未知均不动', () => {
  const store = freshStore();
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-a3', delta: 'A' }, { streamKey: 'sk-a3', sessionId: '100', executionId: 'ex-a' }));
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-b3', delta: 'B' }, { streamKey: 'sk-b3', sessionId: '100', executionId: 'ex-b' }));
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-u3', delta: 'U' }, { streamKey: 'sk-u3', sessionId: '100' }));

  const snapshot: SessionBootstrapVO = {
    rootSessionId: '100', historyRevision: '2', sessions: [],
    history: { records: [], turns: {}, nextCursor: null, hasMore: false },
    toolCalls: [], turns: [],
    executions: [{ executionId: 'ex-a', sessionId: '100', status: 'FAILED', startedAt: null, completedAt: null }],
  };
  store.applyBootstrap('100', snapshot);

  assert.equal(store.getResponse('sk-a3')?.finalized, true, 'ex-a 应定格');
  assert.equal(store.getResponse('sk-b3')?.finalized, false, 'ex-b 不得被误伤');
  assert.equal(store.getResponse('sk-u3')?.finalized, false, '归属未知不得被误伤');
});

test('路径2反例4：路径4 只在归属执行内生效 —— ex-b 迟到帧被丢，ex-a 已定格不回退', () => {
  const store = freshStore();
  store.applyFrame('100', frame('RESPONSE_STARTED', { streamKey: 'sk-a4' }, { streamKey: 'sk-a4', executionId: 'ex-a' }));
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-a4', delta: 'A已固定' }, { streamKey: 'sk-a4', executionId: 'ex-a' }));
  store.applyFrame('100', frame('EXECUTION_UPDATED', { state: 'CANCELLED' }, { executionId: 'ex-a' }));

  // ex-a 的迟到 delta 被丢弃
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-a4', delta: '迟到X' }, { streamKey: 'sk-a4', executionId: 'ex-a' }));
  assert.equal(store.getResponse('sk-a4')?.text, 'A已固定');
  assert.equal(store.getResponse('sk-a4')?.text?.includes('迟到X'), false);
});

/* ------------------------------------------------------------------ */
/* D-3. §8.1 路径 3：historyRevision 变更 → 旧代际整体作废              */
/* ------------------------------------------------------------------ */

test('路径3：HISTORY_INVALIDATED 清除未提交响应并把代际推进', () => {
  const store = freshStore();
  // 未提交响应
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-old', delta: '旧代际' }, { streamKey: 'sk-old', sessionId: '100' }));
  // 已提交响应
  store.applyFrame('100', frame('MESSAGE_COMMITTED',
    { streamKey: 'sk-done', messageId: 'msg-1', sessionId: '100', turnId: null, text: '已落库', type: 'AI' },
    { streamKey: 'sk-done', sessionId: '100' }));

  store.applyFrame('100', frame('HISTORY_INVALIDATED', { rootSessionId: '100', historyRevision: '42' }));

  // 未提交的随代际作废：立**墓碑**而非删除 —— 删除会让仍在网络上的迟到帧用同一 streamKey 复活。
  const discarded = store.getResponse('sk-old');
  assert.equal(discarded?.discarded, true);
  assert.equal(discarded?.text, '', '作废后不得保留可渲染的正文');
  // 已提交的属于持久化历史，保留
  assert.equal(store.getResponse('sk-done')?.messageId, 'msg-1');
  assert.equal(store.historyRevision.get('100'), '42');
});

/* ------------------------------------------------------------------ */
/* D-4. §8.1 路径 4：定格之后迟到帧不得复活                             */
/* ------------------------------------------------------------------ */

test('路径4：定格之后迟到的 STARTED / DELTA 被丢弃，不复活响应', () => {
  const store = freshStore();
  store.applyFrame('100', frame('RESPONSE_STARTED', { streamKey: 'sk-e' }, { streamKey: 'sk-e', executionId: 'ex-5' }));
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-e', delta: '已固定' }, { streamKey: 'sk-e', executionId: 'ex-5' }));
  store.applyFrame('100', frame('EXECUTION_UPDATED', { state: 'FAILED' }, { executionId: 'ex-5' }));
  assert.equal(store.getResponse('sk-e')?.finalized, true);

  // 迟到帧：不得追加、不得复活
  store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-e', delta: '迟到片段' }, { streamKey: 'sk-e', executionId: 'ex-5' }));
  store.applyFrame('100', frame('RESPONSE_STARTED', { streamKey: 'sk-e' }, { streamKey: 'sk-e', executionId: 'ex-5' }));

  const slot = store.getResponse('sk-e');
  assert.equal(slot?.text, '已固定');
  assert.equal(slot?.text?.includes('迟到片段'), false);

  // 路径 1 优先级最高：后续完整响应仍可修复正文
  store.applyFrame('100', frame('RESPONSE_FINALIZED', { streamKey: 'sk-e', text: '修复后的完整正文' }, { streamKey: 'sk-e', executionId: 'ex-5' }));
  assert.equal(store.getResponse('sk-e')?.text, '修复后的完整正文');
});

/* ------------------------------------------------------------------ */
/* C. bootstrap 时序：暂存屏障 + STREAM_READY 校验                       */
/* ------------------------------------------------------------------ */

test('STREAM_READY 读 connectionId 与 schemaVersion；版本非 3 放弃同步', () => {
  const store = freshStore();
  store.beginSync('100');
  const ok = store.onStreamReady('100', frame('STREAM_READY', { connectionId: 'conn-1', schemaVersion: 3 }));
  assert.equal(ok, true);
  assert.equal(store.connectionIds['100'], 'conn-1');
  assert.equal(store.getPhase('100'), 'bootstrapping');

  const store2 = freshStore();
  store2.beginSync('200');
  const bad = store2.onStreamReady('200', frame('STREAM_READY', { connectionId: 'c', schemaVersion: 1 }));
  assert.equal(bad, false);
  assert.equal(store2.getPhase('200'), 'idle');
});

test('bootstrap 在途的新帧先暂存，合并后按 FIFO 回放（实时不早于快照应用）', () => {
  const store = freshStore();
  store.beginSync('100');
  store.onStreamReady('100', frame('STREAM_READY', { connectionId: 'c', schemaVersion: 3 }));

  // 快照在途期间的实时帧：应被暂存而非直接应用
  store.ingress('100', frame('TEXT_DELTA', { streamKey: 'sk-live', delta: '在途帧' }, { streamKey: 'sk-live', sessionId: '100' }));
  assert.equal(store.getResponse('sk-live'), undefined); // 尚未应用

  const snapshot: SessionBootstrapVO = {
    rootSessionId: '100', historyRevision: '1', sessions: [],
    history: { records: [], turns: {}, nextCursor: null, hasMore: false },
    toolCalls: [], turns: [], executions: [],
  };
  store.applyBootstrap('100', snapshot);

  // 回放后进入 live，且暂存帧已应用
  assert.equal(store.getPhase('100'), 'live');
  assert.equal(store.getResponse('sk-live')?.text, '在途帧');
});

test('live 阶段的帧直接应用，不进入暂存', () => {
  const store = freshStore();
  store.beginSync('100');
  store.onStreamReady('100', frame('STREAM_READY', { connectionId: 'c', schemaVersion: 3 }));
  store.applyBootstrap('100', {
    rootSessionId: '100', historyRevision: '1', sessions: [],
    history: { records: [], turns: {}, nextCursor: null, hasMore: false },
    toolCalls: [], turns: [], executions: [],
  });
  store.ingress('100', frame('TEXT_DELTA', { streamKey: 'sk-live', delta: '直接应用' }, { streamKey: 'sk-live' }));
  assert.equal(store.getResponse('sk-live')?.text, '直接应用');
});

test('bootstrap 范围外实体不被当作已删除（保留既有槽）', () => {
  const store = freshStore();
  store.applyFrame('100', frame('TOOL_CALL_UPDATED', { id: 'tc-keep', version: '1', type: 'PROMISE', pending: true }));
  const snapshot: SessionBootstrapVO = {
    rootSessionId: '100', historyRevision: '1', sessions: [],
    history: { records: [], turns: {}, nextCursor: null, hasMore: false },
    toolCalls: [], turns: [], executions: [],
  };
  store.applyBootstrap('100', snapshot);
  // 快照未下发该卡片，但已有实时值必须保留（范围外 ≠ 已删除）
  assert.equal(store.getTool('tc-keep')?.id, 'tc-keep');
});

/* ------------------------------------------------------------------ */
/* C. fetchBootstrapSnapshot 复用既有装配逻辑（aggregateSessionMessages） */
/* ------------------------------------------------------------------ */

test('fetchBootstrapSnapshot 复用历史装配逻辑，失败时返回可重试错误', async context => {
  context.mock.method(SessionAPI, 'bootstrap', async () => ({
    code: 1,
    data: {
      rootSessionId: '100',
      historyRevision: '9',
      sessions: [],
      history: {
        records: [
          { id: 'm1', turnId: 't-1', type: 'USER', text: '你好', createTime: '2026-01-01T00:00:00Z' },
          { id: 'm2', turnId: 't-1', type: 'AI', text: '回复', createTime: '2026-01-01T00:00:01Z' },
        ],
        turns: { 't-1': { turnId: 't-1', status: 'COMPLETED' } },
        nextCursor: 'cur-1',
        hasMore: true,
      },
      toolCalls: [],
      turns: [{ turnId: 't-2', status: 'RUNNING' }],
      executions: [],
    } as SessionBootstrapVO,
  }));

  const ok = await fetchBootstrapSnapshot('100');
  assert.equal(ok.ok, true);
  if (!ok.ok) assert.fail(ok.error);
  // 历史记录经同一聚合器转换为展示消息（user + assistant 两条）
  assert.equal(ok.data.messages.length, 2);
  assert.equal(ok.data.messages[0]?.role, 'user');
  assert.equal(ok.data.messages[1]?.role, 'assistant');
  assert.equal(ok.data.historyRevision, '9');
  assert.equal(ok.data.nextCursor, 'cur-1');
  assert.equal(ok.data.hasMore, true);
  assert.equal(ok.data.activeTurns.length, 1);

  // 后端拒绝（code=0）→ 判别结构失败，带可重试错误
  context.mock.method(SessionAPI, 'bootstrap', async () => ({ code: 0, errMsg: '无权访问' }));
  const failed = await fetchBootstrapSnapshot('100');
  assert.equal(failed.ok, false);
  if (failed.ok) assert.fail('预期失败');
  assert.equal(failed.error, '无权访问');
});
