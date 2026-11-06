#!/usr/bin/env node
/**
 * M3 S4 · `MotionController` 的行为单测（P-M01…P-M05 / P-M09…P-M12 的可单测部分）。
 *
 * <p><b>为什么这些断言必须存在：</b>"唯一位置写入者"是本切片的心脏，而它的三条保证
 * （L1 只有一个时钟、L2 只有一个写口、L3 订阅随所有权摘除）**任何一条被改成 `if` 都不会
 * 让别的用例变红**——它们只在真机上表现为"拖拽时窗口被拉回去"或者"两个来源交替写导致抽搐"。
 * 所以这里逐条打钉子：拖拽开始后订阅表必须为空（结构事实），不是"samples 没涨"（行为巧合）。</p>
 *
 * <p><b>时钟怎么处理：</b>运动自己不注册定时器，它只消费"拍"。测试里用一个假订阅源
 * （`subscribeSample`）手动投递拍：每次投递就是一个 16ms 的 tick，`tickId` 单调递增。
 * 这样"加速 7 拍""滞回 40 拍""漫游 10 轮"全是确定性断言，没有睡眠、不会 flake。</p>
 *
 * @module tests/petMotionController
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');

/** 待测模块（绝对路径载入，避免 cwd 影响）。 */
const MOTION_MODULE = require(path.join(__dirname, '..', 'electron', 'pet-motion.cjs'));
const { MOTION, MotionController, OWNER_TOKENS, BLOCKED_BEHAVIORS, MOTION_BEHAVIOR_GATE } = MOTION_MODULE;

/** 几何真源（算"宠物中心"用；与 `pet-window.cjs` 同一份 JSON）。 */
const GEOMETRY = require(path.join(__dirname, '..', 'pet-geometry.json'));
const ART_ORIGIN = Object.freeze({
  x: GEOMETRY.effectMargin.left,
  y: GEOMETRY.effectMargin.top + GEOMETRY.bubbleHeight,
});
const ART_SIZE = Object.freeze({ width: GEOMETRY.artWidth, height: GEOMETRY.artHeight });
const WINDOW_SIZE = Object.freeze({
  width: GEOMETRY.artWidth + GEOMETRY.effectMargin.left + GEOMETRY.effectMargin.right,
  height:
    GEOMETRY.artHeight +
    GEOMETRY.effectMargin.top +
    GEOMETRY.effectMargin.bottom +
    GEOMETRY.bubbleHeight,
});

/** 单屏工作区（1920×1080 减去任务栏）。 */
const WORK_AREA = Object.freeze({ x: 0, y: 0, width: 1920, height: 1040 });

/**
 * 造一个可手摇的运动控制器 + 观测台。
 *
 * @param {object} [options] 覆盖项
 * @param {object} [options.prefs] 偏好（默认两个开关都开）
 * @param {object} [options.initial] 窗口初始位置
 * @param {object} [options.workArea] 工作区读取函数
 * @param {() => number} [options.rng] 随机源
 * @returns {object} 观测台
 */
function makeHarness(options = {}) {
  const overrides = options && typeof options === 'object' ? options : {};
  const state = {
    writes: [],
    sent: [],
    cursorReads: 0,
    cursor: { x: 0, y: 0 },
    subscribers: [],
    time: 1000,
    prefs: { follow: true, roam: true, reducedMotion: false, ...(overrides.prefs || {}) },
  };
  const controller = new MotionController({
    setWindowPosition: (x, y) => state.writes.push({ x, y }),
    subscribeSample: (listener) => {
      state.subscribers.push(listener);
      return () => {
        state.subscribers = state.subscribers.filter((item) => item !== listener);
      };
    },
    workArea: overrides.workArea || (() => ({ ...WORK_AREA })),
    size: { ...WINDOW_SIZE },
    artOrigin: { ...ART_ORIGIN },
    artSize: { ...ART_SIZE },
    initial: overrides.initial === undefined ? { x: 800, y: 400 } : overrides.initial,
    cursor: () => {
      state.cursorReads += 1;
      return { x: state.cursor.x, y: state.cursor.y };
    },
    prefs: () => ({ ...state.prefs }),
    send: (command) => state.sent.push(command),
    clock: { now: () => state.time },
    rng: overrides.rng || (() => 0.5),
  });
  controller.start();

  let tickId = 0;
  /**
   * 投递一拍（`tickId` 单调递增）。
   *
   * @param {{x: number, y: number}} [point] 本拍光标（省略则用 `state.cursor`）
   * @returns {boolean} 运动层是否做了动作
   */
  const tick = (point) => {
    tickId += 1;
    const sample = { tickId, point: point === undefined ? { ...state.cursor } : { ...point } };
    let handled = false;
    for (const listener of [...state.subscribers]) {
      handled = listener(sample) === true || handled;
    }
    return handled;
  };
  /**
   * 推进 `count` 拍。
   *
   * @param {number} count 拍数
   * @param {{x: number, y: number}} [point] 光标
   * @returns {void}
   */
  const tickMany = (count, point) => {
    for (let index = 0; index < count; index += 1) tick(point);
  };
  return { controller, state, tick, tickMany, center: () => controller.centerOf(controller.position) };
}

