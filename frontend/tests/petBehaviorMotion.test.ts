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
  MOTION_REST_STATES,
  PetBehaviorStateMachine,
  SIT_AFTER_IDLE_MS,
  SLEEPY_AFTER_IDLE_MS,
  SLEEP_AFTER_IDLE_MS,
  applyFacingIfMoving,
  applyMotionPolicy,
  behaviorReportOf,
  decidePrefsMotion,
  isMotionAllowed,
  motionIntentForPosture,
  postureOf,
  type MotionIntentReason,
  type MotionMode,
  type MotionReportPort,
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

/* ------------------------------------------------------------------------------------
 * 行为态上报（`behavior` 字段）+ 偏好广播 → 运动意图
 *
 * <p>这一组守的是**真机上的空转**：主进程的运动控制器早就有"行为态闸门"
 * （`BLOCKED_BEHAVIORS = ['sleeping','sleep','drag']`），但渲染层如果不把当前行为态
 * 随意图报上去，主进程永远拿着默认值 `idle` 放行——实测症状就是
 * `posture=sleep` 却在平移窗口。同理，"用户打开自由漫游"只落盘不生效，
 * 因为渲染层没有据此重新评估意图。</p>
 * ---------------------------------------------------------------------------------- */

/**
 * 从主进程运动真源里读出 `BLOCKED_BEHAVIORS`（**不复制清单**：复制一份就是第二真源）。
 *
 * @returns 主进程认定的"必须拦住"的行为态
 */
function readMainProcessBlockedBehaviors(): string[] {
  const source = readSource('electron/pet-motion.cjs');
  const match = /const BLOCKED_BEHAVIORS = Object\.freeze\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(match !== null, 'pet-motion.cjs 里找不到 BLOCKED_BEHAVIORS（主进程闸门的真源消失了）');
  const list = match[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item.length > 0);
  assert.ok(list.length > 0, 'BLOCKED_BEHAVIORS 解析为空（门禁失效）');
  return list;
}

test('行为态上报：值域与主进程 BLOCKED_BEHAVIORS 逐值对齐（原样透传，不重新映射）', () => {
  const blocked = readMainProcessBlockedBehaviors();
  assert.ok(blocked.length > 0, '主进程必须给出至少一个被拦的行为态');
  for (const value of blocked) {
    assert.equal(
      behaviorReportOf(value),
      value,
      `上报值 ${value} 被渲染层改写成了 ${behaviorReportOf(value)}：主进程按字符串命中判定，改写即失效`,
    );
    assert.notEqual(behaviorReportOf(value), 'idle', `${value} 是必须拦住的行为态，绝不能报成 idle`);
  }
  // 兜底：状态机未就绪时报 idle（**不许报空串** —— 主进程会忽略空串并沿用旧值）
  assert.equal(behaviorReportOf(null), 'idle');
  assert.equal(behaviorReportOf(undefined), 'idle');
  assert.equal(behaviorReportOf(''), 'idle');
});

test('行为态上报：真状态机走到 sleeping / drag，报上去的就是那两个值（不是 idle）', () => {
  const clock = new Clock();
  const sleeping = machine(clock);
  clock.goTo(SLEEP_AFTER_IDLE_MS);
  sleeping.tick();
  assert.equal(sleeping.state, 'sleeping');
  assert.equal(behaviorReportOf(sleeping.state), 'sleeping', '睡着时必须上报 sleeping');

  const dragged = machine(new Clock());
  dragged.handle('drag-start');
  assert.equal(dragged.state, 'drag');
  assert.equal(behaviorReportOf(dragged.state), 'drag', '拖拽时必须上报 drag');

  // 主进程清单里的 `sleep` 是**姿态名**：渲染层的睡姿由 postureOf 派生。
  // 这里断言"万一上报它，也不能被改写成 idle"（值域对齐的第二半）。
  assert.equal(behaviorReportOf('sleep'), 'sleep');
});

