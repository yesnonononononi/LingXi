/**
 * M3 S1 · `electron/pet-motion.cjs` 的单测（纯运动学：**无 Electron、无定时器、无 I/O**）。
 *
 * <p><b>这个文件守的是什么：</b>M3 的手感参数只有一份真源（`MOTION`），运动学全部是纯函数。
 * 纯函数不靠"跑起来看观感"验收，靠**行为断言**：滞回带在中间不抖、低速时浮点累加不卡住、
 * 漫游目标让**整个窗口**留在工作区内。这三条正是历史上最容易"改坏了也没人红"的地方。</p>
 *
 * <p><b>刻意不在这里写死手感数值</b>：参数由主理人真机微调（U-M1），本文件只断言
 * **结构不变式**（滞回带宽度、降速快于加速、分档上下界合法）与**分组视图/扁平视图一致**。
 * 若某个数字被改动破坏这些不变式，用例自然红；若只是"手感调档"，不需要改测试。</p>
 *
 * <p>运行：`npm run test:pet`（node 直接跑）。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const motion = require(path.join(__dirname, '..', 'electron', 'pet-motion.cjs'));

const {
  MOTION,
  FOLLOW_PHASES,
  GAITS,
  decideFollowPhase,
  decideGait,
  stepToward,
  decideFacing,
  resolveRoamBounds,
  clampTargetToWorkArea,
  pickRoamTarget,
} = motion;

/** 浮点比较的容差（DIP 量级）。 */
const EPS = 1e-9;

/**
 * 造一个确定性的伪随机数发生器（线性同余），让"100 次采样"可复现。
 *
 * @param {number} seed 种子（整数）
 * @returns {() => number} 返回 `[0,1)` 的随机数
 */
function makeRng(seed) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/**
 * 按固定脚本返回一串值的假 rng（用于角落偏好分组断言）。
 *
 * @param {number[]} values 依次返回的值
 * @returns {() => number} 假 rng（取完即抛，防止调用方多取）
 */
function scriptedRng(values) {
  let index = 0;
  return () => {
    if (index >= values.length) {
      throw new Error(`[test] scriptedRng 被多取了一次（第 ${index + 1} 次）`);
    }
    const value = values[index];
    index += 1;
    return value;
  };
}

test('M01 · MOTION 是冻结的单一真源，且分组视图与扁平视图逐值一致', () => {
  assert.equal(Object.isFrozen(MOTION), true, 'MOTION 必须被 Object.freeze');
  assert.equal(Object.isFrozen(MOTION.walkSpeedDipPerSec), true, '嵌套对象也必须冻结');
  assert.equal(Object.isFrozen(MOTION.runSpeedDipPerSec), true, '嵌套对象也必须冻结');

  // 分组视图（任务书字段名）与扁平视图（设计 §3.3.3 字段名）只能是同一批数字的两个名字
  assert.equal(MOTION.walkSpeedDipPerSec.min, MOTION.walkMinDipPerSec);
  assert.equal(MOTION.walkSpeedDipPerSec.max, MOTION.walkMaxDipPerSec);
  assert.equal(MOTION.runSpeedDipPerSec.min, MOTION.runMinDipPerSec);
  assert.equal(MOTION.runSpeedDipPerSec.max, MOTION.runMaxDipPerSec);
  assert.equal(MOTION.facingHysteresisDip, MOTION.facingFlipHysteresisDip);

  // 结构不变式（G-M5 的同构断言；任一被改坏都说明滞回/降速失效）
  assert.ok(
    MOTION.followStartRadiusDip >= MOTION.followStopRadiusDip + 40,
    `滞回带太窄：start(${MOTION.followStartRadiusDip}) 至少要 stop(${MOTION.followStopRadiusDip}) + 40`,
  );
  assert.ok(
    MOTION.gaitRunRadiusDip >= MOTION.gaitWalkRadiusDip + 30,
    `步态双阈值太近：run(${MOTION.gaitRunRadiusDip}) 至少要 walk(${MOTION.gaitWalkRadiusDip}) + 30`,
  );
  assert.ok(MOTION.decelDipPerSec2 > MOTION.accelDipPerSec2, '减速度必须大于加速度（否则停不住）');
  assert.ok(MOTION.walkMinDipPerSec < MOTION.walkMaxDipPerSec, '走速带上下界必须有序');
  assert.ok(MOTION.runMinDipPerSec < MOTION.runMaxDipPerSec, '跑速带上下界必须有序');
  assert.ok(MOTION.walkMaxDipPerSec < MOTION.runMinDipPerSec, '走速上限必须低于跑速下限（两档要分得开）');
  assert.ok(MOTION.roamMinIntervalMs > 0 && MOTION.roamMinIntervalMs <= MOTION.roamMaxIntervalMs);
  assert.ok(MOTION.roamDwellMs > 0 && MOTION.roamMaxDurationMs > 0 && MOTION.roamMarginDip > 0);
  assert.ok(MOTION.roamCornerBias >= 0 && MOTION.roamCornerBias <= 1);
  assert.ok(MOTION.tickMs > 0 && Number.isInteger(MOTION.tickMs), 'tickMs 必须是正整数（与命中轮询同一拍）');

  // 冻结是**真**冻结：Reflect.set 必须失败且值不变（本文件不在 strict 模式下，
  // 直接用赋值在非严格代码里是静默失败，所以用 Reflect.set 的返回值断言）
  assert.equal(Reflect.set(MOTION, 'followStopRadiusDip', 1), false, '冻结对象必须拒绝写入');
  assert.notEqual(MOTION.followStopRadiusDip, 1, '冻结对象的值不许被改写');
});

