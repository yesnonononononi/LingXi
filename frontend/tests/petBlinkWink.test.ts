/**
 * 眨眼 × wink 单测（T04 的 R4 / R5 / R6，tsx 执行，零 Electron、零真定时器）。
 *
 * <p><b>它守的是什么（设计文档 §5.2 的四条规则）：</b></p>
 * <ol>
 *   <li>一次眨眼只产出 `blink`（闭眼），半闭帧资产在就再补一条 `blinkHalf`；
 *       **永不**产出 `sleepy`——那是"困倦整脸"，会让嘴型跟着每次眨眼抖一下；</li>
 *   <li>`blinkHalf` 未交付时退化成**两态**（只有一条 `blink`），任何情况下都不许拿别的表情顶上；</li>
 *   <li>睡眠中 `blink` / `blinkHalf` / `wink` 三者全被判 `reject`；</li>
 *   <li>`wink` 是交互表情，与 `blink` 是两件事：同一槽位连发也不会被 80ms 判重合并掉。</li>
 * </ol>
 *
 * <p>时间全靠假定时器：真 `setTimeout` 会让这些断言变成"等 100ms 再看一眼"的统计猜测。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLINK_CLOSED_MS,
  BLINK_EXPRESSION_MAP,
  BLINK_HALF_MS,
  BlinkDriver,
  blinkClosedOp,
  blinkHalfOp,
} from '../src/pet/presentation/blink-driver';
import type { TimerPort } from '../src/pet/presentation/bus';
import { BLINK_LIKE_EXPRESSIONS, interruptDecision } from '../src/pet/presentation/priority';
import { isBlinkLikeExpression } from '../src/pet/presentation/layered-presentation';
import type { PresentationOp } from '../src/pet/presentation/types';

/** 假定时器：可以按"最早到期"逐个执行，从而精确排出 op 的顺序。 */
class FakeTimer implements TimerPort {
  /** 待执行定时器。 */
  readonly pending: { handle: number; handler: () => void; delayMs: number }[] = [];

  /** 句柄发号器。 */
  private seq = 0;

  /**
   * 注册定时器。
   *
   * @param handler 到期回调
   * @param delayMs 延迟毫秒
   * @returns 句柄
   */
  setTimeout(handler: () => void, delayMs: number): number {
    this.seq += 1;
    this.pending.push({ handle: this.seq, handler, delayMs });
    return this.seq;
  }

  /**
   * 取消定时器。
   *
   * @param handle 句柄
   */
  clearTimeout(handle: number): void {
    const index = this.pending.findIndex((item) => item.handle === handle);
    if (index >= 0) this.pending.splice(index, 1);
  }

  /** 执行"最早到期"的那一个（同延迟按注册顺序）。 */
  runNext(): void {
    if (this.pending.length === 0) return;
    let best = 0;
    for (let index = 1; index < this.pending.length; index += 1) {
      if (this.pending[index].delayMs < this.pending[best].delayMs) best = index;
    }
    const [item] = this.pending.splice(best, 1);
    item.handler();
  }

  /** 当前待执行的延迟列表（断言"有没有排半闭帧"用）。 */
  delays(): number[] {
    return this.pending.map((item) => item.delayMs);
  }
}

/**
 * 造一个眨眼调度器。
 *
 * @param hasHalf 半闭帧资产是否可用
 * @returns 调度器 + op 收集器 + 假定时器
 */
function makeDriver(hasHalf: boolean): {
  readonly driver: BlinkDriver;
  readonly ops: PresentationOp[];
  readonly timer: FakeTimer;
} {
  const ops: PresentationOp[] = [];
  const timer = new FakeTimer();
  // rng 固定 0.5：不触发"偶发双眨"（12%），间隔走长分支——序列可预测且不掺噪声
  const driver = new BlinkDriver(
    (op) => ops.push(op),
    () => 0.5,
    () => false,
    timer,
    () => hasHalf,
  );
  return { driver, ops, timer };
}

// ------------------------------------------------------------------ R4：眨眼序列

test('R4：half 映射指向 blinkHalf（不是 sleepy），wink 也在映射表里但语义独立', () => {
  assert.equal(BLINK_EXPRESSION_MAP.open, 'neutral');
  assert.equal(BLINK_EXPRESSION_MAP.closed, 'blink');
  assert.equal(BLINK_EXPRESSION_MAP.half, 'blinkHalf', '半闭帧必须是独立档，不许再借用 sleepy');
  assert.notEqual(BLINK_EXPRESSION_MAP.half, 'sleepy');
  assert.equal(BLINK_EXPRESSION_MAP.wink, 'wink', 'wink 必须指向 wink 自己的贴片，不许顶替 blink');
  assert.deepEqual([...BLINK_LIKE_EXPRESSIONS], ['blink', 'blinkHalf', 'wink']);
  for (const id of BLINK_LIKE_EXPRESSIONS) assert.equal(isBlinkLikeExpression(id), true);
  assert.equal(isBlinkLikeExpression('sleepy'), false, '困倦不是眨眼类（它是状态，不是眼皮动作）');
  assert.equal(isBlinkLikeExpression('happy'), false);
});

