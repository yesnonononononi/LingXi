#!/usr/bin/env node
/**
 * QA · M3「自主移动 + 鼠标跟随」**对抗性测试**（寻找可被绕过的路径，而不是复述既有绿灯）。
 *
 * <p><b>为什么单独一份：</b>既有套件（`petMotion*` / `petWindowMotionWiring` /
 * `petLauncherWiring` / `petBehaviorMotion`）覆盖的是"设计里的正常路径"与"已修掉的六个真机缺陷"。
 * 本文件只做一件事：**从攻击者视角逐条尝试把单写者、数值边界、滞回、状态机、IPC 载荷与
 * 静态门禁弄坏**。凡是"试过但没弄坏"的，也写成用例——它是有价值的守卫；凡是"弄坏了"的，
 * 必须写红，并在报告里单列。
 *
 * <p><b>六组攻击面（与任务书一一对应）：</b></p>
 * <ol>
 *   <li>A · 单写者被绕过的可能路径（拖拽期并发 tick / `reclampNow` 同拍 / `stop()` 残留订阅 /
 *       `trySetMode` 与 `endDrag` 乱序 / `beginDrag` 二次调用）；</li>
 *   <li>B · 数值边界（极小与 0/负 workArea、窗口比工作区大、速度 0、dt=0/负、目标 NaN/Infinity、坐标极大值）；</li>
 *   <li>C · 抖动与停滞（滞回带 ±0.5 DIP、0.1 DIP/拍累积、两目标反复交替是否漂移）；</li>
 *   <li>D · 状态机与运动竞态（同拍"进入休息态 vs 请求 roam"两种顺序、prefs 快变、活跃模式不许跳档）；</li>
 *   <li>E · IPC 载荷对抗（`behavior` 非字符串/超长/原型、未知 `mode`、`prefs-set` 非布尔、窗口销毁后读快照）；</li>
 *   <li>F · 静态门禁可被规避的写法（注释写关键字、字符串拼接、`eval`/`Function`、动态 require）。</li>
 * </ol>
 *
 * <p><b>关于 F 组的诚实说明：</b>`scripts/check-pet-motion.mjs` 是**文本门禁**，强项是
 * "阻止无意漂移"，不是"阻止蓄意绕过"。F 组用该脚本**导出的判据函数**喂合成源码，
 * 逐条证明"哪种写法它抓得住、哪种抓不住"。抓不住的条目是**已知局限**（要么人评审、
 * 要么由运行时用例兜住），不是"门禁坏了"——但边界必须写清楚，否则"门禁全绿"会被误读成
 * "结构上不可能"。</p>
 *
 * <p><b>关于 D6 的诚实说明：</b>`state-machine.ts` 是 TypeScript，本套件按任务书要求跑在
 * `node --test`（纯 CJS，不加载 TS 转译器）。所以涉及 TS 侧的两条（活跃模式不许跳档、
 * 运动事件不写 `lastInteractionAt`）用**源码结构断言**实现——它们只能证明"那几行还在"，
 * 不能证明"运行时确实这么走"。运行时的等价证明在 `tests/petBehaviorMotion.test.ts`（tsx 段），
 * 两边不重叠、也不互相替代。</p>
 *
 * @module tests/qa-motion-adversarial
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const MOTION_MODULE = require(path.join(__dirname, '..', 'electron', 'pet-motion.cjs'));
const {
  MOTION,
  MotionController,
  OWNER_TOKENS,
  MOTION_MODES,
  MOTION_REASONS,
  BLOCKED_BEHAVIORS,
  MOTION_BEHAVIOR_GATE,
  decideFollowPhase,
  stepToward,
  resolveRoamBounds,
  clampTargetToWorkArea,
  pickRoamTarget,
} = MOTION_MODULE;

const { applyPrefsPatch } = require(path.join(__dirname, '..', 'electron', 'pet-prefs.cjs'));
const { makeStage, withPetWindow } = require('./helpers/petWindowHarness.cjs');

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

/** 单屏工作区（1920×1080 减任务栏）。 */
const WORK_AREA = Object.freeze({ x: 0, y: 0, width: 1920, height: 1040 });

/** 前端根目录（门禁 `loadSources()` 与源码结构断言用它解析路径）。 */
const FRONTEND_ROOT = path.join(__dirname, '..');

/**
 * 手摇测试台：假订阅源 + 假时钟 + 假窗口写口。
 *
 * <p>**刻意不复用** `petMotionController.test.cjs` 的 harness：那份把 `state.subscribers` 当
 * 唯一真相，而本文件要验的恰恰是"订阅表里到底还剩什么"和"就算有人硬喂已退订的回调会发生什么"，
 * 所以这里额外暴露 `stale`（历史监听快照），用来模拟"轮询器手里还攥着已退订的回调"。</p>
 *
 * @param {object} [options] 覆盖项（`workArea` / `initial` / `rng` / `prefs`）
 * @returns {object} 测试台
 */
function makeRig(options = {}) {
  const overrides = options && typeof options === 'object' ? options : {};
  const state = {
    writes: [],
    sent: [],
    subscribers: [],
    /** 历史上曾经被注册过的监听（含已经退订的）——模拟轮询器侧的残留引用。 */
    stale: [],
    cursor: { x: 0, y: 0 },
    time: 1000,
    prefs: { follow: true, roam: true, reducedMotion: false, ...(overrides.prefs || {}) },
  };
  const controller = new MotionController({
    setWindowPosition: (x, y) => state.writes.push({ x, y }),
    subscribeSample: (listener) => {
      state.subscribers.push(listener);
      state.stale.push(listener);
      return () => {
        state.subscribers = state.subscribers.filter((item) => item !== listener);
      };
    },
    workArea: overrides.workArea || (() => ({ ...WORK_AREA })),
    size: { ...WINDOW_SIZE },
    artOrigin: { ...ART_ORIGIN },
    artSize: { ...ART_SIZE },
    initial: overrides.initial === undefined ? { x: 800, y: 400 } : overrides.initial,
    cursor: () => ({ ...state.cursor }),
    prefs: () => ({ ...state.prefs }),
    send: (command) => state.sent.push(command),
    clock: { now: () => state.time },
    rng: overrides.rng || (() => 0.5),
  });

  let tickId = 0;
  /** 投递一拍（喂给**当前订阅表**里的所有监听）。 */
  const tick = (point) => {
    tickId += 1;
    const sample = { tickId, point: point === undefined ? { ...state.cursor } : { ...point } };
    let handled = false;
    for (const listener of [...state.subscribers]) handled = listener(sample) === true || handled;
    return handled;
  };
  const tickMany = (count, point) => {
    for (let index = 0; index < count; index += 1) tick(point);
  };
  return { controller, state, tick, tickMany, center: () => controller.centerOf(controller.position) };
}

/** 把光标放到"宠物中心右侧 `distance` DIP"。 */
function placeCursorRight(rig, distance) {
  const center = rig.center();
  rig.state.cursor = { x: center.x + distance, y: center.y };
  return rig.state.cursor;
}

/**
 * 造一个"与 main.cjs 注入同形状"的偏好端口（仅本文件用）。
 *
 * @param {object} [initial] 初始偏好
 * @returns {object} `{port}`
 */
