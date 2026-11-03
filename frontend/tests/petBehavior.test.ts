/**
 * 行为状态机单测（tsx 执行，纯逻辑，不碰 DOM）。
 *
 * <p>覆盖每一条转移与每个边界：89999/90000ms、连点 2/3 次、睡眠中点击、拖拽中不睡。
 * 时间与随机全部由测试注入，因此这些断言是确定性的，不含 sleep、不含统计猜测。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ANGRY_HOLD_MS,
  DRAG_START_SURPRISED_MS,
  IDLE_BRIDGE_MS,
  MULTI_TAP_THRESHOLD,
  MULTI_TAP_WINDOW_MS,
  PET_BEHAVIOR_DEBUG_STATES,
  PetBehaviorStateMachine,
  SLEEPY_AFTER_IDLE_MS,
  SLEEP_AFTER_IDLE_MS,
  TAP_HOLD_MS,
  WAKE_HOLD_MS,
  isPetBehaviorDebugState,
  type PetBehaviorDebugState,
} from '../src/pet/behavior/state-machine';
import { INTERRUPT_LOCK_MS } from '../src/pet/presentation/priority';
import type { PetPresentation, PresentationOp } from '../src/pet/presentation/types';

/** 可控时钟：行为状态机只认注入的 now()。 */
class Clock {
  /** 当前虚拟时间（毫秒）。 */
  time = 0;

  /** 读当前时间。 */
  now = (): number => this.time;

  /**
   * 推进时间。
   *
   * @param ms 毫秒
   */
  advance(ms: number): void {
    this.time += ms;
  }
}

/**
 * 建一个用固定 rng（0.5 = 抖动为 0）的状态机。
 *
 * @param clock 时钟
 * @returns 状态机
 */
function machine(clock: Clock): PetBehaviorStateMachine {
  return new PetBehaviorStateMachine({ now: clock.now, rng: () => 0.5 });
}

test('行为：初始是 idle，且没有待下发指令', () => {
  const clock = new Clock();
  const sm = machine(clock);
  assert.equal(sm.state, 'idle');
  assert.equal(sm.isSleeping, false);
  assert.deepEqual(sm.tick(), []);
});

test('行为：点击一次 → tap（happy 表情 + 整图一弹），并带 TTL', () => {
  const clock = new Clock();
  const sm = machine(clock);
  const ops = sm.handle('tap');
  assert.equal(sm.state, 'tap');
  assert.equal(ops.length, 2);
  const motion = ops.find((op) => op.kind === 'motion');
  const expression = ops.find((op) => op.kind === 'expression');
  assert.equal(motion?.id, 'tap');
  assert.equal(expression?.id, 'happy');
  // rng 固定 0.5 → 抖动为 0 → 正好是基准时长
  assert.equal(motion?.durationMs, TAP_HOLD_MS);
  assert.equal(expression?.durationMs, TAP_HOLD_MS);
});

test('行为：tap 到期后经桥接回到常驻 idle（两拍）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('tap');
  clock.advance(TAP_HOLD_MS - 1);
  assert.deepEqual(sm.tick(), [], '未到期不该回 idle');
  clock.advance(1);
  const bridge = sm.tick();
  assert.equal(sm.state, 'idle');
  assert.equal(bridge[0]?.id, 'idle');
  // 桥接用高优先级 + TTL，避免被总线"低优先级锁"拒绝后卡在 tap 姿势
  assert.equal(bridge[0]?.priority, 2);
  assert.equal(bridge[0]?.durationMs, IDLE_BRIDGE_MS);

  clock.advance(IDLE_BRIDGE_MS);
  const steady = sm.tick();
  assert.equal(steady[0]?.id, 'idle');
  assert.equal(steady[0]?.priority, 0, '常驻 idle 必须是优先级 0，否则眨眼永远打不进来');
  assert.equal(steady[0]?.durationMs, undefined, '常驻 idle 不该带 TTL');
});

test('行为：连点 2 次不生气（仍在 tap）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('tap');
  clock.advance(300);
  sm.handle('tap');
  assert.equal(sm.state, 'tap');
});

