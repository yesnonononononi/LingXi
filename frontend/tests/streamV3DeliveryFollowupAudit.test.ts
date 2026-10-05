import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { attachStreamV3, detachStreamV3 } from '../src/services/streamV3Sync';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { useChatView } from '../src/views/chat/useChatView';
import { chatApi } from '../src/services/chat';
import { createHarness, flush, frame, readyFrame, bootstrapSnapshot } from './harness/streamV3Harness';

async function setupSync() {
  const harness = createHarness();
  const store = useStreamV3Store();
  const session = attachStreamV3('100');
  await flush();
  harness.server.push('100', readyFrame('followup-connection'));
  await flush();
  return { harness, store, finish() { detachStreamV3(session); harness.teardown(); } };
}

test('收尾复核：暂存溢出必须主动恢复，而不只是拒绝旧快照', async () => {
  const a = await setupSync();
  const originalTimer = window.setTimeout;
  const scheduled: Array<() => void> = [];
  try {
    window.setTimeout = ((callback: () => void, delay: number) => {
      // SSE 收到帧会刷新长周期空闲计时；它不等于同步失败后的 1/2/4 秒恢复。
      if (delay >= 1000 && delay <= 4000) { scheduled.push(callback); return -1; }
      return originalTimer(callback, delay);
    }) as any;
    a.harness.server.push('100', frame('TEXT_DELTA', { streamKey: 'overflow', delta: 'x'.repeat(2 * 1024 * 1024 + 1) },
      { turnId: 't1', executionId: 'e1' }));
    await flush();
    a.harness.bootstrap.resolveNext(bootstrapSnapshot());
    await flush();
    assert.equal(a.store.getPhase('100'), 'idle');
    assert.ok(scheduled.length > 0 || a.harness.bootstrap.calls.length > 1,
      'store 作废 token 后，协调器未收到失败信号，仍无退避恢复任务');
    if (scheduled.length > 0) scheduled[0]!();
    await flush();
    assert.equal(a.harness.bootstrap.calls.length, 2, '恢复任务必须真的重新 bootstrap');
  } finally { window.setTimeout = originalTimer; a.finish(); }
});

test('收尾复核：历史代际推进后，未知 streamKey 的旧代际增量不得复活', async () => {
  const a = await setupSync();
  try {
    a.harness.bootstrap.resolveNext(bootstrapSnapshot());
    await flush();
    a.harness.server.push('100', frame('HISTORY_INVALIDATED', {
      rootSessionId: '100', historyRevision: '2', turnIds: ['t1'], executionIds: ['e1'],
    }, { historyRevision: '2' }));
    await flush();
    a.harness.server.push('100', frame('TEXT_DELTA', { streamKey: 'late-unseen', delta: '旧代际正文' },
      { sessionId: '100', turnId: 't1', executionId: 'e1', historyRevision: '1' }));
    await flush();
    assert.equal(a.store.currentHistoryRevision('100'), '2');
    const slot = a.store.getResponse('late-unseen');
    assert.ok(!slot || slot.discarded || slot.text === '', '只挡已见过 streamKey 的墓碑，挡不住旧代际新身份');
  } finally { a.finish(); }
});

test('收尾复核：bootstrap 失败后执行退避回调，能重新同步至 live', async () => {
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
    assert.equal(scheduled.length, 1);
    scheduled[0]!();
    await flush();
    assert.equal(a.harness.bootstrap.calls.length, 2);
    a.harness.bootstrap.resolveNext(bootstrapSnapshot());
    await flush();
    assert.equal(a.store.getPhase('100'), 'live');
  } finally { window.setTimeout = originalTimer; a.finish(); }
});

test('收尾复核：A 发送尚未受理，切到空闲 B 不得继续阻塞 B 发送', async () => {
  const harness = createHarness();
  const scope = effectScope();
  const originals = { detail: chatApi.fetchSessionDetail, models: chatApi.fetchModels,
    configs: chatApi.fetchUserConfigs, command: chatApi.sendCommand };
  const view = scope.run(() => useChatView({}, (() => undefined) as any))!;
  let release: ((value: any) => void) | undefined;
  let sending: Promise<void> | undefined;
  try {
    view.localSessions.value = ['100', '300'].map(id => ({ id, title: id, createdAt: 0,
      updatedAt: 0, messages: [], runStatus: 'IDLE' })) as any;
    (chatApi as any).fetchSessionDetail = async (id: string) => ({ ok: true, data: {
      id, title: id, rawRecords: [], turns: {}, subSessions: [], runStatus: 'IDLE' } });
    (chatApi as any).fetchModels = async () => ({ ok: true, data: [] });
    (chatApi as any).fetchUserConfigs = async () => ({ ok: true, data: [] });
    async function enter(id: string) {
      await view.handleSelectSession(id);
      await flush();
      harness.server.push(id, readyFrame(`followup-${id}`));
      await flush();
      harness.bootstrap.resolveNext(bootstrapSnapshot({ rootSessionId: id,
        sessions: [{ id, version: '1', runStatus: 'IDLE' } as any] }));
      await flush();
    }
    await enter('100');
    await view.handleModelUpdated();
    (chatApi as any).sendCommand = () => new Promise(resolve => { release = resolve; });
    sending = view.handleSendMessage('A 的提问', false, false, false);
    await flush();
    assert.equal(view.isSending.value, true);
    await enter('300');
    assert.equal(view.currentActiveSession.value?.id, '300');
    assert.equal(useStreamV3Store().sessions.get('300')?.runStatus, 'IDLE');
    assert.equal(view.isSending.value, false, '本地请求计数未按会话隔离，A 的在途请求继续阻塞 B');
  } finally {
    release?.({ sessionId: '100', turnId: 't1', executionId: 'e1' });
    await sending;
    scope.stop(); harness.teardown();
    chatApi.fetchSessionDetail = originals.detail; chatApi.fetchModels = originals.models;
    chatApi.fetchUserConfigs = originals.configs; chatApi.sendCommand = originals.command;
  }
});