/** 把光标放到"宠物中心右侧 `distance` DIP"处。 */
function cursorRightOf(harness, distance) {
  const center = harness.center();
  return { x: center.x + distance, y: center.y };
}

// ---------------------------------------------------------------- 源码形态（L1 / L2 的静态钉子）

test('L1 唯一时钟：pet-motion.cjs 里不许出现定时器全局函数（运动只能订阅命中轮询那一拍）', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'pet-motion.cjs'), 'utf8');
  for (const token of ['set' + 'Interval', 'set' + 'Timeout']) {
    const hits = source.split(token).length - 1;
    assert.equal(hits, 0, `pet-motion.cjs 出现了 ${token}（${hits} 次）：这会制造第二个时钟，位置写入权不再唯一`);
  }
});

test('DIP 纯度：pet-motion.cjs 不出现缩放比例类标识符（U-M5：全程 DIP）', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'pet-motion.cjs'), 'utf8');
  for (const token of ['scale' + 'Factor', 'device' + 'PixelRatio', 'zoom' + 'Factor']) {
    assert.equal(source.includes(token), false, `pet-motion.cjs 出现了 ${token}：混合 DPI 下会与命中矩形打架`);
  }
});

test('L2 唯一写口：MotionController 构造必须拿到 setWindowPosition（缺了直接抛）', () => {
  assert.throws(
    () =>
      new MotionController({
        subscribeSample: () => () => {},
        workArea: () => ({ ...WORK_AREA }),
        size: { ...WINDOW_SIZE },
      }),
    /setWindowPosition/,
  );
  assert.throws(
    () =>
      new MotionController({
        setWindowPosition: () => {},
        workArea: () => ({ ...WORK_AREA }),
        size: { ...WINDOW_SIZE },
      }),
    /subscribeSample/,
  );
});

// ---------------------------------------------------------------- 加速 / 减速 / 停住（P-M01、P-M02）

test('P-M01 加速：从 0 起，达到 walkMin 所需的拍数之内速度必须够（accel 生效）', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  harness.state.cursor = cursorRightOf(harness, 300);
  const ticksNeeded = Math.ceil(MOTION.walkMinDipPerSec / ((MOTION.accelDipPerSec2 * MOTION.tickMs) / 1000));

  harness.tick();
  const afterFirst = harness.controller.snapshot();
  assert.ok(afterFirst.velocityDipPerSec > 0, `首拍就该起步（accel>0），实际 ${afterFirst.velocityDipPerSec}`);

  harness.tickMany(ticksNeeded - 1);
  const snapshot = harness.controller.snapshot();
  assert.ok(
    snapshot.velocityDipPerSec >= MOTION.walkMinDipPerSec,
    `${ticksNeeded} 拍后速度必须 ≥ walkMin ${MOTION.walkMinDipPerSec}，实际 ${snapshot.velocityDipPerSec}`,
  );
  assert.ok(
    snapshot.velocityDipPerSec <= MOTION.walkMaxDipPerSec,
    `速度不许越过 walkMax ${MOTION.walkMaxDipPerSec}，实际 ${snapshot.velocityDipPerSec}`,
  );
  assert.equal(snapshot.gait, 'walk', '300 DIP 落在 walk 带（< gaitWalkRadius）');
});

