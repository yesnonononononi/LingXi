import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { useChatView } from '../src/views/chat/useChatView';
import { chatApi } from '../src/services/chat';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { useSseRouterStore } from '../src/stores/sseRouter';
import { createHarness, flush, frame, readyFrame, bootstrapSnapshot, promiseCard, subSessionVO } from './harness/streamV3Harness';

/** 缺陷 4（重发幂等作废）与缺陷 5（未决集合跨根对账）的边界核验。 */
function setupProbe() {
  const harness = createHarness();
  const scope = effectScope();
  const view = scope.run(() => useChatView({}, (() => undefined) as any))!;
  const store = useStreamV3Store();
  const originals = {
    detail: chatApi.fetchSessionDetail, models: chatApi.fetchModels,
    configs: chatApi.fetchUserConfigs, command: chatApi.sendCommand,
  };
  (chatApi as any).fetchModels = async () => ({ ok: true, data: [] });
  (chatApi as any).fetchUserConfigs = async () => ({ ok: true, data: [] });
  (chatApi as any).fetchSessionDetail = async (id: string) => ({ ok: true, data: {
    id, title: id, rawRecords: [], turns: {}, subSessions: [],
    runStatus: 'IDLE', hasMoreMessages: false, nextMessageCursor: null,
  } });
  view.localSessions.value = ['100', '300'].map(id => ({
    id, title: id, createdAt: 0, updatedAt: 0, messages: [], runStatus: 'IDLE',
  })) as any;
  async function enter(id: string, overrides: any = {}) {
    await view.handleSelectSession(id);
    await flush();
    harness.server.push(id, readyFrame(`ready-${id}`));
    await flush();
    harness.bootstrap.resolveNext(bootstrapSnapshot({
      rootSessionId: id, historyRevision: '1', sessions: [{ id } as any],
      history: { records: [
        { id: `${id}1`, sessionId: id, turnId: `${id}-t1`, type: 'USER', text: `${id}提问` },
        { id: `${id}2`, sessionId: id, turnId: `${id}-t1`, type: 'AI', text: `${id}已提交回答` },
      ], turns: {}, nextCursor: null, hasMore: false },
      ...overrides,
    }));
    await flush();
  }
  return { harness, view, store, enter, cleanup() {
    scope.stop(); harness.teardown();
    chatApi.fetchSessionDetail = originals.detail; chatApi.fetchModels = originals.models;
    chatApi.fetchUserConfigs = originals.configs; chatApi.sendCommand = originals.command;
  } };
}

test('边界：重发回执先到、失效事件后到，两个通道顺序颠倒也收敛', async () => {
  const p = setupProbe();
  try {
    await p.enter('100');
    await p.view.handleModelUpdated();
    let release!: (value: any) => void;
    (chatApi as any).sendCommand = () => new Promise(resolve => { release = resolve; });
    const resending = p.view.handleResendMessage({ id: '1001', role: 'user', content: '100提问' } as any);
    // 顺序颠倒：回执先返回，失效事件后到
    release({ sessionId: '100', turnId: '100-t2', executionId: 'e2', invalidatedTurnIds: ['100-t1'], invalidatedExecutionIds: ['e1'] });
    await resending;
    await flush();
    p.harness.server.push('100', frame('HISTORY_INVALIDATED', { rootSessionId: '100', historyRevision: '2' }),
      frame('MESSAGE_COMMITTED', { messageId: '1003', sessionId: '100', turnId: '100-t2', type: 'USER', text: '重发提问' }),
      frame('MESSAGE_COMMITTED', { messageId: '1004', sessionId: '100', turnId: '100-t2', type: 'AI', text: '重发后的正文', streamKey: 'resend-live' },
        { sessionId: '100', turnId: '100-t2', executionId: 'e2' }));
    await flush();
    assert.ok(p.view.displayedMessages.value.some(m => m.content.includes('重发后的正文')),
      '反向顺序下新代际正文丢失');
  } finally { p.cleanup(); }
});

test('边界：重发回执重复投递两次，结果幂等', async () => {
  const p = setupProbe();
  try {
    await p.enter('100');
    await p.view.handleModelUpdated();
    (chatApi as any).sendCommand = async () => ({ sessionId: '100', turnId: '100-t2', executionId: 'e2', invalidatedTurnIds: ['100-t1'], invalidatedExecutionIds: ['e1'] });
    await p.view.handleResendMessage({ id: '1001', role: 'user', content: '100提问' } as any);
    await flush();
    p.harness.server.push('100', frame('MESSAGE_COMMITTED', { messageId: '1004', sessionId: '100', turnId: '100-t2', type: 'AI', text: '正文', streamKey: 'rk' },
      { sessionId: '100', turnId: '100-t2', executionId: 'e2' }));
    await flush();
    const before = p.view.displayedMessages.value.map(m => m.content).join('|');

    // 同一回执再走一次
    await p.view.handleResendMessage({ id: '1001', role: 'user', content: '100提问' } as any);
    await flush();
    const after = p.view.displayedMessages.value.map(m => m.content).join('|');
    assert.equal(after, before, '重复回执改变了视图');
  } finally { p.cleanup(); }
});

