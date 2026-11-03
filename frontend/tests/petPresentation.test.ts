/**
 * 表现层指令与调度单测（tsx 执行，不碰 DOM）。
 *
 * <p>覆盖设计文档 §3.2 的打断规则表逐行、调度总线的层 TTL 与排队、眨眼调度器的间隔分布与
 * 三态序列、指令路由的映射表，以及 preload 白名单与路由器清单的一致性（漏改白名单是"发了没反应"
 * 的头号原因）。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PresentationBus, type TimerPort } from '../src/pet/presentation/bus';
import {
  BLINK_CLOSED_MS,
  BLINK_HALF_MS,
  BLINK_LONG_MAX_DELAY_MS,
  BLINK_LONG_MIN_DELAY_MS,
  BLINK_MAX_DELAY_MS,
  BLINK_MIN_DELAY_MS,
  BLINK_SHORT_GAP_PROBABILITY,
  BLINK_SHORT_MAX_DELAY_MS,
  BLINK_SHORT_MIN_DELAY_MS,
  DOUBLE_BLINK_GAP_MS,
  DOUBLE_BLINK_PROBABILITY,
  BLINK_EXPRESSION_MAP,
  BlinkDriver,
  blinkClosedOp,
  blinkHalfOp,
  nextBlinkDelayMs,
} from '../src/pet/presentation/blink-driver';
import { CommandRouter, MOTION_RECIPES } from '../src/pet/presentation/command-router';
import {
  INTERRUPT_LOCK_MS,
  canInterrupt,
  interruptDecision,
  suppressionReason,
  type InterruptQuery,
} from '../src/pet/presentation/priority';
import {
  DEFAULT_PRESENTATION_STATE,
  DRIVEN_NEUTRAL,
  EXPRESSION_IDS,
  MOTION_IDS,
  isPresentationOp,
  type PresentationOp,
  type PresentationState,
} from '../src/pet/presentation/types';

/** 可控时钟 + 定时器（把 TTL 变成可断言的同步推进）。 */
class FakeTimer implements TimerPort {
  /** 当前虚拟时间（毫秒）。 */
  private time = 0;

  /** 自增句柄。 */
  private seq = 0;

  /** 待执行任务。 */
  private readonly tasks = new Map<number, { at: number; handler: () => void }>();

  /** 累计注册的定时器数量（断言"没有泄漏"用）。 */
  scheduled = 0;

  /** 累计取消的定时器数量。 */
  cancelled = 0;

  /**
   * 注册定时器。
   *
   * @param handler 回调
   * @param delayMs 延迟
   * @returns 句柄
   */
  setTimeout(handler: () => void, delayMs: number): number {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.time + delayMs, handler });
    this.scheduled += 1;
    return id;
  }

  /**
   * 取消定时器。
   *
   * @param handle 句柄
   */
  clearTimeout(handle: number): void {
    if (this.tasks.delete(handle)) this.cancelled += 1;
  }

  /**
   * 推进虚拟时间并按到期顺序执行任务。
   *
   * @param ms 推进毫秒数
   */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, task] of this.tasks) {
        if (task.at <= target && task.at < nextAt) {
          nextAt = task.at;
          nextId = id;
        }
      }
      if (nextId < 0) break;
      const task = this.tasks.get(nextId);
      this.tasks.delete(nextId);
      this.time = nextAt;
      task?.handler();
    }
    this.time = target;
  }

  /** 当前虚拟时间。 */
  now(): number {
    return this.time;
  }

  /** 待执行任务数。 */
  pending(): number {
    return this.tasks.size;
  }
}

/** 只记录 op 的假表现层（用于验证调度而不是验证 DOM 写入）。 */
class RecordingPresentation {
  /** 收到过的 op（按时间顺序）。 */
  readonly applied: PresentationOp[] = [];

  /** 当前状态。 */
  private current: PresentationState = DEFAULT_PRESENTATION_STATE;

  /** 收到一条 op。 */
  apply(op: PresentationOp): void {
    this.applied.push(op);
    if (op.kind === 'expression') this.current = { ...this.current, expression: op.id as PresentationState['expression'] };
    if (op.kind === 'motion') this.current = { ...this.current, motion: op.id as PresentationState['motion'] };
    if (op.kind === 'driven') {
      this.current = {
        ...this.current,
        driven: { ...this.current.driven, [op.id]: typeof op.value === 'number' ? op.value : DRIVEN_NEUTRAL[op.id as keyof typeof DRIVEN_NEUTRAL] },
      };
    }
  }

  /** 预准备（本测试不关心）。 */
  async prepare(): Promise<void> {}

  /** 当前状态。 */
  get state(): PresentationState {
    return this.current;
  }

  /** 释放。 */
  dispose(): void {}
}

