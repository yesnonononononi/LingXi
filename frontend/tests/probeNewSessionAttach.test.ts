import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope } from 'vue';
import { useChatView } from '../src/views/chat/useChatView';
import { chatApi } from '../src/services/chat';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { createHarness, flush, frame, readyFrame, bootstrapSnapshot } from './harness/streamV3Harness';

/**
 * 缺陷 3 的补挂守卫是否误伤「新建会话首轮发送」。
 *
 * <p>这是最高频路径：临时会话 id → 回执返回真实 id → 必须补挂流，
 * 否则本轮事件无人接收（永久缺口）。守卫判据是「回执到达时查看的仍是本会话」，
 * 新建会话时 localActiveId 已在回执前同步改成真实 id，理论上应当放行。</p>
 */
function setupProbe() {
  const harness = createHarness();
  const scope = effectScope();
  const view = scope.run(() => useChatView({}, (() => undefined) as any))!;
  const store = useStreamV3Store();
  const originals = {
    detail: chatApi.fetchSessionDetail,
    models: chatApi.fetchModels,
    configs: chatApi.fetchUserConfigs,
    command: chatApi.sendCommand,
    create: chatApi.createSession,
  };
  (chatApi as any).fetchModels = async () => ({ ok: true, data: [{ id: 7, name: 'm7' }] });
  (chatApi as any).fetchUserConfigs = async () => ({ ok: true, data: [] });
  (chatApi as any).fetchSessionDetail = async (id: string) => ({ ok: true, data: {
    id, title: id, rawRecords: [], turns: {}, subSessions: [],
    runStatus: 'IDLE', hasMoreMessages: false, nextMessageCursor: null,
  } });
  return { harness, view, store, cleanup() {
    scope.stop();
    harness.teardown();
    chatApi.fetchSessionDetail = originals.detail;
    chatApi.fetchModels = originals.models;
    chatApi.fetchUserConfigs = originals.configs;
    chatApi.sendCommand = originals.command;
    chatApi.createSession = originals.create;
  } };
}

test('探针：新建会话首轮发送必须补挂流并接收本轮事件', async () => {
  const p = setupProbe();
  try {
    await p.view.handleModelUpdated();
    // 临时会话：尚未落库，条目已在 localSessions 里
    p.view.localSessions.value = [{ id: 'temp-1', title: '', createdAt: 0, updatedAt: 0, messages: [], runStatus: 'IDLE' }] as any;
    p.view.localActiveId.value = 'temp-1';
    await flush();

    (chatApi as any).createSession = async () => 500;
    (chatApi as any).sendCommand = async () => ({ sessionId: '500', turnId: '500-t1', executionId: 'e5' });
    await p.view.handleSendMessage('第一条提问', false, false, false);
    await flush();

    // 补挂后必须真的建了连接
    assert.equal(p.harness.server.openCount('500'), 1, '新建会话首轮未补挂流，本轮事件将无人接收');
    assert.equal(p.view.currentActiveSession.value?.id, '500');

    // 本轮 SSE 事件必须被接收并渲染。
    // 新建会话的连接此刻还在「等 READY」，未走完同步时序的帧会被暂存 —— 先补齐时序再推正文。
    p.harness.server.push('500', readyFrame('ready-500'));
    await flush();
    p.harness.bootstrap.resolveNext(bootstrapSnapshot({
      rootSessionId: '500', historyRevision: '1', sessions: [{ id: '500' } as any],
    }));
    await flush();
    assert.equal(p.store.getPhase('500'), 'live');

    p.harness.server.push('500', frame('TEXT_DELTA', { streamKey: 'k1', delta: '首轮正文' },
      { rootSessionId: '500', sessionId: '500', turnId: '500-t1', executionId: 'e5' }));
    await flush();
    assert.equal(p.store.getResponse('k1')?.text, '首轮正文');
    assert.ok(p.view.displayedMessages.value.some(m => m.content.includes('首轮正文')),
      '正文未进入派生视图');
  } finally { p.cleanup(); }
});

test('探针：已有会话首轮发送走同一守卫也不被误挡', async () => {
  const p = setupProbe();
  try {
    await p.view.handleModelUpdated();
    p.view.localSessions.value = [{ id: '600', title: 'a', createdAt: 0, updatedAt: 0, messages: [], runStatus: 'IDLE' }] as any;
    p.view.localActiveId.value = '600';
    await flush();
    p.harness.server.push.length; // noop，保持可读
    // 先建立既有连接并完成同步
    await p.view.handleSelectSession('600');
    await flush();
    p.harness.server.push('600', readyFrame('ready-600'));
    await flush();
    p.harness.bootstrap.resolveNext(bootstrapSnapshot({
      rootSessionId: '600', historyRevision: '1', sessions: [{ id: '600' } as any],
    }));
    await flush();

    (chatApi as any).sendCommand = async () => ({ sessionId: '600', turnId: '600-t2', executionId: 'e6' });
    await p.view.handleSendMessage('追问', false, false, false);
    await flush();
    assert.equal(p.view.currentActiveSession.value?.id, '600');
    assert.ok(p.harness.server.connection('600'), '已有会话的流被守卫误关');
    p.harness.server.push('600', frame('TEXT_DELTA', { streamKey: 'k2', delta: '追问正文' },
      { rootSessionId: '600', sessionId: '600', turnId: '600-t2', executionId: 'e6' }));
    await flush();
    assert.equal(p.store.getResponse('k2')?.text, '追问正文');
  } finally { p.cleanup(); }
});