function makePrefsPort(initial) {
  const listeners = new Set();
  const state = { version: 1, follow: false, roam: true, ...(initial || {}) };
  const port = {
    getPrefs: () => ({ ...state }),
    setPrefs: (patch) => {
      const next = { ...state };
      if (patch && typeof patch.follow === 'boolean') next.follow = patch.follow;
      if (patch && typeof patch.roam === 'boolean') next.roam = patch.roam;
      const changed = next.follow !== state.follow || next.roam !== state.roam;
      Object.assign(state, next);
      if (changed) for (const listener of [...listeners]) listener({ ...state });
      return { prefs: { ...state }, ok: true, problems: [], changed };
    },
    onPrefsChange: (listener) => {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { port };
}

// ================================================================ A · 单写者被绕过的可能路径

test('A1 拖拽期并发 tick：订阅表必须为空（结构），且硬喂残留回调也不许写（令牌兜底）', () => {
  const rig = makeRig();
  rig.controller.start();
  assert.deepEqual(rig.controller.trySetMode('follow', 'prefs'), { ok: true });
  assert.equal(rig.state.subscribers.length, 1, '开了 follow 必须恰好一个订阅（不多不少）');

  placeCursorRight(rig, 400);
  rig.tickMany(3);
  const writesBeforeDrag = rig.state.writes.length;
  assert.ok(writesBeforeDrag > 0, '前置：拖拽前必须真的在动，否则下面的"0 写"说明不了任何问题');

  rig.controller.beginDrag();
  assert.equal(
    rig.state.subscribers.length,
    0,
    'L3：拖拽开始必须把回调从订阅表里摘掉（不是"在回调里判一下 owner 就跳过"）',
  );

  // 攻击①：并发投喂（模拟轮询器在这一拍仍然叫醒了回调表）
  placeCursorRight(rig, 900);
  rig.tickMany(20);
  assert.equal(rig.state.writes.length, writesBeforeDrag, '拖拽期间定时器路径必须 0 写入');

  // 攻击②：拿着**历史监听引用**硬喂（模拟退订竞争/引用泄漏）——令牌必须兜住
  const stale = rig.state.stale[0];
  assert.equal(typeof stale, 'function', '前置：必须确实拿到过监听');
  const handled = stale({ tickId: 9999, point: { x: 0, y: 0 } });
  assert.equal(handled, false, '写入权在 drag 上 ⇒ 已退订的回调也必须早退（令牌是第二道，不是第一道）');
  assert.equal(rig.state.writes.length, writesBeforeDrag, '硬喂残留回调也不许产生任何窗口写入');
  assert.equal(rig.controller.snapshot().owner, OWNER_TOKENS.DRAG);
});

test('A2 reclampNow 与运动 tick 同拍：一次夹取只写一次、累加器对齐、下一拍不回弹也不漂移', () => {
  const rig = makeRig();
  rig.controller.start();
  rig.controller.trySetMode('follow', 'prefs');
  placeCursorRight(rig, 600);
  rig.tickMany(10);

  const beforeReclamp = { x: rig.controller.position.x, y: rig.controller.position.y };
  // 同拍：夹取（模拟 display-removed 落在两次 tick 之间）
  const wrote = rig.controller.reclampNow({ x: -5000, y: -5000 });
  assert.equal(wrote, true, '越界夹取必须真的写一次');
  assert.deepEqual(rig.state.writes.slice(-1)[0], { x: 0, y: 0 }, '夹取结果必须是工作区原点（整窗在内）');
  assert.equal(
    rig.controller.snapshot().owner,
    OWNER_TOKENS.LOCOMOTION,
    '夹取结束后写入权必须还给运动（finally 恢复）',
  );

  // 夹取后：浮点累加器必须已经等于夹取后的位置（否则下一拍会朝旧位置"跳回去"）
  assert.deepEqual(
    { x: rig.controller.position.x, y: rig.controller.position.y },
    { x: 0, y: 0 },
    '累加器必须与窗口对齐，不许保留夹取前的旧坐标（那是"漂移"的来源）',
  );

  // 紧接着一拍：必须从 0 开始往右走，不许回弹到夹取前的位置
  const beforeTick = rig.state.writes.length;
  rig.tick();
  if (rig.state.writes.length > beforeTick) {
    const after = rig.state.writes.slice(-1)[0];
    assert.ok(after.x >= 0 && after.x < beforeReclamp.x, `夹取后必须从新位置继续（实际写 ${after.x}）`);
  }
  assert.ok(rig.controller.position.x > 0, '浮点位置必须开始向右推进');
  // 位置没变时夹取必须返回 false（不许白写 DWM）
  const settled = rig.controller.snapshot();
  assert.equal(
    rig.controller.reclampNow({ x: settled.x, y: settled.y }),
    false,
    '目标位置与当前已写入位置相同 ⇒ 夹取必须返回 false（不白写 DWM）',
  );
});

test('A3 stop() 后不得残留订阅；单独 start() 不得把已停的模式偷偷接回来', () => {
  const rig = makeRig();
  rig.controller.start();
  rig.controller.trySetMode('follow', 'prefs');
  placeCursorRight(rig, 400);
  rig.tickMany(3);

  rig.controller.stop();
  assert.equal(rig.state.subscribers.length, 0, 'stop() 必须退订（窗口销毁后一次都不许再写位置）');
  const writesAtStop = rig.state.writes.length;
  const samplesAtStop = rig.controller.snapshot().samples;

  // 残留订阅攻击：硬喂历史监听
  for (const listener of rig.state.stale) listener({ tickId: 5000, point: { x: 0, y: 0 } });
  assert.equal(rig.state.writes.length, writesAtStop, 'stop() 之后任何一拍都不许写位置');
  assert.equal(rig.controller.snapshot().samples, samplesAtStop, 'stop() 之后不许再做运动解算');

  // start() 单独调用：mode 已是 off ⇒ 不许重新订阅
  rig.controller.start();
  assert.equal(rig.state.subscribers.length, 0, 'start() 单独调用不得订阅（mode=off 时从不订阅）');
  rig.controller.trySetMode('follow', 'prefs');
  assert.equal(rig.state.subscribers.length, 1, '重新开模式后必须恰好一个订阅（不是零、也不是两个）');
});

test('A4 trySetMode 与 endDrag 乱序：三种顺序都必须只有 0 或 1 个订阅（绝不重复订阅）', () => {
  const rig = makeRig();
  rig.controller.start();

  // 顺序①：开模式 → 拖拽 → 拖拽中改模式 → 松手
  rig.controller.trySetMode('follow', 'prefs');
  rig.controller.beginDrag();
  assert.equal(rig.state.subscribers.length, 0);
  assert.deepEqual(rig.controller.trySetMode('roam', 'prefs'), { ok: true }, '拖拽期间允许受理模式（写入权仍归拖拽）');
  assert.equal(rig.controller.snapshot().owner, OWNER_TOKENS.DRAG, '拖拽期间受理模式不得把写入权抢回来');
  assert.equal(rig.state.subscribers.length, 0, '拖拽期间受理模式也不得订阅（否则又把抢写路径接回去了）');
  rig.controller.endDrag();
  assert.equal(rig.controller.snapshot().owner, OWNER_TOKENS.LOCOMOTION);
  assert.equal(rig.state.subscribers.length, 1, '松手后必须恰好一个订阅');

  // 顺序②：重复 endDrag / 重复开同一模式，都必须幂等
  rig.controller.endDrag();
  rig.controller.endDrag();
  assert.equal(rig.state.subscribers.length, 1, '重复 endDrag 不得叠加订阅（attachIfActive 必须幂等）');
  rig.controller.trySetMode('follow', 'prefs');
  assert.equal(rig.state.subscribers.length, 1, '重复开同一模式不得叠加订阅');

  // 顺序③：拖拽中 off（交互打断）→ 松手
  rig.controller.beginDrag();
  rig.controller.trySetMode('off', 'interaction');
  assert.notEqual(
    rig.controller.snapshot().desiredMode,
    'off',
    '交互打断只清生效模式、必须保留用户意图（§5.1 注释 1：手一离开跟随要能继续）',
  );
  assert.equal(
    rig.controller.snapshot().desiredMode,
    'follow',
    '保留的必须是"上一次成功受理的意图"（本序列里是 follow），不许被 off/interaction 清掉',
  );
  rig.controller.endDrag();
  assert.equal(rig.controller.snapshot().mode, 'off');
  assert.equal(rig.state.subscribers.length, 0, 'mode=off 松手后不得订阅');
  assert.equal(rig.controller.snapshot().owner, OWNER_TOKENS.NONE, '没有运动时写入权必须归 none');
});

test('A5 beginDrag 二次调用必须幂等（订阅表仍空、所有者仍 drag、不得抛）', () => {
  const rig = makeRig();
  rig.controller.start();
  rig.controller.trySetMode('roam', 'prefs');
  assert.equal(rig.state.subscribers.length, 1);
  assert.equal(rig.controller.beginDrag(), true);
  assert.equal(rig.controller.beginDrag(), true, '二次 beginDrag 必须仍返回 true（不抛）');
  assert.equal(rig.state.subscribers.length, 0);
  assert.equal(rig.controller.snapshot().owner, OWNER_TOKENS.DRAG);
  const writes = rig.state.writes.length;
  assert.equal(rig.controller.dragTo(1200, 700, 50, 50), true);
  assert.equal(rig.state.writes.length, writes + 1, 'dragTo 必须恰好写一次');
});

test('A6 同一拍内 tick 与 dragTo 混合：任何时刻只有一个写者（写次数可逐条归因）', () => {
  const rig = makeRig();
  rig.controller.start();
  rig.controller.trySetMode('follow', 'prefs');
  placeCursorRight(rig, 500);

  rig.tick();
  rig.controller.beginDrag();
  const before = rig.state.writes.length;
  for (let index = 0; index < 30; index += 1) {
    rig.tick();
    rig.controller.dragTo(1000 + index, 600, 40, 40);
  }
  const motionWrites = rig.state.writes.length - before;
  assert.equal(motionWrites, 30, `拖拽期间写入必须全部来自 dragTo（30 次），实际 ${motionWrites} 次`);

  const dragTargets = new Set();
  for (let index = 0; index < 30; index += 1) dragTargets.add(1000 + index - 40);
  for (const write of rig.state.writes.slice(before)) {
    assert.ok(dragTargets.has(write.x), `出现非拖拽来源的写入 x=${write.x}（这就是"抢写"）`);
  }
});

test('A7 【Q-M3 · 疑似缺陷】拖拽期间 reclampNow 不许抢写（drag 独占写入权）', () => {
  const rig = makeRig();
  rig.controller.start();
  rig.controller.trySetMode('follow', 'prefs');
  placeCursorRight(rig, 300);
  rig.tickMany(3);
  rig.controller.beginDrag();
  assert.equal(rig.controller.snapshot().owner, OWNER_TOKENS.DRAG, '前置：拖拽独占写入权（§5.1 第 2 级）');

  const writesAtDrag = rig.state.writes.length;
  const draggedX = rig.controller.snapshot().x;
  // 显示器事件（display-metrics-changed）在拖拽中途到达 ⇒ 窗口层会调 reclampNow
  const wrote = rig.controller.reclampNow({ x: -3000, y: draggedX === null ? 0 : 400 });

  assert.equal(wrote, false, '拖拽期间夹取**不许**写窗口（窗口会被从手指下拽走，正是"被拉回目标点"的抽搐形态）');
  assert.equal(rig.state.writes.length, writesAtDrag, '拖拽期间夹取必须 0 写入');
  assert.equal(rig.controller.snapshot().x, draggedX, '窗口必须还停在用户拖到的位置');
  assert.equal(rig.controller.snapshot().owner, OWNER_TOKENS.DRAG, '写入权不许被夹取临时拿走');

  // 松手后夹取正常生效（deferred 语义：拖拽结束后才夹）
  rig.controller.endDrag();
  assert.equal(rig.controller.reclampNow({ x: -3000, y: 400 }), true, '松手后夹取必须恢复正常（越界必须被夹回）');
});

// ================================================================ B · 数值边界

test('B1 workArea 宽高为 0 / 负值：无有效值时一律"不做动作"，有有效值后脏值回退上次', () => {
  // ① 从头就没有有效工作区
  const rig = makeRig({ workArea: () => ({ x: 0, y: 0, width: 0, height: 0 }) });
  rig.controller.start();
  rig.controller.trySetMode('roam', 'prefs');
  rig.state.time = 10_000;
  rig.tickMany(5);
  assert.equal(rig.state.writes.length, 0, 'workArea 宽高为 0 ⇒ 漫游必须不解算、不写窗口（不许拿 0 当边界乱走）');
  assert.equal(rig.controller.snapshot().target, null, '不许选出一个 0 面积工作区里的目标点');
  assert.equal(rig.controller.reclampNow(), false, '无有效工作区 ⇒ 夹取必须返回 false（不写）');

  // ② 负宽高（脏值）：必须被 requireRect 拒掉
  const negative = makeRig({ workArea: () => ({ x: 0, y: 0, width: -100, height: -100 }) });
  negative.controller.start();
  // 用 roam 走"每拍现算工作区"那条路径（follow 不消费工作区：设计 §6.1 只有漫游/夹取/拖拽读它）
  negative.controller.trySetMode('roam', 'prefs');
  negative.state.time = 30_000;
  negative.tickMany(5);
  assert.equal(negative.state.writes.length, 0, '负宽高必须被拒（读不到工作区 ⇒ 不解算、不写）');
  assert.equal(negative.controller.snapshot().target, null, '负宽高下不许选出目标点');

  // ③ 先有效、后脏：脏的那一拍回退到"上一次有效值"，而不是 null
  let health = 'ok';
  const flaky = makeRig({
    workArea: () =>
      health === 'ok' ? { ...WORK_AREA } : { x: 0, y: 0, width: Number.NaN, height: 0 },
  });
  flaky.controller.start();
  flaky.controller.trySetMode('roam', 'prefs');
  flaky.state.time = 5000;
  flaky.tick();
  assert.notEqual(flaky.controller.snapshot().target, null, '前置：有效工作区下必须选出目标');
  health = 'dirty';
  for (let index = 0; index < 3; index += 1) {
    flaky.state.time += 16;
    flaky.tick();
  }
  assert.ok(Number.isFinite(flaky.controller.position.x), '兜底后位置必须仍是有限数');
  assert.ok(Number.isFinite(flaky.controller.position.y), '兜底后位置必须仍是有限数');
  for (const write of flaky.state.writes) {
    assert.ok(Number.isFinite(write.x) && Number.isFinite(write.y), `脏工作区下写口收到非有限坐标：${JSON.stringify(write)}`);
  }
});

test('B2 窗口比 workArea 大 / workArea 极小：范围退化到工作区原点，目标点无 NaN', () => {
  const tiny = { x: 100, y: 50, width: 40, height: 30 };
  const bounds = resolveRoamBounds({ workArea: tiny, windowSize: { ...WINDOW_SIZE } });
  assert.deepEqual(
    bounds,
    { minX: 100, maxX: 100, minY: 50, maxY: 50 },
    '窗口比工作区大 ⇒ 只可能贴左上角（宁可贴边，不许越界）',
  );
  assert.deepEqual(
    pickRoamTarget({ workArea: tiny, windowSize: { ...WINDOW_SIZE }, rng: () => 0.9 }),
    { x: 100, y: 50 },
    '退化区间里随机出来的也必须落在那一个点',
  );
  assert.deepEqual(
    clampTargetToWorkArea({ workArea: tiny, windowSize: { ...WINDOW_SIZE }, target: { x: -9999, y: 9999 } }),
    { x: 100, y: 50 },
    '越界目标必须被夹到退化点',
  );

  // 只比窗口大 10 DIP：margin 必须被压到 slack/2，不许出现 min > max
  const narrow = { x: 0, y: 0, width: WINDOW_SIZE.width + 10, height: WINDOW_SIZE.height + 10 };
  const narrowBounds = resolveRoamBounds({ workArea: narrow, windowSize: { ...WINDOW_SIZE } });
  assert.ok(narrowBounds.minX <= narrowBounds.maxX, 'minX 不许大于 maxX（否则 clamp 会把点吸到 max，窗口越界）');
  assert.ok(narrowBounds.minY <= narrowBounds.maxY, 'minY 不许大于 maxY');
  assert.deepEqual(
    { minX: narrowBounds.minX, maxX: narrowBounds.maxX },
    { minX: 5, maxX: 5 },
    'margin 必须被压到 slack/2 = 5 ⇒ 仅剩 1 个可用位置（0+5 到 10−5）',
  );
});

test('B3 速度 0 / dt=0 / 负 dt：不推进、不误报到达；负 dt 必须显式报错', () => {
  const from = { x: 100, y: 100 };
  const to = { x: 500, y: 100 };
  assert.deepEqual(
    stepToward({ from, to, speedLimit: 0, accel: 480, dtMs: 16 }),
    { x: 100, y: 100, speed: 0, arrived: false },
    '速度上限 0 ⇒ 不推进，且**不许**宣布到达（到达只由"真的够近了"决定）',
  );
  assert.deepEqual(
    stepToward({ from, to, speedLimit: 240, accel: 480, dtMs: 0 }),
    { x: 100, y: 100, speed: 0, arrived: false },
    'dt=0 ⇒ 不推进，也不许宣布到达',
  );
  assert.deepEqual(
    stepToward({ from, to: from, speedLimit: 240, accel: 480, dtMs: 16 }),
    { x: 100, y: 100, speed: 0, arrived: true },
    '已经在目标上 ⇒ 立即到达（这是唯一合法的"速度 0 + arrived"组合）',
  );
  assert.throws(
    () => stepToward({ from, to, speedLimit: 240, accel: 480, dtMs: -16 }),
    RangeError,
    '负 dt 必须显式报错（不许当成 0 静默吞掉）',
  );
  assert.equal(MOTION.tickMs, 16, '控制器内部的 dt 恒为 MOTION.tickMs，外部无法改成 0/负');
});

test('B4 目标 NaN / Infinity：坏随机源与坏目标点必须显式报错，控制器不许写出非有限坐标', () => {
  assert.throws(
    () => pickRoamTarget({ workArea: { ...WORK_AREA }, windowSize: { ...WINDOW_SIZE }, rng: () => Number.NaN }),
    RangeError,
    'rng 返回 NaN 必须报错（不许"夹一下继续"）',
  );
  assert.throws(
    () => pickRoamTarget({ workArea: { ...WORK_AREA }, windowSize: { ...WINDOW_SIZE }, rng: () => 1 }),
    RangeError,
    'rng 返回 1（半开区间外）必须报错',
  );
  assert.throws(
    () =>
      clampTargetToWorkArea({
        workArea: { ...WORK_AREA },
        windowSize: { ...WINDOW_SIZE },
        target: { x: Number.NaN, y: 0 },
      }),
    TypeError,
    '目标点 NaN 必须报错',
  );
  assert.throws(
    () =>
      clampTargetToWorkArea({
        workArea: { ...WORK_AREA },
        windowSize: { ...WINDOW_SIZE },
        target: { x: Infinity, y: 0 },
      }),
    TypeError,
    '目标点 Infinity 必须报错',
  );

  const rig = makeRig();
  rig.controller.start();
  rig.controller.trySetMode('follow', 'prefs');
  placeCursorRight(rig, 400);
  rig.tickMany(5);
  assert.ok(Number.isFinite(rig.controller.position.x) && Number.isFinite(rig.controller.position.y));
  for (const write of rig.state.writes) {
    assert.ok(Number.isFinite(write.x) && Number.isFinite(write.y), `写口收到非有限坐标：${JSON.stringify(write)}`);
  }
});

test('B5 坐标极大值：超大目标不产生 Infinity/NaN；溢出到 Infinity 的拖拽目标是已知缺口（写红）', () => {
  // ① stepToward：Number.MAX_VALUE 目标下本拍仍只走该走的距离
  const step = stepToward({
    from: { x: 0, y: 0 },
    to: { x: Number.MAX_VALUE, y: 0 },
    speedLimit: MOTION.runMaxDipPerSec,
    accel: MOTION.accelDipPerSec2,
    dtMs: MOTION.tickMs,
  });
  assert.ok(Number.isFinite(step.x), `MAX_VALUE 目标下位移必须有限（实际 ${step.x}）`);
  assert.ok(step.x > 0 && step.x < 1, `一拍位移必须很小（实际 ${step.x}）`);
  assert.equal(step.arrived, false);

  // ② 1e15 目标：控制器正常推进、不产生 Infinity
  const rig = makeRig();
  rig.controller.start();
  rig.controller.trySetMode('follow', 'prefs');
  rig.state.cursor = { x: 1e15, y: rig.center().y };
  rig.tickMany(3);
  assert.ok(Number.isFinite(rig.controller.position.x), '极大目标下浮点位置必须有限');
  for (const write of rig.state.writes) assert.ok(Number.isFinite(write.x));

  // ③ 两个**各自有限**的入参相减可以溢出成 Infinity。这个缺口由 E6 端到端写红（报告 Q-M1），
  //    这里钉住"溢出发生在派生候选点、而不是入参校验"，避免有人以为 requireFiniteNumber 已经挡住了。
  const drag = makeRig();
  drag.controller.start();
  drag.controller.beginDrag();
  assert.doesNotThrow(() => drag.controller.dragTo(1e308, 0, 0, 0), '单侧极端值不溢出（对照）');
  assert.throws(
    () => drag.controller.dragTo(1e308, 0, -1e308, 0),
    TypeError,
    '入参各自有限，但 candidate.x = 1e308 - (-1e308) = Infinity ⇒ requireFiniteNumber 在派生点上报错',
  );
});

// ================================================================ C · 抖动与停滞

test('C1 滞回带 ±0.5 DIP：三个半径边界上的相位转移必须完全确定', () => {
  const cases = [
    [95.5, 'chase', 'arrived'],
    [96, 'chase', 'arrived'],
    [96.5, 'chase', 'chase'],
    [219.5, 'arrived', 'arrived'],
    [220, 'arrived', 'chase'],
    [220.5, 'arrived', 'chase'],
    [219.5, 'idle', 'idle'],
    [220, 'idle', 'chase'],
    [96, 'idle', 'idle'],
    [0, 'arrived', 'arrived'],
    [0, 'chase', 'arrived'],
  ];
  for (const [distanceDip, phase, expected] of cases) {
    assert.equal(
      decideFollowPhase({ distanceDip, phase }),
      expected,
      `距离 ${distanceDip} 现相 ${phase} ⇒ 期望 ${expected}`,
    );
  }
  // 带内不许抖：96~220 之间任取点，chase 保持 chase、arrived 保持 arrived
  for (let distance = 97; distance < 220; distance += 5) {
    assert.equal(decideFollowPhase({ distanceDip: distance, phase: 'chase' }), 'chase');
    assert.equal(decideFollowPhase({ distanceDip: distance, phase: 'arrived' }), 'arrived');
  }
});

test('C2 带内 0 写入：光标停在 150 DIP（>停止 96 且 <启动 220）时既不停也不重新起追', () => {
  const rig = makeRig();
  rig.controller.start();
  rig.controller.trySetMode('follow', 'prefs');

  placeCursorRight(rig, 400);
  rig.tickMany(5);
  assert.equal(rig.controller.snapshot().phase, 'chase', '前置：400 DIP 必须进入 chase');
  assert.ok(rig.state.writes.length > 0, '前置：必须真的在走');

  placeCursorRight(rig, 90);
  rig.tickMany(4);
  assert.equal(rig.controller.snapshot().phase, 'arrived', '90 DIP < 停止半径 96 ⇒ 必须到达');
  const writesAtArrive = rig.state.writes.length;
  rig.tickMany(10);
  assert.equal(rig.state.writes.length, writesAtArrive, '到达后必须 0 写入（不许"贴脸蹭"）');

  // 光标退到 150 DIP：在滞回带内 ⇒ 保持 arrived、0 写入（"用户小幅移动鼠标猫不该重启动"）
  placeCursorRight(rig, 150);
  rig.tickMany(10);
  assert.equal(rig.controller.snapshot().phase, 'arrived', '滞回带内必须保持 arrived');
  assert.equal(rig.state.writes.length, writesAtArrive, '滞回带内必须 0 写入');

  // 越过 220 ⇒ 重新起追
  placeCursorRight(rig, 260);
  rig.tickMany(5);
  assert.equal(rig.controller.snapshot().phase, 'chase', '> 启动半径 220 ⇒ 必须重新起追');
});

test('C3 低速不停滞：0.1 DIP/拍的累积位移必须真的攒出 10 DIP（round 不许当累加基准）', () => {
  // 6.25 DIP/s × 16ms = 0.1 DIP/拍。若实现先把每拍结果 Math.round 再当下一拍基准，
  // 位置会永远停在 0（Math.round(0.1) === 0）——这正是设计 §4.2 点名的坑。
  let x = 0;
  let speed = 0;
  const rounded = [];
  for (let index = 0; index < 100; index += 1) {
    const step = stepToward({
      from: { x, y: 0 },
      to: { x: 1000, y: 0 },
      speedLimit: 6.25,
      accel: MOTION.accelDipPerSec2,
      currentSpeed: speed,
      dtMs: MOTION.tickMs,
    });
    x = step.x;
    speed = step.speed;
    rounded.push(Math.round(x));
  }
  assert.ok(Math.abs(x - 10) < 0.2, `100 拍 × 0.1 DIP 必须攒出 ≈10 DIP（实际 ${x}）`);
  assert.equal(Math.round(x), 10);
  for (let index = 1; index < rounded.length; index += 1) {
    assert.ok(rounded[index] >= rounded[index - 1], `第 ${index} 拍取整位置回退：${rounded[index - 1]} → ${rounded[index]}`);
  }
});

test('C4 两目标反复交替：位置必须始终落在两目标构成的区间内（不许累积漂移）', () => {
  const left = { x: 100, y: 500 };
  const right = { x: 1100, y: 500 };
  let state = { x: 600, y: 500, speed: 0 };
  for (let index = 0; index < 200; index += 1) {
    const target = index % 2 === 0 ? right : left;
    const step = stepToward({
      from: { x: state.x, y: state.y },
      to: target,
      speedLimit: MOTION.walkMaxDipPerSec,
      accel: MOTION.accelDipPerSec2,
      currentSpeed: state.speed,
      dtMs: MOTION.tickMs,
    });
    state = { x: step.x, y: step.y, speed: step.speed };
    assert.ok(Number.isFinite(state.x), `第 ${index} 拍出现非有限坐标`);
    assert.ok(
      state.x >= left.x - 0.001 && state.x <= right.x + 0.001,
      `第 ${index} 拍越出两目标区间：x=${state.x}（这就是累积漂移）`,
    );
    assert.equal(state.y, 500, '纯水平目标下 y 不许变（垂直漂移同样是漂移）');
  }
});

// ================================================================ D · 状态机与运动竞态

test('D1 同拍顺序①：先报 sleeping 再请求 roam ⇒ 主进程必须自己闸住（behavior-blocked）', () => {
  const rig = makeRig();
  rig.controller.start();
  assert.equal(rig.controller.reportBehavior('sleeping'), false, '还没在动 ⇒ reportBehavior 不"停掉"任何东西');

  const refused = rig.controller.trySetMode('roam', 'prefs');
  assert.equal(refused.ok, false, '行为态 sleeping 下开漫游必须被拒（渲染层那层不算，主进程要自己判）');
  assert.equal(refused.reason, MOTION_BEHAVIOR_GATE.REASON, `拒绝原因必须可判定（实际 ${JSON.stringify(refused)}）`);
  assert.equal(rig.controller.snapshot().refusals, 1, '拒绝必须计数（真机"猫不动"要能查到原因）');
  assert.match(rig.controller.snapshot().lastRefusal, /sleeping/);
  assert.equal(rig.state.subscribers.length, 0, '被拒 ⇒ 一次都不许订阅');
  assert.equal(rig.state.writes.length, 0, '被拒 ⇒ 一次都不许写');

  rig.controller.reportBehavior('idle');
  assert.deepEqual(rig.controller.trySetMode('roam', 'prefs'), { ok: true });
  assert.equal(rig.state.subscribers.length, 1, '醒来后必须能重新开起来（否则"醒来永不恢复"复现）');
});

test('D2 同拍顺序②：先开 roam、再报 sleeping ⇒ 必须立刻停下并摘掉订阅，且保留用户意图', () => {
  const rig = makeRig();
  rig.controller.start();
  rig.controller.trySetMode('roam', 'prefs');
  rig.state.time = 10_000;
  rig.tickMany(3);
  const writesWhileRoaming = rig.state.writes.length;
  assert.ok(writesWhileRoaming > 0, '前置：漫游必须真的在动');

  assert.equal(rig.controller.reportBehavior('sleeping'), true, '正在动时上报睡觉 ⇒ 必须立刻停（否则"趴着滑行"复现）');
  assert.equal(rig.controller.snapshot().mode, 'off');
  assert.equal(rig.state.subscribers.length, 0, '停下必须摘掉订阅（结构，不是"回调里判一下"）');
  assert.equal(rig.controller.snapshot().velocityDipPerSec, 0, '速度必须归零');
  assert.equal(rig.controller.snapshot().gait, 'none');
  assert.equal(rig.controller.snapshot().desiredMode, 'roam', '用户意图必须保留（醒来后要能继续）');
  rig.tickMany(10);
  assert.equal(rig.state.writes.length, writesWhileRoaming, '停下后必须 0 写入');

  for (const behavior of BLOCKED_BEHAVIORS) {
    const item = makeRig();
    item.controller.start();
    item.controller.reportBehavior(behavior);
    assert.equal(item.controller.trySetMode('roam', 'prefs').ok, false, `${behavior} 必须让 roam 被拒`);
    assert.equal(item.controller.trySetMode('follow', 'prefs').ok, false, `${behavior} 必须让 follow 被拒`);
    assert.deepEqual(item.controller.trySetMode('off', 'prefs'), { ok: true }, 'off 永远要被受理（安全方向）');
  }
});

test('D3 快速 prefs 连变（开→关→开）：偏好只能"收回"、不许自己"开启"', () => {
  const rig = makeRig();
  rig.controller.start();
  rig.controller.trySetMode('roam', 'prefs');
  assert.equal(rig.controller.snapshot().mode, 'roam');

  assert.equal(rig.controller.applyPrefs({ roam: false }), true, '关掉漫游 ⇒ 必须立刻停');
  assert.equal(rig.controller.snapshot().mode, 'off');
  assert.equal(rig.state.subscribers.length, 0);

  assert.equal(rig.controller.applyPrefs({ roam: true }), false, '再打开 ⇒ 只记偏好，不许自己开始动（渲染层才是请求方）');
  assert.equal(rig.controller.snapshot().mode, 'off', 'applyPrefs 不许把模式自己改回 roam');
  rig.state.time = 20_000;
  rig.tickMany(5);
  assert.equal(rig.state.writes.length, 0, '偏好重开但没人请求 ⇒ 0 写入');

  assert.deepEqual(rig.controller.trySetMode('roam', 'prefs'), { ok: true }, '再请求一次才动');
  assert.equal(rig.state.subscribers.length, 1);

  // 两个开关独立：关 follow 不许连坐 roam
  const both = makeRig();
  both.controller.start();
  both.controller.trySetMode('roam', 'prefs');
  assert.equal(both.controller.applyPrefs({ follow: false, roam: true }), false, '关 follow 不许连坐 roam');
  assert.equal(both.controller.snapshot().mode, 'roam');

  // reduced-motion：一律停 + 一律拒开
  both.state.prefs.reducedMotion = true;
  assert.equal(both.controller.applyPrefs({ reducedMotion: true }), true);
  assert.equal(both.controller.snapshot().mode, 'off');
  const blocked = both.controller.trySetMode('roam', 'prefs');
  assert.equal(blocked.ok, false, 'reduced-motion 下必须拒绝开启自主运动');
  assert.match(String(blocked.error), /reduced-motion/);
});

test('D4 非法 behavior 上报：非字符串/空串一律忽略（不许把垃圾当状态）', () => {
  const rig = makeRig();
  rig.controller.start();
  const junk = [undefined, null, 0, 1, true, [], {}, () => {}, '', Symbol('x')];
  for (const value of junk) {
    assert.equal(rig.controller.reportBehavior(value), false, `${String(value)} 不该改变任何东西`);
    assert.equal(rig.controller.snapshot().behavior, 'idle', `行为态被 ${String(value)} 污染了`);
  }
  assert.deepEqual(rig.controller.trySetMode('roam', 'prefs'), { ok: true }, '垃圾上报不许把闸门卡住');
});

test('D5 未知 mode / 缺 reason：必须在主进程侧被枚举拒绝，且拒绝可读', () => {
  const rig = makeRig();
  rig.controller.start();
  for (const mode of ['fly', '', null, undefined, 0, 'FOLLOW', 'follow ']) {
    const result = rig.controller.trySetMode(mode, 'prefs');
    assert.equal(result.ok, false, `mode=${JSON.stringify(mode)} 必须被拒`);
    assert.match(String(result.error), /非法 mode/);
  }
  for (const reason of ['', null, undefined, 'because', 0]) {
    const result = rig.controller.trySetMode('roam', reason);
    assert.equal(result.ok, false, `reason=${JSON.stringify(reason)} 必须被拒`);
    assert.match(String(result.error), /非法 reason/);
  }
  assert.equal(rig.state.subscribers.length, 0, '全被拒 ⇒ 一次订都不许订');
  assert.equal(MOTION_MODES.length, 3);
  assert.equal(MOTION_REASONS.length, 4);
});

test('D6 活跃模式"不许跳档"与"运动事件不写空闲计时"：源码结构守卫（TS 侧只能静态查）', () => {
  const source = readFileSync(path.join(FRONTEND_ROOT, 'src', 'pet', 'behavior', 'state-machine.ts'), 'utf8');

  // ① 两个集合的成员必须固定
  assert.match(
    source,
    /IDLE_CHAIN_STATES[^=]*=\s*Object\.freeze\(\['idle',\s*'walk',\s*'run'\]\)/,
    "IDLE_CHAIN_STATES 必须恰好是 idle/walk/run（改回 ['idle'] 就是 §13.2 R1 的回退，必须有人红）",
  );
  assert.match(
    source,
    /MOTION_REST_STATES[^=]*=\s*Object\.freeze\(\[\s*'sleepy',\s*'sleeping',\s*'lie',\s*'drag',?\s*\]\)/s,
    'MOTION_REST_STATES 必须恰好是 sleepy/sleeping/lie/drag',
  );

  // ② "放开抑制的那一拍只认第一档"
  const heldIndex = source.indexOf('if (heldBefore) {');
  assert.ok(heldIndex > 0, 'tick() 里必须有 if (heldBefore) 分支（少了它，关掉开关的瞬间猫会直接睡过去）');
  const afterHeld = source.indexOf('if (idleMs >= SLEEP_AFTER_IDLE_MS)', heldIndex);
  assert.ok(afterHeld > heldIndex, 'heldBefore 分支之后必须紧跟常规三档（否则 tick 的档位结构变了）');
  const heldBlock = source.slice(heldIndex, afterHeld);
  assert.match(heldBlock, /SIT_AFTER_IDLE_MS/, '放开那一拍必须落 20s 档（先坐）');
  assert.doesNotMatch(heldBlock, /SLEEP_AFTER_IDLE_MS|SLEEPY_AFTER_IDLE_MS/, '放开那一拍**不许**直接判困倦/睡着（跳档）');

  // ③ 运动事件绝不写 lastInteractionAt：把每一处写入的"所属方法"取出来对白名单
  const lines = source.split(/\r?\n/);
  const enclosing = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/this\.lastInteractionAt\s*=/.test(lines[index])) continue;
    let owner = '<unknown>';
    for (let back = index; back >= 0; back -= 1) {
      const match =
        lines[back].match(/^ {2}(?:private |public |protected )?(?:readonly )?([A-Za-z_$][\w$]*)\s*\(/) ||
        lines[back].match(/^ {2}(?:get|set) ([A-Za-z_$][\w$]*)\(/);
      if (match) {
        owner = match[1];
        break;
      }
    }
    enclosing.push(owner);
  }
  assert.ok(enclosing.length >= 5, `必须真的找到写入点（实际 ${enclosing.length} 处）`);
  const allowed = [
    'constructor',
    'resumeFromRest',
    'reset',
    'restore',
    'markInteraction',
    'enterState',
    'tap',
    'startDrag',
    'endDrag',
  ];
  const unexpected = enclosing.filter((name) => !allowed.includes(name));
  assert.deepEqual(
    unexpected,
    [],
    `lastInteractionAt 出现了未经评审的写入点：${JSON.stringify(unexpected)}` +
      '（运动事件 move-start/move-gait/move-end 写它会让空闲链断掉，见设计 §5.3 / P-M13）',
  );
  for (const name of ['startMove', 'finishMove']) {
    assert.ok(!enclosing.includes(name), `${name} 里不许写 lastInteractionAt（自主移动不是用户交互）`);
  }
});

// ================================================================ E · IPC 载荷对抗

/**
 * 载入 `pet-preload.cjs`（真跑，用一个假的 electron）。
 *
 * @returns {{api: object, invokeCalls: object[]}} 桥对象与调用记录
 */
function loadPreload() {
  const invokeCalls = [];
  const exposed = { api: null };
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld: (key, api) => {
        exposed.key = key;
        exposed.api = api;
      },
    },
    ipcRenderer: {
      invoke: (channel, payload) => {
        invokeCalls.push({ channel, payload });
        return Promise.resolve({ ok: true });
      },
      send: (channel, payload) => {
        invokeCalls.push({ channel, payload, oneWay: true });
      },
      on: () => {},
      removeListener: () => {},
    },
  };
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, parent, isMain);
  };
  const preloadPath = path.join(FRONTEND_ROOT, 'electron', 'pet-preload.cjs');
  delete require.cache[preloadPath];
  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }
  assert.equal(exposed.key, 'petAPI', '前置：preload 必须把桥挂在 petAPI 上');
  return { api: exposed.api, invokeCalls };
}

