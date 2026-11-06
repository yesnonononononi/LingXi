/**
 * S3 / T03：渲染层运动接入的单测（纯逻辑 + 假时钟，不依赖 electron）。
 *
 * <p><b>这一片只有一条真正的"用户可见"风险，它必须用 1ms 精度钉住：</b>
 * 自主移动**不是用户交互**，所以它绝对不能刷新空闲计时（设计 §5.3）。
 * 一旦 `move-start` 顺手写了一次 `lastInteractionAt`，那么一只"每 20s 自己溜达一圈"的猫
 * 会永远停在 `walk`，用户在桌面上看到的是一只**从不坐下、也从不睡着**的桌宠——
 * 而所有实现者都会觉得"移动嘛，当然算活动"。`P-M13` 守的就是这一条。</p>
 *
 * <p>本文件覆盖五组判据：</p>
 * <ol>
 *   <li>`move-start` / `move-gait` / `move-end` 三条事件对 `stateValue` 的影响（且不产 op）；</li>
 *   <li>三条事件都**不改** `idleElapsedMs()`（P-M13 的判据级要求）；</li>
 *   <li>`IDLE_CHAIN_STATES = ['idle','walk','run']` 的 20s / 60s / 90s 派生（阈值一个都没改）；</li>
 *   <li>姿态 → 运动意图（`P-M15`）与朝向滞回的前置条件（`G-M7`）；</li>
 *   <li>`main.ts` 侧的四条静态纪律（单一通道名、意图里没有坐标、不复制 MOTION 数值、
 *       隐藏时 0 发送、`move-*` 不写 `lastInteractionAt`、无 `scaleX(-1)`）。</li>
 * </ol>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  IDLE_CHAIN_STATES,
  PetBehaviorStateMachine,
  SIT_AFTER_IDLE_MS,
  SLEEPY_AFTER_IDLE_MS,
  SLEEP_AFTER_IDLE_MS,
  applyFacingIfMoving,
  applyMotionPolicy,
  motionIntentForPosture,
  postureOf,
  type MotionIntentReason,
  type MotionMode,
  type MotionRequestPort,
  type PetBehaviorState,
} from '../src/pet/behavior/state-machine';
import { PET_POSES } from '../src/pet/poses/manifest';
import type { PostureId } from '../src/pet/poses/types';
import type { Facing } from '../src/pet/poses/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * 读一个前端文件。
 *
 * @param relative 相对 `frontend/` 的路径
 * @returns 文件内容
 */
function readSource(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/**
 * 取出"代码"（去掉整行注释与块注释）。
 *
 * <p>注释里写"以前这里把 24 DIP 抄了一份"是**有价值的历史**，而判据要守的是
 * 代码里不许再出现那类数值。</p>
 *
 * @param source 源码
 * @returns 去注释后的源码
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/**
 * 取两段标记之间的代码（找不到标记就返回空串，让断言自己红）。
 *
 * @param source 源码
 * @param from 起始标记（含）
 * @param to 结束标记（不含）
 * @returns 切片
 */
function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start + from.length);
  if (end < 0) return '';
  return source.slice(start, end);
}

/** 可控时钟（状态机只认注入的 `now()`）。 */
class Clock {
  /** 虚拟时间（毫秒）。 */
  time = 0;

  /** 读时间（写成箭头函数，避免丢 `this`）。 */
  now = (): number => this.time;

  /**
   * 推进时间。
   *
   * @param ms 毫秒
   */
  advance(ms: number): void {
    this.time += ms;
  }

  /**
   * 跳到某个绝对时刻。
   *
   * @param at 毫秒
   */
  goTo(at: number): void {
    this.time = at;
  }
}

/**
 * 建一个抖动为 0 的状态机（`rng` 固定 0.5，`lastInteractionAt` = 构造时刻）。
 *
 * @param clock 时钟
 * @returns 状态机
 */
function machine(clock: Clock): PetBehaviorStateMachine {
  return new PetBehaviorStateMachine({ now: clock.now, rng: () => 0.5 });
}

/** 记录调用的运动意图端口（桩）。 */
class RecordingPort implements MotionRequestPort {
  /** 调用的 `[mode, reason]` 序列。 */
  readonly calls: Array<[MotionMode, MotionIntentReason]> = [];

