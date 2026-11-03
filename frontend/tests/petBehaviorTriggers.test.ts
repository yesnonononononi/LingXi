/**
 * §6 触发入口表逐行复现（T04 断言 1，纯逻辑，不碰 DOM）。
 *
 * <p><b>为什么要逐字段断言：</b>"表情变对了"不算验过——<b>层级 / 优先级 / 时长</b>任何一个错了
 * 用户都会看到别的东西（优先级低了会被眨眼刷掉，TTL 错了一闪就没，`base` 写错了回落链会断）。
 * 所以每一行都同时钉 `kind` / `id` / `layer` / `priority` / `durationMs`，并引用导出的常量
 * 而不是抄数字（抄数字的测试会在常量被改时静默失效）。</p>
 *
 * <p>覆盖：E01 neutral、E02 wink、E03 surprised（点醒 / 拖起）、E04 sad（长拖）、
 * E05 angry（连点 3 次）、E06 shy（头部连点 2 次 / 按住 600ms）、E07 happy（身体单击）、
 * E08 sleepy（60s 犯困 → 90s 真睡）。生理眨眼那一行在 `petBlinkWink.test.ts`。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANGRY_HOLD_MS,
  DEFAULT_TAP_CONTEXT,
  IDLE_BRIDGE_MS,
  MULTI_TAP_WINDOW_MS,
  PET_DOUBLE_TAP_MS,
  PET_HOLD_MS,
  PET_SHOW_MS,
  PetBehaviorStateMachine,
  SAD_DRAG_MS,
  SAD_HOLD_MS,
  SLEEPY_AFTER_IDLE_MS,
  SLEEP_AFTER_IDLE_MS,
  TAP_HOLD_MS,
  WAKE_HOLD_MS,
  WINK_MS,
  type TapContext,
} from '../src/pet/behavior/state-machine';
import { classifyProfile, faceRectNormalized } from '../src/pet/behavior/hit-profile';
import { PET_LAYERS, faceLayer } from '../src/pet/layers/manifest';
import type { PresentationOp } from '../src/pet/presentation/types';

/** 可控时钟。 */
class Clock {
  /** 当前虚拟时间。 */
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
 * 建状态机（rng 固定 0.5 → 抖动为 0，时长断言才能等于常量）。
 *
 * @param clock 时钟
 * @returns 状态机
 */
function machine(clock: Clock): PetBehaviorStateMachine {
  return new PetBehaviorStateMachine({ now: clock.now, rng: () => 0.5 });
}

/** 头部点击上下文。 */
const HEAD_TAP: TapContext = { profile: 'head', holdMs: 0 };
/** 身体点击上下文。 */
const BODY_TAP: TapContext = { profile: 'body', holdMs: 0 };

/**
 * 按 kind 取唯一一条指令。
 *
 * @param ops 指令列表
 * @param kind 类别
 * @returns 指令
 */
function pick(ops: readonly PresentationOp[], kind: PresentationOp['kind']): PresentationOp {
  const found = ops.filter((op) => op.kind === kind);
  assert.equal(found.length, 1, `期望恰好一条 ${kind}，实际 ${found.length} 条（${ops.map((op) => `${op.kind}:${String(op.id)}`).join(', ')}）`);
  return found[0];
}

/**
 * 断言一条指令的全部关键字段。
 *
 * @param op 指令
 * @param expected 期望字段
 */
function expectOp(
  op: PresentationOp,
  expected: {
    readonly kind: PresentationOp['kind'];
    readonly id: string;
    readonly layer: PresentationOp['layer'];
    readonly priority: PresentationOp['priority'];
    readonly durationMs?: number;
  },
): void {
  assert.equal(op.kind, expected.kind);
  assert.equal(String(op.id), expected.id);
  assert.equal(op.layer, expected.layer);
  assert.equal(op.priority, expected.priority);
  assert.equal(op.durationMs, expected.durationMs, `${String(op.id)} 的 TTL 必须精确`);
  assert.equal(op.force, true, '入态指令必须带接管标记（否则会被未到期的旧记录挡住）');
}

// ------------------------------------------------------------------ E07 / E01

test('§6 E07：身体单击 → happy（transient / prio1 / 480ms）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  const ops = sm.handle('tap', BODY_TAP);
  expectOp(pick(ops, 'expression'), { kind: 'expression', id: 'happy', layer: 'transient', priority: 1, durationMs: TAP_HOLD_MS });
  expectOp(pick(ops, 'motion'), { kind: 'motion', id: 'tap', layer: 'base', priority: 1, durationMs: TAP_HOLD_MS });
});

