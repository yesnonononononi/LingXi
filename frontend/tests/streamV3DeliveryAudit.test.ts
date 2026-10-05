import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { attachStreamV3, detachStreamV3 } from '../src/services/streamV3Sync';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { useChatView } from '../src/views/chat/useChatView';
import { chatApi } from '../src/services/chat';
import { projectSessionMessages } from '../src/views/chat/messageProjection';
import { createHarness, flush, frame, readyFrame, bootstrapSnapshot, promiseCard } from './harness/streamV3Harness';

const rows = [
  { id: '1', sessionId: '100', turnId: 't1', type: 'USER', text: '应保留的第一轮提问' },
  { id: '2', sessionId: '100', turnId: 't1', type: 'AI', text: '应保留的第一轮回答' },
  { id: '3', sessionId: '100', turnId: 't2', type: 'USER', text: '将被重发的第二轮' },
];

async function setupSync() {
  const harness = createHarness();
  const store = useStreamV3Store();
  const session = attachStreamV3('100');
  await flush();
  harness.server.push('100', readyFrame('delivery-connection'));
  await flush();
  return { harness, store, finish() { detachStreamV3(session); harness.teardown(); } };
}

test('交付核验：重复 READY 后仍为 live，后续增量立即应用', async () => {
  const a = await setupSync();
  try {
    a.harness.bootstrap.resolveNext(bootstrapSnapshot());
    await flush();
    a.harness.server.push('100', readyFrame('delivery-connection'),
      frame('TEXT_DELTA', { streamKey: 'duplicate-ready', delta: '仍然渲染' }, { turnId: 't1', executionId: 'e1' }));
    await flush();
    assert.equal(a.store.getPhase('100'), 'live');
    assert.equal(a.store.getResponse('duplicate-ready')?.text, '仍然渲染');
    assert.equal(a.harness.bootstrap.calls.length, 1);
  } finally { a.finish(); }
});

test('交付核验：快照已含新代际，暂存的同代际作废事件不得清掉快照', async () => {
  const a = await setupSync();
  try {
    a.harness.server.push('100', frame('HISTORY_INVALIDATED', { rootSessionId: '100', historyRevision: '2' }));
    await flush();
    a.harness.bootstrap.resolveNext(bootstrapSnapshot({ historyRevision: '2',
      history: { records: rows.slice(0, 2) as any, turns: {}, hasMore: false, nextCursor: null } }));
    await flush();
    assert.equal(a.store.currentHistoryRevision('100'), '2');
    assert.ok(a.store.getHistory('100').has('1'), '回放同代际失效事件清掉了权威快照');
  } finally { a.finish(); }
});

test('交付核验：重发第二轮后第一轮有效历史仍在，且不依赖终态回查', async () => {
  const a = await setupSync();
  try {
    a.harness.bootstrap.resolveNext(bootstrapSnapshot({
      history: { records: rows as any, turns: {}, hasMore: false, nextCursor: null } }));
    await flush();
    a.harness.server.push('100', frame('HISTORY_INVALIDATED', { rootSessionId: '100', historyRevision: '2' }));
    await flush();
    a.store.discardByInvalidation('100', ['t2'], ['e2']);
    assert.ok(a.store.getHistory('100').has('1'), '根会话整体清空使重发点之前的有效历史丢失');
    assert.ok(a.store.getHistory('100').has('2'));
    assert.equal(a.store.getHistory('100').has('3'), false);
  } finally { a.finish(); }
});

test('交付核验：bootstrap 失败应主动登记恢复，不等待服务端再发 READY', async () => {
  const a = await setupSync();
  const originalTimer = window.setTimeout;
  const scheduled: Array<() => void> = [];
  try {
    window.setTimeout = ((callback: () => void, delay: number) => {
      if (delay > 0) { scheduled.push(callback); return -1; }
      return originalTimer(callback, delay);
    }) as any;
    a.harness.bootstrap.rejectNext();
    await flush();
    assert.ok(scheduled.length > 0 || a.harness.bootstrap.calls.length > 1,
      '同步失败后连接仍开着，但没有重试或重连任务，缺失的快照无法自愈');
  } finally { window.setTimeout = originalTimer; a.finish(); }
});

test('交付核验：暂存溢出后旧 bootstrap 不得被接受为完整同步', async () => {
  const a = await setupSync();
  try {
    a.harness.server.push('100', frame('TEXT_DELTA', { streamKey: 'overflow', delta: 'x'.repeat(2 * 1024 * 1024 + 1) },
      { turnId: 't1', executionId: 'e1' }));
    await flush();
    assert.equal(a.store.getPhase('100'), 'idle');
    a.harness.bootstrap.resolveNext(bootstrapSnapshot());
    await flush();
    assert.notEqual(a.store.getPhase('100'), 'live', '已丢失暂存帧的旧同步仍被标记为成功');
  } finally { a.finish(); }
});