test('偏好 → 运动意图：roam / follow 优先级 / 全关 / 睡着不动 / 坐着先起身', () => {
  // roam 开、行为态正常 ⇒ 请求 roam
  assert.deepEqual(decidePrefsMotion(false, true, 'idle'), { mode: 'roam', resumeFromRest: false });
  // 两个都开 ⇒ follow 优先（§5）
  assert.deepEqual(decidePrefsMotion(true, true, 'idle'), { mode: 'follow', resumeFromRest: false });
  assert.deepEqual(decidePrefsMotion(true, false, 'idle'), { mode: 'follow', resumeFromRest: false });
  // 两个都关 ⇒ off
  assert.deepEqual(decidePrefsMotion(false, false, 'idle'), { mode: 'off', resumeFromRest: false });
  // 睡着 / 困倦 / 趴着 / 被拖 ⇒ 一律 off（不许发起自己会拒收的请求）
  for (const state of MOTION_REST_STATES) {
    assert.deepEqual(
      decidePrefsMotion(false, true, state),
      { mode: 'off', resumeFromRest: false },
      `${state} 下不许发起 roam`,
    );
    assert.deepEqual(decidePrefsMotion(true, true, state), { mode: 'off', resumeFromRest: false });
  }
  // 坐着是"容许动、但得先站起来"（否则 move-* 会被状态机拒收 ⇒ 坐着平移）
  assert.deepEqual(decidePrefsMotion(false, true, 'sit'), { mode: 'roam', resumeFromRest: true });
  // 状态机没建好 ⇒ 不动
  assert.deepEqual(decidePrefsMotion(false, true, null), { mode: 'off', resumeFromRest: false });
  // 动作态与走/跑都算可动
  for (const state of ['tap', 'angry', 'wake', 'pet', 'walk', 'run'] as const satisfies readonly PetBehaviorState[]) {
    assert.equal(isMotionAllowed(state), true, `${state} 应当允许发起移动`);
  }
});

test('偏好生效（行为侧）：roam 开着而猫坐着 ⇒ 起身，且起身后的运动事件仍不刷新空闲计时', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  clock.goTo(SIT_AFTER_IDLE_MS);
  behavior.tick();
  assert.equal(behavior.state, 'sit', '静置 20s 应当已经坐下（这是真机上"开了漫游不动"的现场）');

  const decision = decidePrefsMotion(false, true, behavior.state);
  assert.equal(decision.mode, 'roam');
  assert.equal(decision.resumeFromRest, true);

  assert.equal(behavior.resumeFromRest(), true, '坐着时必须能起身');
  assert.equal(behavior.state, 'idle');
  // 起身后必须**不再立刻坐下**（空闲链重新计时），否则站起来只闪一帧
  clock.advance(SIT_AFTER_IDLE_MS - 1);
  behavior.tick();
  assert.equal(behavior.state, 'idle', '起身后立刻又被按回 sit：空闲链没有重新计时');
  // 但起身**之后**的运动事件依然一个字都不写 lastInteractionAt（P-M13 不受影响）
  const elapsedBefore = behavior.idleElapsedMs();
  behavior.handle('move-start', { gait: 'walk', reason: 'prefs' });
  assert.equal(behavior.state, 'walk');
  assert.equal(behavior.idleElapsedMs(), elapsedBefore, '运动事件不许刷新空闲计时');
});

test('偏好生效（行为侧）：睡着的猫不许被"打开漫游"叫醒', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  clock.goTo(SLEEP_AFTER_IDLE_MS);
  behavior.tick();
  assert.equal(behavior.state, 'sleeping');
  assert.equal(behavior.resumeFromRest(), false, 'sleeping 不许被叫醒（睡眠是被动态，开漫游不是摸头）');
  assert.equal(behavior.state, 'sleeping');
  // 拖拽中同样不许起身（位置写入权在 drag）
  const dragged = machine(new Clock());
  dragged.handle('drag-start');
  assert.equal(dragged.resumeFromRest(), false);
  assert.equal(dragged.state, 'drag');
});