test('边界：回执只带 turnIds 不带 executionIds 不应崩', async () => {
  const p = setupProbe();
  try {
    await p.enter('100');
    await p.view.handleModelUpdated();
    (chatApi as any).sendCommand = async () => ({ sessionId: '100', turnId: '100-t2', executionId: 'e2', invalidatedTurnIds: ['100-t1'] });
    await p.view.handleResendMessage({ id: '1001', role: 'user', content: '100提问' } as any);
    await flush();
    p.harness.server.push('100', frame('MESSAGE_COMMITTED', { messageId: '1004', sessionId: '100', turnId: '100-t2', type: 'AI', text: '正文', streamKey: 'rk2' },
      { sessionId: '100', turnId: '100-t2', executionId: 'e2' }));
    await flush();
    assert.ok(p.view.displayedMessages.value.some(m => m.content.includes('正文')));
  } finally { p.cleanup(); }
});

test('边界：对 100 做未决对账，不得误删 300 的待审批卡', async () => {
  const p = setupProbe();
  try {
    // 300 上先挂一张未决卡（快照也带上它，保持「仍在未决集合」的真实语义）
    const card300 = promiseCard({ id: 'card-300', conversationId: '300', executionId: 'e300' });
    await p.enter('300', { toolCalls: [card300] });
    p.harness.server.push('300', frame('TOOL_CALL_UPDATED', card300));
    await flush();
    assert.ok(p.store.getTool('card-300'), '300 的卡未建立');

    // 切到 100，100 的快照未决集合为空（只影响 100 树）
    await p.enter('100');
    assert.equal(p.store.getTool('card-300')?.id, 'card-300', '对 100 的对账误删了 300 的卡');

    // 切回 300（快照仍声明该卡未决），卡片应仍在且仍待审批
    await p.enter('300', { toolCalls: [card300] });
    const cards = p.view.displayedMessages.value.flatMap(m => m.promptCards ?? []);
    assert.equal(cards.filter(c => c.toolCallId === 'card-300' && c.pending).length, 1,
      '切回后 300 的卡丢失或不再待审批');
  } finally { p.cleanup(); }
});

test('边界：300 未决集合真的不含该卡时，对账应清掉它（300 自己重同步）', async () => {
  const p = setupProbe();
  try {
    const card300 = promiseCard({ id: 'card-300', conversationId: '300', executionId: 'e300' });
    await p.enter('300', { toolCalls: [card300] });
    assert.ok(p.store.getTool('card-300'));

    // 必须真的切走再切回：同会话重复进入不会重新挂流，快照也就不会应用。
    await p.enter('100');
    await p.enter('300', { toolCalls: [] });
    assert.equal(p.store.getTool('card-300'), undefined, '本根未决集合外的过期卡未被清理');
  } finally { p.cleanup(); }
});

test('边界：子会话的待审批卡仍能冒泡到根视图', async () => {
  const p = setupProbe();
  try {
    // 100 根 + 101 子
    await p.enter('100', { sessions: [{ id: '100' } as any, subSessionVO('101', '100', '子代理')] });
    p.harness.server.push('100', frame('SESSION_UPDATED', subSessionVO('101', '100', '子代理')),
      frame('TOOL_CALL_UPDATED', promiseCard({ id: 'card-sub', conversationId: '101', executionId: 'eSub' })));
    await flush();
    const cards = p.view.displayedMessages.value.flatMap(m => m.promptCards ?? []);
    assert.equal(cards.filter(c => c.toolCallId === 'card-sub' && c.pending).length, 1,
      '子会话待审批卡未冒泡到根视图');

    // 用「100 树内未决集合含该卡」的快照重同步，卡片必须还在
    await p.enter('100', { sessions: [{ id: '100' } as any, subSessionVO('101', '100', '子代理')],
      toolCalls: [promiseCard({ id: 'card-sub', conversationId: '101', executionId: 'eSub' })] });
    const after = p.view.displayedMessages.value.flatMap(m => m.promptCards ?? []);
    assert.equal(after.filter(c => c.toolCallId === 'card-sub' && c.pending).length, 1,
      '对账把子会话仍在未决集合里的卡误删了');
  } finally { p.cleanup(); }
});