test('R4：半闭帧可用时一次眨眼 = blink(100ms) → blinkHalf(80ms)，永不含 sleepy', () => {
  const { driver, ops, timer } = makeDriver(true);
  driver.start();
  assert.equal(ops.length, 0, 'start 只排程，不立刻产出');
  timer.runNext(); // 到点 → 闭眼
  assert.equal(ops.length, 1);
  assert.equal(ops[0].id, 'blink');
  assert.equal(ops[0].layer, 'transient');
  assert.equal(ops[0].priority, 0);
  assert.equal(ops[0].durationMs, BLINK_CLOSED_MS);
  assert.equal(ops[0].fadeMs, 0);
  timer.runNext(); // 闭眼后 80ms → 半闭
  assert.equal(ops.length, 2);
  assert.equal(ops[1].id, 'blinkHalf');
  assert.equal(ops[1].durationMs, BLINK_HALF_MS);
  assert.equal(ops[1].fadeMs, 0);
  assert.deepEqual(
    ops.map((op) => op.id),
    ['blink', 'blinkHalf'],
    '眨眼序列必须是"闭 → 半闭"，不许出现 third 帧',
  );
  assert.equal(ops.some((op) => op.id === 'sleepy'), false, '眨眼永远不许产出 sleepy（E08 判据）');
  driver.stop();
});

test('R4：半闭帧未交付时退化成两态——一次眨眼只产出 1 条 blink，且不排半闭定时器', () => {
  const { driver, ops, timer } = makeDriver(false);
  driver.start();
  timer.runNext();
  assert.equal(ops.length, 1, '两态眨眼只许有一条指令');
  assert.equal(ops[0].id, 'blink');
  assert.equal(ops.some((op) => op.id === 'sleepy'), false);
  assert.equal(ops.some((op) => op.id === 'blinkHalf'), false, '没有资产就不许请求半闭帧');
  // 待执行的定时器里只该有"下一次眨眼"，不该有 80ms 的半闭
  assert.equal(
    timer.delays().includes(BLINK_HALF_MS),
    false,
    '没有半闭资产时不该排出 80ms 的半闭定时器',
  );
  driver.stop();
  assert.equal(driver.isRunning, false);
});

test('R4：halfAvailable 会把手误注入的探测函数异常吞掉（宁可爱两态，也不许把眨眼带崩）', () => {
  const ops: PresentationOp[] = [];
  const timer = new FakeTimer();
  const driver = new BlinkDriver(
    (op) => ops.push(op),
    () => 0.5,
    () => false,
    timer,
    () => {
      throw new Error('读取贴片清单失败');
    },
  );
  assert.equal(driver.halfAvailable, false);
  driver.start();
  timer.runNext();
  assert.deepEqual(ops.map((op) => op.id), ['blink']);
  driver.stop();
});

test('R4：睡眠中一次都不眨眼（定时器照排，但一条 op 都不产出）', () => {
  const ops: PresentationOp[] = [];
  const timer = new FakeTimer();
  const driver = new BlinkDriver(
    (op) => ops.push(op),
    () => 0.5,
    () => true,
    timer,
    () => true,
  );
  driver.start();
  timer.runNext();
  assert.equal(ops.length, 0, '睡着不该眨眼');
  assert.ok(timer.pending.length > 0, '但必须继续排下一轮，否则醒来后永远不再眨');
  driver.stop();
});

// ------------------------------------------------------------------ R6：睡眠抑制

test('R6：睡眠中 blink / blinkHalf / wink 全部被判 reject', () => {
  for (const id of ['blink', 'blinkHalf', 'wink'] as const) {
    const decision = interruptDecision({
      incoming: { kind: 'expression', id, layer: 'transient', priority: 0, reason: `test:${id}` },
      active: null,
      sleeping: true,
    });
    assert.equal(decision, 'reject', `睡眠中 ${id} 必须被拒（且不排队）`);
  }
  // 反向：醒着时同一条指令必须能过（否则等于把眨眼整体关了）
  for (const id of ['blink', 'blinkHalf', 'wink'] as const) {
    const decision = interruptDecision({
      incoming: { kind: 'expression', id, layer: 'transient', priority: 0, reason: `test:${id}` },
      active: null,
      sleeping: false,
    });
    assert.equal(decision, 'apply', `醒着时 ${id} 不该被拒`);
  }
  // 睡眠中非眨眼类表情不受这条规则影响（规则表只认眨眼类集合）
  assert.equal(
    interruptDecision({
      incoming: { kind: 'expression', id: 'happy', layer: 'transient', priority: 0, reason: 'test:happy' },
      active: null,
      sleeping: true,
    }),
    'apply',
  );
});

// ------------------------------------------------------------------ R5：wink 与 blink 互不覆盖

test('R5：同一槽位里 wink 不会被当成 blink 的"连点重复"合并掉', () => {
  const lastApplied = { slot: 'transient:expression', id: 'blink', atMs: 0 };
  const decision = interruptDecision({
    incoming: { kind: 'expression', id: 'wink', layer: 'transient', priority: 1, reason: 'test:wink' },
    active: null,
    sleeping: false,
    lastApplied,
    nowMs: 10,
  });
  assert.equal(decision, 'apply', 'wink 与 blink 是两个语义，不能被 80ms 判重吞掉');
  // 反向：真正的重复（同 id 同槽位 80ms 内）仍然要被合并
  assert.equal(
    interruptDecision({
      incoming: { kind: 'expression', id: 'blink', layer: 'transient', priority: 0, reason: 'test:blink' },
      active: null,
      sleeping: false,
      lastApplied,
      nowMs: 10,
    }),
    'reject',
  );
});

test('R5：blink 与 wink 的 op 结构和时长不同（不许互相顶替）', () => {
  const blink = blinkClosedOp('test:blink');
  const half = blinkHalfOp('test:half');
  assert.equal(blink.id, 'blink');
  assert.equal(half.id, 'blinkHalf');
  assert.equal(blink.durationMs, BLINK_CLOSED_MS);
  assert.equal(half.durationMs, BLINK_HALF_MS);
  // 两条都必须 fade 0（眨眼窗口只有 80–100ms，叠 100ms 淡入等于全程半透明）
  assert.equal(blink.fadeMs, 0);
  assert.equal(half.fadeMs, 0);
  assert.notEqual(String(blink.id), BLINK_EXPRESSION_MAP.wink);
});
