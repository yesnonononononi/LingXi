/**
 * QA 独立验证的对抗用例：锁住 asyncSubSessionStatus 的 ①②③ 优先级与四态回落不变量，
 * 来源见 design-incremental §9。（仅新增本说明，未改动任何断言。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  asyncSubSessionStatus,
  isAsyncDelegation,
  subItemStatusDotClass,
  subItemStatusLabel,
} from '../src/utils/asyncDelegation';
import { buildBubbleFromTurnView } from '../src/views/chat/blockProjection';
import type { ToolCallTrace } from '../src/types/chat';
import type { TurnViewVO } from '../src/types/block';

/**
 * 交付总监定点复验（QA 严过关）——最终形态 `asyncSubSessionStatus` 的四组对抗用例。
 *
 * 最终分支：
 *   ① if (sub) 权威态优先
 *   ② else if (isAsyncDelegation(tc)) → success 抑制为 running，其余回落工具态
 *   ③ else 阻塞式整支回落工具态
 */

/** 协作式工具轨迹：入参带 runtime_mode=async。 */
function asyncTc(status: ToolCallTrace['status']): ToolCallTrace {
  return { query: JSON.stringify({ agentId: 7, task: 'x', runtime_mode: 'async' }), status } as ToolCallTrace;
}

/** 阻塞式工具轨迹：无任何协作式标记。 */
function blockingTc(status: ToolCallTrace['status']): ToolCallTrace {
  return { query: JSON.stringify({ agentId: 7, task: 'x' }), status } as ToolCallTrace;
}

/* ============================ 第 1 组：② 与 ① 的优先级 ============================ */
// 关键对抗点：async 标记为真且子会话存在时，必须仍走 ① 权威态 —— ② 不得抢先返回。
// 选用的 (sub, tc) 组合刻意让 ① 与 ② 的结论不同，从而能证伪「② 遮蔽 ①」。

test('第1组① ② 不遮蔽 ①：async + 子会话存在 → 一律走权威态', () => {
  // ① = running，②(success→running) 恰好同值，仍断言
  assert.equal(asyncSubSessionStatus({ runStatus: 'RUNNING' }, asyncTc('success')), 'running');

  // ① = completed；②(calling→running) 会不同 ⇒ 若 ② 抢先，这里必红
  assert.equal(
    asyncSubSessionStatus({ runStatus: 'IDLE', lastOutcome: 'COMPLETED' }, asyncTc('calling')),
    'completed',
    '子会话已完成时，协作式标记不得把结论改成「进行中」',
  );

  // ① = failed；②(success→running) 会不同 ⇒ 若 ② 抢先，这里必红
  assert.equal(
    asyncSubSessionStatus({ runStatus: 'IDLE', lastOutcome: 'FAILED' }, asyncTc('success')),
    'failed',
    '子会话已失败时，协作式标记不得把结论改成「进行中」',
  );

  // ① = completed；②(success→running) 会不同 ⇒ 若 ② 抢先，这里必红
  assert.equal(
    asyncSubSessionStatus({ runStatus: 'IDLE', lastOutcome: 'COMPLETED' }, asyncTc('success')),
    'completed',
  );

  // 挂起态也必须来自权威态
  assert.equal(asyncSubSessionStatus({ runStatus: 'SUSPENDED' }, asyncTc('failed')), 'suspended');
});

/* ============================ 第 2 组：② 的四态回落 ============================ */
// 协作式 + 无子会话（第一条实时事件到达前）。

test('第2组② 协作式无子会话：success 抑制为「进行中」（消灭「提前完成」）', () => {
  assert.equal(asyncSubSessionStatus(undefined, asyncTc('success')), 'running',
    '协作式工具 success 只代表委派已受理，不得显示为完成');
});

test('第2组② 协作式无子会话：failed 如实回落「失败」（不得永远进行中）', () => {
  assert.equal(asyncSubSessionStatus(undefined, asyncTc('failed')), 'failed',
    '工具自身失败时子会话不会出现，必须如实显示失败，不能永远停在进行中');
});

test('第2组② 协作式无子会话：calling / pending → 进行中', () => {
  assert.equal(asyncSubSessionStatus(undefined, asyncTc('calling')), 'running');
  assert.equal(asyncSubSessionStatus(undefined, asyncTc('pending')), 'running');
});

test('第2组② 协作式无子会话：未知状态 → unknown', () => {
  assert.equal(asyncSubSessionStatus(undefined, asyncTc(undefined)), 'unknown');
});