  /**
   * 记录一次请求。
   *
   * @param mode 模式
   * @param reason 原因
   * @returns 恒为 `true`（桩不模拟拒绝）
   */
  requestMode(mode: MotionMode, reason: MotionIntentReason): boolean {
    this.calls.push([mode, reason]);
    return true;
  }
}

test('三条运动事件驱动状态：move-start→walk、move-gait→run、move-end→idle，且都不产表现层指令', () => {
  const clock = new Clock();
  const behavior = machine(clock);

  clock.goTo(1000);
  assert.deepEqual(behavior.handle('move-start', { gait: 'walk', reason: 'moving' }), []);
  assert.equal(behavior.state, 'walk');
  assert.equal(behavior.isMoving, true);

  clock.advance(16);
  assert.deepEqual(behavior.handle('move-gait', { gait: 'run', reason: 'moving' }), []);
  assert.equal(behavior.state, 'run');

  clock.advance(16);
  assert.deepEqual(behavior.handle('move-end', { gait: 'none', reason: 'arrived' }), []);
  assert.equal(behavior.state, 'idle');
  assert.equal(behavior.isMoving, false);
  // 走/跑是**姿态**，姿态走独立通道（PoseController.setPosture），动作/表情在姿态态本来就被藏起来
  assert.equal(behavior.sustainedMotion, null);
});

test('P-M13 判据级要求：三条运动事件一个字都不写 lastInteractionAt（空闲计时继续走）', () => {
  const clock = new Clock();
  const behavior = machine(clock);

  clock.goTo(5000);
  const before = behavior.idleElapsedMs();
  behavior.handle('move-start', { gait: 'walk' });
  assert.equal(behavior.idleElapsedMs(), before, 'move-start 不许刷新空闲计时');

  clock.advance(1000);
  const afterStart = behavior.idleElapsedMs();
  behavior.handle('move-gait', { gait: 'run' });
  assert.equal(behavior.idleElapsedMs(), afterStart, 'move-gait 不许刷新空闲计时');

  clock.advance(1000);
  const afterGait = behavior.idleElapsedMs();
  behavior.handle('move-end', { gait: 'none', reason: 'arrived' });
  assert.equal(behavior.idleElapsedMs(), afterGait, 'move-end 不许刷新空闲计时');
  assert.equal(behavior.idleElapsedMs(), 7000);
});

test('P-M13：lastInteractionAt 之后 19.5s 发起 6s 漫游 ⇒ 20.5s 时必须已坐下（哪怕此刻仍在走）', () => {
  const clock = new Clock();
  const behavior = machine(clock);

  // 19.5s：漫游起步（走 → 跑），这一趟计划走 6s（到 25.5s 才 move-end）
  clock.goTo(19500);
  behavior.handle('move-start', { gait: 'walk', reason: 'roam' });
  clock.goTo(19800);
  behavior.handle('move-gait', { gait: 'run', reason: 'roam' });
  assert.equal(behavior.state, 'run');

  // 20.5s：**没有任何 move-end**，行为拍照常推进 ⇒ 20s 空闲链必须已经生效
  clock.goTo(20500);
  behavior.tick();
  assert.equal(behavior.state, 'sit', '走到一半也必须坐下：移动不算交互');
  assert.equal(behavior.isMoving, false);
  assert.equal(behavior.idleElapsedMs(), 20500, '计时起点仍是 0ms 那次构造，没有被移动推后');
  // 坐下是"姿态"：不产生任何表现层指令
  assert.deepEqual(behavior.handle('move-end', { gait: 'none', reason: 'arrived' }), []);
  assert.equal(behavior.state, 'sit');
});

test('坐下之后迟到的运动包被忽略（坐着不许平移，§5 注释 2）', () => {
  const clock = new Clock();
  const behavior = machine(clock);

  clock.goTo(21000);
  behavior.tick();
  assert.equal(behavior.state, 'sit');

  clock.advance(16);
  assert.deepEqual(behavior.handle('move-gait', { gait: 'walk', reason: 'moving' }), []);
  assert.equal(behavior.state, 'sit', 'sit 不在空闲链白名单里 ⇒ 运动事件不得把它拽起来');
  assert.deepEqual(behavior.handle('move-start', { gait: 'run' }), []);
  assert.equal(behavior.state, 'sit');
});

