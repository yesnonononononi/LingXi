import test from 'node:test';
import assert from 'node:assert/strict';
import { attachStreamV3 } from '../src/services/streamV3Sync';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { projectSessionMessages } from '../src/views/chat/messageProjection';
import {
  bootstrapSnapshot,
  createHarness,
  flush,
  frame,
  promiseCard,
  readyFrame,
} from './harness/streamV3Harness';

/**
 * 场景 5：断线恢复 / 连接复用 / 旧请求迟到。
 *
 * 三条都是「异步到达顺序」问题，靠最终值断言看不出来 —— 必须控制 READY、bootstrap 与实时帧的先后。
 */

test('场景5-1 新连接：bootstrap 在途收到的更新不被旧快照覆盖，卡片只显示一次', async () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();
    attachStreamV3('100');
    await flush();

    harness.server.push('100', readyFrame('conn-1'));
    await flush();
    assert.equal(store.getPhase('100'), 'bootstrapping', 'READY 后应进入 bootstrap 在途');
    assert.equal(harness.bootstrap.pendingCount, 1, 'READY 后应发出一次 bootstrap');

    // bootstrap 在途：卡片以**更新**的版本到达（暂存，待快照合并后回放）
    harness.server.push('100', frame('TOOL_CALL_UPDATED', promiseCard({
      version: '5', status: 'completed', pending: false, allowedActions: [], rawOutput: { outcome: 'APPROVED' },
    })));
    await flush();

    // 快照最后返回，且带的是**更旧**的版本
    harness.bootstrap.resolveNext(bootstrapSnapshot({ toolCalls: [promiseCard({ version: '2' })] }));
    await flush();

    assert.equal(store.getPhase('100'), 'live');
    assert.equal(store.getTool('call_1')?.version, '5', '较旧快照不得覆盖较新的实时值');

    const cards = projectSessionMessages('100').flatMap(m => m.promptCards ?? []);
    assert.equal(cards.length, 1, '同一张卡只能显示一次');
    assert.equal(cards[0].toolCallId, 'call_1');
  } finally {
    harness.teardown();
  }
});

test('场景5-2 连接复用：重挂到已 READY 的连接能完成同步，不永久等待第二个 READY', async () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();
    const first = attachStreamV3('100');
    await flush();
    harness.server.push('100', readyFrame('conn-1'));
    await flush();
    harness.bootstrap.resolveNext(bootstrapSnapshot());
    await flush();
    assert.equal(store.getPhase('100'), 'live');

    // 重挂到同一条会话：连接已在跑且已投递过事件 → 触发 onReattached
    attachStreamV3('100');
    await flush();

    assert.notEqual(
      store.getPhase('100'), 'awaiting-ready',
      '复用连接不会再发 READY，不能停在等待 READY 的阶段'
    );
    assert.equal(harness.bootstrap.calls.length, 2, '重挂应重新拉一次 bootstrap 补齐缺口');

    // 重新同步在途：帧先暂存（屏障照常生效），快照返回后回放
    harness.server.push('100', frame('TOOL_CALL_UPDATED', promiseCard({ id: 'call_9' })));
    await flush();
    harness.bootstrap.resolveNext(bootstrapSnapshot());
    await flush();

    assert.ok(store.getTool('call_9'), '重挂后到达的帧必须被应用，而不是被无限暂存');
    assert.equal(store.getPhase('100'), 'live');

    first.detach();
  } finally {
    harness.teardown();
  }
});

test('场景5-3 旧请求迟到：旧 bootstrap 不得覆盖新连接状态，每次有效同步只请求一次 bootstrap', async () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();

    // 第一次同步
    const first = attachStreamV3('100');
    await flush();
    harness.server.push('100', readyFrame('conn-1'));
    await flush();
    assert.equal(harness.bootstrap.calls.length, 1);

    // 切走（旧 bootstrap 仍在途）
    first.detach();
    await flush();

    // 第二次同步：新连接
    const second = attachStreamV3('100');
    await flush();
    harness.server.push('100', readyFrame('conn-2'));
    await flush();
    assert.equal(harness.bootstrap.calls.length, 2, '每次有效同步只应请求一次 bootstrap');

    // 新快照先返回（后发起的那次 = 索引 1）
    harness.bootstrap.resolveAt(1, bootstrapSnapshot({ historyRevision: '5' }));
    await flush();
    assert.equal(store.historyRevision.get('100'), '5');

    // 旧快照最后返回（先发起的那次 = 索引 0，代次已过期）—— 不得覆盖
    harness.bootstrap.resolveAt(0, bootstrapSnapshot({ historyRevision: '2' }));
    await flush();

    assert.equal(store.historyRevision.get('100'), '5', '过期的 bootstrap 不得回退代际');
    assert.equal(store.getPhase('100'), 'live');

    second.detach();
  } finally {
    harness.teardown();
  }
});