/**
 * 造一条测试用 op。
 *
 * @param overrides 覆盖字段
 * @returns 完整 op
 */
function op(overrides: Partial<PresentationOp> = {}): PresentationOp {
  return {
    kind: 'expression',
    id: 'happy',
    layer: 'transient',
    priority: 1,
    durationMs: 900,
    fadeMs: 0,
    reason: 'test',
    ...overrides,
  } as PresentationOp;
}

// ---------------------------------------------------------------- 打断规则表

test('规则表：priority 更高 → 立即打断', () => {
  const query: InterruptQuery = {
    incoming: op({ priority: 2 }),
    active: { layer: 'transient', priority: 1, remainingMs: 1000 },
  };
  assert.equal(interruptDecision(query), 'apply');
});

test('规则表：priority 相同 → 后到覆盖', () => {
  const query: InterruptQuery = {
    incoming: op({ priority: 1 }),
    active: { layer: 'base', priority: 1, remainingMs: 5000 },
  };
  assert.equal(interruptDecision(query), 'apply');
});

test('规则表：priority 更低且活动剩余 >120ms → 拒绝', () => {
  const query: InterruptQuery = {
    incoming: op({ kind: 'expression', id: 'blink', priority: 0, durationMs: 100 }),
    active: { layer: 'transient', priority: 1, remainingMs: INTERRUPT_LOCK_MS + 1 },
  };
  assert.equal(interruptDecision(query), 'reject');
  assert.equal(canInterrupt(query), false);
  assert.equal(suppressionReason(query), 'lower-priority-locked');
});

test('规则表：priority 更低且活动剩余 ≤120ms → 排队', () => {
  const query: InterruptQuery = {
    incoming: op({ kind: 'expression', id: 'blink', priority: 0, durationMs: 100 }),
    active: { layer: 'transient', priority: 1, remainingMs: INTERRUPT_LOCK_MS },
  };
  assert.equal(interruptDecision(query), 'queue');
  assert.equal(canInterrupt(query), false);
  assert.equal(suppressionReason(query), 'queued-until-active-expires');
});

test('规则表：低优先级遇永不到期的活动指令 → 拒绝而不是排队', () => {
  const query: InterruptQuery = {
    incoming: op({ priority: 0 }),
    active: { layer: 'base', priority: 1, remainingMs: null },
  };
  assert.equal(interruptDecision(query), 'reject');
});

test('规则表：睡眠中来 blink → 抑制（既不应用也不排队）', () => {
  const query: InterruptQuery = {
    incoming: op({ kind: 'expression', id: 'blink', priority: 0, durationMs: 100 }),
    active: null,
    sleeping: true,
  };
  assert.equal(interruptDecision(query), 'reject');
  assert.equal(suppressionReason(query), 'sleeping-no-blink');
});

test('规则表：拖拽中来 ambient → 抑制', () => {
  const query: InterruptQuery = {
    incoming: op({ kind: 'expression', id: 'neutral', layer: 'ambient', priority: 2 }),
    active: null,
    activeMotion: 'drag',
  };
  assert.equal(interruptDecision(query), 'reject');
  assert.equal(suppressionReason(query), 'drag-blocks-ambient');
});

test('规则表：同一 op 80ms 内重复 → 合并丢弃；超过 80ms 放行', () => {
  const duplicated: InterruptQuery = {
    incoming: op({ kind: 'expression', id: 'happy' }),
    active: { layer: 'transient', priority: 1, remainingMs: 500 },
    lastApplied: { slot: 'transient:expression', id: 'happy', atMs: 1000 },
    nowMs: 1000 + 79,
  };
  assert.equal(interruptDecision(duplicated), 'reject');
  assert.equal(suppressionReason(duplicated), 'duplicate-within-80ms');

  const later: InterruptQuery = { ...duplicated, nowMs: 1000 + 80 };
  assert.notEqual(interruptDecision(later), 'reject');
});

test('规则表：没有活动指令时任何 op 都应用', () => {
  assert.equal(interruptDecision({ incoming: op({ priority: 0 }), active: null }), 'apply');
});

// ---------------------------------------------------------------- 调度总线

test('总线：应用后按 TTL 回落到 base 层指令', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = new PresentationBus(target, { timer, now: () => timer.now() });
  bus.dispatch(op({ kind: 'expression', id: 'neutral', layer: 'base', priority: 0, durationMs: undefined }));
  bus.dispatch(op({ kind: 'expression', id: 'happy', layer: 'transient', priority: 1, durationMs: 300 }));
  assert.equal(target.state.expression, 'happy');

  timer.advance(300);
  // 到期后 re-apply 主导指令（base 的 neutral）
  assert.equal(target.state.expression, 'neutral');
  assert.equal(bus.peek('transient', 'expression'), null);
  assert.equal(bus.peek('base', 'expression')?.id, 'neutral');
});