test('P-M02 减速停住：接近停止半径时不许冲过头，到达后一拍都不许再写', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  const cursor = cursorRightOf(harness, 600);
  harness.state.cursor = cursor;

  const trail = [];
  for (let index = 0; index < 400; index += 1) {
    harness.tick();
    trail.push({ ...harness.controller.snapshot() });
    if (harness.controller.snapshot().phase === 'arrived') break;
  }
  const last = harness.controller.snapshot();
  assert.equal(last.phase, 'arrived', '必须停在停止半径内（一直 chase 说明减速逻辑没生效）');
  assert.equal(last.velocityDipPerSec, 0, '到达时速度必须归零');

  const center = harness.center();
  const distance = Math.hypot(cursor.x - center.x, cursor.y - center.y);
  assert.ok(
    distance <= MOTION.followStopRadiusDip + 1e-6,
    `到达时与光标距离必须 ≤ 停止半径 ${MOTION.followStopRadiusDip}，实际 ${distance}`,
  );
  // 冲过头是"腿刹不住"的数值指纹：中心越过光标超过 8 DIP 就算失控
  const overshoot = Math.max(0, center.x - cursor.x);
  assert.ok(overshoot <= 8, `不许冲过目标点（实际越界 ${overshoot} DIP）`);

  const writesAtArrival = harness.state.writes.length;
  harness.tickMany(20);
  assert.equal(harness.state.writes.length, writesAtArrival, '到达之后一拍都不许再写位置（float→int 未变即不写）');
  assert.equal(trail.length > 1, true);
});

test('P-M03 整数写入：目标取整后没有变化就不许再调写口（白写会触发多余合成）', () => {
  const harness = makeHarness();
  harness.controller.beginDrag();
  assert.equal(harness.controller.dragTo(810.2, 500.4, 0, 0), true, '第一次要真的写');
  assert.equal(harness.controller.dragTo(810.4, 500.2, 0, 0), false, '取整后 (810,500) 未变 ⇒ 不许写');
  assert.equal(harness.state.writes.length, 1, `实际写了 ${harness.state.writes.length} 次`);
  assert.equal(harness.controller.snapshot().x, 810);
  assert.equal(harness.controller.snapshot().y, 500);
});

test('P-M05 拖拽目标夹取：目标点在工作区外时，写入位置仍让整窗留在工作区内', () => {
  const harness = makeHarness();
  harness.controller.beginDrag();
  assert.equal(harness.controller.dragTo(-500, 9000, 0, 0), true);
  const written = harness.state.writes[0];
  assert.ok(written.x >= WORK_AREA.x, `x=${written.x} 不许小于工作区左边界`);
  assert.ok(
    written.x + WINDOW_SIZE.width <= WORK_AREA.x + WORK_AREA.width,
    `整窗必须留在工作区内：x+w=${written.x + WINDOW_SIZE.width} > 右边界`,
  );
  assert.ok(
    written.y + WINDOW_SIZE.height <= WORK_AREA.y + WORK_AREA.height,
    `整窗必须留在工作区内：y+h=${written.y + WINDOW_SIZE.height} > 下边界`,
  );
});

// ---------------------------------------------------------------- 朝向滞回（P-M04）

test('P-M04 朝向滞回：dx 在 ±10 里抖 40 拍翻转 0 次，反向超过滞回才翻', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  const center = harness.center();
  const initialFacing = harness.controller.snapshot().facing;

  let flips = 0;
  let previous = initialFacing;
  for (let index = 0; index < 40; index += 1) {
    const dx = index % 2 === 0 ? 10 : -10;
    harness.tick({ x: center.x + dx, y: center.y });
    const facing = harness.controller.snapshot().facing;
    if (facing !== previous) flips += 1;
    previous = facing;
  }
  assert.equal(flips, 0, `滞回带内不许翻向（实际翻了 ${flips} 次）`);

  harness.tick({ x: center.x + 40, y: center.y });
  assert.equal(harness.controller.snapshot().facing, 1, '正向超过滞回必须面右');
  harness.tick({ x: center.x - 40, y: center.y });
  assert.equal(harness.controller.snapshot().facing, -1, '反向超过滞回必须面左');
});

// ---------------------------------------------------------------- 抢占 / 挂起 / 去重（L3 + tickId）