test('P-M14：白名单含 walk/run ⇒ 一直走着的猫 60s 犯困、90s 睡着（不必先停下）', () => {
  const clock = new Clock();
  const behavior = machine(clock);

  clock.goTo(59500);
  behavior.handle('move-start', { gait: 'walk' });
  assert.equal(behavior.state, 'walk');

  clock.goTo(60500);
  behavior.tick();
  assert.equal(behavior.state, 'sleepy');

  clock.goTo(90000);
  behavior.tick();
  assert.equal(behavior.state, 'sleeping');
  assert.equal(behavior.isSleeping, true);
});

test('空闲链白名单三态 × 三档边界：20s / 60s / 90s 对 idle / walk / run 一律成立（阈值未改）', () => {
  // 阈值本身就是判据：先把它钉死，再验"白名单只换状态集合、不换数字"
  assert.equal(SIT_AFTER_IDLE_MS, 20000);
  assert.equal(SLEEPY_AFTER_IDLE_MS, 60000);
  assert.equal(SLEEP_AFTER_IDLE_MS, 90000);
  assert.deepEqual([...IDLE_CHAIN_STATES], ['idle', 'walk', 'run']);

  const states: readonly PetBehaviorState[] = ['idle', 'walk', 'run'];

  for (const state of states) {
    // 一台机器走完整条时间轴：边界两侧各一拍，顺序与阈值都不许变
    const clock = new Clock();
    const behavior = machine(clock);
    if (state !== 'idle') behavior.handle('move-start', { gait: state === 'run' ? 'run' : 'walk' });
    assert.equal(behavior.state, state, `${state} 起步后应当还在自己那一态`);

    // 20s：19999 还不坐，20000 恰好坐下
    clock.goTo(SIT_AFTER_IDLE_MS - 1);
    behavior.tick();
    assert.equal(behavior.state, state, `${state} 在 ${SIT_AFTER_IDLE_MS - 1}ms 还不该坐下`);
    clock.goTo(SIT_AFTER_IDLE_MS);
    behavior.tick();
    assert.equal(behavior.state, 'sit', `${state} 在 ${SIT_AFTER_IDLE_MS}ms 必须坐下`);

    // 60s：59999 还只是坐着，60000 恰好困倦（sit 分支自己决定下一档，不重判 20s）
    clock.goTo(SLEEPY_AFTER_IDLE_MS - 1);
    behavior.tick();
    assert.equal(behavior.state, 'sit', `坐在 ${SLEEPY_AFTER_IDLE_MS - 1}ms 还不该困`);
    clock.goTo(SLEEPY_AFTER_IDLE_MS);
    behavior.tick();
    assert.equal(behavior.state, 'sleepy', `坐在 ${SLEEPY_AFTER_IDLE_MS}ms 必须困倦`);

    // 90s：89999 还是困倦，90000 恰好睡着
    clock.goTo(SLEEP_AFTER_IDLE_MS - 1);
    behavior.tick();
    assert.equal(behavior.state, 'sleepy', `在 ${SLEEP_AFTER_IDLE_MS - 1}ms 还不该睡着`);
    clock.goTo(SLEEP_AFTER_IDLE_MS);
    behavior.tick();
    assert.equal(behavior.state, 'sleeping', `在 ${SLEEP_AFTER_IDLE_MS}ms 必须睡着`);
  }
});

test('拖拽期间的运动包被忽略（位置写入权在 drag，§5.1 第 2 级）', () => {
  const clock = new Clock();
  const behavior = machine(clock);

  clock.goTo(1000);
  behavior.handle('drag-start');
  assert.equal(behavior.state, 'drag');
  assert.deepEqual(behavior.handle('move-start', { gait: 'walk' }), []);
  assert.equal(behavior.state, 'drag', '拖拽中不许被运动事实拽进 walk');
  // 拖拽拍也不推进空闲链
  clock.goTo(30000);
  behavior.tick();
  assert.equal(behavior.state, 'drag');
});