test('静态：main.ts 有 pet:command 的 prefs 分支，且同时读扁平与嵌套两种载荷', () => {
  const source = codeOf(readSource('src/pet/main.ts'));
  assert.ok(
    source.includes("command.type === 'prefs'"),
    "缺少 `command.type === 'prefs'` 分支（偏好广播没人接，开了漫游等于没开）",
  );
  const branch = sliceBetween(source, "if (command.type === 'prefs') {", 'return;');
  assert.ok(branch.length > 0, 'prefs 分支必须能切出来');
  // 载荷是超集：扁平 follow/roam 与嵌套 prefs 都要能读
  assert.ok(branch.includes('command.prefs'), 'prefs 分支没有读嵌套的 command.prefs（超集载荷的另一半）');
  assert.ok(branch.includes('command.follow') && branch.includes('command.roam'), 'prefs 分支没有读扁平的 follow/roam');
  assert.ok(branch.includes('locomotion.onPrefs('), 'prefs 分支必须把开关交给运动桥重新评估');
  // 偏好可能先于状态机到达（ready 后立刻广播）：状态机就绪时必须补一次评估，否则永远 off
  assert.ok(
    source.includes('if (locomotion.prefs.follow || locomotion.prefs.roam) locomotion.onPrefs('),
    '缺少"状态机就绪后补一次偏好评估"的兜底（偏好早于状态机到达时，开关会永远不生效）',
  );
});

