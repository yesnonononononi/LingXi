import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { useChatView } from '../src/views/chat/useChatView';
import { chatApi } from '../src/services/chat';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { createHarness, flush, frame, readyFrame, bootstrapSnapshot } from './harness/streamV3Harness';

/** 缺陷 2 的连接代次边界：重复 READY 幂等、旧 bootstrap 不污染新代际。 */
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
  return { harness, view, store, cleanup() {
    scope.stop(); harness.teardown();
    chatApi.fetchSessionDetail = originals.detail; chatApi.fetchModels = originals.models;
    chatApi.fetchUserConfigs = originals.configs; chatApi.sendCommand = originals.command;
  } };
}

test('边界：同一连接重复 READY 不重复 bootstrap', async () => {
  const p = setupProbe();
  try {
    await p.view.handleSelectSession('100');
    await flush();
    p.harness.server.push('100', readyFrame('conn-A'));
    await flush();
    assert.equal(p.harness.bootstrap.calls.length, 1);
    p.harness.bootstrap.resolveNext(bootstrapSnapshot({ rootSessionId: '100', historyRevision: '1', sessions: [{ id: '100' } as any] }));
    await flush();
    assert.equal(p.store.getPhase('100'), 'live');

    // 同一连接上又来一条 READY（相同 connectionId）
    p.harness.server.push('100', readyFrame('conn-A'));
    await flush();
    assert.equal(p.harness.bootstrap.calls.length, 1, '同一连接的重复 READY 触发了重复 bootstrap');
  } finally { p.cleanup(); }
});

test('边界：旧连接在途 bootstrap 迟到返回不得污染新代际', async () => {
  const p = setupProbe();
  const originalTimer = window.setTimeout;
  try {
    await p.view.handleSelectSession('100');
    await flush();
    p.harness.server.push('100', readyFrame('conn-A'));
    await flush();
    assert.equal(p.harness.bootstrap.calls.length, 1);
    // 故意不 resolve 第一条 bootstrap：让它成为「旧代际在途请求」

    const scheduled: Array<() => void> = [];
    window.setTimeout = ((cb: () => void, d: number) => {
      if (d >= 1000) { scheduled.push(cb); return -1; }
      return originalTimer(cb, d);
    }) as any;
    p.harness.server.closeFromServer('100');
    await flush();
    assert.equal(scheduled.length, 1, '断流未登记重连');
    scheduled[0]!();                       // 触发重连 → 新连接
    await flush();
    assert.equal(p.harness.server.openCount('100'), 2, '未建立第二条连接');
    p.harness.server.push('100', readyFrame('conn-B'));   // 新连接 READY（新 connectionId）
    await flush();
    assert.equal(p.harness.bootstrap.calls.length, 2, '新连接未重新 bootstrap');

    // 新代际先返回
    p.harness.bootstrap.resolveAt(1, bootstrapSnapshot({
      rootSessionId: '100', historyRevision: '1', sessions: [{ id: '100' } as any],
      history: { records: [{ id: '9', sessionId: '100', turnId: 't9', type: 'AI', text: '新代际正文' } as any], turns: {}, nextCursor: null, hasMore: false },
    }));
    await flush();
    assert.equal(p.store.getPhase('100'), 'live');
    assert.ok(p.view.displayedMessages.value.some(m => m.content.includes('新代际正文')), '新代际正文缺失');

    // 旧代际的 bootstrap 此刻才返回：必须被丢弃，不得把代际写回退
    p.harness.bootstrap.resolveAt(0, bootstrapSnapshot({
      rootSessionId: '100', historyRevision: '0', sessions: [{ id: '100' } as any],
      history: { records: [{ id: '8', sessionId: '100', turnId: 't8', type: 'AI', text: '旧代际正文' } as any], turns: {}, nextCursor: null, hasMore: false },
    }));
    await flush();
    assert.equal(p.store.currentHistoryRevision('100'), '1', '旧 bootstrap 把代际写回退了');
    assert.ok(p.view.displayedMessages.value.some(m => m.content.includes('新代际正文')), '新代际正文被旧 bootstrap 覆盖');
    assert.ok(!p.view.displayedMessages.value.some(m => m.content.includes('旧代际正文')), '旧代际正文复活了');
  } finally { window.setTimeout = originalTimer; p.cleanup(); }
});