test('§6 E01：状态结束后回 idle → neutral（base / prio0 / 无 TTL）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('tap', BODY_TAP);
  clock.advance(TAP_HOLD_MS);
  sm.tick(); // 桥接 idle（带 TTL，优先级 2）
  clock.advance(IDLE_BRIDGE_MS);
  const steady = sm.tick();
  expectOp(pick(steady, 'expression'), { kind: 'expression', id: 'neutral', layer: 'base', priority: 0, durationMs: undefined });
  expectOp(pick(steady, 'motion'), { kind: 'motion', id: 'idle', layer: 'base', priority: 0, durationMs: undefined });
});

// ------------------------------------------------------------------ E06 / E02

test('§6 E06：头部连点 2 次（间隔 < 1500ms）→ shy（transient / prio1 / 900ms）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  // 第一次头部单击还没构成抚摸：给一次普通点击反应（不能"点了没反应"）
  const first = sm.handle('tap', HEAD_TAP);
  assert.equal(pick(first, 'expression').id, 'happy');
  clock.advance(PET_DOUBLE_TAP_MS - 1);
  const second = sm.handle('tap', HEAD_TAP);
  assert.equal(sm.state, 'pet');
  expectOp(pick(second, 'expression'), { kind: 'expression', id: 'shy', layer: 'transient', priority: 1, durationMs: PET_SHOW_MS });
  expectOp(pick(second, 'motion'), { kind: 'motion', id: 'happy', layer: 'base', priority: 1, durationMs: PET_SHOW_MS });
});

test('§6 E06：头部间隔 ≥ 1500ms 的两次点击不算抚摸（仍是普通点击）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('tap', HEAD_TAP);
  clock.advance(PET_DOUBLE_TAP_MS + 1);
  const ops = sm.handle('tap', HEAD_TAP);
  assert.notEqual(sm.state, 'pet');
  assert.equal(pick(ops, 'expression').id, 'happy');
});

test('§6 E06：头部按住 ≥ 600ms → shy（一次就够）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  const ops = sm.handle('tap', { profile: 'head', holdMs: PET_HOLD_MS });
  assert.equal(sm.state, 'pet');
  expectOp(pick(ops, 'expression'), { kind: 'expression', id: 'shy', layer: 'transient', priority: 1, durationMs: PET_SHOW_MS });
  // 599ms 不算按住
  const clock2 = new Clock();
  const sm2 = machine(clock2);
  const short = sm2.handle('tap', { profile: 'head', holdMs: PET_HOLD_MS - 1 });
  assert.notEqual(sm2.state, 'pet');
  assert.equal(pick(short, 'expression').id, 'happy');
});

test('§6 E02：抚摸结束（shy 到期）→ wink（transient / prio1 / 600ms / fade 0）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('tap', HEAD_TAP);
  clock.advance(200);
  sm.handle('tap', HEAD_TAP);
  assert.equal(sm.state, 'pet');
  // shy 未到期：什么都不该产出（否则 wink 会提前盖掉 shy）
  clock.advance(PET_SHOW_MS - 1);
  assert.deepEqual(sm.tick(), []);
  clock.advance(1);
  const ops = sm.tick();
  expectOp(pick(ops, 'expression'), { kind: 'expression', id: 'wink', layer: 'transient', priority: 1, durationMs: WINK_MS });
  expectOp(pick(ops, 'motion'), { kind: 'motion', id: 'idle', layer: 'base', priority: 2, durationMs: WINK_MS });
  const wink = pick(ops, 'expression');
  assert.equal(wink.fadeMs, 0, 'wink 必须硬切（fade 0）');
  assert.equal(sm.state, 'idle');
  // wink 播满 600ms 后由 tick 落到常驻 idle（桥接与 wink 同时到期，不许中途截断）
  clock.advance(WINK_MS);
  const steady = sm.tick();
  expectOp(pick(steady, 'expression'), { kind: 'expression', id: 'neutral', layer: 'base', priority: 0, durationMs: undefined });
});