test('M02 · 滞回带四态：进入即停 / 带内保持 / 越过启动半径才重追 / 95 仍停', () => {
  const start = MOTION.followStartRadiusDip; // 220
  const stop = MOTION.followStopRadiusDip; // 96

  // 正在追，进入停止半径 ⇒ 到达（用 stop 派生，避免把"96"抄成第二份真源）
  assert.equal(decideFollowPhase({ distanceDip: stop, phase: 'chase' }), 'arrived');
  assert.equal(decideFollowPhase({ distanceDip: stop - 1, phase: 'chase' }), 'arrived');
  // 已到达，距离落在滞回带内 ⇒ **保持 arrived**（不许抖回 chase）
  assert.equal(decideFollowPhase({ distanceDip: 150, phase: 'arrived' }), 'arrived');
  // 越过启动半径 ⇒ 重新追
  assert.equal(decideFollowPhase({ distanceDip: 221, phase: 'arrived' }), 'chase');
  assert.equal(decideFollowPhase({ distanceDip: start + 1, phase: 'arrived' }), 'chase');
  // 已到达，距离 95 ⇒ 仍在停止半径内，保持 arrived
  assert.equal(decideFollowPhase({ distanceDip: 95, phase: 'arrived' }), 'arrived');
  // 正在追、距离 100：**已越过停止半径**（默认 96），所以继续追——这是滞回带之外的常态，
  // 也说明"进入才停"是 stop 半径决定的，不是"小于启动半径就停"
  assert.equal(decideFollowPhase({ distanceDip: 100, phase: 'chase' }), 'chase');
  // 空闲态：只有越过启动半径才起追
  assert.equal(decideFollowPhase({ distanceDip: start, phase: 'idle' }), 'chase');
  assert.equal(decideFollowPhase({ distanceDip: start - 1, phase: 'idle' }), 'idle');
  assert.ok(stop < 100 && start > 150, '前提：停止半径 < 100 < 150 < 启动半径（否则上面几条语义不成立）');
});

test('M03 · 滞回带边界 ±1px 抖动 200 次：相位翻转数必须为 0', () => {
  const stop = MOTION.followStopRadiusDip;
  let phase = 'chase';
  // 先落到 arrived
  phase = decideFollowPhase({ distanceDip: stop, phase });
  assert.equal(phase, 'arrived');

  let flips = 0;
  let previous = phase;
  for (let index = 0; index < 200; index += 1) {
    // 在停止半径两侧各 ±1 DIP 抖动：没有滞回的实现会每拍翻一次
    const distanceDip = index % 2 === 0 ? stop + 1 : stop - 1;
    phase = decideFollowPhase({ distanceDip, phase });
    if (phase !== previous) flips += 1;
    previous = phase;
  }
  assert.equal(flips, 0, `滞回带失效：边界 ±1px 抖动 200 次出现 ${flips} 次翻转（应恒为 0）`);
  assert.equal(phase, 'arrived');
});