test('E1 preload：behavior 非字符串一律丢弃；未知 mode 只做形状收敛（判定权在主进程）', () => {
  const { api, invokeCalls } = loadPreload();
  const send = (payload) => {
    invokeCalls.length = 0;
    api.motionIntent(payload);
    return invokeCalls[0] ? invokeCalls[0].payload : undefined;
  };

  assert.deepEqual(
    send({ mode: 'roam', reason: 'dev', behavior: 'sleeping' }),
    { mode: 'roam', reason: 'dev', behavior: 'sleeping' },
    '合法载荷必须逐字段透传（含 behavior）',
  );

  for (const value of [42, 0, null, true, ['sleeping'], { toString: () => 'sleeping' }, () => 'sleeping']) {
    const payload = send({ mode: 'roam', reason: 'dev', behavior: value });
    assert.equal('behavior' in payload, false, `behavior=${String(value)} 必须被白名单丢掉（否则主进程闸门收到垃圾）`);
    assert.deepEqual(payload, { mode: 'roam', reason: 'dev' });
  }

  // 原型污染：`__proto__` 作为**自有属性**（JSON.parse 的真实形态）不许泄漏成 behavior
  const polluted = JSON.parse('{"mode":"roam","reason":"dev","__proto__":{"behavior":"sleeping"}}');
  assert.equal('behavior' in send(polluted), false, 'JSON.parse 出的 __proto__ 自有属性不许被当成 behavior');

  assert.deepEqual(
    send({ mode: 'fly', reason: 'dev' }),
    { mode: 'fly', reason: 'dev' },
    '未知 mode 必须原样交给主进程判（判定权唯一）',
  );
  assert.deepEqual(send({ mode: 42, reason: 'dev' }), { reason: 'dev' }, '非字符串 mode 必须丢掉');
  assert.deepEqual(send(null), {}, 'null 载荷必须退化成空对象（不抛）');
  assert.deepEqual(send('roam'), {}, '字符串载荷必须退化成空对象（不抛）');

  // 超长字符串会透传（报告 Q-M2 记录项：主进程 reportBehavior 无长度上限）
  assert.equal(send({ mode: 'roam', reason: 'dev', behavior: 'x'.repeat(100_000) }).behavior.length, 100_000);
});