test('行为：连点 3 次（间隔 < 2000ms）→ angry', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('tap');
  clock.advance(300);
  sm.handle('tap');
  clock.advance(300);
  const ops = sm.handle('tap');
  assert.equal(sm.state, 'angry');
  const motion = ops.find((op) => op.kind === 'motion');
  const expression = ops.find((op) => op.kind === 'expression');
  assert.equal(motion?.id, 'angry');
  assert.equal(expression?.id, 'angry');
  assert.equal(motion?.durationMs, ANGRY_HOLD_MS);
});

test('行为：连点阈值就是 3（恰好 3 次生气，2 次不生气）', () => {
  assert.equal(MULTI_TAP_THRESHOLD, 3);
  // 边界再钉一次：第 3 次才生气，不能被改成 1 或 2 还不红
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('tap');
  clock.advance(MULTI_TAP_WINDOW_MS - 1);
  sm.handle('tap');
  assert.equal(sm.state, 'tap', '2 次不该生气');
  clock.advance(MULTI_TAP_WINDOW_MS - 1);
  sm.handle('tap');
  assert.equal(sm.state, 'angry', '3 次必须生气');
});

test('行为：相邻间隔 ≥ 2000ms 的 3 次点击不算连点（窗口会滑走）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('tap');
  clock.advance(MULTI_TAP_WINDOW_MS);
  sm.handle('tap');
  clock.advance(MULTI_TAP_WINDOW_MS);
  sm.handle('tap');
  assert.equal(sm.state, 'tap', '每次点击都超出窗口，累计不到 3 次');
});

test('行为：89999ms 无交互不睡 / 90000ms 睡（字面量边界）', () => {
  // 边界用字面量而不是常量：用常量会让"把阈值改成 89000"这种变异跟着一起变，测不出问题
  assert.equal(SLEEP_AFTER_IDLE_MS, 90000, '睡眠阈值必须是 90s');

  const clock = new Clock();
  const sm = machine(clock);
  // M1 起 60s 会先进"困倦"（sleepy，未睡），所以先把这一档消费掉再验 90s 边界
  clock.advance(SLEEPY_AFTER_IDLE_MS);
  sm.tick();
  assert.equal(sm.state, 'sleepy', '60s 应当先犯困');
  assert.equal(sm.isSleeping, false, '困倦不是睡眠');

  clock.advance(89999 - SLEEPY_AFTER_IDLE_MS);
  assert.deepEqual(sm.tick(), [], '困倦态下每拍都必须幂等（不重下发）');
  assert.equal(sm.state, 'sleepy', '89999ms 只是困倦，还没睡');

  clock.advance(1);
  const ops = sm.tick();
  assert.equal(sm.state, 'sleeping', '90000ms 必须睡');
  assert.equal(sm.isSleeping, true);
  const motion = ops.find((op) => op.kind === 'motion');
  const expression = ops.find((op) => op.kind === 'expression');
  assert.equal(motion?.id, 'sleepy');
  // E08：真睡是**双眼闭合**（闭眼贴片），困倦才是半闭的 `sleepy`；两档不得同形
  assert.equal(expression?.id, 'blink', '真睡的基础表情必须是闭眼贴片，不能与困倦同形');
  assert.equal(expression?.layer, 'base');
  // 睡眠动作优先级 0：真正的"抑制眨眼"由 bus 的 sleeping 判定做，不是靠抢占
  assert.equal(motion?.priority, 0);
});

test('行为：睡眠阈值早 1ms 也不许提前入睡（89000ms 仍应清醒）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(89000);
  sm.tick();
  // 89000ms 时最多是"困倦"，还绝不能是 sleeping（真睡是 90000ms）
  assert.equal(sm.state, 'sleepy');
  assert.equal(sm.isSleeping, false, '89000ms 不许提前入睡');
});

test('行为：睡眠中点击 → wake（surprised + 一抖）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SLEEP_AFTER_IDLE_MS);
  sm.tick();
  assert.equal(sm.state, 'sleeping');

  const ops = sm.handle('tap');
  assert.equal(sm.state, 'wake');
  assert.equal(sm.isSleeping, false);
  const motion = ops.find((op) => op.kind === 'motion');
  const expression = ops.find((op) => op.kind === 'expression');
  assert.equal(motion?.id, 'wake');
  assert.equal(expression?.id, 'surprised');
  assert.equal(motion?.priority, 2, '惊醒要能压过一切（含同层残留）');
  assert.equal(motion?.durationMs, WAKE_HOLD_MS);
});

