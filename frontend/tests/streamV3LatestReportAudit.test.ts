import test from 'node:test';
import assert from 'node:assert/strict';
import { attachStreamV3, detachStreamV3 } from '../src/services/streamV3Sync';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { createHarness, flush, frame, readyFrame, bootstrapSnapshot } from './harness/streamV3Harness';

async function setupSync(revision = '1') {
  const harness = createHarness();
  const store = useStreamV3Store();
  const session = attachStreamV3('100');
  await flush();
  harness.server.push('100', readyFrame('latest-audit'));
  await flush();
  harness.bootstrap.resolveNext(bootstrapSnapshot({ historyRevision: revision }));
  await flush();
  return { harness, store, session, finish() { detachStreamV3(session); harness.teardown(); } };
}

test('最新报告复核：执行 SUSPENDED 仍可恢复，但当前响应片段必须拒绝迟到增量', async () => {
  const a = await setupSync();
  try {
    const identity = { sessionId: '100', turnId: 't1', executionId: 'e1', historyRevision: '1' };
    a.harness.server.push('100', frame('RESPONSE_STARTED', { streamKey: 'paused-response' }, identity),
      frame('TEXT_DELTA', { streamKey: 'paused-response', delta: '暂停前正文' }, identity),
      frame('EXECUTION_UPDATED', { state: 'SUSPENDED' }, identity));
    await flush();
    assert.equal(a.store.executions.get('e1')?.status, 'SUSPENDED');
    a.harness.server.push('100', frame('TEXT_DELTA', { streamKey: 'paused-response', delta: '迟到正文' }, identity));
    await flush();
    assert.equal(a.store.getResponse('paused-response')?.text, '暂停前正文',
      'docs/stream-protocol-v3-design.md §8.1 要求暂停定格当前片段；这不代表执行终结');
  } finally { a.finish(); }
});

test('最新报告复核：重挂 bootstrap 的 SUSPENDED 也必须定格现有片段', async () => {
  const a = await setupSync();
  let reattached: ReturnType<typeof attachStreamV3> | undefined;
  try {
    const identity = { sessionId: '100', turnId: 't1', executionId: 'e1', historyRevision: '1' };
    a.harness.server.push('100', frame('TEXT_DELTA', { streamKey: 'before-reattach', delta: '已收到片段' }, identity));
    await flush();
    a.session.detach();
    reattached = attachStreamV3('100');
    await flush();
    assert.equal(a.harness.bootstrap.pendingCount, 1);
    a.harness.bootstrap.resolveNext(bootstrapSnapshot({ executions: [
      { executionId: 'e1', sessionId: '100', status: 'SUSPENDED', startedAt: null, completedAt: null },
    ] }));
    await flush();
    assert.equal(a.store.getPhase('100'), 'live');
    assert.equal(a.store.getResponse('before-reattach')?.finalized, true,
      '断线期间已暂停，bootstrap 与实时暂停必须使用相同的片段定格规则');
  } finally { if (reattached) detachStreamV3(reattached); a.finish(); }
});

test('最新报告复核：根 revision=2 时，后端子会话自身 revision=1 不得被错判为旧事实', async () => {
  const a = await setupSync('2');
  try {
    // 载荷按 CommittedStateV3Observer.publishSessionUpdated 构造：信封取实体自身 revision。
    // SubSessionResolver 新建子会话不继承根 revision，Session 默认值为 1。
    a.harness.server.push('100', frame('SESSION_UPDATED', {
      id: '200', rootSessionId: '100', historyRevision: '1', version: '10', name: '新子会话',
    }, { rootSessionId: '100', sessionId: '200', historyRevision: '1' }));
    await flush();
    assert.ok(a.store.sessions.has('200'),
      '全事件根代际守卫与现有 SESSION_UPDATED 生产端口径冲突，新子会话实体被丢弃');
  } finally { a.finish(); }
});

test('最新报告复核：溢出后的退避可以完成第二次快照并恢复至 live', async () => {
  const harness = createHarness();
  const store = useStreamV3Store();
  const session = attachStreamV3('100');
  const originalTimer = window.setTimeout;
  const retries: Array<() => void> = [];
  try {
    await flush();
    harness.server.push('100', readyFrame('overflow-complete'));
    await flush();
    window.setTimeout = ((callback: () => void, delay: number) => {
      if (delay >= 1000 && delay <= 4000) { retries.push(callback); return -1; }
      return originalTimer(callback, delay);
    }) as any;
    harness.server.push('100', frame('TEXT_DELTA', { streamKey: 'overflow', delta: 'x'.repeat(2 * 1024 * 1024 + 1) }));
    await flush();
    harness.bootstrap.resolveNext(bootstrapSnapshot());
    await flush();
    assert.equal(retries.length, 1);
    retries[0]!();
    await flush();
    assert.equal(harness.bootstrap.calls.length, 2);
    harness.bootstrap.resolveNext(bootstrapSnapshot({ history: { records: [
      { id: '1', sessionId: '100', turnId: 't1', type: 'USER', text: '恢复后的提问' },
    ], turns: {}, nextCursor: null, hasMore: false } }));
    await flush();
    assert.equal(store.getPhase('100'), 'live');
    assert.ok(store.getHistory('100').has('1'));
  } finally { window.setTimeout = originalTimer; detachStreamV3(session); harness.teardown(); }
});