test('E2 preload + 偏好端口：prefs-set 只认布尔，未知键与字符串布尔一律丢弃', () => {
  const { api, invokeCalls } = loadPreload();
  const send = (patch) => {
    invokeCalls.length = 0;
    api.prefsSet(patch);
    return invokeCalls[0].payload;
  };
  assert.deepEqual(send({ follow: 'yes' }), {}, 'follow:"yes" 必须被丢弃（不接受真值转换）');
  assert.deepEqual(send({ roam: 'false' }), {}, 'roam:"false" 必须被丢弃（字符串不是布尔）');
  assert.deepEqual(send({ follow: 1 }), {}, '数字 1 不是布尔');
  assert.deepEqual(send({ follow: true, roam: false }), { follow: true, roam: false });
  assert.deepEqual(send({ follow: true, extra: 'x' }), { follow: true }, '未知键必须忽略');

  // 主进程侧同一份判据（applyPrefsPatch）：字符串布尔必须不改变任何字段
  const store = { write: () => ({ ok: true, problems: [] }) };
  const result = applyPrefsPatch({ store, prefs: { version: 1, follow: false, roam: true }, patch: { follow: 'yes' } });
  assert.equal(result.prefs.follow, false, 'follow:"yes" 不许把 false 变成 true');
  assert.equal(result.prefs.roam, true);
  assert.equal(result.changed, false, '没变就必须如实说 changed:false（否则会触发一次无意义的广播与菜单重建）');
});

