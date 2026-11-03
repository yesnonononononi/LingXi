/**
 * 入态指令的落地报告（M6-b 第二轮必修项 1 的"不许静默"那一半）。
 *
 * <p><b>为什么单独一份类型：</b>`bus.dispatch()` 早就返回了 `applied | queued | rejected`，
 * 但调用方（渲染入口）以前把它整个丢掉——于是睡眠被拒、画面没睡、行为层照样宣称睡了，
 * 永远没人发现。现在每一批"入态指令"都必须产出一份报告，`ok === false` 表示
 * <b>行为层与表现层没有对齐</b>（已回滚 + 已修复，见 `main.ts` 的
 * `dispatchEntryOps`），调用方与调试后门都必须把它交出去。</p>
 *
 * @module pet/presentation/entry-report
 */
import type { DispatchOutcome } from './bus';

/** 一批入态指令的落地报告。 */
export interface EntryDispatchReport {
  /** 是否全部落地（每条都是 `applied`）。 */
  readonly ok: boolean;
  /** 逐条结果（与传入的指令顺序一一对应）。 */
  readonly outcomes: DispatchOutcome[];
  /** 立即生效的条数。 */
  readonly applied: number;
  /** 被排队（未能立刻落地）的条数。 */
  readonly queued: number;
  /** 被拒绝的条数。 */
  readonly rejected: number;
  /** 是否已经把行为层回滚到下发前的现场。 */
  readonly rolledBack: boolean;
  /** 人话结论（日志与调试面板直接显示，不允许为空）。 */
  readonly message: string;
}

/** `forceState()` 的返回值：落地报告 + 目标状态名。 */
export interface ForceStateResult extends EntryDispatchReport {
  /** 目标状态名（调用方传进来的字符串，方便对照）。 */
  readonly state: string;
}

/**
 * 造一份"空报告"（没有任何指令要下发时用）。
 *
 * @param message 结论文案
 * @returns 报告
 */
export function emptyEntryReport(message: string): EntryDispatchReport {
  return { ok: true, outcomes: [], applied: 0, queued: 0, rejected: 0, rolledBack: false, message };
}

/**
 * 统计一批下发结果。
 *
 * @param outcomes 逐条结果
 * @returns 计数（`ok` 按"全部立即生效"判定）
 */
export function summarizeOutcomes(outcomes: readonly DispatchOutcome[]): {
  ok: boolean;
  applied: number;
  queued: number;
  rejected: number;
} {
  let applied = 0;
  let queued = 0;
  let rejected = 0;
  for (const outcome of outcomes) {
    if (outcome === 'applied') applied += 1;
    else if (outcome === 'queued') queued += 1;
    else rejected += 1;
  }
  return { ok: rejected === 0 && queued === 0, applied, queued, rejected };
}