test('总线：跨层比较优先级（眨眼不该刷掉生气表情）', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = new PresentationBus(target, { timer, now: () => timer.now() });
  bus.dispatch(op({ kind: 'expression', id: 'angry', layer: 'base', priority: 1, durationMs: 2000 }));
  const outcome = bus.dispatch(op({ kind: 'expression', id: 'blink', layer: 'transient', priority: 0, durationMs: 100 }));
  assert.equal(outcome, 'rejected');
  assert.equal(target.state.expression, 'angry');
});

test('总线：低优先级指令在活动指令剩余 ≤120ms 时排队，到期后执行', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = new PresentationBus(target, { timer, now: () => timer.now() });
  bus.dispatch(op({ kind: 'expression', id: 'happy', layer: 'transient', priority: 1, durationMs: 150 }));
  timer.advance(50); // 剩余 100ms ≤ 120 → 排队
  const outcome = bus.dispatch(op({ kind: 'expression', id: 'blink', layer: 'transient', priority: 0, durationMs: 100 }));
  assert.equal(outcome, 'queued');
  assert.equal(bus.queuedCount, 1);

  timer.advance(100); // happy 到期 → 排队指令执行
  assert.equal(target.state.expression, 'blink');
  assert.equal(bus.queuedCount, 0);
});

// ---------------------------------------------------------------- 入态接管（M6-b 第二轮必修项 1）

test('规则表：入态接管（force）在"低优先级锁"未解除时仍然 apply', () => {
  // 复刻 QA 的现场：angry 的表情记录还有 1200ms 才到期（远大于 INTERRUPT_LOCK_MS），
  // 此时进来一条优先级 0 的睡眠指令。没有接管语义时这里返回 reject，
  // 于是"行为层说睡了、画面永远停在 angry"。
  const query: InterruptQuery = {
    incoming: op({ kind: 'motion', id: 'sleepy', layer: 'base', priority: 0, durationMs: undefined, force: true }),
    active: { layer: 'base', priority: 1, remainingMs: 1200 },
    lastApplied: { kind: 'expression', id: 'angry', atMs: 0 },
    nowMs: 10,
  };
  assert.equal(interruptDecision(query), 'apply');
  assert.equal(suppressionReason(query), null, '接管不该被记成"重复"或"低优先级锁"');
});

test('规则表：接管不受 80ms 连点合并约束（连续两次入态都要真的落地）', () => {
  const incoming = op({ kind: 'motion', id: 'tap', layer: 'base', priority: 1, durationMs: 480, force: true });
  const query: InterruptQuery = {
    incoming,
    active: null,
    lastApplied: { slot: 'base:motion', id: 'tap', atMs: 5 },
    nowMs: 10,
  };
  assert.equal(interruptDecision(query), 'apply');
  // 对照：不带 force 的"表现请求"同 80ms 内重复仍要被合并掉
  assert.equal(interruptDecision({ ...query, incoming: op({ kind: 'motion', id: 'tap', layer: 'base', priority: 1, durationMs: 480 }) }), 'reject');
});

test('总线：高优先级记录未过期时，入态指令仍能接管目标层（且 3 秒后不回退）', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = new PresentationBus(target, { timer, now: () => timer.now() });

  // 现场：angry 的动作与表情都还活着（TTL 1200ms）
  assert.equal(
    bus.dispatch(op({ kind: 'motion', id: 'angry', layer: 'base', priority: 1, durationMs: 1200 })),
    'applied',
  );
  assert.equal(
    bus.dispatch(op({ kind: 'expression', id: 'angry', layer: 'transient', priority: 1, durationMs: 1200 })),
    'applied',
  );
  timer.advance(200); // 距离 angry 到期还有 1000ms ≫ INTERRUPT_LOCK_MS

  // 进入睡眠（优先级 0，但带接管标记）
  const sleepMotion: PresentationOp = {
    kind: 'motion', id: 'sleepy', layer: 'base', priority: 0, loop: true, fadeMs: 0, reason: 'test:force:sleep', force: true,
  };
  const sleepExpression: PresentationOp = {
    kind: 'expression', id: 'sleepy', layer: 'transient', priority: 0, fadeMs: 0, reason: 'test:force:sleep', force: true,
  };
  assert.equal(bus.dispatch(sleepMotion), 'applied');
  assert.equal(bus.dispatch(sleepExpression), 'applied');
  assert.equal(target.state.motion, 'sleepy');
  assert.equal(target.state.expression, 'sleepy');
  // 该层旧记录必须被作废（不是"叠一层"）
  assert.equal(bus.peek('base', 'motion')?.id, 'sleepy');
  assert.equal(bus.peek('transient', 'expression')?.id, 'sleepy');

  // 关键：不能只是"闪一下"。3 秒后（远超 angry 的 1000ms 残余）仍然是睡眠
  timer.advance(3000);
  assert.equal(target.state.motion, 'sleepy', '睡眠必须是持续态，不能被旧记录的 TTL 拽回去');
  assert.equal(target.state.expression, 'sleepy');
  assert.equal(bus.queuedCount, 0);
});

