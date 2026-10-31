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
  BLINK_MAX_DELAY_MS,
  BLINK_MIN_DELAY_MS,
  DOUBLE_BLINK_GAP_MS,
  DOUBLE_BLINK_PROBABILITY,
  BlinkDriver,
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
    lastApplied: { kind: 'expression', id: 'happy', atMs: 1000 },
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
  assert.equal(bus.peek('transient'), null);
  assert.equal(bus.peek('base')?.id, 'neutral');
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

test('眨眼：间隔落在 2.5–6.5s，rng=0 取下限、rng≈1 取上限', () => {
  const driver = new BlinkDriver(() => {}, () => 0, () => false, new FakeTimer());
  assert.equal(driver.nextDelayMs(), BLINK_MIN_DELAY_MS);
  const high = new BlinkDriver(() => {}, () => 0.999999, () => false, new FakeTimer());
  assert.ok(high.nextDelayMs() <= BLINK_MAX_DELAY_MS);
  const mid = new BlinkDriver(() => {}, () => 0.5, () => false, new FakeTimer());
  const midDelay = mid.nextDelayMs();
  assert.ok(midDelay > BLINK_MIN_DELAY_MS && midDelay < BLINK_MAX_DELAY_MS, `mid=${midDelay}`);
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
  // rng 序列：0（间隔下限）、1（不双眨）
  const values = [0, 1];
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
  assert.equal(emitted[0]?.id, 'blink');
  assert.equal(emitted[0]?.durationMs, BLINK_CLOSED_MS);
  timer.advance(BLINK_CLOSED_MS);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1]?.id, 'sleepy');
  assert.equal(emitted[1]?.durationMs, BLINK_HALF_MS);
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
  assert.equal(EXPRESSION_IDS.length, 9, '除 8 档外只允许预留 yawn');
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
