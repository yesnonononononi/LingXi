import test from 'node:test';
import assert from 'node:assert/strict';
import { useStreamV3Store } from '../src/stores/streamV3Store';
import { projectSessionMessages } from '../src/views/chat/messageProjection';
import { createHarness, flush, frame, promiseCard, subSessionVO } from './harness/streamV3Harness';

/**
 * 场景 6：重发与作废隔离。
 *
 * 重发是**破坏性**操作（后端物理删除目标轮次及其之后的历史），所以断言分两类：
 * ① 被作废范围必须消失；② 作废范围之外（别的根会话、未作废轮次）必须完好无损。
 * 第二类更容易被忽略 —— 清理写宽一格就会误删。
 */

test('场景6-1 作废按根会话隔离：不得误删其他根会话的未提交响应', () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();

    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-a', delta: 'A 的正文' }, { rootSessionId: '100', sessionId: '100' }));
    store.applyFrame('200', frame('TEXT_DELTA', { streamKey: 'sk-b', delta: 'B 的正文' }, { rootSessionId: '200', sessionId: '200' }));
    assert.equal(store.responses.size, 2);

    // 只有根 100 换代
    store.applyFrame('100', frame('HISTORY_INVALIDATED', { rootSessionId: '100', historyRevision: '2' }, { rootSessionId: '100', sessionId: '100' }));

    assert.equal(store.getResponse('sk-b')?.text, 'B 的正文', '别的根会话正在生成的正文不得被清掉');
    assert.equal(store.getResponse('sk-b')?.discarded, false);

    const a = store.getResponse('sk-a');
    assert.equal(a?.discarded, true, '本根会话的未提交响应应作废');
    assert.equal(a?.text, '', '作废后不得再渲染旧正文');
  } finally {
    harness.teardown();
  }
});

test('场景6-2 切换会话按根会话树清：子会话活响应不得残留', () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();

    store.applyFrame('100', frame('SESSION_UPDATED', subSessionVO('200', '100')));
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-root', delta: '根' }, { rootSessionId: '100', sessionId: '100' }));
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-sub', delta: '子' }, { rootSessionId: '100', sessionId: '200' }));
    assert.equal(store.responses.size, 2);

    store.resetSession('100');

    assert.equal(store.responses.size, 0, '子会话残留也必须一并清掉，否则切回来会混进新会话视图');
  } finally {
    harness.teardown();
  }
});

test('场景6-3 作废后迟到的旧 delta 不得复活正文', () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();

    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-old', delta: '旧正文' }, { sessionId: '100' }));
    store.applyFrame('100', frame('HISTORY_INVALIDATED', { rootSessionId: '100', historyRevision: '2' }, { sessionId: '100' }));

    // 网络上迟到的旧增量
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-old', delta: '又来了' }, { sessionId: '100' }));
    store.applyFrame('100', frame('RESPONSE_FINALIZED', { streamKey: 'sk-old', text: '整段旧正文', thinking: null }, { sessionId: '100' }));

    assert.equal(store.getResponse('sk-old')?.text, '', '迟到帧不得把已作废的正文写回来');
    assert.equal(projectSessionMessages('100').length, 0, '作废内容不得出现在视图里');
  } finally {
    harness.teardown();
  }
});

test('场景6-4 作废后迟到的分页结果不得复活历史行', () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();

    // 重发推进代际到 2
    store.applyFrame('100', frame('HISTORY_INVALIDATED', { rootSessionId: '100', historyRevision: '2' }, { sessionId: '100' }));

    // 代际 1 时发起的翻页此时才返回
    store.ingestHistoryPage('100', {
      records: [{ id: '1', sessionId: '100', turnId: '9001', type: 'USER', text: '作废前的提问' }],
      turns: {}, hasMore: false, nextCursor: null,
    }, '1');

    assert.equal(store.getHistory('100').size, 0, '旧代际的分页结果必须丢弃');

    // 当前代际的分页正常写入
    store.ingestHistoryPage('100', {
      records: [{ id: '2', sessionId: '100', turnId: '9002', type: 'USER', text: '新代际的提问' }],
      turns: {}, hasMore: false, nextCursor: null,
    }, '2');
    assert.equal(store.getHistory('100').size, 1);
  } finally {
    harness.teardown();
  }
});

test('场景6-5 作废后按执行清卡片：被作废轮次的待审批卡不得留在界面', () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();

    store.ingestToolCall(promiseCard({ id: 'call_doomed', executionId: '900' }));
    store.ingestToolCall(promiseCard({ id: 'call_alive', executionId: '901' }));
    assert.equal(store.tools.size, 2);

    store.dropToolsByExecution(['900']);

    assert.equal(store.getTool('call_doomed'), undefined, '被作废执行的卡片必须移除');
    assert.ok(store.getTool('call_alive'), '未作废执行的卡片必须保留');
  } finally {
    harness.teardown();
  }
});

test('场景6-6 回执与失效事件两种到达顺序，最终状态一致', async () => {
  const buildState = (invalidationFirst: boolean) => {
    const harness = createHarness();
    const store = useStreamV3Store();

    // 作废前的现场：一条活响应、一个轮次摘要、一张卡片
    store.applyFrame('100', frame('TEXT_DELTA', { streamKey: 'sk-old', delta: '旧正文' }, { sessionId: '100' }));
    store.ingestTurn({ turnId: '9001', status: 'RUNNING' } as any);
    store.ingestToolCall(promiseCard({ id: 'call_doomed', executionId: '900' }));

    const applyInvalidationEvent = () =>
      store.applyFrame('100', frame('HISTORY_INVALIDATED', { rootSessionId: '100', historyRevision: '2' }, { sessionId: '100' }));
    // 回执到达后的落点：清会话实时态 + 按回执给出的范围删轮次与卡片
    const applyReceipt = () => {
      store.resetSession('100');
      store.dropTurns(['9001']);
      store.dropToolsByExecution(['900']);
    };

    if (invalidationFirst) {
      applyInvalidationEvent();
      applyReceipt();
    } else {
      applyReceipt();
      applyInvalidationEvent();
    }

    return {
      responses: store.responses.size,
      discarded: [...store.responses.values()].filter(slot => slot.discarded).length,
      turns: store.turns.size,
      tools: store.tools.size,
      revision: store.historyRevision.get('100'),
      harness,
    };
  };

  const eventFirst = buildState(true);
  await flush();
  const receiptFirst = buildState(false);
  await flush();

  try {
    assert.deepEqual(
      { responses: eventFirst.responses, discarded: eventFirst.discarded, turns: eventFirst.turns, tools: eventFirst.tools, revision: eventFirst.revision },
      { responses: receiptFirst.responses, discarded: receiptFirst.discarded, turns: receiptFirst.turns, tools: receiptFirst.tools, revision: receiptFirst.revision },
      '两种到达顺序必须收敛到同一状态'
    );
    // 作废范围确实消失了
    assert.equal(eventFirst.turns, 0);
    assert.equal(eventFirst.tools, 0);
    assert.equal(eventFirst.revision, '2');
  } finally {
    eventFirst.harness.teardown();
    receiptFirst.harness.teardown();
  }
});