test('总线：反向接管（sleeping → angry）同样成立', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = new PresentationBus(target, { timer, now: () => timer.now(), isSleeping: () => target.state.expression === 'sleepy' });
  assert.equal(
    bus.dispatch({ kind: 'motion', id: 'sleepy', layer: 'base', priority: 0, loop: true, fadeMs: 0, reason: 'test:force:sleep', force: true }),
    'applied',
  );
  assert.equal(
    bus.dispatch({ kind: 'expression', id: 'sleepy', layer: 'transient', priority: 0, fadeMs: 0, reason: 'test:force:sleep', force: true }),
    'applied',
  );
  // 睡眠动作是"永不到期"的记录（remainingMs === null），纯优先级比较时它会把一切低优先级 op 拒掉
  assert.equal(
    bus.dispatch(op({ kind: 'motion', id: 'angry', layer: 'base', priority: 1, durationMs: 1200, force: true })),
    'applied',
  );
  assert.equal(
    bus.dispatch(op({ kind: 'expression', id: 'angry', layer: 'transient', priority: 1, durationMs: 1200, force: true })),
    'applied',
  );
  assert.equal(target.state.motion, 'angry');
  assert.equal(target.state.expression, 'angry');
  timer.advance(1200);
  // angry 到期后回落：没有可回落的主导指令，但也不能回到睡眠（旧记录已被接管作废）
  assert.notEqual(target.state.expression, 'sleepy');
});

test('总线：入态接管会作废排队中的旧请求（不能在 TTL 到期时把旧状态贴回来）', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = new PresentationBus(target, { timer, now: () => timer.now() });
  bus.dispatch(op({ kind: 'expression', id: 'happy', layer: 'transient', priority: 1, durationMs: 150 }));
  timer.advance(50); // 剩余 100ms ≤ 120 → 低优先级请求进入排队
  assert.equal(
    bus.dispatch(op({ kind: 'expression', id: 'blink', layer: 'transient', priority: 0, durationMs: 100 })),
    'queued',
  );
  assert.equal(bus.queuedCount, 1);

  // 入态接管：睡眠表情（force）
  assert.equal(
    bus.dispatch({ kind: 'expression', id: 'sleepy', layer: 'transient', priority: 0, fadeMs: 0, reason: 'test:force:sleep', force: true }),
    'applied',
  );
  assert.equal(bus.queuedCount, 0, '接管之后旧的排队请求必须全部作废');
  timer.advance(1000);
  assert.equal(target.state.expression, 'sleepy');
});

test('总线：睡眠中丢弃 blink，但仍应用其它指令', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = new PresentationBus(target, { timer, now: () => timer.now(), isSleeping: () => true });
  assert.equal(bus.dispatch(op({ kind: 'expression', id: 'blink', priority: 0, durationMs: 100 })), 'rejected');
  assert.equal(bus.dispatch(op({ kind: 'expression', id: 'sad', priority: 1, durationMs: 500 })), 'applied');
});

test('总线：非法 op 与释放后投递都被拒绝（不抛）', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = new PresentationBus(target, { timer, now: () => timer.now() });
  assert.equal(bus.dispatch({ kind: 'expression', id: '不存在的表情' } as unknown as PresentationOp), 'rejected');
  bus.dispose();
  assert.equal(bus.dispatch(op()), 'rejected');
  assert.equal(timer.pending(), 0);
});

test('总线：同层新指令会取消旧指令的定时器（不留悬空定时器）', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = new PresentationBus(target, { timer, now: () => timer.now() });
  bus.dispatch(op({ kind: 'expression', id: 'happy', durationMs: 900 }));
  bus.dispatch(op({ kind: 'expression', id: 'sad', durationMs: 1200 }));
  assert.equal(timer.pending(), 1);
  assert.ok(timer.cancelled >= 1);
});

test('总线：driven 档写入实现的状态（角度/不透明度）', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = new PresentationBus(target, { timer, now: () => timer.now() });
  bus.dispatch(op({ kind: 'driven', id: 'tailAngle', layer: 'ambient', priority: 0, durationMs: undefined, value: 3.5 }));
  assert.equal(target.state.driven.tailAngle, 3.5);
});

// ---------------------------------------------------------------- 眨眼