test('E3 主进程 IPC：未知 mode / 缺 reason / 畸形载荷都必须拒而不崩', () => {
  const stage = makeStage(null);
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc }) => {
        const event = ipc.eventFor(win);
        for (const payload of [null, 'roam', [], 0, { mode: 'fly', reason: 'dev' }, { mode: 'roam' }]) {
          const result = ipc.invoke('pet:motion-intent', payload, event);
          assert.equal(result.ok, false, `畸形载荷 ${JSON.stringify(payload)} 必须被拒`);
          assert.equal(typeof result.error, 'string', '拒绝必须带可读原因');
        }
        assert.equal(controller.motionSnapshot().mode, 'off', '畸形载荷不许改变模式');
        assert.ok(controller.motionSnapshot().refusals > 0, '拒绝必须计数');
      },
      { prefs: makePrefsPort().port },
    );
  } finally {
    stage.cleanup();
  }
});

test('E4 主进程 IPC：同一次 invoke 里"刚要睡 + 开漫游"必须被闸住（顺序固定：先记录、再判）', () => {
  const stage = makeStage(null);
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc }) => {
        const event = ipc.eventFor(win);
        const result = ipc.invoke('pet:motion-intent', { mode: 'roam', reason: 'dev', behavior: 'sleeping' }, event);
        assert.equal(result.ok, false, '同一次调用里上报睡觉 + 请求漫游 ⇒ 必须先记录再判，否则就放过去了');
        assert.equal(result.reason, 'behavior-blocked');
        assert.equal(controller.motionSnapshot().mode, 'off');
        assert.equal(controller.motionSnapshot().behavior, 'sleeping');

        const awake = ipc.invoke('pet:motion-intent', { mode: 'roam', reason: 'dev', behavior: 'idle' }, event);
        assert.deepEqual(awake, { ok: true }, '醒后同一请求必须受理（"醒来永不恢复"必须被守住）');
        assert.equal(controller.motionSnapshot().mode, 'roam');
      },
      { prefs: makePrefsPort({ roam: true }).port },
    );
  } finally {
    stage.cleanup();
  }
});