test('交付核验：实时 SESSION_UPDATED 的 RUNNING 应进入界面发送守卫', async () => {
  const harness = createHarness();
  const scope = effectScope();
  const originalDetail = chatApi.fetchSessionDetail;
  const originalModels = chatApi.fetchModels;
  const originalConfigs = chatApi.fetchUserConfigs;
  const view = scope.run(() => useChatView({}, (() => undefined) as any))!;
  try {
    view.localSessions.value = [{ id: '100', title: '会话', createdAt: 0, updatedAt: 0, messages: [], runStatus: 'IDLE' }] as any;
    (chatApi as any).fetchSessionDetail = async () => ({ ok: true, data: {
      id: '100', title: '会话', rawRecords: [], turns: {}, subSessions: [], runStatus: 'IDLE' } });
    (chatApi as any).fetchModels = async () => ({ ok: true, data: [] });
    (chatApi as any).fetchUserConfigs = async () => ({ ok: true, data: [] });
    await view.handleSelectSession('100');
    await flush();
    harness.server.push('100', readyFrame('delivery-view'));
    await flush();
    harness.bootstrap.resolveNext(bootstrapSnapshot({ sessions: [{ id: '100', runStatus: 'IDLE', version: '1' } as any] }));
    await flush();
    harness.server.push('100', frame('SESSION_UPDATED', { id: '100', runStatus: 'RUNNING', version: '2' }));
    await flush();
    assert.equal(useStreamV3Store().sessions.get('100')?.runStatus, 'RUNNING');
    assert.equal(view.isSending.value, true, 'v3 已为 RUNNING，界面仍读旧会话条目的 IDLE');
  } finally {
    scope.stop(); harness.teardown();
    chatApi.fetchSessionDetail = originalDetail;
    chatApi.fetchModels = originalModels;
    chatApi.fetchUserConfigs = originalConfigs;
  }
});

test('交付核验：快照已有已审批卡片，回放旧 pending 帧不得复活审批按钮', async () => {
  const a = await setupSync();
  try {
    const pending = promiseCard({ id: 'staged-card', version: '1', executionId: 'e1' });
    const decided = promiseCard({ id: 'staged-card', version: '2', executionId: 'e1',
      pending: false, status: 'completed', allowedActions: [], rawOutput: { outcome: 'APPROVED' } });
    a.harness.server.push('100', frame('TOOL_CALL_UPDATED', pending));
    await flush();
    a.harness.bootstrap.resolveNext(bootstrapSnapshot({ toolCalls: [], history: {
      records: [...rows.slice(0, 2), { id: '4', sessionId: '100', turnId: 't1', type: 'TOOL',
        toolCallId: 'staged-card', toolCall: decided }] as any,
      turns: {}, hasMore: false, nextCursor: null,
    } }));
    await flush();
    const cards = projectSessionMessages('100').flatMap(message => message.promptCards ?? []);
    assert.ok(cards.some(card => card.toolCallId === 'staged-card'));
    assert.equal(cards.filter(card => card.toolCallId === 'staged-card' && card.pending).length, 0,
      '快照历史里的 v2 已决断事实没有进入 tools 比较基线，回放 v1 又显示待审批');
  } finally { a.finish(); }
});

test('交付核验：同会话连续两次执行结束，必须分别触发终态对账', async () => {
  const harness = createHarness();
  const scope = effectScope();
  const originals = { detail: chatApi.fetchSessionDetail, models: chatApi.fetchModels,
    configs: chatApi.fetchUserConfigs, tree: chatApi.fetchSessionTree, pages: chatApi.fetchSessionMessages };
  const view = scope.run(() => useChatView({}, (() => undefined) as any))!;
  const reconciled: string[] = [];
  try {
    view.localSessions.value = [{ id: '100', title: '会话', createdAt: 0, updatedAt: 0, messages: [], runStatus: 'IDLE' }] as any;
    (chatApi as any).fetchSessionDetail = async () => ({ ok: true, data: {
      id: '100', title: '会话', rawRecords: [], turns: {}, subSessions: [], runStatus: 'IDLE' } });
    (chatApi as any).fetchModels = async () => ({ ok: true, data: [] });
    (chatApi as any).fetchUserConfigs = async () => ({ ok: true, data: [] });
    (chatApi as any).fetchSessionTree = async (id: string) => {
      reconciled.push(id);
      return { ok: true, data: { rootSessionId: id, root: { runStatus: 'IDLE' }, subSessions: [] } };
    };
    (chatApi as any).fetchSessionMessages = async () => ({ ok: true,
      data: { records: [], turns: {}, hasMore: false, nextCursor: null } });
    await view.handleSelectSession('100');
    await flush();
    harness.server.push('100', readyFrame('delivery-terminal'));
    await flush();
    harness.bootstrap.resolveNext(bootstrapSnapshot());
    await flush();
    harness.server.push('100', frame('EXECUTION_UPDATED', { state: 'COMPLETED' }, { executionId: 'e1', turnId: 't1' }));
    await flush();
    assert.equal(reconciled.length, 1);
    harness.server.push('100', frame('EXECUTION_UPDATED', { state: 'RUNNING' }, { executionId: 'e2', turnId: 't2' }));
    await flush();
    harness.server.push('100', frame('EXECUTION_UPDATED', { state: 'COMPLETED' }, { executionId: 'e2', turnId: 't2' }));
    await flush();
    assert.equal(reconciled.length, 2, '旧执行终态一直存在，watch 标量不再变化，第二次收尾永不触发');
  } finally {
    scope.stop(); harness.teardown();
    chatApi.fetchSessionDetail = originals.detail; chatApi.fetchModels = originals.models;
    chatApi.fetchUserConfigs = originals.configs; chatApi.fetchSessionTree = originals.tree;
    chatApi.fetchSessionMessages = originals.pages;
  }
});