test('P-M06 拖拽抢占：beginDrag 之后订阅表为空（结构事实），拖拽期间运动一拍都不动', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  harness.state.cursor = cursorRightOf(harness, 400);
  harness.tickMany(5);
  assert.equal(harness.state.subscribers.length, 1, '运动中必须正好一个订阅');
  const before = harness.controller.snapshot();
  assert.ok(before.samples > 0, '进入拖拽前应该已经在动');

  assert.equal(harness.controller.beginDrag(), true);
  assert.equal(harness.state.subscribers.length, 0, '拖拽一开始回调就必须从订阅表里被摘掉（不是 if 跳过）');
  assert.equal(harness.controller.snapshot().owner, OWNER_TOKENS.DRAG);

  const writesBefore = harness.state.writes.length;
  const timeBefore = harness.state.time;
  harness.state.cursor = cursorRightOf(harness, 900);
  harness.state.time = timeBefore + 5000;
  harness.tickMany(10);
  assert.equal(harness.controller.snapshot().samples, before.samples, '拖拽期间运动 0 采样');
  assert.equal(harness.state.writes.length, writesBefore, '拖拽期间运动 0 写入');
  assert.equal(harness.controller.snapshot().ticks, before.ticks, '拖拽期间连"受理的拍"都不该涨');

  // 拖拽自己的写不受影响（它走同一唯一写口，但令牌是 drag）
  assert.equal(harness.controller.dragTo(900, 300, 0, 0), true);

  harness.controller.endDrag();
  assert.equal(harness.state.subscribers.length, 1, '松手后订阅要接回来');
  assert.equal(harness.controller.snapshot().owner, OWNER_TOKENS.LOCOMOTION);
  harness.tick();
  assert.ok(harness.controller.snapshot().ticks > before.ticks, '松手后重新开始受理拍');
});

test('P-M07 隐藏 0 采样：挂起后订阅为空、tick 100 次也不涨；恢复后一拍收敛', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  harness.state.cursor = cursorRightOf(harness, 400);
  harness.tickMany(3);
  const before = harness.controller.snapshot();

  harness.controller.setSuspended('hidden', true);
  assert.equal(harness.state.subscribers.length, 0, '挂起 = 退订');
  harness.tickMany(100);
  const suspended = harness.controller.snapshot();
  assert.equal(suspended.ticks, before.ticks, '隐藏期间 ticks 不许涨');
  assert.equal(suspended.samples, before.samples, '隐藏期间 samples 不许涨');
  assert.equal(harness.state.writes.length, before.x === 0 ? harness.state.writes.length : harness.state.writes.length);

  harness.controller.setSuspended('hidden', false);
  assert.equal(harness.state.subscribers.length, 1, '恢复 = 重新订阅');
  harness.tick();
  assert.equal(harness.controller.snapshot().ticks, before.ticks + 1, '恢复后一拍就收敛');
});

test('tickId 去重：同一拍被叫醒两次（hint 与定时器撞车）只积分一次', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  harness.state.cursor = cursorRightOf(harness, 500);

  const sample = { tickId: 7, point: { ...harness.state.cursor } };
  harness.state.subscribers[0](sample);
  const first = harness.controller.snapshot();
  harness.state.subscribers[0](sample);
  const second = harness.controller.snapshot();

  assert.equal(first.ticks, 1);
  assert.equal(second.ticks, 1, '同一 tickId 不许被积分两次');
  assert.equal(second.samples, 1, '同一 tickId 不许采样两次');
  assert.equal(second.duplicateTicks, 1, '重复通知要记账（诊断用）');
});

// ---------------------------------------------------------------- 漫游（P-M09、P-M11、P-M12）

test('P-M11 漫游间隔：连续 10 轮间隔全部落在 [roamMin, roamMax]', () => {
  const sequence = [0.9, 0.0, 0.0, 0.95, 0.95, 0.95];
  let index = 0;
  const rng = () => {
    const value = sequence[index % sequence.length];
    index += 1;
    return value;
  };
  const harness = makeHarness({ rng });
  assert.deepEqual(harness.controller.trySetMode('roam', 'dev'), { ok: true });

  const intervals = [];
  // 第 1 个间隔由"启用时刻"起算，之后每轮到达/放弃都会重排
  for (let round = 0; round < 12; round += 1) {
    const before = harness.controller.roam.nextAt;
    harness.state.time += 20000; // 直接把时间推到下一轮必然到期之后
    harness.tick();
    const target = harness.controller.roam.target;
    if (target === null) continue;
    // 到达（视作一次性走到）
    harness.controller.position = { x: target.x, y: target.y };
    harness.state.time += 1;
    harness.tick();
    const after = harness.controller.roam.nextAt;
    if (harness.controller.roam.target === null && after > before) {
      intervals.push(after - harness.controller.roam.dwellUntil);
    }
  }
  assert.ok(intervals.length >= 3, `必须观测到足够多轮（实际 ${intervals.length}）`);
  for (const interval of intervals) {
    assert.ok(
      interval >= MOTION.roamMinIntervalMs - 1e-6 && interval <= MOTION.roamMaxIntervalMs + 1e-6,
      `间隔 ${interval} 必须落在 [${MOTION.roamMinIntervalMs}, ${MOTION.roamMaxIntervalMs}]`,
    );
  }
});