test('M04 · decideFollowPhase 参数校验：非法 phase / 负距离 / 倒置滞回带都抛', () => {
  assert.throws(() => decideFollowPhase({ distanceDip: 10, phase: 'run' }), TypeError);
  assert.throws(() => decideFollowPhase({ distanceDip: -1, phase: 'idle' }), RangeError);
  assert.throws(() => decideFollowPhase({ distanceDip: Number.NaN, phase: 'idle' }), TypeError);
  assert.throws(
    () => decideFollowPhase({ distanceDip: 10, phase: 'idle', followStartRadiusDip: 100, followStopRadiusDip: 100 }),
    RangeError,
  );
  assert.throws(() => decideFollowPhase(null), TypeError);
  assert.deepEqual([...FOLLOW_PHASES], ['idle', 'chase', 'arrived']);
});

test('M05 · 步态双阈值滞回：≥run 跑、<walk 走、中间带保持现相', () => {
  const run = MOTION.gaitRunRadiusDip; // 420
  const walk = MOTION.gaitWalkRadiusDip; // 320

  assert.equal(decideGait({ distanceDip: run, currentGait: 'walk' }), 'run');
  assert.equal(decideGait({ distanceDip: run - 1, currentGait: 'run' }), 'run', '中间带必须保持 run');
  assert.equal(decideGait({ distanceDip: walk - 1, currentGait: 'run' }), 'walk', '低于 walk 阈值必须退回走');
  assert.equal(decideGait({ distanceDip: walk, currentGait: 'walk' }), 'walk', '正好在 walk 阈值仍算走');
  assert.equal(decideGait({ distanceDip: walk + 1, currentGait: 'walk' }), 'walk', '中间带必须保持 walk');

  // 中间带来回抖动 100 次：只要现相不被外部改写，步态不翻
  let gait = 'walk';
  let flips = 0;
  for (let index = 0; index < 100; index += 1) {
    const distanceDip = index % 2 === 0 ? walk + 1 : round(walk + run) / 2;
    const next = decideGait({ distanceDip, currentGait: gait });
    if (next !== gait) flips += 1;
    gait = next;
  }
  assert.equal(flips, 0, `步态双阈值失效：中间带抖动出现 ${flips} 次翻转`);

  assert.deepEqual([...GAITS], ['walk', 'run']);
  assert.throws(() => decideGait({ distanceDip: 10, currentGait: 'none' }), TypeError);
  assert.throws(() => decideGait({ distanceDip: -5 }), RangeError);
  assert.throws(() => decideGait({ distanceDip: 10, gaitRunRadiusDip: 100, gaitWalkRadiusDip: 300 }), RangeError);
});

/**
 * 四舍五入到整数（只在本文件的构造性断言里用）。
 *
 * @param {number} value 数值
 * @returns {number} 取整结果
 */
function round(value) {
  return Math.round(value);
}

test('M06 · 朝向滞回：|dx| ≤ 24 不翻向，超过才翻', () => {
  const hysteresis = MOTION.facingFlipHysteresisDip; // 24

  // 当前面朝左（-1），光标在右侧但没超过滞回 ⇒ 不翻
  assert.equal(decideFacing({ dx: hysteresis, currentFacing: -1 }), -1);
  assert.equal(decideFacing({ dx: hysteresis - 1, currentFacing: -1 }), -1);
  assert.equal(decideFacing({ dx: -hysteresis, currentFacing: 1 }), 1);
  // 超过滞回 ⇒ 翻
  assert.equal(decideFacing({ dx: hysteresis + 1, currentFacing: -1 }), 1);
  assert.equal(decideFacing({ dx: -(hysteresis + 1), currentFacing: 1 }), -1);
  // 同向时永远是同一个值（不因为正面/负面而翻）
  assert.equal(decideFacing({ dx: hysteresis + 100, currentFacing: 1 }), 1);
  assert.equal(decideFacing({ dx: -(hysteresis + 100), currentFacing: -1 }), -1);

  // 在 ±滞回带内抖 200 次：朝向翻转数必须为 0
  let facing = -1;
  let flips = 0;
  for (let index = 0; index < 200; index += 1) {
    const dx = index % 2 === 0 ? hysteresis : -hysteresis;
    const next = decideFacing({ dx, currentFacing: facing });
    if (next !== facing) flips += 1;
    facing = next;
  }
  assert.equal(flips, 0, `朝向滞回失效：±${hysteresis} 内抖动出现 ${flips} 次翻向`);

  assert.throws(() => decideFacing({ dx: 0, currentFacing: 0 }), TypeError);
  assert.throws(() => decideFacing({ dx: Number.NaN }), TypeError);
  assert.throws(() => decideFacing({ dx: 0, hysteresisDip: -1 }), RangeError);
});