test('E5 主进程 IPC：窗口销毁后读快照返回 null、发意图被拒（不许抛）', () => {
  const stage = makeStage(null);
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc }) => {
        const event = ipc.eventFor(win);
        assert.notEqual(controller.motionSnapshot(), null, '前置：销毁前快照必须可读');
        controller.destroy();
        assert.equal(controller.motionSnapshot(), null, '窗口销毁后快照必须返回 null（不许让调用方崩）');
        const after = ipc.invoke('pet:motion-intent', { mode: 'roam', reason: 'dev' }, event);
        assert.equal(after.ok, false, '窗口销毁后意图必须被拒');
        assert.equal(typeof after.error, 'string');
      },
      { prefs: makePrefsPort({ roam: true }).port },
    );
  } finally {
    stage.cleanup();
  }
});

test('E6 【Q-M1 · 疑似缺陷】拖拽坐标溢出成 Infinity 时，异常不许抛进 ipcMain 监听器', () => {
  const stage = makeStage(null);
  try {
    withPetWindow(
      stage,
      ({ win, ipc, state }) => {
        const event = ipc.eventFor(win);
        assert.deepEqual(ipc.invoke('pet:drag-start', { cursorX: -1e308, cursorY: 0 }, event), { ok: true });
        // dragOffset = round(-1e308) - bounds.x ⇒ 后续 candidate.x = 1e308 - (-1e308) = Infinity
        const movesBefore = state.moves.length;
        assert.doesNotThrow(
          () => ipc.send('pet:drag-move', { cursorX: 1e308, cursorY: 0 }, event),
          'pet:drag-move 处理器没有 try/catch：派生候选点溢出成 Infinity 时 TypeError 会直接抛进 ipcMain 监听器' +
            '（主进程未捕获异常）。期望：dragTo 把"派生候选点非有限"收敛成 return false（这一拍不动）。',
        );
        assert.equal(state.moves.length, movesBefore, '溢出这一拍必须 0 写入');
      },
      { prefs: makePrefsPort({ roam: true }).port },
    );
  } finally {
    stage.cleanup();
  }
});