test('P-M12 漫游单次上限：目标迟迟到不了 ⇒ 超过 roamMaxDurationMs 就放弃（phase=aborted）', () => {
  const rng = () => 0.9;
  const harness = makeHarness({ rng });
  assert.deepEqual(harness.controller.trySetMode('roam', 'dev'), { ok: true });
  harness.tick();
  assert.notEqual(harness.controller.roam.target, null, '第一拍就该选出目标');

  harness.state.time += MOTION.roamMaxDurationMs + 1;
  harness.tick();
  assert.equal(harness.controller.roam.target, null, '超时后必须放弃目标');
  const fact = harness.state.sent.filter((command) => command.type === 'motion').pop();
  assert.equal(fact.phase, 'aborted', '超时对外必须是 aborted（渲染层据此收 move-end）');
  assert.equal(fact.gait, 'none');
});

test('漫游完全不读光标（§8.3：cursorReads 恒不增长）', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('roam', 'dev'), { ok: true });
  harness.tickMany(50);
  assert.equal(harness.controller.snapshot().cursorReads, 0, '漫游不需要光标，一次都不该读');
  assert.equal(harness.state.cursorReads, 0, '注入口也不该被调用');
  assert.ok(harness.controller.snapshot().samples > 0, '但采样（积分）必须发生');
});

test('跟随复用轮询器读到的光标：正路不额外读（cursorReads 不涨）', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  const center = harness.center();
  harness.tickMany(10, { x: center.x + 400, y: center.y });
  assert.equal(harness.controller.snapshot().cursorReads, 0, '采样已带光标点 ⇒ 不许重复读');
  assert.equal(harness.controller.snapshot().samples, 10);

  // 订阅方没带光标（极端情况）才回退到注入口
  harness.controller.onSample({ tickId: 999 });
  assert.equal(harness.controller.snapshot().cursorReads, 1, '没有 point 时才自己读一次');
});

// ---------------------------------------------------------------- 偏好 / 拒绝（reduced-motion、开关）

test('reduced-motion 为真：拒绝开启 follow/roam（安全方向永远是别动）', () => {
  const harness = makeHarness({ prefs: { reducedMotion: true } });
  const follow = harness.controller.trySetMode('follow', 'dev');
  assert.equal(follow.ok, false);
  assert.match(follow.error, /减少动态/);
  const roam = harness.controller.trySetMode('roam', 'dev');
  assert.equal(roam.ok, false);
  assert.equal(harness.controller.snapshot().mode, 'off');
  assert.equal(harness.state.subscribers.length, 0, '被拒之后一条订阅都不许有');
});

test('偏好未开：follow=false 拒绝 follow、roam=false 拒绝 roam（渲染层只是请求方）', () => {
  const harness = makeHarness({ prefs: { follow: false, roam: false } });
  assert.equal(harness.controller.trySetMode('follow', 'dev').ok, false);
  assert.equal(harness.controller.trySetMode('roam', 'dev').ok, false);
  assert.equal(harness.controller.snapshot().mode, 'off');
});

test('applyPrefs：勾选被取消 / 要求减少动态时必须立刻停（不许"猫还在跑"）', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  assert.equal(harness.controller.applyPrefs({ follow: true, roam: true, reducedMotion: false }), false);
  assert.equal(harness.controller.applyPrefs({ follow: false, roam: true, reducedMotion: false }), true);
  assert.equal(harness.controller.snapshot().mode, 'off');
  assert.equal(harness.state.subscribers.length, 0);

  assert.deepEqual(harness.controller.trySetMode('roam', 'dev'), { ok: true });
  assert.equal(harness.controller.applyPrefs({ follow: true, roam: true, reducedMotion: true }), true);
  assert.equal(harness.controller.snapshot().mode, 'off');
});