test('行为：wake 到期后回到 idle（并经桥接落到常驻）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SLEEP_AFTER_IDLE_MS);
  sm.tick();
  sm.handle('tap');
  clock.advance(WAKE_HOLD_MS);
  const bridge = sm.tick();
  assert.equal(sm.state, 'idle');
  assert.equal(bridge[0]?.id, 'idle');
  clock.advance(IDLE_BRIDGE_MS);
  const steady = sm.tick();
  assert.equal(steady[0]?.priority, 0);
});

test('行为：拖动开始 → drag（循环、不限时、优先级 2）+ 惊一下（surprised 600ms）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  const ops = sm.handle('drag-start');
  assert.equal(sm.state, 'drag');
  assert.equal(sm.isDragging, true);
  // M1 起 drag-start 多一条"惊一下"（E03 的 drag-start 入口），所以是两条
  const motion = ops.filter((op) => op.kind === 'motion');
  const expression = ops.filter((op) => op.kind === 'expression');
  assert.equal(ops.length, 2);
  assert.equal(motion.length, 1);
  assert.equal(motion[0]?.id, 'drag');
  assert.equal(motion[0]?.priority, 2);
  assert.equal(motion[0]?.loop, true);
  assert.equal(motion[0]?.durationMs, undefined, '拖拽不限时');
  assert.equal(expression.length, 1);
  assert.equal(expression[0]?.id, 'surprised', '刚被拎起来必须惊一下');
  assert.equal(expression[0]?.layer, 'transient');
  assert.equal(expression[0]?.priority, 2);
  assert.equal(expression[0]?.durationMs, DRAG_START_SURPRISED_MS);
});

test('行为：拖动结束 → 桥接 idle → 常驻 idle', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('drag-start');
  const bridge = sm.handle('drag-end');
  assert.equal(sm.state, 'idle');
  assert.equal(sm.isDragging, false);
  assert.equal(bridge[0]?.id, 'idle');
  assert.equal(bridge[0]?.priority, 2);
  assert.equal(bridge[0]?.durationMs, IDLE_BRIDGE_MS);
  clock.advance(IDLE_BRIDGE_MS);
  const steady = sm.tick();
  assert.equal(steady[0]?.priority, 0);
});

test('行为：拖拽中不触发睡眠（哪怕过去 10 分钟）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('drag-start');
  clock.advance(SLEEP_AFTER_IDLE_MS * 6);
  assert.deepEqual(sm.tick(), []);
  assert.equal(sm.state, 'drag');
  assert.equal(sm.isSleeping, false);
});

test('行为：拖拽中的点击被忽略（不打断拖拽、不计连点）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('drag-start');
  assert.deepEqual(sm.handle('tap'), []);
  assert.deepEqual(sm.handle('tap'), []);
  assert.deepEqual(sm.handle('tap'), []);
  assert.equal(sm.state, 'drag', '连点 3 次也不该在拖拽中生气');
});

test('行为：重复的 drag-start / drag-end 是幂等的', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('drag-start');
  assert.deepEqual(sm.handle('drag-start'), []);
  sm.handle('drag-end');
  assert.deepEqual(sm.handle('drag-end'), []);
});

test('行为：生气指令的优先级高于眨眼（ambient 不许刷掉 angry）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('tap');
  sm.handle('tap');
  const ops = sm.handle('tap');
  const expression = ops.find((op) => op.kind === 'expression');
  assert.equal(expression?.priority, 1);
  assert.ok(
    (expression?.priority ?? 0) > 0,
    '生气表情优先级必须 > 眨眼(0)，否则眨眼会把生气刷掉',
  );
});