test('静态：每条 motionIntent 载荷都带 behavior（键在 send 处、字段必填、来源唯一）', () => {
  const source = codeOf(readSource('src/pet/main.ts'));

  // 唯一的下发点必须把 behavior 一起带上
  const callIndex = source.indexOf('.call(bridge');
  assert.ok(callIndex >= 0, '找不到 bridge.motionIntent 的下发点（门禁失效）');
  const sendSlice = source.slice(Math.max(0, callIndex - 700), callIndex + 200);
  assert.ok(sendSlice.includes('behavior:'), '下发载荷里没有 behavior 键（主进程闸门会永远拿到 idle）');
  assert.ok(sendSlice.includes('MotionIntent'), '下发载荷应当显式标注为 MotionIntent（防以后漏字段）');

  // 接口上 behavior 是**必填**（`?` 一加就等于允许不发）
  const intent = sliceBetween(source, 'interface MotionIntent {', '}');
  assert.ok(intent.includes('behavior'), 'MotionIntent 必须声明 behavior');
  assert.equal(/behavior\s*\?/.test(intent), false, 'behavior 不许是可选字段');

  // 来源唯一：只许从行为状态机的 stateValue 派生，不许另起一份
  assert.ok(
    source.includes('behaviorReportOf(behavior?.state ?? null)'),
    'behavior 必须来自行为状态机的 stateValue',
  );
  const reportCalls = source.match(/behaviorReportOf\(/g) ?? [];
  assert.equal(reportCalls.length, 1, `behaviorReportOf 只许在唯一的下发点调用一次，实际 ${reportCalls.length} 次`);
});

test('静态：序列播放期间不许发起自主移动（§5 第 3 级）', () => {
  const source = codeOf(readSource('src/pet/main.ts'));
  const request = sliceBetween(source, 'requestMode(mode: MotionMode', 'applyFacingIfMoving(facing: Facing)');
  assert.ok(request.includes('sequencePlaying'), 'requestMode 缺少"序列播放中不许开启"的闸门');
  assert.ok(source.includes('setSequencePlaying(true)'), '播放路径必须置上序列标志');
  assert.ok(source.includes('setSequencePlaying(false)'), '序列结束时必须撤掉序列标志');
});

/* ------------------------------------------------------------------------------------
 * 休息态进出双向同步（`syncRestMotion`）—— 两条真机 bug 的回归用例
 *
 * <p>真机采样（70s）暴露了两个方向的问题，它们必须一起闭环：</p>
 * <ol>
 *   <li><b>进入休息态后没停</b>：猫在用户打开漫游**之前**就已经是 `lie`，随后进入
 *       `sleeping`，`mode` 仍是 `roam`，一路睡姿平移（1229,313 → 307,347）。根因是
 *       触发点挂在"姿态变化事件"上，而不是行为态本身。</li>
 *   <li><b>离开休息态没恢复</b>：点醒之后 `mode` 永远 `off`（且主进程 `behavior` 卡在
 *       陈旧的 `sleeping`），用户必须再点一次菜单才恢复漫游。</li>
 * </ol>
 * 两个方向都**不许**刷新 `lastInteractionAt`（否则空闲链断掉）。
 * ---------------------------------------------------------------------------------- */

/** 记录"带行为态"的意图（`MotionReportPort` 的桩，也是本组判据的观测点）。 */
class RecordingReportPort implements MotionReportPort {
  /** 收到的全部意图（按到达顺序）。 */
  readonly calls: Array<{ mode: MotionMode; reason: MotionIntentReason; behavior: string }> = [];

  /**
   * 记录一次意图（桩不模拟主进程的行为态闸门，闸门由渲染层的 `requestMode` 守）。
   *
   * @param mode 模式
   * @param reason 原因
   * @param behavior 行为态
   * @returns 恒为 `true`
   */
  requestMode(mode: MotionMode, reason: MotionIntentReason, behavior: string): boolean {
    this.calls.push({ mode, reason, behavior });
    return true;
  }

  /** 最后一条意图（没有时为 `null`）。 */
  get last(): { mode: MotionMode; reason: MotionIntentReason; behavior: string } | null {
    return this.calls.length === 0 ? null : this.calls[this.calls.length - 1];
  }

  /** 所有"开启类"意图（`mode !== 'off'`）。 */
  get opened(): Array<{ mode: MotionMode; reason: MotionIntentReason; behavior: string }> {
    return this.calls.filter((call) => call.mode !== 'off');
  }
}

test('真机回归①：先让 roam 生效、再推进到 sleeping ⇒ 立刻下发 off，且此后不再发 roam', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  const port = new RecordingReportPort();

  // 真机采样起点就是 mode=roam（用户在猫已经趴着时打开了自由漫游）
  port.requestMode('roam', 'prefs', 'idle');
  // 首次同步发生在可动态：不产生任何下发（`null`）
  assert.equal(behavior.syncRestMotion(false, true, port), null);
  assert.equal(port.calls.length, 1, '可动状态下同步不该发任何意图');

  // 60s 犯困（此时姿态早就不是 stand 了：判据绝不能挂在"姿态有没有变"上）
  clock.goTo(SLEEPY_AFTER_IDLE_MS);
  behavior.tick();
  assert.equal(behavior.state, 'sleepy', '静置 60s 应当已经困倦');
  const sleepyExit = behavior.syncRestMotion(false, true, port);
  assert.notEqual(sleepyExit, null, '进入困倦必须下发');
  assert.deepEqual(port.last, { mode: 'off', reason: 'idle-chain', behavior: 'sleepy' });

  // 90s 真睡：**休息态内部互转也必须重发**（`sleepy` 主进程不拦，`sleeping` 才拦）
  clock.goTo(SLEEP_AFTER_IDLE_MS);
  behavior.tick();
  assert.equal(behavior.state, 'sleeping');
  const sleepingExit = behavior.syncRestMotion(false, true, port);
  assert.notEqual(sleepingExit, null, 'sleepy→sleeping 必须再下发一次（否则主进程停在 sleepy，闸门不生效）');
  assert.deepEqual(port.last, { mode: 'off', reason: 'idle-chain', behavior: 'sleeping' });

  // 睡着之后连续 40 拍（10 秒）都**不许**再出现任何开启类意图
  for (let i = 0; i < 40; i += 1) {
    clock.advance(250);
    behavior.tick();
    behavior.syncRestMotion(false, true, port);
  }
  assert.equal(behavior.state, 'sleeping', '睡着期间不该自己醒');
  assert.deepEqual(
    port.opened.filter((call) => call.behavior === 'sleeping' || call.behavior === 'sleepy'),
    [],
    '睡眠期间出现了开启类意图：猫会在床上滑行（真机 1229,313 → 307,347 就是这个 bug）',
  );
});