test('眨眼：不规则分布——短分支 0.9–2.0s，长分支 3.2–9.0s', () => {
  // 第一个值决定分支（< 22% 走短间隔），第二个值在分支内取值
  assert.equal(nextBlinkDelayMs(seq([0, 0])), BLINK_SHORT_MIN_DELAY_MS);
  assert.equal(nextBlinkDelayMs(seq([0, 1])), BLINK_SHORT_MAX_DELAY_MS);
  assert.equal(nextBlinkDelayMs(seq([0.9, 0])), BLINK_LONG_MIN_DELAY_MS);
  assert.equal(nextBlinkDelayMs(seq([0.9, 1])), BLINK_LONG_MAX_DELAY_MS);
  // 分支阈值本身：恰好等于概率值时走长分支
  assert.equal(nextBlinkDelayMs(seq([BLINK_SHORT_GAP_PROBABILITY, 0])), BLINK_LONG_MIN_DELAY_MS);
  assert.equal(nextBlinkDelayMs(seq([BLINK_SHORT_GAP_PROBABILITY - 0.001, 0])), BLINK_SHORT_MIN_DELAY_MS);
});

test('眨眼：长间隔更常见（长端偏置把取值推向 9s 一侧）', () => {
  // u=0.5 时若均匀分布会落在正中 (3200+9000)/2 = 6100；偏置后应明显更大
  const mid = nextBlinkDelayMs(seq([0.9, 0.5]));
  const uniformMid = (BLINK_LONG_MIN_DELAY_MS + BLINK_LONG_MAX_DELAY_MS) / 2;
  assert.ok(mid > uniformMid, `u=0.5 时应偏向长端：mid=${mid}, uniformMid=${uniformMid}`);
});

test('眨眼：整体分布——短间隔偶发、长间隔为主、全落在上下界内', () => {
  let state = 123456789;
  const rng = (): number => {
    // xorshift32：固定种子，结果可复现
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
  const samples: number[] = [];
  for (let i = 0; i < 4000; i += 1) samples.push(nextBlinkDelayMs(rng));
  const shortCount = samples.filter((ms) => ms < BLINK_LONG_MIN_DELAY_MS).length;
  const shortRatio = shortCount / samples.length;
  const mean = samples.reduce((sum, ms) => sum + ms, 0) / samples.length;
  assert.ok(
    Math.abs(shortRatio - BLINK_SHORT_GAP_PROBABILITY) < 0.05,
    `短间隔占比应接近 ${BLINK_SHORT_GAP_PROBABILITY}，实际 ${shortRatio.toFixed(3)}`,
  );
  assert.ok(mean > 5000, `长间隔为主，均值应明显偏大，实际 ${mean.toFixed(0)}ms`);
  assert.ok(samples.every((ms) => ms >= BLINK_MIN_DELAY_MS && ms <= BLINK_MAX_DELAY_MS));
});

/**
 * 造一个按序列取值的 rng（用尽后重复最后一个值）。
 *
 * @param values 取值序列
 * @returns rng
 */
function seq(values: readonly number[]): () => number {
  let cursor = 0;
  return () => values[Math.min(cursor++, values.length - 1)] as number;
}

test('眨眼：BlinkDriver.nextDelayMs 与纯函数同源', () => {
  const driver = new BlinkDriver(() => {}, seq([0.9, 1]), () => false, new FakeTimer());
  assert.equal(driver.nextDelayMs(), BLINK_LONG_MAX_DELAY_MS);
});

test('眨眼：双眨概率阈值为 12%', () => {
  const low = new BlinkDriver(() => {}, () => DOUBLE_BLINK_PROBABILITY - 0.01, () => false, new FakeTimer());
  assert.equal(low.shouldDoubleBlink(), true);
  const high = new BlinkDriver(() => {}, () => DOUBLE_BLINK_PROBABILITY, () => false, new FakeTimer());
  assert.equal(high.shouldDoubleBlink(), false);
});

test('眨眼：三态序列（闭 100ms → 半闭 80ms），每轮两次 emit', () => {
  const timer = new FakeTimer();
  const emitted: PresentationOp[] = [];
  // start 先吃两个数（分支 + 取值）→ 走短分支下限 900ms；再吃一个数判双眨（1 = 不双眨）
  // 第 5 个参数 = "半闭帧资产是否可用"：三态是可选优化，未交付时退化成两态（§5.2 第 3 条），
  // 所以这条用例必须显式声明"资产在"，否则测的是降级路径。
  const driver = new BlinkDriver((item) => emitted.push(item), seq([0, 0, 1, 0, 0]), () => false, timer, () => true);
  driver.start();
  timer.advance(BLINK_SHORT_MIN_DELAY_MS);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.id, 'blink');
  assert.equal(emitted[0]?.durationMs, BLINK_CLOSED_MS);
  timer.advance(BLINK_CLOSED_MS);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1]?.id, BLINK_EXPRESSION_MAP.half);
  assert.equal(emitted[1]?.id, 'blinkHalf', '半闭帧必须是独立档，不许再借 sleepy 整脸');
  assert.equal(emitted[1]?.durationMs, BLINK_HALF_MS);
  driver.stop();
});