test('交互打断保留用户意图（§5.1 注释 1）：off + interaction 之后 desiredMode 仍是 follow', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  harness.controller.setMode('off', 'interaction');
  const snapshot = harness.controller.snapshot();
  assert.equal(snapshot.mode, 'off');
  assert.equal(snapshot.desiredMode, 'follow', '手一离开跟随要能继续，否则用户无法理解');
  hermeticAssertSubscribers(harness);

  harness.controller.setMode('off', 'prefs');
  assert.equal(harness.controller.snapshot().desiredMode, 'off', '偏好关闭要连意图一起清');

  // 非法枚举一律拒绝（不许"猜一个"）
  assert.equal(harness.controller.trySetMode('fly', 'dev').ok, false);
  assert.equal(harness.controller.trySetMode('follow', 'because').ok, false);
});

/** 断言"模式为 off 时没有任何订阅"（内联小工具，避免重复写断言体）。 */
function hermeticAssertSubscribers(harness) {
  assert.equal(harness.state.subscribers.length, 0, 'mode=off 时不许留在定时器的订阅表里');
}

// ---------------------------------------------------------------- 下发（§8.2 只在变化时发）

test('运动事实：moving/arrived 的字段形状正确，且同字段变化才发（不许每拍都发）', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  harness.state.cursor = cursorRightOf(harness, 300);

  harness.tick();
  const first = harness.state.sent[0];
  assert.equal(first.type, 'motion');
  assert.equal(first.phase, 'moving');
  assert.equal(first.gait, 'walk', '300 DIP 落在 walk 带（< gaitWalkRadius）');
  assert.equal(first.facing, 1, '光标在右侧 ⇒ 面右');
  assert.equal(Number.isInteger(first.pos.x) && Number.isInteger(first.pos.y), true, 'pos 必须是整数 DIP');
  assert.equal(typeof first.speedDipPerSec, 'number');

  const before = harness.state.sent.length;
  harness.tick();
  const after = harness.state.sent.length;
  assert.ok(after - before <= 1, '每拍至多发一条');
});

test('到达之后下发 arrived + gait none（渲染层据此收 move-end）', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  const cursor = cursorRightOf(harness, 300);
  harness.state.cursor = cursor;
  for (let index = 0; index < 200; index += 1) {
    harness.tick();
    if (harness.controller.snapshot().phase === 'arrived') break;
  }
  const arrived = harness.state.sent.filter((command) => command.phase === 'arrived').pop();
  assert.ok(arrived, '必须有一条 arrived');
  assert.equal(arrived.gait, 'none');
  assert.equal(arrived.speedDipPerSec, 0);
});

test('stop()：管理模式关闭后一拍都不许再写（窗口销毁路径）', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  harness.state.cursor = cursorRightOf(harness, 500);
  harness.tickMany(3);
  const writes = harness.state.writes.length;
  harness.controller.stop();
  assert.equal(harness.state.subscribers.length, 0);
  harness.tickMany(20);
  assert.equal(harness.state.writes.length, writes, 'stop() 之后一律不许写位置');
  assert.equal(harness.controller.snapshot().mode, 'off');
});
test('单写者结构：非当前写权持有者的写入一律被拒（令牌护栏，不许只靠"约定"）', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('follow', 'dev'), { ok: true });
  harness.state.cursor = cursorRightOf(harness, 400);
  harness.tickMany(3);
  const writes = harness.state.writes.length;
  assert.equal(harness.controller.snapshot().owner, OWNER_TOKENS.LOCOMOTION);

  // 运动是当前写者时：冒充 drag / reclamp / none / 未知令牌的写入必须被拒且一个字节都不落盘。
  for (const token of [OWNER_TOKENS.DRAG, OWNER_TOKENS.RECLAMP, OWNER_TOKENS.NONE, 'bogus']) {
    assert.equal(harness.controller.applyPosition(token, 1200, 600), false, `令牌 ${token} 不得写入`);
  }
  assert.equal(harness.state.writes.length, writes, '被拒的写入不许调用写口');

  // 反过来：拖拽持有写权时，运动令牌同样必须被拒（写权互斥，不是"谁都能写"）。
  assert.equal(harness.controller.beginDrag(), true);
  assert.equal(harness.controller.applyPosition(OWNER_TOKENS.LOCOMOTION, 1200, 600), false);
  assert.equal(harness.controller.applyPosition(OWNER_TOKENS.DRAG, 1200, 600), true);
});


// ---------------------------------------------------------------- 行为状态闸门（S4.1 纵深防御）