test('行为：时间与随机必须注入——源码里不许出现 Date.now / Math.random', () => {
  // 先剥掉注释：注释里正是靠"禁止 Date.now()"这句话做说明，不能算违规代码
  const raw = readFileSync(resolve('src/pet/behavior/state-machine.ts'), 'utf8');
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  assert.equal(/Date\.now\s*\(/.test(code), false, '状态机内部禁止直接读 Date.now()');
  assert.equal(/Math\.random\s*\(/.test(code), false, '状态机内部禁止直接读 Math.random()');
});

test('行为：缺少注入时构造直接抛错（防止以后悄悄退回全局时钟）', () => {
  assert.throws(() => new PetBehaviorStateMachine({ now: undefined as unknown as () => number, rng: () => 0.5 }), TypeError);
  assert.throws(() => new PetBehaviorStateMachine({ now: () => 0, rng: undefined as unknown as () => number }), TypeError);
});

test('行为：桥接时长大于调度锁阈值（否则 idle 会一直被排队）', () => {
  assert.ok(IDLE_BRIDGE_MS > INTERRUPT_LOCK_MS);
});

// ------------------------------------------------------------ 状态型持续动作（M6-b D-B3）

test('行为：睡眠是"状态型持续动作"——loop 且不带 TTL（目录仍是一次性动作）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SLEEP_AFTER_IDLE_MS);
  const ops = sm.tick();
  const motion = ops.find((op) => op.kind === 'motion');
  const expression = ops.find((op) => op.kind === 'expression');
  assert.equal(motion?.loop, true, '持续动作必须循环');
  assert.equal(motion?.durationMs, undefined, '持续动作不许带 TTL（带了就会自己到期）');
  assert.equal(expression?.durationMs, undefined, '睡眠表情也不许带 TTL');
  assert.equal(sm.sustainedMotion, 'sleepy', '持续动作必须登记，tick 才能幂等');
});

test('行为：91s 后 state==="sleeping"，且连续 60 秒 tick 都不会自动回退', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(91000);
  const ops = sm.tick();
  assert.equal(sm.state, 'sleeping');
  assert.equal(sm.isSleeping, true);
  assert.equal(ops.length, 2, '入睡当拍要下发动作 + 表情');

  // 60 秒里每 250ms 一拍，共 240 拍：一拍都不许产出指令，状态也不许自己回去
  for (let index = 0; index < 240; index += 1) {
    clock.advance(250);
    assert.deepEqual(sm.tick(), [], `第 ${index + 1} 拍不该再下发任何指令（tick 必须幂等）`);
    assert.equal(sm.state, 'sleeping', '睡眠不会自动回退');
  }
  assert.equal(sm.sustainedMotion, 'sleepy', '持续动作在整个睡眠期都还在持续');
});

test('行为：睡眠中 tick 幂等——不会每 250ms 重复下发导致动画重启', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SLEEP_AFTER_IDLE_MS);
  sm.tick();
  clock.advance(250);
  assert.deepEqual(sm.tick(), []);
  clock.advance(250);
  assert.deepEqual(sm.tick(), []);
  // 再点一下（惊醒）才允许重新有产出
  const wakeOps = sm.handle('tap');
  assert.equal(wakeOps.length, 2);
  assert.equal(sm.sustainedMotion, null, '离开睡眠态必须终止持续动作');
});

test('行为：惊醒后不会立刻又睡回去（计时被重置）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SLEEP_AFTER_IDLE_MS);
  sm.tick();
  sm.handle('tap');
  // 醒来 → 回 idle 之后再过 89 秒也不该睡（M1：60s 会先进困倦，但绝不能进 sleeping）
  clock.advance(WAKE_HOLD_MS);
  sm.tick();
  clock.advance(IDLE_BRIDGE_MS);
  sm.tick();
  clock.advance(88999);
  sm.tick();
  assert.equal(sm.isSleeping, false, '计时被重置，89 秒后还不许睡回去');
  // M1 起 60s 就会犯困：89s 时应当停在"困倦"这一档，而不是回到 idle 也不是 sleeping
  assert.equal(sm.state, 'sleepy', '计时重置后 89s 是困倦，不是 sleeping');
});