test('§6 E02：pet-end 事件也能直接触发回礼 wink（右键菜单「打个招呼」走这条）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('tap', HEAD_TAP);
  clock.advance(100);
  sm.handle('tap', HEAD_TAP);
  assert.equal(sm.state, 'pet');
  const ops = sm.handle('pet-end');
  expectOp(pick(ops, 'expression'), { kind: 'expression', id: 'wink', layer: 'transient', priority: 1, durationMs: WINK_MS });
  assert.equal(sm.state, 'idle');
});

// ------------------------------------------------------------------ E03

test('§6 E03（点醒）：睡眠中点击 → surprised（transient / prio2 / 700ms）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SLEEP_AFTER_IDLE_MS);
  sm.tick();
  assert.equal(sm.isSleeping, true);
  const ops = sm.handle('tap', BODY_TAP);
  expectOp(pick(ops, 'expression'), { kind: 'expression', id: 'surprised', layer: 'transient', priority: 2, durationMs: WAKE_HOLD_MS });
  expectOp(pick(ops, 'motion'), { kind: 'motion', id: 'wake', layer: 'base', priority: 2, durationMs: WAKE_HOLD_MS });
  assert.equal(sm.state, 'wake');
});

test('§6 E03（拖起）：刚开始拖拽 → surprised（transient / prio2 / 600ms）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  const ops = sm.handle('drag-start');
  const expression = pick(ops, 'expression');
  expectOp(expression, { kind: 'expression', id: 'surprised', layer: 'transient', priority: 2, durationMs: 600 });
  expectOp(pick(ops, 'motion'), { kind: 'motion', id: 'drag', layer: 'base', priority: 2, durationMs: undefined });
});

// ------------------------------------------------------------------ E04

test('§6 E04：长拖拽（≥1200ms）松手 → sad（transient / prio1 / 900ms）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('drag-start');
  clock.advance(SAD_DRAG_MS);
  const ops = sm.handle('drag-end');
  assert.ok(
    ops.some((op) => op.kind === 'expression' && op.id === 'sad'),
    '长拖拽（≥1200ms）松手必须产出 sad 表情（§6 E04：被拎久了委屈）',
  );
  expectOp(pick(ops, 'expression'), { kind: 'expression', id: 'sad', layer: 'transient', priority: 1, durationMs: SAD_HOLD_MS });
  // 桥接时长与 sad 同步到期：比 sad 早到会把委屈截断在 250ms
  expectOp(pick(ops, 'motion'), { kind: 'motion', id: 'idle', layer: 'base', priority: 2, durationMs: SAD_HOLD_MS });
});

test('§6 E04：短拖拽（< 1200ms）不产出 sad', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('drag-start');
  clock.advance(SAD_DRAG_MS - 1);
  const ops = sm.handle('drag-end');
  assert.equal(ops.some((op) => op.kind === 'expression' && op.id === 'sad'), false, '没拎够 1200ms 不该委屈');
  expectOp(pick(ops, 'motion'), { kind: 'motion', id: 'idle', layer: 'base', priority: 2, durationMs: IDLE_BRIDGE_MS });
});

// ------------------------------------------------------------------ E05

test('§6 E05：连点 3 次（间隔 < 2000ms）→ angry（transient / prio1 / 1200ms）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('tap', BODY_TAP);
  clock.advance(MULTI_TAP_WINDOW_MS - 1);
  sm.handle('tap', BODY_TAP);
  clock.advance(MULTI_TAP_WINDOW_MS - 1);
  const ops = sm.handle('tap', BODY_TAP);
  expectOp(pick(ops, 'expression'), { kind: 'expression', id: 'angry', layer: 'transient', priority: 1, durationMs: ANGRY_HOLD_MS });
  expectOp(pick(ops, 'motion'), { kind: 'motion', id: 'angry', layer: 'base', priority: 1, durationMs: ANGRY_HOLD_MS });
});