test('真机回归②：sleeping 期间无论偏好怎么变，任何意图都只能是 off', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  const port = new RecordingReportPort();

  clock.goTo(SLEEP_AFTER_IDLE_MS);
  behavior.tick();
  assert.equal(behavior.state, 'sleeping');
  behavior.syncRestMotion(false, true, port);
  const baseline = port.calls.length;
  assert.ok(baseline >= 1, '进入睡眠必须至少下发一次');

  // 睡眠期间偏好反复变化 + 反复行为拍：全部只能是 off（`requestMode` 的第 5 道闸门）
  for (const [follow, roam] of [[true, true], [true, false], [false, true], [false, false]] as const) {
    behavior.syncRestMotion(follow, roam, port);
    clock.advance(250);
    behavior.tick();
    behavior.syncRestMotion(follow, roam, port);
  }
  const after = port.calls.slice(baseline);
  assert.deepEqual(
    after.filter((call) => call.mode !== 'off'),
    [],
    '睡眠期间出现了开启类意图',
  );
  // 且上报的行为态没有退回 idle（把 sleeping 丢了等于闸门失效）
  assert.equal(port.last?.behavior, 'sleeping');
});

test('真机回归③：sleeping → 醒来（roam 仍开着）⇒ 重新下发 roam，behavior 为当前态', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  const port = new RecordingReportPort();

  clock.goTo(SLEEP_AFTER_IDLE_MS);
  behavior.tick();
  assert.equal(behavior.state, 'sleeping');
  behavior.syncRestMotion(false, true, port);
  assert.equal(port.last?.mode, 'off');

  // 点醒：sleeping → wake（真实入口在 `tap` 里，与点击分区无关）
  clock.advance(1000);
  behavior.handle('tap');
  assert.equal(behavior.state, 'wake', '睡眠中被点击应当惊醒');
  const wakeExit = behavior.syncRestMotion(false, true, port);
  assert.notEqual(wakeExit, null, '离开休息态必须重评估并下发');
  assert.equal(port.last?.mode, 'roam', '醒来后必须自动恢复漫游（真机上是永久 off）');
  assert.equal(port.last?.reason, 'prefs');
  assert.equal(port.last?.behavior, behavior.state, 'behavior 必须是当前行为态（不许留陈旧 sleeping）');

  // 只发一次：后续拍里 same (mode, reason, behavior) 幂等，不把 IPC 打满
  const count = port.calls.length;
  for (let i = 0; i < 8; i += 1) {
    clock.advance(250);
    behavior.tick();
    behavior.syncRestMotion(false, true, port);
  }
  assert.ok(port.calls.length - count <= 1, '醒来后不该反复重发同一意图');
});

test('真机回归④：两个开关都关时，醒来也要发一次 off（把陈旧的 behavior 刷掉）', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  const port = new RecordingReportPort();

  clock.goTo(SLEEP_AFTER_IDLE_MS);
  behavior.tick();
  behavior.syncRestMotion(false, false, port);
  assert.deepEqual(port.last, { mode: 'off', reason: 'idle-chain', behavior: 'sleeping' });

  clock.advance(1000);
  behavior.handle('tap');
  const exit = behavior.syncRestMotion(false, false, port);
  assert.notEqual(exit, null, '开关都关也必须发一条：主进程的 behavior 还停在 sleeping，必须刷新');
  assert.equal(port.last?.mode, 'off');
  assert.equal(port.last?.reason, 'prefs');
  assert.equal(port.last?.behavior, behavior.state);
  assert.notEqual(port.last?.behavior, 'sleeping', '不许再把陈旧的 sleeping 报上去');
});

