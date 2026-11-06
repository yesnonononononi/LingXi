/**
 * 步幅匹配用例：**速度档 × 动画周期 = 每周期位移**，且位移必须与"走路/跑步"这个观感对得上。
 *
 * <p><b>为什么这一条必须单独测：</b>它是 M3 里唯一"跨两个部门"的数字——
 * `<nobr>速度带</nobr>` 在 `electron/pet-motion.cjs` 的 `MOTION` 里（主进程），
 * `<nobr>帧时长</nobr>` 在 `pet-poses.json` 的 `clips[].frameMs` 里（美术资产）。
 * 两者都对、但**乘起来不对**时，用户看到的是"脚在原地刨"或者"轮子滑行"：
 * 动画播完了还没走完一步（像在冰上滑），或者走完一步动画还在原地补帧（像在跑步机上）。
 * 这类缺陷没有任何运行时断言能抓到，只有把两个域的数字乘起来才看得见（设计 §10.2 G-M8）。</p>
 *
 * <p>顺带钉住"禁原地滑行"的前提：`walk` 的最慢速度换算到每拍位移是 0.896 DIP < 1，
 * 所以运动学**必须**浮点累加、只在写窗口时取整——一旦哪一拍先取整再累加，
 * 低速时会出现 `Δpos = 0` 的拍，那就是原地滑行（本文件有专门的用例守这条）。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 运动真源（CJS；`MOTION` 是唯一的手感数字来源）。 */
const { MOTION, stepToward } = require('../electron/pet-motion.cjs') as {
  MOTION: {
    tickMs: number;
    walkMinDipPerSec: number;
    walkMaxDipPerSec: number;
    runMinDipPerSec: number;
    runMaxDipPerSec: number;
    accelDipPerSec2: number;
    decelDipPerSec2: number;
  };
  stepToward: (options: {
    from: { x: number; y: number };
    to: { x: number; y: number };
    speedLimit: number;
    accel: number;
    currentSpeed?: number;
    dtMs: number;
  }) => { x: number; y: number; speed: number; arrived: boolean };
};

/** 姿态清单（走/跑两批的逐帧时长都在这里；本文件只读，不改）。 */
const PET_POSES = require('../pet-poses.json') as {
  batches: Record<string, { clips: Array<{ id: string; facing: number; frames: string[]; frameMs: number[] }> }>;
};

/**
 * 取某一批的动画周期（毫秒）＝ 全部帧时长之和。
 *
 * <p>`pet-poses.json` 里同一个 `cycle` 片段有 `-1` / `1` 两份（左右朝向各一套），
 * 时长必须相等：不等就意味着"往左走比往右走快"，用户一眼能看出来。</p>
 *
 * @param batch 批次名（`walk` / `run`）
 * @returns 周期毫秒数
 */
function cycleMsOf(batch: string): number {
  const clips = PET_POSES.batches[batch]?.clips ?? [];
  assert.ok(clips.length > 0, `${batch} 批次没有片段（姿态清单缺失或改名）`);
  const durations = clips.map((clip) => clip.frameMs.reduce((sum, ms) => sum + ms, 0));
  for (const duration of durations) {
    assert.equal(duration, durations[0], `${batch} 的两个朝向周期不一致：${durations.join(' / ')}ms`);
  }
  for (const clip of clips) {
    assert.equal(
      clip.frameMs.length,
      clip.frames.length,
      `${batch}[facing=${clip.facing}] 的 frameMs 与 frames 数量不一致（逐帧时长缺失）`,
    );
    assert.ok(
      new Set(clip.frames).size > 1,
      `${batch}[facing=${clip.facing}] 所有帧都指向同一张图（会被判成假动画，G-P14）`,
    );
  }
  return durations[0];
}

/**
 * 按 `stepToward` 逐拍推进一段直线，返回每一拍的位置与速度。
 *
 * @param options 推进参数
 * @param options.speedLimit 速度上限（DIP/秒）
 * @param options.ticks 拍数
 * @returns 每一拍的 `{x, speed}`（起点 x=0）
 */
function walkStraight(options: { speedLimit: number; ticks: number }): Array<{ x: number; speed: number }> {
  const frames: Array<{ x: number; speed: number }> = [];
  let position = { x: 0, y: 0 };
  let speed = 0;
  // 目标点放得很远：让"刹车约束"不介入，测的纯粹是速度带与步幅
  const target = { x: options.speedLimit * 100, y: 0 };
  for (let index = 0; index < options.ticks; index += 1) {
    const next = stepToward({
      from: position,
      to: target,
      speedLimit: options.speedLimit,
      accel: MOTION.accelDipPerSec2,
      currentSpeed: speed,
      dtMs: MOTION.tickMs,
    });
    position = { x: next.x, y: next.y };
    speed = next.speed;
    frames.push({ x: next.x, speed: next.speed });
  }
  return frames;
}

test('周期实读：walk 440ms（4 帧×110）、run 540ms（6 帧×90），且左右朝向一致', () => {
  const walk = cycleMsOf('walk');
  const run = cycleMsOf('run');
  assert.equal(walk, 440, `walk 周期应为 440ms，实测 ${walk}ms`);
  assert.equal(run, 540, `run 周期应为 540ms，实测 ${run}ms`);
  // 跑的动作周期与走不同是正常的（帧数多、每帧短）；这里只钉"各自左右一致"（上面已断言）
  assert.notEqual(walk, run);
});