// ================================================================ F · 静态门禁可被规避的写法

/** 载入门禁模块（ESM 动态 import；只读，不改任何文件）。 */
async function loadGate() {
  if (!loadGate.cached) {
    loadGate.cached = await import(
      pathToFileURL(path.join(FRONTEND_ROOT, 'scripts', 'check-pet-motion.mjs')).href
    );
  }
  return loadGate.cached;
}

/** 造一份只含指定文件的"源码表"。 */
function sourcesOf(pairs) {
  return new Map(Object.entries(pairs));
}

test('F1 G-M1（无自重时钟）：普通写法与注释写法都抓得住，字符串拼接能被绕过', async () => {
  const gate = await loadGate();
  const check = (source) => gate.checkNoTicker(sourcesOf({ 'electron/pet-motion.cjs': source }));

  assert.deepEqual(check('const MOTION = Object.freeze({});\n'), [], '基线：干净源码必须 0 命中');
  assert.equal(check('const MOTION = {};\nconst t = setInterval(fn, 16);\n').length, 1, '裸 setInterval 必须被抓');
  assert.equal(check('const MOTION = {};\nconst t = setTimeout(fn, 16);\n').length, 1, '裸 setTimeout 必须被抓');
  assert.equal(
    check('const MOTION = {};\n// 这里写一句 setInterval 也会被抓（门禁连注释都算）\n').length,
    1,
    '注释里写关键字也会被抓（这是有意的：禁词连注释都不许出现，避免"注释里留着将来有人解开"）',
  );
  assert.equal(
    check("const MOTION = {};\nconst t = globalThis['setInterval'](fn, 16);\n").length,
    1,
    '方括号取属性仍然含字面量 setInterval ⇒ 抓得住',
  );
  assert.deepEqual(
    check("const MOTION = {};\nconst tick = globalThis['set' + 'Interval'](fn, 16);\n"),
    [],
    '【已知局限】字符串拼接绕过 G-M1（文本门禁挡的是无意漂移，不是蓄意绕过）',
  );
});