test('真机回归⑤：进、睡、出三个方向都不许刷新 lastInteractionAt', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  const port = new RecordingReportPort();

  behavior.syncRestMotion(false, true, port);
  const atIdle = behavior.idleElapsedMs();

  clock.goTo(SLEEPY_AFTER_IDLE_MS);
  behavior.tick();
  const atSleepy = behavior.idleElapsedMs();
  assert.equal(atSleepy, atIdle + SLEEPY_AFTER_IDLE_MS, 'tick 到困倦本身不改计时');
  behavior.syncRestMotion(false, true, port);
  assert.equal(behavior.idleElapsedMs(), atSleepy, '进入困倦的同步不许刷新空闲计时');

  clock.goTo(SLEEP_AFTER_IDLE_MS);
  behavior.tick();
  const atSleeping = behavior.idleElapsedMs();
  behavior.syncRestMotion(false, true, port);
  assert.equal(behavior.idleElapsedMs(), atSleeping, '睡眠中的同步不许刷新空闲计时');

  // 醒来是**真实交互**，计时起点允许被 tap 拉回（那是 `tap` 的职责，不是同步的）
  clock.advance(1000);
  behavior.handle('tap');
  const afterWakeTap = behavior.idleElapsedMs();
  behavior.syncRestMotion(false, true, port);
  assert.equal(behavior.idleElapsedMs(), afterWakeTap, '离开休息态的重评估不许顺手刷新空闲计时');
});

/* ------------------------------------------------------------------------------------
 * 活跃模式抑制空闲链（裁决：follow / roam 任一开启 ⇒ 不推进到 sit / sleepy / sleeping）
 *
 * <p>真机第三个形态：`posture=sit` 却被漫游推着走（walk 96 / run 238）。成因是设计层面
 * 两条规则打架：规则 A「自主移动不刷新空闲计时」⇒ 20s 必坐；规则 B「自主漫游优先级高于
 * 空闲坐」。两条同时成立时实现只能挑一条。裁决：**活跃模式下休息态让位于自主移动**。</p>
 *
 * <p>纪律：抑制**不是重置计时**（`lastInteractionAt` 一个字不动），且必须在状态机内部。</p>
 * ---------------------------------------------------------------------------------- */

/**
 * 跑一段"每拍 tick"的仿真（250ms 一拍），记录出现过的状态。
 *
 * @param behavior 状态机
 * @param clock 时钟
 * @param fromMs 起始绝对时刻
 * @param toMs 结束绝对时刻
 * @returns 依次出现过的状态（含中间态）
 */
function runBeats(
  behavior: PetBehaviorStateMachine,
  clock: Clock,
  fromMs: number,
  toMs: number,
): PetBehaviorState[] {
  const seen: PetBehaviorState[] = [];
  const step = 250;
  for (let at = fromMs; at <= toMs; at += step) {
    clock.goTo(at);
    behavior.tick();
    seen.push(behavior.state);
  }
  return seen;
}

test('活跃模式①：roam:true 且 60s 无交互 ⇒ 不许进 sit / sleepy / sleeping（保持 idle）', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  behavior.setMotionPrefs(false, true);
  assert.equal(behavior.isActiveMode, true);

  const seen = runBeats(behavior, clock, 0, 60000);
  for (const state of seen) {
    assert.ok(
      state === 'idle' || state === 'walk' || state === 'run',
      `活跃模式下 60s 内出现了休息态 ${state}：它会在漫游中被按成 sit，于是"坐着平移"`,
    );
  }
  assert.equal(behavior.state, 'idle');
  // 姿态也不许是坐/趴/睡（真机判据直接看 posture）
  const posture = postureOf(behavior.state, PET_POSES, 1);
  assert.ok(posture === 'stand' || posture === 'walk' || posture === 'run', `posture=${posture}`);
});