test('行为：睡眠中开始拖拽 → 打断持续动作，且拖拽中不入睡', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SLEEP_AFTER_IDLE_MS);
  sm.tick();
  assert.equal(sm.sustainedMotion, 'sleepy');
  const dragOps = sm.handle('drag-start');
  assert.equal(sm.state, 'drag');
  assert.equal(sm.isDragging, true);
  assert.equal(sm.sustainedMotion, null, '拖拽打断睡眠，持续动作必须被清掉');
  assert.equal(dragOps[0]?.id, 'drag');
  clock.advance(SLEEP_AFTER_IDLE_MS * 3);
  assert.deepEqual(sm.tick(), []);
});

// ------------------------------------------------------------ 外部驱动的状态入口（M6-b O1）

test('外部驱动：PET_BEHAVIOR_DEBUG_STATES 与 isPetBehaviorDebugState 覆盖同一份清单', () => {
  assert.deepEqual([...PET_BEHAVIOR_DEBUG_STATES], ['idle', 'tap', 'happy', 'angry', 'sleeping', 'wake', 'drag']);
  for (const state of PET_BEHAVIOR_DEBUG_STATES) assert.equal(isPetBehaviorDebugState(state), true);
  assert.equal(isPetBehaviorDebugState('nope'), false);
  assert.equal(isPetBehaviorDebugState(3), false);
});

test('外部驱动：enterState("sleeping") 直接进入睡眠并登记持续动作', () => {
  const clock = new Clock();
  const sm = machine(clock);
  const ops = sm.enterState('sleeping');
  assert.equal(sm.state, 'sleeping');
  assert.equal(sm.sustainedMotion, 'sleepy');
  assert.equal(ops.length, 2);
  assert.equal(ops.find((op) => op.kind === 'motion')?.id, 'sleepy');
  // 直达睡眠同样走"真睡 = 闭眼"口径（后门与真机必须同一条路径，否则调试看到的没有参考价值）
  assert.equal(ops.find((op) => op.kind === 'expression')?.id, 'blink');
  // 幂等：直达进去之后 tick 同样沉默
  clock.advance(250);
  assert.deepEqual(sm.tick(), []);
});

test('外部驱动：enterState 覆盖全部 7 个状态，非法值返回空数组', () => {
  const clock = new Clock();
  for (const state of PET_BEHAVIOR_DEBUG_STATES) {
    const sm = machine(clock);
    const ops = sm.enterState(state);
    assert.ok(ops.length >= 1, `${state} 必须产出至少一条指令`);
    if (state === 'idle') {
      assert.equal(sm.state, 'idle');
      // idle 走桥接（优先级 2 + TTL），否则会被总线的低优先级锁拒绝
      assert.equal(ops[0]?.priority, 2);
      assert.equal(ops[0]?.durationMs, IDLE_BRIDGE_MS);
    } else if (state === 'happy') {
      assert.equal(sm.state, 'tap', 'happy 是 tap 状态下的组合表现');
      assert.equal(ops.find((op) => op.kind === 'expression')?.id, 'happy');
    } else {
      assert.equal(sm.state, state);
    }
  }
  const sm = machine(clock);
  assert.deepEqual(sm.enterState('bogus' as unknown as PetBehaviorDebugState), []);
  assert.equal(sm.state, 'idle');
});

test('外部驱动：enterState("drag") 之后仍能被 enterState("idle") 拉回来（不留死结）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.enterState('drag');
  assert.equal(sm.isDragging, true);
  sm.enterState('idle');
  assert.equal(sm.state, 'idle');
  assert.equal(sm.isDragging, false);
});

test('外部驱动：markInteraction() 把 90 秒计时起点拉回现在', () => {
  const clock = new Clock();
  const sm = machine(clock);
  assert.equal(SLEEP_AFTER_IDLE_MS, 90000);
  clock.advance(89999);
  sm.markInteraction();
  clock.advance(1);
  assert.deepEqual(sm.tick(), [], '重置后 1ms 不该有任何指令（连困倦都不到）');
  assert.equal(sm.state, 'idle', '重置后不该立刻入睡');
  // 从重置那一刻算起：89999ms 仍清醒（困倦）、90000ms 才睡（60s 起的困倦是中间态，不算睡）
  clock.advance(89998);
  sm.tick();
  assert.equal(sm.state, 'sleepy', '60s 之后先进困倦');
  assert.equal(sm.isSleeping, false);
  clock.advance(1);
  sm.tick();
  assert.equal(sm.state, 'sleeping', '从重置那一刻起满 90000ms 才睡');
});