test('M07 · stepToward：到达即吸附、不冲过头、速度为 0 且 arrived 只由距离决定', () => {
  const result = stepToward({
    from: { x: 0, y: 0 },
    to: { x: 100, y: 0 },
    speedLimit: MOTION.walkMaxDipPerSec,
    accel: MOTION.accelDipPerSec2,
    dtMs: MOTION.tickMs,
  });
  assert.ok(result.x > 0 && result.x < 100, `首拍应推进但不到达，实际 x=${result.x}`);
  assert.equal(result.arrived, false);

  // 一步跨过目标：必须精确落到目标点、速度归零、宣布到达（不许"越过再回弹"）
  const reached = stepToward({
    from: { x: 99, y: 0 },
    to: { x: 100, y: 0 },
    speedLimit: MOTION.runMaxDipPerSec,
    accel: MOTION.accelDipPerSec2,
    currentSpeed: MOTION.runMaxDipPerSec,
    dtMs: MOTION.tickMs,
  });
  assert.deepEqual(reached, { x: 100, y: 0, speed: 0, arrived: true });
  // 已经在目标点：立刻 arrived
  assert.deepEqual(
    stepToward({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, speedLimit: 96, accel: 480, dtMs: 16 }),
    { x: 5, y: 5, speed: 0, arrived: true },
  );
  // 时钟没走（dtMs=0）：位置不变，且**不许**因为速度 0 就宣布到达
  const frozen = stepToward({ from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, speedLimit: 96, accel: 480, dtMs: 0 });
  assert.equal(frozen.arrived, false);
  assert.equal(frozen.x, 0);
});

test('M08 · stepToward：速度上限恒不被越过（含加速段）', () => {
  const limit = MOTION.walkMaxDipPerSec;
  let position = { x: 0, y: 0 };
  let speed = 0;
  for (let index = 0; index < 60; index += 1) {
    const step = stepToward({
      from: position,
      to: { x: 5000, y: 0 },
      speedLimit: limit,
      accel: MOTION.accelDipPerSec2,
      currentSpeed: speed,
      dtMs: MOTION.tickMs,
    });
    assert.ok(step.speed <= limit + EPS, `第 ${index} 拍速度 ${step.speed} 超过上限 ${limit}`);
    assert.ok(step.x >= position.x, '位置不许倒退');
    position = { x: step.x, y: step.y };
    speed = step.speed;
  }
  assert.ok(speed > limit * 0.9, `加速 60 拍后应接近上限，实际 ${speed}`);
});

test('M09 · stepToward：低速（0.6 DIP/拍）必须能累积前进，不许被取整卡住', () => {
  // speed 37.5 DIP/s × 16ms = 0.6 DIP/拍。accel 取足够大，让首拍就达到限定速度。
  const speedLimit = 37.5;
  const accel = 1e6;
  const perTick = (speedLimit * MOTION.tickMs) / 1000;
  assert.ok(Math.abs(perTick - 0.6) < 1e-9, `前提：每拍位移应为 0.6 DIP，实际 ${perTick}`);

  let position = { x: 0, y: 0 };
  let speed = 0;
  const ticks = 100;
  for (let index = 0; index < ticks; index += 1) {
    const step = stepToward({
      from: position,
      to: { x: 10000, y: 0 },
      speedLimit,
      accel,
      currentSpeed: speed,
      dtMs: MOTION.tickMs,
    });
    position = { x: step.x, y: step.y };
    speed = step.speed;
  }
  const expected = perTick * ticks;
  assert.ok(
    Math.abs(position.x - expected) < 1,
    `低速累积误差过大：100 拍后应在 ${expected} 附近，实际 ${position.x}（先取整再累加就会偏）`,
  );

  // 更极端：0.4 DIP/拍（取整后每拍都是 0 ⇒ 永久卡死）
  const slowLimit = 25; // 25 × 0.016 = 0.4
  assert.ok(Math.abs((slowLimit * MOTION.tickMs) / 1000 - 0.4) < 1e-9);
  let slowPosition = { x: 0, y: 0 };
  let slowSpeed = 0;
  for (let index = 0; index < 50; index += 1) {
    const step = stepToward({
      from: slowPosition,
      to: { x: 10000, y: 0 },
      speedLimit: slowLimit,
      accel,
      currentSpeed: slowSpeed,
      dtMs: MOTION.tickMs,
    });
    slowPosition = { x: step.x, y: step.y };
    slowSpeed = step.speed;
  }
  assert.ok(slowPosition.x > 19, `低速卡死：50 拍 × 0.4 DIP 应前进约 20 DIP，实际 ${slowPosition.x}`);
});