test('活跃模式②：follow:true 且 60s 无交互 ⇒ 同样不许进休息态', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  behavior.setMotionPrefs(true, false);

  const seen = runBeats(behavior, clock, 0, 60000);
  for (const state of seen) {
    assert.ok(state === 'idle' || state === 'walk' || state === 'run', `follow 开启后出现了休息态 ${state}`);
  }
  // 90s 也不许睡（再往后跑 40s）
  const later = runBeats(behavior, clock, 60250, 100000);
  for (const state of later) {
    assert.ok(state === 'idle' || state === 'walk' || state === 'run', `follow 开启后 100s 出现了休息态 ${state}`);
  }
});

test('活跃模式③：两个开关都关 ⇒ 既有 20s / 60s / 90s 三档照旧生效（没被抑制误伤）', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  behavior.setMotionPrefs(false, false);
  assert.equal(behavior.isActiveMode, false);

  clock.goTo(SIT_AFTER_IDLE_MS);
  behavior.tick();
  assert.equal(behavior.state, 'sit', '20s 必须仍然坐下');
  clock.goTo(SLEEPY_AFTER_IDLE_MS);
  behavior.tick();
  assert.equal(behavior.state, 'sleepy', '60s 必须仍然困倦');
  clock.goTo(SLEEP_AFTER_IDLE_MS);
  behavior.tick();
  assert.equal(behavior.state, 'sleeping', '90s 必须仍然睡');
  // 阈值常量一个都没改
  assert.equal(SIT_AFTER_IDLE_MS, 20000);
  assert.equal(SLEEPY_AFTER_IDLE_MS, 60000);
  assert.equal(SLEEP_AFTER_IDLE_MS, 90000);
});

test('活跃模式④：关掉开关的瞬间，若已 ≥20s 无交互 ⇒ 下一拍直接进 sit（不等待、也不跳过）', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  behavior.setMotionPrefs(false, true);
  // 被漫游按着跑了 70s（已经 ≥ 20s，甚至 ≥ 60s）
  runBeats(behavior, clock, 0, 70000);
  assert.equal(behavior.state, 'idle', '活跃模式下应当一直是 idle');

  // 用户关掉开关：下一拍就必须坐下（用既有 now - lastInteractionAt 判断，不必重新等 20s）
  behavior.setMotionPrefs(false, false);
  clock.goTo(70250);
  behavior.tick();
  assert.equal(behavior.state, 'sit', '关掉开关的下一拍必须直接进 sit（不许再等一轮）');
  assert.ok(SIT_AFTER_IDLE_MS <= 70250, '这里的时刻确实已经 ≥ 20s');

  // 且不许一跳到底：紧接着的一拍不能已经在 sleeping（跳过 sit 是另一种错误）
  clock.goTo(70500);
  behavior.tick();
  assert.notEqual(behavior.state, 'sleeping', '放开的第一拍不许直接睡着（要从第一档重新走）');
});

test('活跃模式⑤：抑制期间 lastInteractionAt 一个字不动（不是重置计时）', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  behavior.setMotionPrefs(false, true);

  runBeats(behavior, clock, 0, 30000);
  assert.equal(behavior.idleElapsedMs(), 30000, '抑制不许改计时起点：30s 就该算出 30000');
  runBeats(behavior, clock, 30250, 120000);
  assert.equal(behavior.idleElapsedMs(), 120000, '被按了 2 分钟，空闲计时仍应如实累计到 120000');
  assert.equal(behavior.state, 'idle');

  // 反向：抑制只影响"要不要进休息态"，不影响计时本身
  behavior.setMotionPrefs(false, false);
  clock.goTo(120250);
  behavior.tick();
  assert.equal(behavior.state, 'sit', '计时没被重置 ⇒ 关掉开关立刻能坐下');
});