test('眨眼：半闭帧资产未交付时退化成两态（闭 → 睁），仍然只有 blink 一条', () => {
  const timer = new FakeTimer();
  const emitted: PresentationOp[] = [];
  const driver = new BlinkDriver((item) => emitted.push(item), seq([0, 0, 1, 0, 0]), () => false, timer);
  driver.start();
  timer.advance(BLINK_SHORT_MIN_DELAY_MS);
  timer.advance(BLINK_CLOSED_MS + BLINK_HALF_MS);
  assert.deepEqual(emitted.map((item) => item.id), ['blink'], '缺半闭资产时一次眨眼只产出一条闭眼指令');
  driver.stop();
});

test('眨眼：睡眠中不产出任何 op', () => {
  const timer = new FakeTimer();
  const emitted: PresentationOp[] = [];
  const driver = new BlinkDriver((item) => emitted.push(item), () => 0, () => true, timer);
  driver.start();
  timer.advance(BLINK_MAX_DELAY_MS * 3);
  assert.equal(emitted.length, 0);
  driver.stop();
});

test('眨眼：触发双眨时 220ms 后再来一轮', () => {
  const timer = new FakeTimer();
  const emitted: PresentationOp[] = [];
  // 每次 tick 消耗两个 rng：间隔、是否双眨
  const values = [0, 0, 0, 1];
  let cursor = 0;
  const driver = new BlinkDriver(
    (item) => emitted.push(item),
    () => values[Math.min(cursor++, values.length - 1)],
    () => false,
    timer,
  );
  driver.start();
  timer.advance(BLINK_MIN_DELAY_MS);
  assert.equal(emitted.length, 1);
  timer.advance(DOUBLE_BLINK_GAP_MS);
  assert.equal(emitted.length >= 2, true, `双眨后应再闭眼一次，实际 ${emitted.length} 次`);
  driver.stop();
});

test('眨眼：stop 之后不再产出并清空定时器', () => {
  const timer = new FakeTimer();
  let count = 0;
  const driver = new BlinkDriver(() => {
    count += 1;
  }, () => 0, () => false, timer);
  driver.start();
  driver.stop();
  assert.equal(driver.isRunning, false);
  assert.equal(timer.pending(), 0);
  timer.advance(BLINK_MAX_DELAY_MS);
  assert.equal(count, 0);
});

// ---------------------------------------------------------------- 指令路由

test('路由：play tap → 动作 + 伴随表情两条 op', () => {
  const router = new CommandRouter();
  const ops = router.route({ type: 'play', motion: 'tap' });
  assert.equal(ops.length, 2);
  assert.equal(ops[0]?.kind, 'motion');
  assert.equal(ops[0]?.id, 'tap');
  assert.equal(ops[0]?.durationMs, MOTION_RECIPES.tap.motionMs);
  assert.equal(ops[1]?.kind, 'expression');
  assert.equal(ops[1]?.id, 'happy');
});

test('路由：drag 是循环且不限时，优先级 2', () => {
  const router = new CommandRouter();
  const ops = router.route({ type: 'play', motion: 'drag' });
  assert.equal(ops.length, 1);
  assert.equal(ops[0]?.loop, true);
  assert.equal(ops[0]?.durationMs, undefined);
  assert.equal(ops[0]?.priority, 2);
});

test('路由：expression 指令走 transient 层并带默认 1200ms', () => {
  const router = new CommandRouter();
  const ops = router.route({ type: 'expression', expression: 'shy' });
  assert.equal(ops.length, 1);
  assert.equal(ops[0]?.layer, 'transient');
  assert.equal(ops[0]?.durationMs, 1200);
});

test('路由：未知动作/未知表情/未知类型/非对象一律返回空数组', () => {
  const router = new CommandRouter();
  assert.deepEqual(router.route({ type: 'play', motion: '飞天' }), []);
  assert.deepEqual(router.route({ type: 'expression', expression: '面无表情' }), []);
  assert.deepEqual(router.route({ type: 'hack' }), []);
  assert.deepEqual(router.route(null), []);
  assert.deepEqual(router.route('play'), []);
});

test('路由：ready/hit-state/visible/ping 不产出 op（由 main.ts 直接消费）', () => {
  const router = new CommandRouter();
  for (const type of ['ready', 'hit-state', 'visible', 'ping']) {
    assert.deepEqual(router.route({ type }), [], `type=${type} 不该产生表现层 op`);
  }
});