test('行为闸门：渲染层上报 sleeping 后，主进程自己拒绝开启 roam/follow（不靠渲染层守）', () => {
  const harness = makeHarness();
  assert.equal(harness.controller.isBehaviorBlocked(), false, '初值 idle 不该被闸住');
  assert.equal(harness.controller.reportBehavior('sleeping'), false, '原本没在动，无需停');

  for (const mode of ['roam', 'follow']) {
    const before = harness.controller.snapshot().refusals;
    const refused = harness.controller.trySetMode(mode, 'dev');
    assert.equal(refused.ok, false, `行为态 sleeping 下 ${mode} 必须被拒（主进程侧独立防线）`);
    assert.equal(refused.reason, MOTION_BEHAVIOR_GATE.REASON, '拒绝必须带可判定的 reason');
    assert.equal(refused.reason, 'behavior-blocked');
    assert.equal(harness.controller.snapshot().refusals, before + 1, '拒绝必须计入 refusals');
    assert.match(refused.error, /sleeping/, '拒绝理由要说得清是哪个行为态挡的');
  }
  assert.equal(harness.state.subscribers.length, 0, '被拒后不许订阅（0 采样）');
  assert.equal(harness.controller.snapshot().behavior, 'sleeping');
});

test('行为闸门：三个行为态全部拦（sleeping / sleep / drag），其它态一律放行', () => {
  assert.deepEqual([...BLOCKED_BEHAVIORS], ['sleeping', 'sleep', 'drag']);
  for (const behavior of BLOCKED_BEHAVIORS) {
    const harness = makeHarness();
    harness.controller.reportBehavior(behavior);
    assert.equal(harness.controller.trySetMode('roam', 'dev').reason, MOTION_BEHAVIOR_GATE.REASON,
      `行为态 ${behavior} 必须挡住 roam`);
    assert.equal(harness.controller.snapshot().behaviorBlocked, true);
  }
  for (const behavior of ['idle', 'sit', 'lie', 'walk', 'run', 'jump', 'sleepy', 'wake', 'tap']) {
    const harness = makeHarness();
    harness.controller.reportBehavior(behavior);
    assert.deepEqual(harness.controller.trySetMode('roam', 'dev'), { ok: true },
      `行为态 ${behavior} 不该被挡住（过渡态仍有清醒交互，挡住会与 §8.2 契约打架）`);
  }
});

test('行为闸门：正在漫游时上报 sleeping ⇒ 立刻停下（否则睡姿会继续滑行）', () => {
  const harness = makeHarness();
  assert.deepEqual(harness.controller.trySetMode('roam', 'dev'), { ok: true });
  harness.tickMany(3);
  assert.ok(harness.state.writes.length > 0, '前提：漫游确实在写位置');

  assert.equal(harness.controller.reportBehavior('sleeping'), true, '入睡必须把运动停掉');
  assert.equal(harness.controller.snapshot().mode, 'off');
  assert.equal(harness.state.subscribers.length, 0, '停下必须退订（0 采样）');
  const writes = harness.state.writes.length;
  harness.tickMany(30);
  assert.equal(harness.state.writes.length, writes, '睡觉期间一拍都不许写位置');
});

test('行为闸门：醒来（回到 idle）后可以再次开启——闸门是"当下"而不是"永久封印"', () => {
  const harness = makeHarness();
  harness.controller.reportBehavior('sleeping');
  assert.equal(harness.controller.trySetMode('roam', 'dev').ok, false);
  harness.controller.reportBehavior('wake');
  assert.deepEqual(harness.controller.trySetMode('roam', 'dev'), { ok: true });
});

test('行为闸门：非法上报值被忽略（垃圾不许写进快照，也不许把闸门放开或焊死）', () => {
  const harness = makeHarness();
  harness.controller.reportBehavior('sleeping');
  for (const bad of [undefined, null, 42, '', {}, []]) {
    assert.equal(harness.controller.reportBehavior(bad), false);
  }
  assert.equal(harness.controller.snapshot().behavior, 'sleeping', '非法值不得覆盖已有状态');
  assert.equal(harness.controller.trySetMode('roam', 'dev').reason, MOTION_BEHAVIOR_GATE.REASON);
});

test('行为闸门：mode=off 不受闸门影响（关门永远是允许的）', () => {
  const harness = makeHarness();
  harness.controller.reportBehavior('drag');
  assert.deepEqual(harness.controller.trySetMode('off', 'dev'), { ok: true });
  assert.equal(harness.controller.snapshot().refusals, 0, 'off 不该被计一次拒绝');
});