test('活跃模式⑥（真机回归）：**先开 roam 走起来**、再静置 60s ⇒ 全程 posture 不许是 sit / lie / sleep', () => {
  const clock = new Clock();
  const behavior = machine(clock);
  const postures: PostureId[] = [];

  // 先开 roam，并让它真的走起来（起步 + 换档 + 到达停下）
  behavior.setMotionPrefs(false, true);
  behavior.handle('move-start', { gait: 'walk', reason: 'prefs' });
  assert.equal(behavior.state, 'walk');
  postures.push(postureOf(behavior.state, PET_POSES, 1));
  behavior.handle('move-gait', { gait: 'run', reason: 'prefs' });
  assert.equal(behavior.state, 'run');
  postures.push(postureOf(behavior.state, PET_POSES, 1));
  behavior.handle('move-end', { gait: 'none', reason: 'arrived' });
  assert.equal(behavior.state, 'idle');

  // 再静置 60s：每拍都记账姿态（这是真机采样的等价物）
  for (let at = 250; at <= 60000; at += 250) {
    clock.goTo(at);
    behavior.tick();
    postures.push(postureOf(behavior.state, PET_POSES, 1));
  }
  for (const posture of postures) {
    assert.ok(
      posture !== 'sit' && posture !== 'lie' && posture !== 'sleep',
      `出现休息姿态 ${posture}：漫游中会被推着走（真机 sit + walk 96 的现场）`,
    );
  }
  assert.equal(behavior.state, 'idle');
});

test('静态：抑制由状态机内部承担，渲染层只透传（不许用外部 if 兜）', () => {
  const machineSource = codeOf(readSource('src/pet/behavior/state-machine.ts'));
  const tickBody = sliceBetween(machineSource, 'tick(): PresentationOp[]', 'private enterSit');
  assert.ok(tickBody.length > 0, 'tick 必须能切出来');
  assert.ok(tickBody.includes('this.isActiveMode'), 'tick 内部必须自己判定活跃模式（结构保证）');
  assert.ok(tickBody.includes('!suppressed'), '空闲链三档必须被 !suppressed 挡住');
  // 透传点存在且只有一处（渲染层不许自己再写一份抑制逻辑）
  const main = codeOf(readSource('src/pet/main.ts'));
  assert.ok(main.includes('behavior?.setMotionPrefs(this.followEnabled, this.roamEnabled);'), '渲染层必须把偏好透传给状态机');
  assert.equal(main.includes('IDLE_CHAIN_STATES.includes'), false, '渲染层不许自己再判一遍空闲链（那就是两处约定）');
});

test('静态：行为拍里接了 `syncRestMotion`，且它不读时钟、不写 lastInteractionAt', () => {
  const main = codeOf(readSource('src/pet/main.ts'));
  assert.ok(main.includes('locomotion.syncRestMotion();'), '行为拍里缺少休息态同步（两个真机 bug 的共同修复点）');
  const machineSource = codeOf(readSource('src/pet/behavior/state-machine.ts'));
  const body = sliceBetween(machineSource, 'syncRestMotion(follow: boolean', 'get isSleeping()');
  assert.ok(body.length > 0, 'syncRestMotion 必须存在于状态机');
  assert.equal(body.includes('lastInteractionAt'), false, '休息态同步里出现了 lastInteractionAt（空闲链会断）');
  assert.equal(body.includes('this.now()'), false, '休息态同步不许读时钟：它只做意图下发');
  // 判据必须挂在行为态上（真机根因是挂在姿态变化上）
  assert.ok(body.includes('MOTION_REST_STATES.includes(current)'), '判据必须是行为态，不能改成"姿态有没有变"');
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