test('M10 · stepToward：斜向移动保持共线（不产生横向漂移）', () => {
  const from = { x: 10, y: 20 };
  const to = { x: 130, y: 220 };
  const result = stepToward({ from, to, speedLimit: 200, accel: MOTION.accelDipPerSec2, dtMs: MOTION.tickMs });
  // 起点→终点 与 起点→新位置 必须同向（叉积为 0）
  const cross = (to.x - from.x) * (result.y - from.y) - (to.y - from.y) * (result.x - from.x);
  assert.ok(Math.abs(cross) < 1e-6, `斜向移动偏离直线：叉积 ${cross}`);
});

test('M11 · stepToward 参数校验：非点 / 负速度 / 非正加速度 / 负 dt 都抛', () => {
  assert.throws(() => stepToward(null), TypeError);
  assert.throws(() => stepToward({ from: { x: 0 }, to: { x: 1, y: 1 }, speedLimit: 10, accel: 1, dtMs: 16 }), TypeError);
  assert.throws(
    () => stepToward({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, speedLimit: -1, accel: 1, dtMs: 16 }),
    RangeError,
  );
  assert.throws(
    () => stepToward({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, speedLimit: 10, accel: 0, dtMs: 16 }),
    RangeError,
  );
  assert.throws(
    () => stepToward({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, speedLimit: 10, accel: 1, dtMs: -1 }),
    RangeError,
  );
  assert.throws(
    () => stepToward({ from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, speedLimit: 10, accel: 1, currentSpeed: -1, dtMs: 16 }),
    RangeError,
  );
});

test('M12 · pickRoamTarget：100 次采样都让**整个窗口**落在 workArea 内', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  // 故意用非对称窗口尺寸，防止"拿宽当高"的笔误被对称数据掩盖
  const windowSize = { width: 268, height: 348 };
  const margin = MOTION.roamMarginDip;
  const rng = makeRng(20261107);

  for (let index = 0; index < 100; index += 1) {
    const target = pickRoamTarget({ workArea, windowSize, rng });
    assert.ok(Number.isFinite(target.x) && Number.isFinite(target.y), `第 ${index} 次目标点非有限值`);
    // 整窗判据：左上角在 [area+margin]，右下角不越过 area 的另一侧 margin
    assert.ok(
      target.x >= workArea.x + margin - EPS,
      `第 ${index} 次左边越界：x=${target.x} < ${workArea.x + margin}`,
    );
    assert.ok(
      target.x + windowSize.width <= workArea.x + workArea.width - margin + EPS,
      `第 ${index} 次右边越界：x+width=${target.x + windowSize.width} > ${workArea.x + workArea.width - margin}`,
    );
    assert.ok(
      target.y >= workArea.y + margin - EPS,
      `第 ${index} 次上边越界：y=${target.y} < ${workArea.y + margin}`,
    );
    assert.ok(
      target.y + windowSize.height <= workArea.y + workArea.height - margin + EPS,
      `第 ${index} 次下边越界：y+height=${target.y + windowSize.height} > ${workArea.y + workArea.height - margin}`,
    );
  }
});

test('M13 · pickRoamTarget：rng < cornerBias 时只从四角内缩点里挑', () => {
  const workArea = { x: 100, y: 50, width: 1600, height: 900 };
  const windowSize = { width: 268, height: 348 };
  const bounds = resolveRoamBounds({ workArea, windowSize });
  const corners = [
    `${bounds.minX},${bounds.minY}`,
    `${bounds.maxX},${bounds.minY}`,
    `${bounds.minX},${bounds.maxY}`,
    `${bounds.maxX},${bounds.maxY}`,
  ];

  // 第 1 次 0.1 < 0.5 ⇒ 走角落分支；第 2 次决定角序号（0.0 / 0.25 / 0.5 / 0.75 → 四角）
  const picks = [0, 0.25, 0.5, 0.75].map((selector) =>
    pickRoamTarget({ workArea, windowSize, rng: scriptedRng([0.1, selector]) }),
  );
  picks.forEach((target, index) => {
    assert.equal(`${target.x},${target.y}`, corners[index], `第 ${index} 个角不匹配：${JSON.stringify(target)}`);
  });

  // 第 1 次 0.9 ≥ 0.5 ⇒ 走均匀分支（两次随机各自给 x/y），且整窗仍在内
  const uniform = pickRoamTarget({ workArea, windowSize, rng: scriptedRng([0.9, 0.5, 0.5]) });
  assert.ok(uniform.x > bounds.minX && uniform.x < bounds.maxX, `均匀分支 x 应在区间内，实际 ${uniform.x}`);
  assert.ok(uniform.y > bounds.minY && uniform.y < bounds.maxY, `均匀分支 y 应在区间内，实际 ${uniform.y}`);

  // cornerBias=1 ⇒ 必定挑角；cornerBias=0 ⇒ 必定不挑角
  const alwaysCorner = pickRoamTarget({ workArea, windowSize, rng: scriptedRng([0.999, 0]), cornerBias: 1 });
  assert.ok(corners.includes(`${alwaysCorner.x},${alwaysCorner.y}`), 'bias=1 必须挑角');
  const neverCorner = pickRoamTarget({ workArea, windowSize, rng: scriptedRng([0.0, 0.3, 0.3]), cornerBias: 0 });
  assert.ok(!corners.includes(`${neverCorner.x},${neverCorner.y}`), 'bias=0 不许挑角');
});