// ------------------------------------------------------------ 总线口径：睡眠指令不许被低优先级锁吃掉

test('行为 × 总线：优先级 0 的睡眠指令能穿过"常驻 idle"的活动记录（D-B3 真因）', async () => {
  const { PresentationBus } = await import('../src/pet/presentation/bus');
  const clock = new Clock();
  const sm = machine(clock);

  /** 只记录最后一次动作/表情的假表现层。 */
  class FakePresentation {
    /** 当前快照。 */
    state = { expression: 'neutral' as const, motion: null, driven: {} } as unknown as PetPresentation['state'];

    /** 收到的指令。 */
    readonly applied: PresentationOp[] = [];

    /**
     * 记录指令。
     *
     * @param op 指令
     */
    apply(op: PresentationOp): void {
      this.applied.push(op);
      const current = this.state as unknown as { expression: string; motion: string | null };
      this.state = {
        ...current,
        ...(op.kind === 'expression' ? { expression: String(op.id) } : {}),
        ...(op.kind === 'motion' ? { motion: String(op.id) } : {}),
      } as unknown as PetPresentation['state'];
    }

    /**
     * 预准备（测试里无事可做）。
     *
     * @returns 已完成的 Promise
     */
    async prepare(): Promise<void> {}

    /** 释放（测试里无事可做）。 */
    dispose(): void {}
  }

  const target = new FakePresentation();
  // 定时器端口：本用例里两条指令都不带 TTL，不应该有任何定时器被挂上
  const timer = {
    setTimeout: (): number => 0,
    clearTimeout: (): void => {},
  };
  const bus = new PresentationBus(target as unknown as PetPresentation, {
    timer,
    now: clock.now,
    isSleeping: () => sm.isSleeping,
  });

  // 启动态：base 层 = 中性表情 + 常驻 idle（优先级 0、无 TTL）——这正是睡眠指令要面对的活动记录
  assert.equal(
    bus.dispatch({ kind: 'expression', id: 'neutral', layer: 'base', priority: 0, fadeMs: 0, reason: 'boot' }),
    'applied',
  );
  assert.equal(
    bus.dispatch({ kind: 'motion', id: 'idle', layer: 'base', priority: 0, loop: true, fadeMs: 0, reason: 'boot' }),
    'applied',
  );

  clock.advance(SLEEP_AFTER_IDLE_MS);
  const outcomes = sm.tick().map((op) => bus.dispatch(op));
  assert.deepEqual(outcomes, ['applied', 'applied'], '睡眠动作与表情都必须真的落地，不能被低优先级锁拒绝');
  assert.equal(target.state.motion, 'sleepy');
  // E08：真睡的表情是闭眼贴片 `blink`（走 base 槽）。这条同时证明"睡眠抑制眨眼"的规则
  // 没有把**睡眠的基础表情**一起拒掉——否则这里会是 applied 之外的第三种结果，脸层退回困倦。
  assert.equal(target.state.expression, 'blink', '真睡的基础表情必须是闭眼贴片');
  // 睡眠期再走 10 拍：总线不该收到任何新指令（tick 幂等），表情/动作保持睡眠
  for (let index = 0; index < 10; index += 1) {
    clock.advance(250);
    assert.deepEqual(sm.tick(), []);
  }
  assert.equal(target.state.expression, 'blink');
  // 反向自证：睡眠中真正的生理眨眼（transient 槽）必须被总线拒掉，不能顶掉睡眠的脸
  assert.equal(
    bus.dispatch({ kind: 'expression', id: 'blink', layer: 'transient', priority: 0, durationMs: 100, fadeMs: 0, reason: 'test:physio-blink' }),
    'rejected',
    '睡眠中生理眨眼必须被抑制（与基础闭眼表情是两件事）',
  );
  assert.equal(target.state.expression, 'blink');
});

// ---------------------------------------------------------------- 入态接管（M6-b 第二轮必修项 1）