test('postureOf 把 walk / run 派生到 walk / run 姿态（姿态映射不是新机制）', () => {
  // 生产资产里六批 accepted 已含 walk / run；这里断言的是"派生表"而不是"资产是否存在"
  assert.equal(postureOf('walk', PET_POSES, 1), 'walk');
  assert.equal(postureOf('run', PET_POSES, -1), 'run');
  assert.equal(postureOf('idle', PET_POSES, 1), 'stand');
});

test('P-M15：姿态一旦不可动（sit / lie / sleep / jump）就下发一次 off（idle-chain），不重复', () => {
  const port = new RecordingPort();

  // stand / walk / run 是"可以动"的三态：允许运动，不发任何请求
  for (const posture of ['stand', 'walk', 'run'] as const satisfies readonly PostureId[]) {
    assert.equal(motionIntentForPosture(posture), null, `${posture} 不该撤销运动`);
    assert.equal(applyMotionPolicy(posture, port, null), null);
  }
  assert.deepEqual(port.calls, []);

  // 第一个不可动姿态：发一条，然后记住"已经 off"
  let previous: MotionMode | null = null;
  for (const posture of ['sit', 'lie', 'sleep', 'jump'] as const satisfies readonly PostureId[]) {
    previous = applyMotionPolicy(posture, port, previous);
    assert.equal(previous, 'off');
  }
  assert.deepEqual(port.calls, [['off', 'idle-chain']], '250ms 一拍也不许把 IPC 打满（幂等）');

  // 回到可动姿态不清账：'off' 仍然记着（避免"站起来的同一拍又发一条 follow"）
  assert.equal(applyMotionPolicy('stand', port, previous), 'off');
  assert.equal(port.calls.length, 1);
});

test('sleepy / sleeping 的真实派生 ⇒ requestMode("off","idle-chain") 被调用（睡着不许继续走）', () => {
  const port = new RecordingPort();
  const sleepyPosture = postureOf('sleepy', PET_POSES, 1);
  const sleepingPosture = postureOf('sleeping', PET_POSES, 1);
  assert.notEqual(sleepyPosture, 'stand');
  assert.ok(sleepingPosture === 'sleep' || sleepingPosture === 'lie', `睡姿应是 sleep 或降级的 lie，实际 ${sleepingPosture}`);

  let previous: MotionMode | null = applyMotionPolicy(sleepyPosture, port, null);
  previous = applyMotionPolicy(sleepingPosture, port, previous);
  assert.deepEqual(port.calls, [['off', 'idle-chain']]);
  assert.equal(previous, 'off');
});

test('G-M7②：朝向只在走 / 跑时写入，非走 / 跑姿态一个字都不写', () => {
  const written: Facing[] = [];
  const setFacing = (next: Facing): void => {
    written.push(next);
  };

  // 坐着 / 趴着 / 睡着：不写（否则用户会看到"坐着坐着突然转身"）
  for (const posture of ['stand', 'sit', 'lie', 'sleep', 'jump'] as const satisfies readonly PostureId[]) {
    assert.equal(applyFacingIfMoving(posture, 1, setFacing), false, `${posture} 不该写朝向`);
  }
  assert.deepEqual(written, []);

  // 走 / 跑：写一次，值原样透传（滞回由主进程算，渲染层不复制 24 DIP）
  assert.equal(applyFacingIfMoving('walk', -1, setFacing), true);
  assert.equal(applyFacingIfMoving('run', 1, setFacing), true);
  assert.deepEqual(written, [-1, 1]);
});

test('非法朝向抛 TypeError（跨进程来的不可信输入不许静默）', () => {
  const written: Facing[] = [];
  const setFacing = (next: Facing): void => {
    written.push(next);
  };
  for (const bad of [0, 2, -2, Number.NaN]) {
    assert.throws(() => applyFacingIfMoving('walk', bad as Facing, setFacing), TypeError);
  }
  assert.deepEqual(written, []);
});