test('preload 白名单与路由清单一致（漏改白名单 = 发了没反应）', () => {
  const preloadPath = resolve(process.cwd(), 'electron/pet-preload.cjs');
  const source = readFileSync(preloadPath, 'utf8');
  const matched = /KNOWN_COMMAND_TYPES\s*=\s*\[([\s\S]*?)\]/.exec(source);
  assert.ok(matched, '未能在 pet-preload.cjs 中找到 KNOWN_COMMAND_TYPES');
  const whitelist = (matched?.[1] ?? '')
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item.length > 0);
  for (const required of ['ready', 'hit-state', 'visible', 'ping', 'play', 'expression']) {
    assert.ok(whitelist.includes(required), `白名单缺少 ${required}，主进程发这个类型会被静默丢弃`);
  }
});

// ---------------------------------------------------------------- 枚举契约

test('枚举与美术规格书 §5/§6 逐条对应（枚举名不许再改）', () => {
  // 规格书 §5 的 E1–E8
  const specExpressions = ['neutral', 'blink', 'surprised', 'sad', 'angry', 'shy', 'happy', 'sleepy'];
  for (const id of specExpressions) {
    assert.ok((EXPRESSION_IDS as readonly string[]).includes(id), `缺少规格书 §5 的表情 ${id}`);
  }
  // M1/T01：一是预留的 `yawn`，二是新增的 `blinkHalf`（生理眨眼半闭帧）与 `wink`（单眼交互表情）。
  // 三者的语义分开是设计文档 §5 的核心要求，所以这里是"精确等于 11"而不是放宽成 >=。
  assert.equal(EXPRESSION_IDS.length, 11, '8 档 + 预留 yawn + blinkHalf/wink 分离后共 11 档');
  // 两档新语义必须真的进枚举（否则 isExpressionId 会把它们判成非法，指令在总线上被丢掉）
  assert.ok((EXPRESSION_IDS as readonly string[]).includes('blinkHalf'), '缺少生理眨眼半闭帧 blinkHalf');
  assert.ok((EXPRESSION_IDS as readonly string[]).includes('wink'), '缺少单眼交互表情 wink');
  // 规格书 §6.2 的运行时动作全集
  const specMotions = ['idle', 'tap', 'happy', 'angry', 'surprised', 'sleepy', 'sad', 'drag', 'wake'];
  assert.deepEqual([...MOTION_IDS].sort(), [...specMotions].sort());
});

test('isPresentationOp：结构与 id 都要校验', () => {
  assert.equal(isPresentationOp(op()), true);
  assert.equal(isPresentationOp({ ...op(), priority: 3 }), false);
  assert.equal(isPresentationOp({ ...op(), layer: 'main' }), false);
  assert.equal(isPresentationOp({ ...op(), kind: 'expression', id: 'tap' }), false);
  assert.equal(isPresentationOp({ ...op(), durationMs: -1 }), false);
  assert.equal(isPresentationOp({ ...op(), value: Number.NaN }), false);
});

// ---------------------------------------------------------------- 槽位模型 + 表情回落（M6-b 第四轮）

/**
 * 造一块"有基础画面"的总线：base 的中性表情 + 常驻 idle 动作，与真机 boot 顺序一致。
 *
 * @param timer 假定时器
 * @param target 记录型表现层
 * @returns 总线
 */
function bootBus(timer: FakeTimer, target: RecordingPresentation): PresentationBus {
  const bus = new PresentationBus(target, { timer, now: () => timer.now() });
  assert.equal(
    bus.dispatch(op({ kind: 'expression', id: 'neutral', layer: 'base', priority: 0, durationMs: undefined })),
    'applied',
  );
  assert.equal(
    bus.dispatch(op({ kind: 'motion', id: 'idle', layer: 'base', priority: 0, durationMs: undefined, loop: true })),
    'applied',
  );
  return bus;
}

test('槽位：同层的 expression 与 motion 各占一个槽，互不顶占', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = bootBus(timer, target);

  // 两条都在，且分属不同槽位
  assert.equal(bus.peek('base', 'expression')?.id, 'neutral');
  assert.equal(bus.peek('base', 'motion')?.id, 'idle');

  // 动作覆盖动作、表情覆盖表情；跨 kind 不应把对方清掉
  bus.dispatch(op({ kind: 'motion', id: 'tap', layer: 'base', priority: 1, durationMs: 480 }));
  assert.equal(bus.peek('base', 'expression')?.id, 'neutral', '动作落地不该顶掉 base 的表情槽');
  assert.equal(bus.peek('base', 'motion')?.id, 'tap');

  bus.dispatch(op({ kind: 'expression', id: 'happy', layer: 'base', priority: 1, durationMs: undefined }));
  assert.equal(bus.peek('base', 'motion')?.id, 'tap', '表情落地不该顶掉 base 的动作槽');
  assert.equal(bus.peek('base', 'expression')?.id, 'happy');
});