test('M14 · pickRoamTarget / resolveRoamBounds：极小屏也保证整窗在工作区内', () => {
  // 工作区比"窗口 + 2×margin"还窄：边距自动缩小到"刚好能放下整窗"，仍不许越界
  const workArea = { x: 0, y: 0, width: 300, height: 400 };
  const windowSize = { width: 268, height: 348 };
  const bounds = resolveRoamBounds({ workArea, windowSize });
  // slackX = 300-268 = 32 ⇒ marginX = min(48, 16) = 16；slackY = 400-348 = 52 ⇒ marginY = min(48,26)=26
  assert.deepEqual(bounds, { minX: 16, maxX: 16, minY: 26, maxY: 26 });
  const target = pickRoamTarget({ workArea, windowSize, rng: scriptedRng([0.9, 0.999999, 0.999999]) });
  assert.ok(target.x + windowSize.width <= workArea.x + workArea.width + EPS, '极小屏右边越界');
  assert.ok(target.y + windowSize.height <= workArea.y + workArea.height + EPS, '极小屏下边越界');
  assert.ok(target.x >= workArea.x, '极小屏左边越界');
  assert.ok(target.y >= workArea.y, '极小屏上边越界');

  // 窗口比工作区还大：只能贴左上角（仍然不越界，也不抛）
  const tiny = resolveRoamBounds({ workArea: { x: 0, y: 0, width: 200, height: 200 }, windowSize });
  assert.deepEqual(tiny, { minX: 0, maxX: 0, minY: 0, maxY: 0 });
});

test('M15 · clampTargetToWorkArea：夹的是**整窗**（不是只夹中心点）', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const windowSize = { width: 268, height: 348 };
  const clamped = clampTargetToWorkArea({ workArea, windowSize, target: { x: 5000, y: 5000 } });
  assert.ok(clamped.x + windowSize.width <= workArea.width + EPS, `右下角越界：${clamped.x}`);
  assert.ok(clamped.y + windowSize.height <= workArea.height + EPS, `右下角越界：${clamped.y}`);
  const clampedLeft = clampTargetToWorkArea({ workArea, windowSize, target: { x: -5000, y: -5000 } });
  assert.ok(clampedLeft.x >= 0 && clampedLeft.y >= 0, '左上角越界');
  // 已经在区间内的点不许被移动
  const inside = { x: 600, y: 300 };
  assert.deepEqual(clampTargetToWorkArea({ workArea, windowSize, target: inside }), inside);
});

test('M16 · pickRoamTarget / stepToward 的入参校验：坏 rng / 坏 cornerBias / 坏几何都抛', () => {
  const workArea = { x: 0, y: 0, width: 800, height: 600 };
  const windowSize = { width: 268, height: 348 };
  assert.throws(() => pickRoamTarget({ workArea, windowSize, rng: 'nope' }), TypeError);
  assert.throws(() => pickRoamTarget({ workArea, windowSize, rng: () => 1.5 }), RangeError);
  assert.throws(() => pickRoamTarget({ workArea, windowSize, cornerBias: 2 }), RangeError);
  assert.throws(() => pickRoamTarget({ workArea: { x: 0, y: 0, width: -1, height: 10 }, windowSize }), TypeError);
  assert.throws(() => resolveRoamBounds({ workArea, windowSize, marginDip: -1 }), RangeError);
  assert.throws(() => clampTargetToWorkArea({ workArea, windowSize, target: null }), TypeError);
});