test('§6 E05/E06 冲突：头部连点 3 次是「抚摸」不是「生气」（抚摸优先于连点生气）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  sm.handle('tap', HEAD_TAP); // 第 1 次：还没凑够抚摸 → 普通点击反应
  clock.advance(200);
  sm.handle('tap', HEAD_TAP); // 第 2 次：进入抚摸
  assert.equal(sm.state, 'pet');
  clock.advance(200);
  // 第 3 次：抚摸进行中被摸了一下，不能翻脸成生气（抚摸已经清零连点计数）
  const ops = sm.handle('tap', HEAD_TAP);
  assert.notEqual(sm.state, 'angry', '头部连点必须走抚摸语义，不能被连点计数截胡成生气');
  assert.equal(pick(ops, 'expression').id, 'happy');
  assert.equal(sm.state, 'tap');
  // 第 4 次：头部的相邻点击继续被读作"又摸了两下" → 再进抚摸（而不是攒够 3 下生气）
  clock.advance(200);
  const again = sm.handle('tap', HEAD_TAP);
  assert.equal(sm.state, 'pet');
  assert.equal(pick(again, 'expression').id, 'shy');
});

// ------------------------------------------------------------------ E08

test('§6 E08：无交互 60s → sleepy（base / prio0 / loop 动作 + 无 TTL 表情）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SLEEPY_AFTER_IDLE_MS - 1);
  assert.deepEqual(sm.tick(), [], '59999ms 还不该犯困');
  clock.advance(1);
  const ops = sm.tick();
  assert.equal(sm.state, 'sleepy');
  assert.equal(sm.isSleeping, false, '困倦不是睡眠');
  expectOp(pick(ops, 'expression'), { kind: 'expression', id: 'sleepy', layer: 'base', priority: 0, durationMs: undefined });
  const motion = pick(ops, 'motion');
  assert.equal(motion.id, 'sleepy');
  assert.equal(motion.layer, 'base');
  assert.equal(motion.priority, 0);
  assert.equal(motion.loop, true, '困倦动作要一直循环到真睡');
  assert.equal(motion.durationMs, undefined);
});

test('§6 E08：困倦中每一拍都不再产出指令（幂等），90s 才真睡', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SLEEPY_AFTER_IDLE_MS);
  sm.tick();
  for (let index = 0; index < 8; index += 1) {
    clock.advance(250);
    assert.deepEqual(sm.tick(), [], '困倦状态下不许每拍重下发（会把动画拽回起点）');
  }
  clock.advance(SLEEP_AFTER_IDLE_MS - SLEEPY_AFTER_IDLE_MS - 2000);
  sm.tick();
  assert.equal(sm.state, 'sleeping');
  assert.equal(sm.isSleeping, true);
});

test('§6 E08：困倦中点击即可打断（不要求先睡死）', () => {
  const clock = new Clock();
  const sm = machine(clock);
  clock.advance(SLEEPY_AFTER_IDLE_MS);
  sm.tick();
  const ops = sm.handle('tap', BODY_TAP);
  assert.equal(sm.state, 'tap', '犯困时点一下应当进入普通点击反应');
  assert.equal(pick(ops, 'expression').id, 'happy');
});