test('眨眼三态（closed → half → 到期）后表情回到 base 表情（不再永久停在 sleepy）', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = bootBus(timer, target);
  assert.equal(target.state.expression, 'neutral');

  // 闭眼 100ms
  assert.equal(bus.dispatch(blinkClosedOp('test:blink')), 'applied');
  assert.equal(target.state.expression, BLINK_EXPRESSION_MAP.closed);
  timer.advance(BLINK_CLOSED_MS);
  assert.equal(target.state.expression, 'neutral', '闭眼到期必须睁眼（回落 base 表情）');

  // 半闭 80ms
  assert.equal(bus.dispatch(blinkHalfOp('test:blink:half')), 'applied');
  assert.equal(target.state.expression, BLINK_EXPRESSION_MAP.half);
  timer.advance(BLINK_HALF_MS);
  assert.equal(
    target.state.expression,
    'neutral',
    '半闭到期必须回到 base 表情；停在 sleepy 就是"永久半闭眼的困倦脸"',
  );
  assert.equal(bus.peek('transient', 'expression'), null);
});

test('眨眼期间来一条 motion op，不影响表情回落', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = bootBus(timer, target);

  assert.equal(bus.dispatch(blinkClosedOp('test:blink')), 'applied');
  timer.advance(BLINK_CLOSED_MS);
  assert.equal(bus.dispatch(blinkHalfOp('test:blink:half')), 'applied');
  // M1 起半闭帧是独立的 `blinkHalf`（以前借用 `sleepy` 整脸，下一条断言下面还有反向的）
  assert.equal(target.state.expression, BLINK_EXPRESSION_MAP.half);
  assert.notEqual(target.state.expression, 'sleepy', '半闭帧不许是困倦整脸（嘴型会跟着眨眼抖）');

  // 半闭还挂着的时候，行为层下发一条 tap 动作（写 base 的 motion 槽）
  assert.equal(
    bus.dispatch(op({ kind: 'motion', id: 'tap', layer: 'base', priority: 1, durationMs: 480 })),
    'applied',
  );
  timer.advance(BLINK_HALF_MS);
  assert.equal(
    target.state.expression,
    'neutral',
    'motion 只占动作槽：半闭到期后表情必须照样回中性，不能被"重放动作指令"顶住',
  );
  assert.equal(target.state.motion, 'tap');
});

test('回落目标是 base 的 expression 槽（显式），不是"最后一条 base 指令"', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = bootBus(timer, target);

  // 显式改基础表情（等价于 `main.ts` 的 setExpression：**优先级 0**，
  // 它是回落目标而不是抢占指令；给高优先级会永久压死眨眼）
  assert.equal(
    bus.dispatch(op({ kind: 'expression', id: 'shy', layer: 'base', priority: 0, durationMs: undefined })),
    'applied',
  );
  assert.equal(target.state.expression, 'shy');
  assert.equal(bus.dispatch(blinkHalfOp('test:half')), 'applied', '基础表情不该挡住眨眼');
  timer.advance(BLINK_HALF_MS);
  assert.equal(target.state.expression, 'shy', '回落目标应是 base 表情槽，而不是常量 neutral 或最后一条动作');
});

test('base 表情槽为空时，表情到期落到中性脸（绝不停在半闭眼）', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = new PresentationBus(target, { timer, now: () => timer.now() });

  assert.equal(bus.dispatch(blinkHalfOp('test:half')), 'applied');
  timer.advance(BLINK_HALF_MS);
  assert.equal(target.state.expression, 'neutral');
});

test('判重：同一槽位的同 id 在 80ms 内才合并；换槽位/超窗都要放行', () => {
  const timer = new FakeTimer();
  const target = new RecordingPresentation();
  const bus = bootBus(timer, target);

  // 80ms 内连发两条完全相同的闭眼 → 第二条合并丢弃（连点抖动保护仍然有效）
  assert.equal(bus.dispatch(blinkClosedOp('test:blink')), 'applied');
  timer.advance(40);
  assert.equal(bus.dispatch(blinkClosedOp('test:blink')), 'rejected');

  // 超过 80ms 的同一 op 必须真的落地（不能"误判合并"）
  timer.advance(BLINK_CLOSED_MS);
  assert.equal(bus.dispatch(blinkClosedOp('test:blink:again')), 'applied');
  assert.equal(target.state.expression, 'blink');

  // 同一 id 落在另一个槽位是另一件事（base 的 blink ≠ transient 的 blink）
  assert.equal(
    bus.dispatch(op({ kind: 'expression', id: 'blink', layer: 'base', priority: 0, durationMs: undefined })),
    'applied',
  );
  assert.equal(bus.peek('base', 'expression')?.id, 'blink');
});