test('F2 G-M5（pet-window 里 setPosition 计 0）：裸调用抓得住，方括号取属性绕过', async () => {
  const gate = await loadGate();
  const check = (source) => gate.checkWindowPositionWriter(sourcesOf({ 'electron/pet-window.cjs': source }));
  assert.deepEqual(check('function f(win) { win.setBounds({ x: 1 }); }\n'), [], '基线：setBounds 不算 setPosition');
  assert.equal(check('function f(win) { win.setPosition(1, 2); }\n').length, 1, '裸 setPosition 必须被抓');
  assert.deepEqual(
    check("function f(win) { win['setPosition'](1, 2); }\n"),
    [],
    '【已知局限】方括号取属性绕过 G-M5：单写者因此还必须由运行时用例（A1/A6）兜住',
  );
});

test('F3 G-M8（唯一写口）：体内恰好 1 处是对的，体外用 .call / 方括号绕过计数', async () => {
  const gate = await loadGate();
  const check = (source) => gate.checkSinglePositionWriter(sourcesOf({ 'electron/pet-motion.cjs': source }));
  const good = [
    'class C {',
    '  applyPosition(token, x, y) {',
    '    this.setWindowPosition(x, y);',
    '  }',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(check(good), [], '基线：体内恰好一处 ⇒ 0 命中');
  assert.equal(
    check(`${good}function leak(x, y) { this.setWindowPosition(x, y); }\n`).length,
    1,
    '体外多一处直接调用必须被抓（这是 G-M8 的核心判据）',
  );
  assert.deepEqual(
    check(`${good}function leak(x, y) { this.setWindowPosition?.call(null, x, y); }\n`),
    [],
    '【已知局限】`.call(...)` 让"标识符 + ("不再相邻 ⇒ 体外写入不被发现',
  );
  assert.deepEqual(
    check(`${good}function leak(x, y) { this['setWindowPosition'](x, y); }\n`),
    [],
    '【已知局限】方括号取属性同样绕过',
  );
});

test('F4 G-M4（手感数字不许复制）：直接赋值被抓，拆成两行绕过', async () => {
  const gate = await loadGate();
  const files = {
    'electron/pet-window.cjs': '',
    'electron/main.cjs': '',
    'electron/pet-menu.cjs': '',
    'electron/pet-hit-poller.cjs': '',
    'src/pet/main.ts': '',
    'scripts/pet-motion-probe.cjs': '',
  };
  const check = (line) => gate.checkNoBakedHandfeel(sourcesOf({ ...files, 'electron/pet-window.cjs': line }));

  assert.deepEqual(check('const x = 1;\n'), [], '基线：无关行必须 0 命中');
  assert.ok(check('const followStartRadiusDip = 220;\n').length >= 1, '直接给手感常量赋值必须被抓');
  assert.ok(check('const followStartRadiusDip = Number("220");\n').length >= 1, '字面量 220 落在运动语义行上必须被抓');
  assert.deepEqual(
    check('const k = 220;\nconst followStartRadiusDip = k;\n'),
    [],
    '【已知局限】把 220 挪到无运动语义的行、再用变量名转一手 ⇒ G-M4 抓不住',
  );
});

test('F5 G-M10（单一通道）：自造通道与坐标字段被抓；字符串拼接因"次数不为 1"仍然报错（fail-safe）', async () => {
  const gate = await loadGate();
  const base = (render) => ({
    'src/pet/main.ts': render,
    'src/pet/behavior/state-machine.ts': '',
    'electron/pet-window.cjs': '',
  });
  const okRender = [
    "const INTENT = 'pet:motion-intent';",
    'interface MotionIntent { mode: string; reason: string; behavior: string; }',
    'export const x = 1;',
    '',
  ].join('\n');
  assert.deepEqual(
    gate.checkSingleChannel(sourcesOf(base(okRender))),
    [],
    '基线：恰好一处字面量 + 无坐标字段 ⇒ 0 命中',
  );

  const extraChannel = gate.checkSingleChannel(
    sourcesOf({ ...base(okRender), 'electron/pet-window.cjs': "ipcMain.handle('pet:motion-set-position', () => {});\n" }),
  );
  assert.equal(extraChannel.length, 1, '自造运动通道必须被抓（这是"渲染层不许指定坐标"的守卫）');

  const withCoord = gate.checkSingleChannel(
    sourcesOf(
      base(
        [
          "const INTENT = 'pet:motion-intent';",
          'interface MotionIntent {',
          '  mode: string;',
          '  x?: number;',
          '}',
          '',
        ].join('\n'),
      ),
    ),
  );
  assert.equal(withCoord.length, 1, 'interface MotionIntent 出现坐标字段必须被抓');

  const concat = gate.checkSingleChannel(
    sourcesOf(
      base(["const INTENT = 'pet:motion-' + 'intent';", 'interface MotionIntent { mode: string; }', ''].join('\n')),
    ),
  );
  assert.equal(
    concat.length,
    1,
    '字符串拼接让"恰好 1 次"变成 0 次 ⇒ 仍然报错（这条判据在绕过方向上 fail-safe，方向是对的）',
  );
});

test('F6 真仓库基线：文本门禁对当前源码 0 命中（上面那些绕过的前提是"没人这么写"）', async () => {
  const gate = await loadGate();
  const sources = gate.loadSources();
  assert.ok(sources.size > 10, `源码表必须真的读到文件（实际 ${sources.size} 份）`);
  assert.deepEqual(gate.checkNoTicker(sources), [], '真仓库里 pet-motion.cjs 不许有自重时钟');
  assert.deepEqual(gate.checkWindowPositionWriter(sources), [], '真仓库里 pet-window.cjs 不许有 setPosition');
  assert.deepEqual(gate.checkSinglePositionWriter(sources), [], '真仓库里 applyPosition 必须恰好一处定义、一处写入');
  assert.deepEqual(gate.checkSingleChannel(sources), [], '真仓库里运动通道名与意图契约必须合规');
});