test('§6 E08 / P4：60s 困倦与 90s 真睡必须下发**不同**的表情指令（不得同形）', () => {
  const clock = new Clock();
  const sm = machine(clock);

  // 60s：困倦 = 半闭眼的 `sleepy`
  clock.advance(SLEEPY_AFTER_IDLE_MS);
  const sleepyOps = sm.tick();
  const sleepyExpression = pick(sleepyOps, 'expression');
  assert.equal(sleepyExpression.id, 'sleepy', '困倦档必须是半闭眼的 sleepy');
  assert.equal(sleepyExpression.layer, 'base');

  // 90s：真睡 = 双眼闭合的 `blink`（复用已有闭眼贴片，零新增资产）
  clock.advance(SLEEP_AFTER_IDLE_MS - SLEEPY_AFTER_IDLE_MS);
  const sleepingOps = sm.tick();
  assert.equal(sm.state, 'sleeping');
  const sleepingExpression = pick(sleepingOps, 'expression');
  assert.equal(sleepingExpression.id, 'blink', '真睡档必须是闭眼贴片（E08 判据：双眼闭合 vs 半闭眼不得混淆）');
  assert.equal(sleepingExpression.layer, 'base', '睡眠的基础表情走 base 槽（否则会被"睡眠抑制眨眼"规则拒掉）');
  assert.equal(sleepingExpression.priority, 0);
  assert.equal(sleepingExpression.durationMs, undefined, '睡到被叫醒，不许有 TTL');

  // 硬断言：两档的表情 id 必须不同（同形就是 P4 那条 FAIL）
  assert.notEqual(sleepingExpression.id, sleepyExpression.id, '困倦与真睡的表情不得相同');
  // 动作仍然是同一个循环 sleepy（趴睡姿态属 M2，本轮不做）
  assert.equal(pick(sleepingOps, 'motion').id, 'sleepy');
});

// ------------------------------------------------------------------ 头部判定（分区真源）

test('分区：脸区矩形来自层清单的 face.rect，外扩后 上下 0.06 / 左右 0.08', () => {
  const rect = faceRectNormalized(PET_LAYERS);
  assert.ok(rect, '真实清单必须有脸层');
  const face = faceLayer(PET_LAYERS);
  assert.ok(face);
  // 560/2048 ≈ 0.2734，1064/3072 ≈ 0.3464，右下 (560+792)/2048 ≈ 0.6602，(1064+400)/3072 ≈ 0.4766
  assert.ok(Math.abs((rect?.left ?? 0) - 560 / 2048) < 1e-9);
  assert.ok(Math.abs((rect?.top ?? 0) - 1064 / 3072) < 1e-9);
  assert.ok(Math.abs((rect?.right ?? 0) - 1352 / 2048) < 1e-9);
  assert.ok(Math.abs((rect?.bottom ?? 0) - 1464 / 3072) < 1e-9);

  const centerU = ((rect?.left ?? 0) + (rect?.right ?? 0)) / 2;
  const centerV = ((rect?.top ?? 0) + (rect?.bottom ?? 0)) / 2;
  assert.equal(classifyProfile(centerU, centerV, PET_LAYERS), 'head');
  // 左右外扩 0.08：正好在边界内是 head，越过就是 body
  assert.equal(classifyProfile((rect?.right ?? 0) + 0.079, centerV, PET_LAYERS), 'head');
  assert.equal(classifyProfile((rect?.right ?? 0) + 0.081, centerV, PET_LAYERS), 'body');
  // 上下外扩 0.06
  assert.equal(classifyProfile(centerU, (rect?.bottom ?? 0) + 0.059, PET_LAYERS), 'head');
  assert.equal(classifyProfile(centerU, (rect?.bottom ?? 0) + 0.061, PET_LAYERS), 'body');
  // 脚底一定是身体
  assert.equal(classifyProfile(0.5, 0.95, PET_LAYERS), 'body');
  // 脏值一律按身体处理，不许抛
  assert.equal(classifyProfile(Number.NaN, 0.5, PET_LAYERS), 'body');
  assert.equal(classifyProfile(0.5, Number.POSITIVE_INFINITY, PET_LAYERS), 'body');
});

test('分区：缺脸层的清单里一切按身体处理（不能猜坐标）', () => {
  const withoutFace = {
    ...PET_LAYERS,
    layers: PET_LAYERS.layers.filter((layer) => layer.layerId !== 'face'),
  };
  assert.equal(faceRectNormalized(withoutFace), null);
  assert.equal(classifyProfile(0.5, 0.4, withoutFace), 'body');
});

test('分区：默认上下文 = 身体短按（既有调用点不传 ctx 时行为不变）', () => {
  assert.deepEqual({ ...DEFAULT_TAP_CONTEXT }, { profile: 'body', holdMs: 0 });
  const clock = new Clock();
  const sm = machine(clock);
  const ops = sm.handle('tap');
  assert.equal(pick(ops, 'expression').id, 'happy');
});