test('第2组② 协作式标记可来自 result.runtimeMode=ASYNC（不只看 query）', () => {
  const resultOnly: ToolCallTrace = { result: JSON.stringify({ runtimeMode: 'ASYNC', delegated: true }), status: 'success' } as ToolCallTrace;
  assert.equal(isAsyncDelegation(resultOnly), true);
  assert.equal(asyncSubSessionStatus(undefined, resultOnly), 'running');
});

/* ============================ 第 3 组：③ 阻塞式对照 ============================ */
// 防止「抑制 success」被误扩到阻塞式：阻塞式 success 就等于子代理真的跑完了。

test('第3组③ 阻塞式无子会话：success→完成 / failed→失败 / calling→进行中', () => {
  assert.equal(asyncSubSessionStatus(undefined, blockingTc('success')), 'completed');
  assert.equal(asyncSubSessionStatus(undefined, blockingTc('failed')), 'failed');
  assert.equal(asyncSubSessionStatus(undefined, blockingTc('calling')), 'running');
});

/* ============================ 第 4 组：历史态路径独立排查 ============================ */
// 核实 blockProjection（禁改）构造的历史 ToolCallTrace 里 tc.query / tc.result 是否有值。

function historyView(args: string | null, output: string | null, status: TurnViewVO['blocks'][number]['status']): TurnViewVO {
  return {
    sessionId: '800',
    turnId: '1',
    status: 'RUNNING',
    viewVersion: '1',
    blocks: [{
      blockId: 'tool:call-1',
      type: 'TOOL',
      status,
      order: 2,
      toolCallId: 'call-1',
      toolName: 'call_sub_agent',
      arguments: args,
      output,
    }],
  };
}

test('第4组 历史态：blockProjection 产出的历史轨迹携带 query / result（协作式标记在历史态生效）', () => {
  const bubble = buildBubbleFromTurnView(
    historyView(JSON.stringify({ agentId: 7, task: 'x', runtime_mode: 'async' }),
      JSON.stringify({ runtimeMode: 'ASYNC', delegated: true }), 'COMPLETED'),
  );
  const trace = bubble.toolCalls?.[0];
  assert.ok(trace, '历史轮次视图应投影出一个工具轨迹');

  // 硬证据：两个字段确实有值（来自 ToolBlock.arguments / ToolBlock.output）。
  assert.equal(trace.query, JSON.stringify({ agentId: 7, task: 'x', runtime_mode: 'async' }), '历史态 query 有值且等于块 arguments');
  assert.ok(trace.result && trace.result.includes('ASYNC'), '历史态 result 有值且含 ASYNC');

  assert.equal(isAsyncDelegation(trace), true, '历史态同样能认出协作式委派');
  // 历史态下工具块已 COMPLETED、且此刻无子会话 → 走 ②：抑制为进行中（而非误显示完成）。
  assert.equal(asyncSubSessionStatus(undefined, trace), 'running', '历史态协作式 success 不得误显示完成');
});

test('第4组 历史态兜底：blockProjection 无 arguments/output 时 query/result 缺省 → ③ 回落，且「子会话存在」可兜住正确性', () => {
  const bubble = buildBubbleFromTurnView(historyView(null, null, 'COMPLETED'));
  const trace = bubble.toolCalls?.[0];
  assert.ok(trace, '仍应投影出工具轨迹');

  // 取证：字段确实缺省（undefined）。
  assert.equal(trace.query, undefined, '无 arguments 时 query 为 undefined');
  assert.equal(trace.result, undefined, '无 output 时 result 为 undefined');
  assert.equal(isAsyncDelegation(trace), false, '历史态无标记 → 认不出协作式');

  // 此时走 ③（阻塞式回落）：success→completed。
  assert.equal(asyncSubSessionStatus(undefined, trace), 'completed',
    '无标记且无子会话时按阻塞式回落（历史无 arguments/output 的显示形态）');

  // 但只要有子会话（会话树提供），① 权威态兜住显示正确性 —— 与是否认出协作式无关。
  assert.equal(asyncSubSessionStatus({ runStatus: 'RUNNING' }, trace), 'running',
    '子会话存在时以权威态为准，可兜住历史态缺标记的情况');
  assert.equal(asyncSubSessionStatus({ runStatus: 'IDLE', lastOutcome: 'FAILED' }, trace), 'failed');
});

/* ============================ 附：展示态映射稳定性 ============================ */

test('附 展示态 → 色点 / 文案映射稳定', () => {
  assert.equal(subItemStatusDotClass('running'), 'bg-amber-400 animate-pulse');
  assert.equal(subItemStatusDotClass('completed'), 'bg-emerald-500');
  assert.equal(subItemStatusDotClass('failed'), 'bg-red-500');
  assert.equal(subItemStatusLabel('running'), '执行中');
  assert.equal(subItemStatusLabel('failed'), '执行失败');
});
