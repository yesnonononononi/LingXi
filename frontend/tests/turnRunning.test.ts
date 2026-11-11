/**
 * 「轮次仍在运行」判据的逐条证明（`utils/turnRunning.ts`）。
 *
 * 背景（真实缺陷，别把测试删了）：待发送消息（pendingChat）投递后会紧接着开下一轮，
 * 会话在「上一轮刚收尾 → 下一轮接管」的窗口里始终是运行态，而列表末条 assistant
 * 仍是**上一轮**那条。旧守卫只看 `isSending && isLastAssistant` 就判定「还在跑」，
 * 于是上一轮的终态底栏与产物清单被整段藏起来，直到待发送轮次跑完、末条回答移位才恢复。
 *
 * 修法：兜底必须被「本条自带终态证据」否掉。下面每条用例都对应一道守卫，
 * 删掉任何一道都会有一条变红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {hasTerminalEvidence, resolveTurnRunning, type TurnRunningFacts} from '../src/utils/turnRunning';
import type {ChatMessage} from '../src/types/chat';

function facts(overrides: Partial<ChatMessage> = {}, extra: Partial<TurnRunningFacts> = {}): TurnRunningFacts {
  return {
    message: {id: 'm', role: 'assistant', content: 'done', timestamp: 0, isComplete: true, ...overrides},
    turnStatus: null,
    isSending: false,
    isLastAssistant: false,
    ...extra,
  };
}

test('待发送轮次接管期间，已收尾的上一轮不再被当成在跑', () => {
  // 缺陷现场：会话运行态 + 本条是末条回答 + 轮次摘要尚未到达。
  const closed = facts({durationMs: 1200, tokens: 12}, {isSending: true, isLastAssistant: true});
  assert.equal(hasTerminalEvidence(closed.message), true);
  assert.equal(resolveTurnRunning(closed), false, '已带终态证据的上一轮必须放行终态底栏');

  // 反向：真正在跑的那条（还没有任何终结帧写下的证据）必须继续隐藏底栏。
  const streaming = facts({isComplete: false}, {isSending: true, isLastAssistant: true});
  assert.equal(hasTerminalEvidence(streaming.message), false);
  assert.equal(resolveTurnRunning(streaming), true, '没有终态证据的末条回答仍视为在跑');
});

test('消息自带的轮次状态是权威，不再靠会话级 isSending 推断', () => {
  // 后端已逐条下发终态 ⇒ 无论会话是否仍在运行、本条是不是末条，都必须放行底栏。
  for (const turnStatus of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
    const closed = facts({turnStatus}, {isSending: true, isLastAssistant: true});
    assert.equal(resolveTurnRunning(closed), false, `${turnStatus} 必须直接放行`);
  }
  // 甚至没有 durationMs/tokenInfo/tokens 这些证据也一样放行：权威状态本身就够了。
  assert.equal(resolveTurnRunning(facts({turnStatus: 'COMPLETED', durationMs: undefined},
    {isSending: true, isLastAssistant: true})), false);

  // 活跃态同理：后端说 RUNNING，会话级 isSending 为假（例如刚受理、runStatus 还没回写）也算在跑。
  for (const turnStatus of ['ACCEPTED', 'RUNNING', 'WAITING'] as const) {
    assert.equal(resolveTurnRunning(facts({turnStatus}, {isSending: false, isLastAssistant: false})), true,
      `${turnStatus} 必须判在跑`);
  }

  // 消息级状态盖过组绑定的摘要状态：摘要还停在 RUNNING 时，以逐条下发的终态为准。
  assert.equal(resolveTurnRunning(facts({turnStatus: 'COMPLETED'}, {turnStatus: 'RUNNING'})), false);
  assert.equal(resolveTurnRunning(facts({turnStatus: 'RUNNING'}, {turnStatus: 'COMPLETED'})), true);
});

test('终态证据只看终结帧写入的三个字段', () => {
  assert.equal(hasTerminalEvidence({}), false);
  assert.equal(hasTerminalEvidence({durationMs: 0}), true, '0 毫秒也是证据，不能按假值判');
  assert.equal(hasTerminalEvidence({tokens: 0}), true);
  assert.equal(hasTerminalEvidence({tokenInfo: {promptTokens: 1, completionTokens: 2, totalTokens: 3} as never}), true);
});

test('轮次摘要终态、失败与取消优先于任何兜底', () => {
  for (const turnStatus of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
    assert.equal(resolveTurnRunning(facts({isThinking: true}, {turnStatus, isSending: true, isLastAssistant: true})), false,
      `${turnStatus} 轮次不得被迟到的流状态重新打开`);
  }
  assert.equal(resolveTurnRunning(facts({cancelled: true}, {isSending: true, isLastAssistant: true})), false);
  assert.equal(resolveTurnRunning(facts({failed: true}, {isSending: true, isLastAssistant: true})), false);
});

test('实时标记与明确未完成优先于终态证据', () => {
  assert.equal(resolveTurnRunning(facts({isThinking: true, durationMs: 900})), true);
  assert.equal(resolveTurnRunning(facts({isExploring: true, durationMs: 900})), true);
  assert.equal(resolveTurnRunning(facts({isComplete: false, durationMs: 900})), true);
});

test('权威活跃状态压过本端终结标记', () => {
  // 用户点停止 / 前端打了 cancelled·failed 标记，但后端仍报活跃态 ⇒ 轮次没收口，
  // 终态底栏（用量/耗时）不得提前展示。
  for (const turnStatus of ['ACCEPTED', 'RUNNING', 'WAITING'] as const) {
    assert.equal(resolveTurnRunning(facts({cancelled: true}, {turnStatus})), true, `${turnStatus} 下 cancelled 标记不能收口`);
    assert.equal(resolveTurnRunning(facts({failed: true}, {turnStatus})), true, `${turnStatus} 下 failed 标记不能收口`);
  }
});

test('轮次摘要活跃、工具未收尾时仍判在跑', () => {
  assert.equal(resolveTurnRunning(facts({}, {turnStatus: 'RUNNING'})), true);
  assert.equal(resolveTurnRunning(facts({}, {turnStatus: 'WAITING'})), true);
  const calling = [{id: 't1', name: 'edit_file', status: 'calling'}] as never;
  const pending = [{id: 't2', name: 'edit_file', status: 'pending'}] as never;
  const done = [{id: 't3', name: 'edit_file', status: 'success'}] as never;
  assert.equal(resolveTurnRunning(facts({toolCalls: calling})), true, '守卫真空：工具调用中没有其它标记也必须判在跑');
  assert.equal(resolveTurnRunning(facts({toolCalls: pending})), true);
  assert.equal(resolveTurnRunning(facts({toolCalls: done})), false, '历史成功工具不得把已收尾轮次判成在跑');
  assert.equal(resolveTurnRunning(facts({toolCalls: []})), false);
});