test('G-M8 步幅匹配：walk 每周期位移 ∈ [20,48] DIP，run ∈ [64,144] DIP', () => {
  const walkCycle = cycleMsOf('walk');
  const runCycle = cycleMsOf('run');
  const strideOf = (speed: number, cycleMs: number): number => (speed * cycleMs) / 1000;

  for (const speed of [MOTION.walkMinDipPerSec, MOTION.walkMaxDipPerSec]) {
    const stride = strideOf(speed, walkCycle);
    assert.ok(
      stride >= 20 && stride <= 48,
      `walk 步幅 ${stride.toFixed(1)} DIP ∉ [20,48]（速度 ${speed} DIP/s × 周期 ${walkCycle}ms）：` +
        '要么速度带改了没同步动画，要么动画时长改了没同步速度——两者必须同时对',
    );
  }
  for (const speed of [MOTION.runMinDipPerSec, MOTION.runMaxDipPerSec]) {
    const stride = strideOf(speed, runCycle);
    assert.ok(
      stride >= 64 && stride <= 144,
      `run 步幅 ${stride.toFixed(1)} DIP ∉ [64,144]（速度 ${speed} DIP/s × 周期 ${runCycle}ms）`,
    );
  }
});

test('两个速度带不重叠：走的最大速度 < 跑的最小速度（步态能从速度区分开）', () => {
  assert.ok(
    MOTION.walkMaxDipPerSec < MOTION.runMinDipPerSec,
    `walk 上限 ${MOTION.walkMaxDipPerSec} 必须严格小于 run 下限 ${MOTION.runMinDipPerSec}，否则同一速度两种步态都成立`,
  );
  // 减速比加速大是"停得住"的必要条件（与 MOTION 的注释一致，这里只做交叉验证）
  assert.ok(MOTION.decelDipPerSec2 > MOTION.accelDipPerSec2);
});

test('禁原地滑行（前提）：最慢走速换算到每拍位移 < 1 DIP ⇒ 必须浮点累加，不能先取整', () => {
  const perTick = (MOTION.walkMinDipPerSec * MOTION.tickMs) / 1000;
  assert.ok(
    perTick < 1,
    `每拍位移 ${perTick.toFixed(3)} DIP 应当 < 1（否则这条"必须浮点累加"的推理不成立，本用例需要更新）`,
  );
  // 走一整个 walk 周期：每一拍的位移都必须严格 > 0（任何一拍为 0 就是原地滑行）
  const frames = walkStraight({ speedLimit: MOTION.walkMinDipPerSec, ticks: 60 });
  for (let index = 1; index < frames.length; index += 1) {
    const delta = frames[index].x - frames[index - 1].x;
    assert.ok(
      delta > 0,
      `第 ${index} 拍位移为 ${delta}：低速下出现零位移拍 ⇒ 原地滑行（取整了累加基准）`,
    );
  }
  // 位置必须是浮点（不是整数网格）：取整累加会把 0.896 抹成 0
  const fractional = frames.some((frame) => !Number.isInteger(frame.x));
  assert.equal(fractional, true, '位置被取整成整数网格：浮点累加被破坏，低速会卡死');
});

test('稳态速度 = 速度档名义值，且每周期位移与步幅公式一致（走与跑各验一次）', () => {
  for (const gait of ['walk', 'run'] as const) {
    const speed = gait === 'walk' ? MOTION.walkMaxDipPerSec : MOTION.runMinDipPerSec;
    const cycleMs = gait === 'walk' ? 440 : 540;
    const ticksPerCycle = Math.round(cycleMs / MOTION.tickMs);
    const frames = walkStraight({ speedLimit: speed, ticks: ticksPerCycle * 2 });
    const steady = frames[frames.length - 1].speed;
    assert.ok(
      Math.abs(steady - speed) < 1e-6,
      `${gait} 稳态速度 ${steady} ≠ 名义值 ${speed}（加速段还没走完就取样了？）`,
    );
    const perTick = (speed * MOTION.tickMs) / 1000;
    const perCycle = perTick * ticksPerCycle;
    const formulaStride = (speed * cycleMs) / 1000;
    // 周期不是拍长的整数倍（440 / 16 = 27.5），所以"整数拍走完一个周期"会多/少不到一拍的位移。
    // 容差就取"一拍位移"：超过它才说明速度与周期真的对不上。
    const tolerance = perTick + 1e-6;
    assert.ok(
      Math.abs(perCycle - formulaStride) <= tolerance,
      `${gait} 每周期位移 ${perCycle.toFixed(3)} 与步幅公式 ${formulaStride.toFixed(3)} 相差超过一拍位移（${perTick.toFixed(3)}）`,
    );
    // 最后再确认一次：每周期位移落在设计给的步幅带里
    const band = gait === 'walk' ? [20, 48] : [64, 144];
    assert.ok(
      perCycle >= band[0] && perCycle <= band[1],
      `${gait} 每周期位移 ${perCycle.toFixed(1)} ∉ [${band[0]},${band[1]}]`,
    );
  }
});

test('步幅与速度的关系单调：速度越快，同一周期走的越远（不会被"跑更快但步幅更小"的配置弄反）', () => {
  const walkCycle = cycleMsOf('walk');
  const runCycle = cycleMsOf('run');
  const walkStride = (MOTION.walkMaxDipPerSec * walkCycle) / 1000;
  const runStride = (MOTION.runMinDipPerSec * runCycle) / 1000;
  assert.ok(
    runStride > walkStride,
    `跑的最小步幅 ${runStride.toFixed(1)} 必须大于走的最大步幅 ${walkStride.toFixed(1)}：` +
      '否则"跑"看起来比"走"还慢',
  );
});
