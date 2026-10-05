import test from 'node:test';
import assert from 'node:assert/strict';
import { attachStreamV3 } from '../src/services/streamV3Sync';
import { chatApi } from '../src/services/chat';
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
 * PLAN 专项集成：走**真实接线**，证明计划卡链路不需要旧事件入口
 * （`CARD_PENDING` / `AI_MESSAGE` / `COMPLETE_TEXT`），也不需要通知后逐卡 GET。
 *
 * 链路（全部经真实 SSE 协调器与状态机，只替换网络出口）：
 * <pre>
 *   attachStreamV3 → READY → bootstrap
 *   → server.push(PLAN 卡)          // 只推 v3 帧
 *   → 生产决策入口（JSON 回执）
 *   → server.push(恢复响应)
 *   → 断言派生视图出现正文
 * </pre>
 *
 * <p>与「直接 applyFrame + 手工 ingestToolCall」的区别：那条只能证明状态与派生视图能配合，
 * 证不了 <b>SSE 接线</b>与<b>真实决策入口</b>跑得通。这里两者都在链路上。</p>
 */

test('PLAN 专项：v3 卡片经真实接线展示、经生产决策入口审批、恢复响应回到派生视图', async () => {
  const harness = createHarness();
  try {
    const store = useStreamV3Store();

    // ── 1. 建流 → READY → bootstrap（走真实 §8 时序）─────────────────────
    const session = attachStreamV3('100');
    await flush();
    harness.server.push('100', readyFrame('conn-1'));
    await flush();
    harness.bootstrap.resolveNext(bootstrapSnapshot({
      history: {
        records: [
          { id: '1', sessionId: '100', turnId: 't1', type: 'USER', text: '做个计划' },
          { id: '2', sessionId: '100', turnId: 't1', type: 'AI', text: '（等待审批）' },
        ],
        turns: {}, nextCursor: null, hasMore: false,
      },
    }));
    await flush();
    assert.equal(store.getPhase('100'), 'live', 'bootstrap 完成后必须进入 live');

    // ── 2. 只推 v3 卡片（没有任何 CARD_PENDING / AI_MESSAGE / COMPLETE_TEXT）──
    harness.server.push('100', frame('TOOL_CALL_UPDATED', promiseCard({
      id: 'call_plan',
      executionId: '900',
      conversationId: '100',
      title: '实施计划',
      content: { kind: 'PLAN', title: '实施计划', text: '第一步：接线' },
      allowedActions: ['APPROVE', 'REJECT'],
      pending: true,
      status: 'pending',
      version: '1',
    }), { sessionId: '100', turnId: 't1' }));
    await flush();

    const card = projectSessionMessages('100')
      .flatMap(message => message.promptCards ?? [])
      .find(item => item.toolCallId === 'call_plan');
    assert.ok(card, '计划卡必须仅凭 v3 帧经真实流到达并展示（旧事件入口不是必需品）');
    assert.equal(card?.kind, 'PLAN', '形态由 content.kind 分派');
    assert.equal(card?.content, '第一步：接线');
    assert.deepEqual(card?.allowedActions, ['APPROVE', 'REJECT'], '按钮权限读实体下发的 allowedActions');
    assert.equal(card?.pending, true);

    // ── 3. 生产决策入口（JSON 回执，不建请求级 SSE）───────────────────────
    const receipt = await chatApi.decideToolCall('100', 'call_plan', 'APPROVE', '', '1', 'cmd-plan-1');
    assert.equal(receipt.decisionApplied, true, '回执只承诺决策已落库');
    assert.equal(receipt.resumeDisposition, 'QUEUED');
    // 视图层接线的那一步：回执携带的实体更新同一个 tools[toolCallId]。
    store.ingestToolCall(receipt.toolCall);
    await flush();

    const decided = projectSessionMessages('100')
      .flatMap(message => message.promptCards ?? [])
      .filter(item => item.toolCallId === 'call_plan');
    assert.equal(decided.length, 1, '同一张卡不得变成两条');
    assert.equal(decided[0].pending, false);
    assert.equal(decided[0].outcome, 'APPROVED');

    // ── 4. 恢复响应经 v3 会话流到达，并出现在派生视图里 ────────────────────
    harness.server.push('100', frame('RESPONSE_STARTED', { streamKey: 'sk-resume' }, { sessionId: '100', turnId: 't1' }));
    harness.server.push('100', frame('THINKING_DELTA', { streamKey: 'sk-resume', delta: '正在规划' }, { sessionId: '100', turnId: 't1' }));
    harness.server.push('100', frame('TEXT_DELTA', { streamKey: 'sk-resume', delta: '开始实施' }, { sessionId: '100', turnId: 't1' }));
    await flush();

    assert.equal(store.getResponse('sk-resume')?.text, '开始实施', '恢复响应必须经 v3 会话流到达');
    const bodies = projectSessionMessages('100')
      .filter(message => message.role === 'assistant' && message.content)
      .map(message => message.content);
    assert.ok(
      bodies.some(text => text.includes('开始实施')),
      '恢复正文必须出现在派生视图里，实际: ' + JSON.stringify(bodies)
    );

    // ── 5. 全程没有逐卡 GET ──────────────────────────────────────────────
    assert.equal(
      harness.commands.perCardGetCount(), 0,
      '不得在通知后逐卡回查；实际请求: ' + JSON.stringify(harness.commands.calls)
    );
    assert.deepEqual(
      harness.commands.calls, ['POST /tool-call/decisions'],
      '整条链路只应打一次决策接口'
    );

    session.detach();
  } finally {
    harness.teardown();
  }
});