test('行为：所有入态指令都带接管标记（force），一条不漏', () => {
  const collected: PresentationOp[][] = [];

  const tapMachine = machine(new Clock());
  collected.push(tapMachine.handle('tap'));

  const dragMachine = machine(new Clock());
  collected.push(dragMachine.handle('drag-start'));
  // 松手时的桥接 idle（当时就下发，带 TTL）
  collected.push(dragMachine.handle('drag-end'));

  // tick 的桥接落地：下一拍把桥接 idle 换成常驻 idle
  const bridgeClock = new Clock();
  const bridgeMachine = machine(bridgeClock);
  bridgeMachine.handle('drag-start');
  bridgeMachine.handle('drag-end');
  bridgeClock.advance(IDLE_BRIDGE_MS + 1);
  collected.push(bridgeMachine.tick());

  // 90 秒静置 → 入睡
  const sleepClock = new Clock();
  const sleeper = machine(sleepClock);
  sleepClock.advance(SLEEP_AFTER_IDLE_MS);
  collected.push(sleeper.tick());

  // 直达通道的每一个状态
  for (const state of PET_BEHAVIOR_DEBUG_STATES) {
    const fresh = machine(new Clock());
    const ops = fresh.enterState(state as PetBehaviorDebugState);
    if (ops.length > 0) collected.push(ops);
  }

  let total = 0;
  for (const batch of collected) {
    for (const entryOp of batch) {
      total += 1;
      assert.equal(entryOp.force, true, `${entryOp.kind}:${String(entryOp.id)}（${entryOp.reason}）是入态指令，必须带 force`);
    }
  }
  assert.ok(total >= 10, `入态指令样本太少（${total}），说明用例没覆盖到主要路径`);
});

test('行为：快照 / 回滚能把现场整体滚回去（表现层拒绝入态时用）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.enterState('angry');
  assert.equal(sm.state, 'angry');

  const before = sm.snapshot();
  const sleepOps = sm.enterState('sleeping');
  assert.ok(sleepOps.length > 0);
  assert.equal(sm.state, 'sleeping');
  assert.equal(sm.sustainedMotion, 'sleepy');

  assert.equal(sm.restore(before, 'test:reject'), true);
  assert.equal(sm.state, 'angry', '回滚后行为层不能再宣称自己睡了');
  assert.equal(sm.sustainedMotion, null, '持续动作登记也必须一起回滚');
  assert.equal(sm.isSleeping, false);

  // 非法快照一律拒绝且不抛（回滚本身不能把渲染层带崩）
  assert.equal(sm.restore(null), false);
  assert.equal(sm.restore({ ...before, state: '飞天' as unknown as typeof before.state }), false);
  assert.equal(sm.state, 'angry', '失败的还原不能改动现场');
});

test('行为：repairOps 把回滚后的状态重新定向到画面（睡眠 / 拖拽 / 其余落 idle）', () => {
  const clock = new Clock();

  const sleeper = machine(clock);
  sleeper.enterState('sleeping');
  const sleepRepair = sleeper.repairOps();
  assert.equal(sleepRepair.length, 2);
  assert.equal(sleepRepair[0]?.id, 'sleepy');
  // 修复路径必须与入态路径下发同一张脸：真睡 = 闭眼（blink），不是困倦的 sleepy
  assert.equal(sleepRepair[1]?.id, 'blink', '睡眠修复指令的表情必须与 enterSleeping 一致');
  assert.ok(sleepRepair.every((entryOp) => entryOp.force === true));
  assert.equal(sleeper.sustainedMotion, 'sleepy', '修复后持续动作登记必须还在');

  const dragger = machine(clock);
  dragger.handle('drag-start');
  const dragRepair = dragger.repairOps();
  assert.equal(dragRepair.length, 1);
  assert.equal(dragRepair[0]?.id, 'drag');
  assert.equal(dragRepair[0]?.force, true);

  const angryOne = machine(clock);
  angryOne.enterState('angry');
  const idleRepair = angryOne.repairOps();
  assert.equal(angryOne.state, 'idle', '一次性动作回滚到它没有意义，统一落到 idle');
  assert.equal(idleRepair[0]?.id, 'idle');
  assert.equal(idleRepair[1]?.id, 'neutral');
  assert.ok(idleRepair.every((entryOp) => entryOp.force === true));
});