test('静态：main.ts 只用 pet:motion-intent 一个通道名，且 MotionIntent 载荷里没有坐标', () => {
  const source = codeOf(readSource('src/pet/main.ts'));
  assert.equal(source.split("'pet:motion-intent'").length - 1, 1, '通道名只许出现一次（单一真源）');
  for (const forged of ['pet:motion', 'pet:motion-follow', 'pet:locomotion']) {
    assert.equal(source.includes(`'${forged}'`), false, `不许自造第二套通道名：${forged}`);
  }
  const intent = sliceBetween(source, 'interface MotionIntent {', '}');
  assert.ok(intent.length > 0, 'MotionIntent 必须存在');
  assert.equal(/^\s*[xy]\??\s*:/m.test(intent), false, '意图里不许有坐标字段（唯一位置写入者是主进程）');
  assert.ok(intent.includes('mode') && intent.includes('reason'), 'MotionIntent 只承载 mode + reason');
});

test('静态：LocomotionBridge 里没有任何 MOTION 数值烘焙（滞回 / 半径 / 速度一个都没复制）', () => {
  const source = codeOf(readSource('src/pet/main.ts'));
  const bridge = sliceBetween(source, 'class LocomotionBridge {', 'const locomotion = new LocomotionBridge();');
  assert.ok(bridge.length > 0, 'LocomotionBridge 必须存在于 main.ts');
  // `pet-motion.cjs` 的 MOTION 数值（tickMs/半径/速度/加速度/滞回）一个都不许在这里出现
  for (const baked of ['220', '420', '320', '480', '960', '150', '240', '56', '96']) {
    assert.equal(
      new RegExp(`(^|[^0-9.])${baked}([^0-9.]|$)`).test(bridge),
      false,
      `LocomotionBridge 里出现了 MOTION 数值 ${baked}：滞回/速度的单一真源在 pet-motion.cjs`,
    );
  }
  // 唯一允许的数字是渲染层自己的看门狗超时，且必须是常量引用而不是字面量
  assert.ok(bridge.includes('MOVE_COMMAND_STALE_MS'), '看门狗超时必须走常量');
  assert.equal(/now - this\.lastMotionAt <= \d/.test(bridge), false, '不许在比较里写死超时毫秒数');
});

test('静态：隐藏时 0 发送——requestMode 的 this.hidden 判断排在 IPC 调用之前', () => {
  const source = codeOf(readSource('src/pet/main.ts'));
  const request = sliceBetween(source, 'requestMode(mode: MotionMode', 'applyFacingIfMoving(facing: Facing)');
  assert.ok(request.length > 0, 'requestMode 必须存在');
  const hiddenAt = request.indexOf('if (this.hidden)');
  const sendAt = request.indexOf('motionIntent');
  assert.ok(hiddenAt >= 0, '必须有 this.hidden 的早退分支');
  assert.ok(sendAt >= 0, '必须经 bridge.motionIntent 下发');
  assert.ok(hiddenAt < sendAt, '隐藏必须在发送之前早退（隐藏时 0 发送）');
});

test('静态：move-* 三个方法体里没有 lastInteractionAt 赋值（P-M13 的文本守卫）', () => {
  const code = codeOf(readSource('src/pet/behavior/state-machine.ts'));
  const bodies = [
    sliceBetween(code, 'private startMove(ctx: MotionContext)', 'private gaitMove'),
    sliceBetween(code, 'private gaitMove(ctx: MotionContext)', 'private finishMove'),
    sliceBetween(code, 'private finishMove(ctx: MotionContext)', 'tick()'),
  ];
  for (const body of bodies) {
    assert.ok(body.length > 0, '三个方法体都必须能切出来');
    assert.equal(body.includes('lastInteractionAt ='), false, 'move-* 里出现了 lastInteractionAt 赋值');
  }
});

test('静态：渲染层没有 scaleX(-1) 镜像（P-M20），朝向只走 applyPoseFacing', () => {
  const source = codeOf(readSource('src/pet/main.ts'));
  assert.equal(source.includes('scaleX(-1)'), false);
  assert.equal(source.includes("transform: 'scaleX(-1)'"), false);
  // 朝向写入器是函数引用：不新增 `applyPoseFacing(` 调用点（Q7-2 要求调用点恰为两处）
  const occurrences = source.match(/applyPoseFacing\(/g) ?? [];
  const declarations = source.match(/function applyPoseFacing\(/g) ?? [];
  assert.equal(occurrences.length - declarations.length, 2, 'applyPoseFacing 的调用点必须恰为两处');
  assert.ok(source.includes('const poseFacingWriter: (next: Facing) => Facing = applyPoseFacing;'));
});
