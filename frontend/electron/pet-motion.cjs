#!/usr/bin/env node
/**
 * M3 S1 · 运动配置**单一真源** + **纯运动学**（无 I/O、无定时器、无 Electron）。
 *
 * <p><b>这个文件为什么必须先立起来：</b>M3 的手感参数（追停半径、步态双阈值、速度带、
 * 加减速、漫游间隔/停留/上限/边距/角落偏好）只允许有**一份**数字。设计 §3.3.3 的裁决是
 * "一个 `Object.freeze` 的 `MOTION` 常量"，理由有三条：</p>
 * <ol>
 *   <li><b>只有主进程与门禁要读</b>（渲染层只收 `gait` 字符串，它不算速度）——
 *       所以不需要 `pet-geometry.json` 那种"三方共读"的 JSON；</li>
 *   <li><b>随包分发</b>：`package.json` 的 `build.files` 只含 `dist/**`、`electron/**`、
 *       `package.json`，放 `electron/*.cjs` 天然在包里；放 `frontend/*.json` 会被排除在外
 *       （那正是 `pet-geometry.json` 只能"条件 require"的原因，不该再复制一份隐患）；</li>
 *   <li><b>门禁与单测直接 `require` 它做行为断言</b>（不靠正则去猜源码里的数字）。</li>
 * </ol>
 *
 * <p><b>本文件在 S1 的边界（生产行为零变化）：</b>没有任何模块 `require` 它，
 * 它自己**不 require 任何东西**（零依赖，node 里 `require` 即可加载，不需要 Electron）。
 * 接线（`pet-window.cjs` 的唯一写口、`main.cjs` 的托盘）属于 S2/S4——本片禁止触碰那些文件。</p>
 *
 * <p><b>三条禁词（设计 §4.2 / G-M2 / G-M3，本文件必须恒为 0 次命中）：</b></p>
 * <ul>
 *   <li><b>不许自带第二个时钟</b>：既不用定时器全局函数给运动起拍，也不自己排延时
 *       （L1：唯一 ticker 是 `pet-hit-poller.cjs` 的 16ms，运动只能订阅它）；</li>
 *   <li><b>位置写入只有一个出口</b>：本文件不直接调用窗口定位 API
 *       （L2：唯一写口 `applyPosition` 在 S4 落地，它调注入进来的回调）；</li>
 *   <li><b>DIP 纯度</b>：不读任何屏幕缩放比例、不读像素比、不做单位换算
 *       （U-M5：混合 DPI 不做速度补偿，已登记为已知限制）。</li>
 * </ul>
 *
 * <p>上面三条之所以只用文字描述而**不写出那些标识符**：门禁 G-M2/G-M3 是**文本计数**断言
 * （注释也算命中），写出来就会把本文件自己判红。</p>
 *
 * @module electron/pet-motion
 */

'use strict';

/**
 * 采样周期（毫秒）。**必须恒等于** `pet-hit-poller.cjs` 的 `intervalMs`：
 * 运动不新起定时器，直接复用命中轮询的那一拍（设计 §4.1 的 L1）。
 *
 * <p>门禁 G-M2 会断言本文件里的定时器全局函数出现 0 次（注释也算命中，所以这里不写出它们）——"两个时钟抢写"
 * 这个前提被删除，而不是靠 `if` 分先后。</p>
 */
const TICK_MS = 16;

/** 启动半径（DIP）：光标离宠物中心 **≥** 这个值才起追（设计 §6.1）。 */
const FOLLOW_START_RADIUS_DIP = 220;

/** 停止半径（DIP）：**≤** 这个值即停。`start ≥ stop + 40`（滞回带，门禁 G-M5）。 */
const FOLLOW_STOP_RADIUS_DIP = 96;

/** 步态进 `run` 的距离阈值（DIP）：`≥ 420` 才可能跑。 */
const GAIT_RUN_RADIUS_DIP = 420;

/** 步态退回 `walk` 的距离阈值（DIP）：`< 320` 一律走；中间带保持当前步态（滞回）。 */
const GAIT_WALK_RADIUS_DIP = 320;

/** 走速带下限（DIP/秒）。 */
const WALK_MIN_DIP_PER_SEC = 56;

/** 走速带上限（DIP/秒）。 */
const WALK_MAX_DIP_PER_SEC = 96;

/** 跑速带下限（DIP/秒）。 */
const RUN_MIN_DIP_PER_SEC = 150;

/** 跑速带上限（DIP/秒）。 */
const RUN_MAX_DIP_PER_SEC = 240;

/**
 * 加速度（DIP/秒²）：从 0 到 `walkMin 56` 需 `56 / 480 ≈ 117ms`（≈7 拍）——
 * 用户看到的是"刚起步就已经是走姿态"，不是"站着滑一段再开始走"（设计 §7.3）。
 */
const ACCEL_DIP_PER_SEC2 = 480;

/**
 * 减速度（DIP/秒²）：刹车距离 `96² / (2×960) = 4.8 DIP`，远小于停止半径 96，
 * 所以正常接近时**几乎全程匀速、最后一拍停住**（不会"远远就开始龟速爬行"）。
 * `decel > accel` 是"停得住"的必要条件（门禁 G-M5）。
 */
const DECEL_DIP_PER_SEC2 = 960;

/**
 * 朝向翻转滞回（DIP）：只有反向位移**超过**它才翻向。
 *
 * <p>光标在宠物正上方来回微动时 `dx` 会在 0 附近抖，没有滞回就是"每拍翻一次头"。</p>
 */
const FACING_FLIP_HYSTERESIS_DIP = 24;

/** 漫游两轮间隔下限（毫秒）。 */
const ROAM_MIN_INTERVAL_MS = 8000;

/** 漫游两轮间隔上限（毫秒）。 */
const ROAM_MAX_INTERVAL_MS = 20000;

/** 到达漫游目标后的站定时长（毫秒）：站定结束才开始下一轮计时。 */
const ROAM_DWELL_MS = 4000;

/** 单次漫游时长上限（毫秒）：超过即放弃目标并站定（`phase:'aborted'`）。 */
const ROAM_MAX_DURATION_MS = 6000;

/** 角落偏好概率：`rng() < 0.5` ⇒ 从四角的边距内缩点里挑（"角落待机"）。 */
const ROAM_CORNER_BIAS = 0.5;

/** 漫游目标四周内缩（DIP）：同时保证**整个窗口**留在工作区内。 */
const ROAM_MARGIN_DIP = 48;

/**
 * 运动配置的**单一真源**（冻结，含嵌套冻结）。
 *
 * <p><b>两种命名为什么同时存在（不是第二份数字）：</b>设计 §3.3.3 给的是扁平名
 * （`walkMinDipPerSec` / `facingFlipHysteresisDip` …），S4 与门禁按它取；任务书额外要求
 * 分组视图（`walkSpeedDipPerSec: {min,max}` / `facingHysteresisDip`）。两者**共用上面同一批
 * 常量**，因此"改一处"仍然只改一处——`tests/petMotion.test.cjs` 有一条断言钉死
 * "分组视图与扁平视图逐值相等"，任何一侧被单独手改成新数字都会立刻红。</p>
 *
 * <p><b>改这个对象前请先读 U-M1</b>：手感参数（220/96/320/420/56–96/150–240/480/960/24）
 * 是设计初值，**真机观感由主理人定**；调整只允许改这里的数值，不许在别处硬编码
 * （门禁 G-M4「禁烘焙数字」对新文件**一开始就硬失败**，M3 的 U-M6 裁决）。</p>
 */
const MOTION = Object.freeze({
  // —— 时钟（L1：与 HitPoller 同一拍）——
  tickMs: TICK_MS,

  // —— 跟随滞回带（§6.1）——
  followStartRadiusDip: FOLLOW_START_RADIUS_DIP,
  followStopRadiusDip: FOLLOW_STOP_RADIUS_DIP,

  // —— 步态双阈值（§6.1：run 420 / walk 320，中间带保持现相）——
  gaitRunRadiusDip: GAIT_RUN_RADIUS_DIP,
  gaitWalkRadiusDip: GAIT_WALK_RADIUS_DIP,

  // —— 速度带（DIP/秒，§7.2 步幅匹配）——
  walkMinDipPerSec: WALK_MIN_DIP_PER_SEC,
  walkMaxDipPerSec: WALK_MAX_DIP_PER_SEC,
  runMinDipPerSec: RUN_MIN_DIP_PER_SEC,
  runMaxDipPerSec: RUN_MAX_DIP_PER_SEC,

  // —— 加减速（DIP/秒²）——
  accelDipPerSec2: ACCEL_DIP_PER_SEC2,
  decelDipPerSec2: DECEL_DIP_PER_SEC2,

  // —— 朝向滞回（§4.4）——
  facingFlipHysteresisDip: FACING_FLIP_HYSTERESIS_DIP,

  // —— 漫游（§6.2）——
  roamMinIntervalMs: ROAM_MIN_INTERVAL_MS,
  roamMaxIntervalMs: ROAM_MAX_INTERVAL_MS,
  roamDwellMs: ROAM_DWELL_MS,
  roamMaxDurationMs: ROAM_MAX_DURATION_MS,
  roamCornerBias: ROAM_CORNER_BIAS,
  roamMarginDip: ROAM_MARGIN_DIP,

  // —— 分组视图（任务书的字段名，与上面扁平名共用同一批常量）——
  walkSpeedDipPerSec: Object.freeze({ min: WALK_MIN_DIP_PER_SEC, max: WALK_MAX_DIP_PER_SEC }),
  runSpeedDipPerSec: Object.freeze({ min: RUN_MIN_DIP_PER_SEC, max: RUN_MAX_DIP_PER_SEC }),
  facingHysteresisDip: FACING_FLIP_HYSTERESIS_DIP,
});

/** 跟随相位的全部取值（升序无关，仅作枚举校验）。 */
const FOLLOW_PHASES = Object.freeze(['idle', 'chase', 'arrived']);

/** 步态的全部取值（`none` 由调用方在"没在动"时自己表示，不在本模块的步态判据里）。 */
const GAITS = Object.freeze(['walk', 'run']);

/**
 * 断言是有限数值（参数校验；不合法直接 `TypeError`，绝不"猜一下继续跑"）。
 *
 * @param {unknown} value 待校验值
 * @param {string} name 参数名（报错文案用）
 * @returns {number} 数值
 * @throws {TypeError} 不是有限数值
 */
function requireFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`[pet-motion] ${name} 必须是有限数值，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 断言是 `{x, y}` 点（DIP）。
 *
 * @param {unknown} value 待校验值
 * @param {string} name 参数名
 * @returns {{x: number, y: number}} 点
 * @throws {TypeError} 结构非法
 */
function requirePoint(value, name) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`[pet-motion] ${name} 必须是 {x, y} 对象，实际为 ${JSON.stringify(value)}`);
  }
  const point = /** @type {{x?: unknown, y?: unknown}} */ (value);
  return {
    x: requireFiniteNumber(point.x, `${name}.x`),
    y: requireFiniteNumber(point.y, `${name}.y`),
  };
}

/**
 * 断言是 `{x, y, width, height}` 矩形（DIP）。
 *
 * @param {unknown} value 待校验值
 * @param {string} name 参数名
 * @returns {{x: number, y: number, width: number, height: number}} 矩形
 * @throws {TypeError} 结构非法或宽高为负
 */
function requireRect(value, name) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`[pet-motion] ${name} 必须是 {x,y,width,height} 对象，实际为 ${JSON.stringify(value)}`);
  }
  const rect = /** @type {Record<string, unknown>} */ (value);
  const result = {
    x: requireFiniteNumber(rect.x, `${name}.x`),
    y: requireFiniteNumber(rect.y, `${name}.y`),
    width: requireFiniteNumber(rect.width, `${name}.width`),
    height: requireFiniteNumber(rect.height, `${name}.height`),
  };
  if (result.width < 0 || result.height < 0) {
    throw new TypeError(`[pet-motion] ${name} 的宽高不能为负，实际为 ${result.width}×${result.height}`);
  }
  return result;
}

/**
 * 断言是 `{width, height}` 尺寸（不要求 x/y）。
 *
 * @param {unknown} value 待校验值
 * @param {string} name 参数名
 * @returns {{width: number, height: number}} 尺寸
 * @throws {TypeError} 结构非法或宽高为负
 */
function requireSize(value, name) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`[pet-motion] ${name} 必须是 {width,height} 对象，实际为 ${JSON.stringify(value)}`);
  }
  const size = /** @type {Record<string, unknown>} */ (value);
  const result = {
    width: requireFiniteNumber(size.width, `${name}.width`),
    height: requireFiniteNumber(size.height, `${name}.height`),
  };
  if (result.width < 0 || result.height < 0) {
    throw new TypeError(`[pet-motion] ${name} 的宽高不能为负，实际为 ${result.width}×${result.height}`);
  }
  return result;
}

/**
 * 决定跟随相位（**滞回带**语义，设计 §6.1）。
 *
 * <p>三条规则（中间的滞回带是**保持现相**，不是"就近取一个"）：</p>
 * <ol>
 *   <li>`chase` 且距离 ≤ {@link MOTION.followStopRadiusDip} ⇒ `arrived`；否则继续 `chase`；</li>
 *   <li>`arrived` 且距离 < {@link MOTION.followStartRadiusDip} ⇒ 保持 `arrived`（**不许抖回**）；否则重新 `chase`；</li>
 *   <li>`idle` 且距离 ≥ `followStartRadiusDip` ⇒ `chase`；否则保持 `idle`。</li>
 * </ol>
 *
 * <p><b>为什么必须有滞回（这是本函数存在的唯一理由）：</b>单阈值时，光标停在 96 DIP 附近
 * 每拍都在"追/停"之间翻——用户看到猫"走 1px 停 1px"地抽搐。96→220 这 124 DIP 的带里
 * **什么都不做**才是对的（用户小幅移动鼠标时猫不该重启动）。</p>
 *
 * @param {{distanceDip: number, phase: 'idle'|'chase'|'arrived',
 *   followStartRadiusDip?: number, followStopRadiusDip?: number}} options 入参
 * @returns {'idle'|'chase'|'arrived'} 下一拍相位
 * @throws {TypeError} `phase` 不在枚举内 / `distanceDip` 非有限数值 / 半径非法
 */
function decideFollowPhase(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('[pet-motion] decideFollowPhase 需要 {distanceDip, phase} 对象');
  }
  const distanceDip = requireFiniteNumber(options.distanceDip, 'decideFollowPhase.distanceDip');
  if (distanceDip < 0) {
    throw new RangeError(`[pet-motion] decideFollowPhase.distanceDip 不能为负，实际为 ${distanceDip}`);
  }
  const phase = options.phase;
  if (!FOLLOW_PHASES.includes(phase)) {
    throw new TypeError(`[pet-motion] decideFollowPhase.phase 必须是 ${FOLLOW_PHASES.join('/')}，实际为 ${JSON.stringify(phase)}`);
  }
  const startRadius = requireFiniteNumber(
    options.followStartRadiusDip === undefined ? MOTION.followStartRadiusDip : options.followStartRadiusDip,
    'decideFollowPhase.followStartRadiusDip',
  );
  const stopRadius = requireFiniteNumber(
    options.followStopRadiusDip === undefined ? MOTION.followStopRadiusDip : options.followStopRadiusDip,
    'decideFollowPhase.followStopRadiusDip',
  );
  if (!(stopRadius > 0) || !(startRadius > stopRadius)) {
    throw new RangeError(
      `[pet-motion] 滞回带非法：startRadius(${startRadius}) 必须 > stopRadius(${stopRadius}) > 0`,
    );
  }
  if (phase === 'chase') return distanceDip <= stopRadius ? 'arrived' : 'chase';
  if (phase === 'arrived') return distanceDip >= startRadius ? 'chase' : 'arrived';
  return distanceDip >= startRadius ? 'chase' : 'idle';
}

/**
 * 决定步态（**双阈值**，设计 §6.1）。
 *
 * <p>`≥ {@link MOTION.gaitRunRadiusDip}` ⇒ `run`；`< {@link MOTION.gaitWalkRadiusDip}` ⇒ `walk`；
 * **中间带保持 `currentGait`**——否则 `walk ↔ run` 每拍翻，用户看到"走两步跑一步"的抖。</p>
 *
 * @param {{distanceDip: number, currentGait?: 'walk'|'run',
 *   gaitRunRadiusDip?: number, gaitWalkRadiusDip?: number}} options 入参
 * @returns {'walk'|'run'} 步态
 * @throws {TypeError} `currentGait`/`distanceDip` 非法
 */
function decideGait(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('[pet-motion] decideGait 需要 {distanceDip, currentGait?} 对象');
  }
  const distanceDip = requireFiniteNumber(options.distanceDip, 'decideGait.distanceDip');
  if (distanceDip < 0) {
    throw new RangeError(`[pet-motion] decideGait.distanceDip 不能为负，实际为 ${distanceDip}`);
  }
  const currentGait = options.currentGait === undefined ? 'walk' : options.currentGait;
  if (!GAITS.includes(currentGait)) {
    throw new TypeError(`[pet-motion] decideGait.currentGait 必须是 ${GAITS.join('/')}，实际为 ${JSON.stringify(currentGait)}`);
  }
  const runRadius = requireFiniteNumber(
    options.gaitRunRadiusDip === undefined ? MOTION.gaitRunRadiusDip : options.gaitRunRadiusDip,
    'decideGait.gaitRunRadiusDip',
  );
  const walkRadius = requireFiniteNumber(
    options.gaitWalkRadiusDip === undefined ? MOTION.gaitWalkRadiusDip : options.gaitWalkRadiusDip,
    'decideGait.gaitWalkRadiusDip',
  );
  if (!(walkRadius > 0) || !(runRadius > walkRadius)) {
    throw new RangeError(
      `[pet-motion] 步态双阈值非法：runRadius(${runRadius}) 必须 > walkRadius(${walkRadius}) > 0`,
    );
  }
  if (distanceDip >= runRadius) return 'run';
  if (distanceDip < walkRadius) return 'walk';
  return currentGait;
}

/**
 * 朝目标走一步（**纯运动学**：浮点 DIP 累加，绝不把 round 后的值当累加基准）。
 *
 * <p><b>三个数值纪律（都踩过坑）：</b></p>
 * <ol>
 *   <li><b>浮点累加</b>：`position` 在内部是浮点 DIP，只有真正写窗口时才 `Math.round`
 *       （S4 的 `applyPosition`）。若先 round 再累加，速度 56 DIP/s（≈0.9 DIP/拍）会被
 *       连续取整成 0 或 1 ⇒ 低速时**卡在原地不动**（这是本函数第一条用例的存在理由）；</li>
 *   <li><b>刹车约束</b>：`vmax = min(speedLimit, √(2·accel·remaining))` —— 用同一套加速度
 *       反算"这个距离内还能停得住的速度"，保证接近目标时**不会冲过头再回来**；</li>
 *   <li><b>到达即吸附</b>：本拍位移 ≥ 剩余距离 ⇒ 直接落到目标点且 `speed = 0`、`arrived = true`
 *       （不产生"越过目标点再回弹"的抖动）。</li>
 * </ol>
 *
 * @param {{from: {x: number, y: number}, to: {x: number, y: number}, speedLimit: number,
 *   accel: number, currentSpeed?: number, dtMs: number}} options 入参
 *   `speedLimit` 单位 DIP/秒；`accel` 单位 DIP/秒²；`currentSpeed` 缺省 0；`dtMs` 本拍时长
 * @returns {{x: number, y: number, speed: number, arrived: boolean}} 新位置（浮点 DIP）、
 *   本拍速度（DIP/秒）与是否已到达
 * @throws {TypeError|RangeError} 参数非法
 */
function stepToward(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('[pet-motion] stepToward 需要 {from, to, speedLimit, accel, dtMs} 对象');
  }
  const from = requirePoint(options.from, 'stepToward.from');
  const to = requirePoint(options.to, 'stepToward.to');
  const speedLimit = requireFiniteNumber(options.speedLimit, 'stepToward.speedLimit');
  const accel = requireFiniteNumber(options.accel, 'stepToward.accel');
  const currentSpeed = options.currentSpeed === undefined ? 0 : requireFiniteNumber(options.currentSpeed, 'stepToward.currentSpeed');
  const dtMs = requireFiniteNumber(options.dtMs, 'stepToward.dtMs');
  if (speedLimit < 0) throw new RangeError(`[pet-motion] stepToward.speedLimit 不能为负，实际为 ${speedLimit}`);
  if (!(accel > 0)) throw new RangeError(`[pet-motion] stepToward.accel 必须 > 0，实际为 ${accel}`);
  if (currentSpeed < 0) throw new RangeError(`[pet-motion] stepToward.currentSpeed 不能为负，实际为 ${currentSpeed}`);
  if (dtMs < 0) throw new RangeError(`[pet-motion] stepToward.dtMs 不能为负，实际为 ${dtMs}`);

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const remaining = Math.hypot(dx, dy);
  if (remaining === 0) {
    return { x: to.x, y: to.y, speed: 0, arrived: true };
  }
  if (dtMs === 0 || speedLimit === 0) {
    // 本拍不推进（时钟没走 / 明确要求停）：不改变位置，也**不宣布到达**
    // （到达只由"真的够近了"决定，不由"速度 0"决定——否则首拍就会误报 arrived）
    return { x: from.x, y: from.y, speed: currentSpeed, arrived: false };
  }
  // 刹车约束：这个剩余距离内还能停得住的最大速度
  const brakeLimit = Math.sqrt(2 * accel * remaining);
  const desiredSpeed = Math.min(speedLimit, brakeLimit);
  const dtSec = dtMs / 1000;
  const speed =
    currentSpeed < desiredSpeed
      ? Math.min(desiredSpeed, currentSpeed + accel * dtSec)
      : Math.max(desiredSpeed, currentSpeed - accel * dtSec);
  const step = speed * dtSec;
  if (!(step > 0)) {
    return { x: from.x, y: from.y, speed, arrived: false };
  }
  if (step >= remaining) {
    return { x: to.x, y: to.y, speed: 0, arrived: true };
  }
  const unitX = dx / remaining;
  const unitY = dy / remaining;
  return {
    x: from.x + unitX * step,
    y: from.y + unitY * step,
    speed,
    arrived: false,
  };
}

/**
 * 决定朝向（**带滞回**，设计 §4.4）。
 *
 * <p>只有 `|dx|` **超过** {@link MOTION.facingFlipHysteresisDip} 且方向与当前朝向相反时才翻。
 * 光标在正上方微动时 `dx` 在 0 附近抖，没有滞回 ⇒ 每拍翻 ⇒ 用户看到"左右抖头"。</p>
 *
 * @param {{dx: number, currentFacing?: -1|1, hysteresisDip?: number}} options 入参
 * @returns {-1|1} 朝向（`1` = 面朝右，`-1` = 面朝左）
 * @throws {TypeError|RangeError} 参数非法
 */
function decideFacing(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('[pet-motion] decideFacing 需要 {dx, currentFacing?, hysteresisDip?} 对象');
  }
  const dx = requireFiniteNumber(options.dx, 'decideFacing.dx');
  const currentFacing = options.currentFacing === undefined ? -1 : options.currentFacing;
  if (currentFacing !== -1 && currentFacing !== 1) {
    throw new TypeError(`[pet-motion] decideFacing.currentFacing 必须是 -1 或 1，实际为 ${JSON.stringify(currentFacing)}`);
  }
  const hysteresisDip = requireFiniteNumber(
    options.hysteresisDip === undefined ? MOTION.facingFlipHysteresisDip : options.hysteresisDip,
    'decideFacing.hysteresisDip',
  );
  if (hysteresisDip < 0) {
    throw new RangeError(`[pet-motion] decideFacing.hysteresisDip 不能为负，实际为 ${hysteresisDip}`);
  }
  if (Math.abs(dx) <= hysteresisDip) return currentFacing;
  return dx > 0 ? 1 : -1;
}

/**
 * 算出"整窗都能待得住"的目标点范围（**整窗**内缩 {@link MOTION.roamMarginDip}）。
 *
 * <p>关键在"整窗"：只夹**中心点**是错的——中心点在内缩后的矩形里，窗口仍可能探出工作区
 * （窗口半宽 134 DIP 远大于 48 DIP 边距）。所以上界要减去窗口宽高：
 * `maxX = area.x + area.width − margin − window.width`。</p>
 *
 * <p>窗口 + 两侧边距都塞不进工作区时（极小屏 / 巨大边距），退回"贴在工作区左上角"——
 * 仍然保证**整个窗口**在工作区内（宁可贴边，也不许越界）。</p>
 *
 * @param {{workArea: {x: number, y: number, width: number, height: number},
 *   windowSize: {width: number, height: number}, marginDip?: number}} options 入参
 * @returns {{minX: number, maxX: number, minY: number, maxY: number}} 允许的目标点范围（DIP）
 * @throws {TypeError|RangeError} 参数非法
 */
function resolveRoamBounds(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('[pet-motion] resolveRoamBounds 需要 {workArea, windowSize} 对象');
  }
  const workArea = requireRect(options.workArea, 'resolveRoamBounds.workArea');
  const windowSize = requireSize(options.windowSize, 'resolveRoamBounds.windowSize');
  const marginDip = requireFiniteNumber(
    options.marginDip === undefined ? MOTION.roamMarginDip : options.marginDip,
    'resolveRoamBounds.marginDip',
  );
  if (marginDip < 0) throw new RangeError(`[pet-motion] resolveRoamBounds.marginDip 不能为负，实际为 ${marginDip}`);
  // 可用活动空间（窗口能放下的范围）
  const slackX = workArea.width - windowSize.width;
  const slackY = workArea.height - windowSize.height;
  if (slackX < 0 || slackY < 0) {
    // 窗口比工作区还大：只可能贴左上角，不能越界（再多夹也没意义）
    return {
      minX: workArea.x,
      maxX: workArea.x,
      minY: workArea.y,
      maxY: workArea.y,
    };
  }
  const marginX = Math.min(marginDip, slackX / 2);
  const marginY = Math.min(marginDip, slackY / 2);
  return {
    minX: workArea.x + marginX,
    maxX: workArea.x + slackX - marginX,
    minY: workArea.y + marginY,
    maxY: workArea.y + slackY - marginY,
  };
}

/**
 * 把**给定**目标点夹进"整窗不越界"的范围（`pickRoamTarget` 与 S4 的拖拽共用）。
 *
 * @param {{workArea: {x: number, y: number, width: number, height: number},
 *   windowSize: {width: number, height: number}, target: {x: number, y: number},
 *   marginDip?: number}} options 入参
 * @returns {{x: number, y: number}} 夹取后的目标点（DIP，浮点）
 * @throws {TypeError|RangeError} 参数非法
 */
function clampTargetToWorkArea(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('[pet-motion] clampTargetToWorkArea 需要 {workArea, windowSize, target} 对象');
  }
  const target = requirePoint(options.target, 'clampTargetToWorkArea.target');
  const bounds = resolveRoamBounds(options);
  /** 夹取单个轴。 */
  const clampAxis = (value, min, max) => (value < min ? min : value > max ? max : value);
  return {
    x: clampAxis(target.x, bounds.minX, bounds.maxX),
    y: clampAxis(target.y, bounds.minY, bounds.maxY),
  };
}

/**
 * 选一个漫游目标点（**整窗**在工作区内 + 角落偏好）。
 *
 * <p>两次随机数的用途固定，便于测试注入固定 `rng` 序列：</p>
 * <ol>
 *   <li>第 1 次：`rng() < cornerBias` ⇒ 走"角落待机"分支；否则均匀随机；</li>
 *   <li>角落分支：第 2 次 `rng()` 选出四角之一（`[左上, 右上, 左下, 右下]`）；</li>
 *   <li>均匀分支：第 2、3 次 `rng()` 分别给 x、y。</li>
 * </ol>
 *
 * <p><b>不许跨屏</b>（设计 §6.2）：入参给的是"窗口当前所在显示器"的 `workArea`，
 * 所以本函数天然只在当前屏内选点，不需要知道显示器列表。</p>
 *
 * @param {{workArea: {x: number, y: number, width: number, height: number},
 *   windowSize: {width: number, height: number}, rng?: () => number, cornerBias?: number,
 *   marginDip?: number}} options 入参
 * @returns {{x: number, y: number}} 目标点（DIP，浮点；整窗落在工作区内）
 * @throws {TypeError|RangeError} 参数非法（`rng` 返回值不在 `[0,1)` 也抛）
 */
function pickRoamTarget(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('[pet-motion] pickRoamTarget 需要 {workArea, windowSize} 对象');
  }
  const rng = options.rng === undefined ? Math.random : options.rng;
  if (typeof rng !== 'function') {
    throw new TypeError('[pet-motion] pickRoamTarget.rng 必须是函数');
  }
  const cornerBias = requireFiniteNumber(
    options.cornerBias === undefined ? MOTION.roamCornerBias : options.cornerBias,
    'pickRoamTarget.cornerBias',
  );
  if (cornerBias < 0 || cornerBias > 1) {
    throw new RangeError(`[pet-motion] pickRoamTarget.cornerBias 必须在 [0,1]，实际为 ${cornerBias}`);
  }
  const bounds = resolveRoamBounds(options);
  /** 取一个 `[0,1)` 随机数（越界即报错，不许"夹一下继续"）。 */
  const draw = (label) => {
    const value = rng();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError(`[pet-motion] pickRoamTarget.rng 第 ${label} 次返回 ${JSON.stringify(value)}，必须落在 [0,1)`);
    }
    return value;
  };
  if (draw('一') < cornerBias) {
    const corners = [
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.minY },
      { x: bounds.minX, y: bounds.maxY },
      { x: bounds.maxX, y: bounds.maxY },
    ];
    const index = Math.min(corners.length - 1, Math.floor(draw('二') * corners.length));
    return { ...corners[index] };
  }
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  /** 夹取单个轴（取整的浮点尾巴不许把点挤出"整窗在内"的闭区间）。 */
  const clampAxis = (value, min, max) => (value < min ? min : value > max ? max : value);
  return {
    x: clampAxis(roundToHundredth(bounds.minX + draw('二') * spanX), bounds.minX, bounds.maxX),
    y: clampAxis(roundToHundredth(bounds.minY + draw('三') * spanY), bounds.minY, bounds.maxY),
  };
}

/**
 * 把浮点坐标收敛到 1/100 DIP（**只为"随机点的可读性与可复现"**，不是累加基准）。
 *
 * <p>整窗判据用 `[min, max]` 闭区间；1/100 DIP 的取整只会让点更靠内（`maxX` 已留出
 * 窗口宽 + 边距），不会破坏"整窗在内"。</p>
 *
 * @param {number} value 浮点 DIP
 * @returns {number} 1/100 DIP
 */
function roundToHundredth(value) {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------- 运动控制器（S4）

/**
 * 位置写入权的持有者（设计 §3.3.1 的 `OwnerToken` / §5.1）。
 *
 * <p>`none` = 没有人能写（隐藏 / `mode==='off'`）；`locomotion` = 自主运动；
 * `drag` = 用户拖拽；`reclamp` = 显示器事件后的夹取。三处事件驱动、天然互斥。</p>
 */
const OWNER_TOKENS = Object.freeze({
  NONE: 'none',
  LOCOMOTION: 'locomotion',
  DRAG: 'drag',
  RECLAMP: 'reclamp',
});

/** 运动模式（`pet:motion-intent` 的 `mode` 枚举，§8.1）。 */
const MOTION_MODES = Object.freeze(['off', 'follow', 'roam']);

/** 意图原因（§8.1；非法原因直接拒绝，绝不"猜一个继续跑"）。 */
const MOTION_REASONS = Object.freeze(['prefs', 'idle-chain', 'interaction', 'dev']);

/**
 * **行为状态闸门**（S4.1 纵深防御）：这些行为态下主进程**自己**拒绝开启自主运动。
 *
 * <p><b>为什么要主进程再判一遍：</b>真机实测过——直接用 devtools 塞
 * `motionIntent({mode:'roam'})` 时，<b>即使渲染层报告自己是 `sleeping`，主进程运动层照样
 * 把猫平移了</b>。渲染层的"睡着就别动"只是**一层**防线，而它恰好是最容易绕过的一层
 * （devtools、旧版渲染层、渲染层进程重启后短暂丢失状态都会让这层失效）。
 * 主进程必须自己记住"渲染层最近告诉我它在干什么"，并在 `trySetMode` 里先过这道闸。</p>
 *
 * <p><b>为什么只有这三个：</b>它们都是"用户预期画面静止"的状态——睡着（`sleeping` /
 * `sleep`，后者是姿态名）与拖拽中（`drag`，此时写入权也已被拖拽独占）。`sleepy`（打盹→趴下）
 * 没有列入：它仍有清醒交互，且姿态切换本身需要位移能力，列进来会与 §8.2 的意图契约打架。</p>
 */
const BLOCKED_BEHAVIORS = Object.freeze(['sleeping', 'sleep', 'drag']);

/**
 * 行为状态闸门的判定表（导出给测试与门禁读，避免第二份字面量）。
 */
const MOTION_BEHAVIOR_GATE = Object.freeze({
  /** 拒绝时 `trySetMode` 返回的 `reason`。 */
  REASON: 'behavior-blocked',
  /** 会让主进程拒绝开启运动的行为态。 */
  BLOCKED: BLOCKED_BEHAVIORS,
});

/**
 * 运动控制器：**全仓唯一会移动窗口的组件**（设计 §4.1）。
 *
 * <p><b>三层结构（不是三条 `if`）：</b></p>
 * <ol>
 *   <li><b>L1 · 只有一个时钟</b>：本类**不注册任何定时器**，只通过注入的 `subscribeSample`
 *       订阅 `HitPoller` 那一拍（16ms）。"两个定时器抢写"这个前提被删除。</li>
 *   <li><b>L2 · 只有一个写口</b>：私有 {@link MotionController#applyPosition} 是本类里
 *       **唯一**触碰窗口坐标的地方，它调注入的 `setWindowPosition`（窗口层再转成一次
 *       `setBounds`）。窗口层自己不再有任何位置写入点。</li>
 *   <li><b>L3 · 订阅随所有权摘除</b>：拖拽开始就 `detach()`（把回调从订阅表里删掉），
 *       结束再 `attach()`；`mode==='off'` 时**从不订阅**。拖拽期间"运动会不会抢写"不是一个
 *       需要判定的问题——那条回调根本不在表里。</li>
 * </ol>
 *
 * <p><b>去重的第二道保险：</b>同一拍里 `poll()` 可能被定时器和渲染层的 hover-hint 各叫一次，
 * 两次通知带着同一个 `tickId`；`onSample` 只接受**严格递增**的 `tickId`，于是"一拍积分两次"
 * 不可能发生（`duplicateTicks` 只是诊断计数）。</p>
 *
 * <p><b>DIP 纯度（U-M5）：</b>坐标全部是 DIP，本类**不做任何单位换算**，
 * 也不读任何屏幕缩放比例（那会让混合 DPI 下的落点与命中矩形打架）。</p>
 */
class MotionController {
  /**
   * @param {object} deps 依赖注入（全部外部能力都由窗口层提供）
   * @param {(x: number, y: number) => void} deps.setWindowPosition **唯一的窗口移动出口**
   *   （窗口层传 `applyPetPosition`，它内部用 `setBounds`，见 `pet-window.cjs`）
   * @param {(listener: Function) => (() => void)} deps.subscribeSample 订阅命中轮询的每一拍
   *   （窗口层传 `(cb) => poller.onSample(cb)`；返回取消订阅函数）
   * @param {(point: {x: number, y: number}) => ({x: number, y: number,
   *   width: number, height: number})} deps.workArea 取某个屏幕点所在显示器的工作区
   *   （**每拍重读，不跨拍缓存**）
   * @param {{width: number, height: number}} deps.size 窗口尺寸（DIP，用于"整窗在工作区内"）
   * @param {() => {x: number, y: number}} [deps.cursor] 读系统光标（DIP）；仅在订阅方没带
   *   光标点时才调用（正常情况下复用轮询器已读到的那一份，不重复读）
   * @param {() => {follow?: boolean, roam?: boolean, reducedMotion?: boolean}} [deps.prefs]
   *   读当前偏好（reduced-motion 为真时拒绝开启运动）
   * @param {(command: object) => void} [deps.send] 向渲染层下发 `pet:command`（运动事实）
   * @param {{now: () => number}} [deps.clock] 时钟（只用于漫游的间隔/停留/超时排期）
   * @param {() => number} [deps.rng] 随机源（漫游目标与间隔；测试注入固定序列）
   * @param {(point: {x: number, y: number}) => number} [deps.displayId] 显示器 id（只进事实）
   * @param {{x: number, y: number}} [deps.artOrigin] 立绘箱左上角在窗口内的偏移（算宠物中心）
   * @param {{width: number, height: number}} [deps.artSize] 立绘箱尺寸（算宠物中心）
   * @param {{x: number, y: number}} [deps.initial] 窗口初始位置（DIP）
   * @throws {TypeError} 必填依赖缺失或类型错
   */
  constructor(deps) {
    const options = deps && typeof deps === 'object' ? deps : {};
    if (typeof options.setWindowPosition !== 'function') {
      throw new TypeError('[pet-motion] MotionController 需要 setWindowPosition 函数（唯一位置写口）');
    }
    if (typeof options.subscribeSample !== 'function') {
      throw new TypeError('[pet-motion] MotionController 需要 subscribeSample 函数（订阅命中轮询的每一拍）');
    }
    if (typeof options.workArea !== 'function') {
      throw new TypeError('[pet-motion] MotionController 需要 workArea 函数（每拍重读工作区）');
    }
    const size = requireSize(options.size, 'MotionController.size');
    if (!(size.width > 0) || !(size.height > 0)) {
      throw new RangeError(
        `[pet-motion] MotionController.size 必须为正，实际为 ${size.width}×${size.height}`,
      );
    }

    /** 唯一窗口移动出口。 */
    this.setWindowPosition = options.setWindowPosition;
    /** 每拍订阅（返回退订函数）。 */
    this.subscribeSample = options.subscribeSample;
    /** 工作区读取（每拍现算）。 */
    this.workAreaReader = options.workArea;
    /** 窗口尺寸（DIP）。 */
    this.size = size;
    /** 读光标（DIP）；正常路径不调用（复用轮询器已读到的那一份）。 */
    this.readCursor = typeof options.cursor === 'function' ? options.cursor : () => ({ x: 0, y: 0 });
    /** 读偏好。 */
    this.readPrefs = typeof options.prefs === 'function' ? options.prefs : () => ({});
    /** 下发运动事实。 */
    this.send = typeof options.send === 'function' ? options.send : () => {};
    /** 时钟（只排漫游的时间表）。 */
    const clock = options.clock && typeof options.clock.now === 'function' ? options.clock : { now: () => Date.now() };
    this.clock = clock;
    /** 随机源。 */
    this.rng = typeof options.rng === 'function' ? options.rng : Math.random;
    /** 显示器 id（只进事实，不参与判定）。 */
    this.readDisplayId = typeof options.displayId === 'function' ? options.displayId : () => 0;
    /** 立绘箱在窗口内的偏移（宠物中心 = 窗口位置 + 该偏移 + 半箱）。 */
    this.artOrigin = options.artOrigin === undefined ? { x: 0, y: 0 } : requirePoint(options.artOrigin, 'MotionController.artOrigin');
    /** 立绘箱尺寸。 */
    this.artSize = options.artSize === undefined ? { width: size.width, height: size.height } : requireSize(options.artSize, 'MotionController.artSize');
    /** 写入后回调（窗口层用它刷新命中矩形的屏幕原点）。 */
    this.afterWrite = typeof options.afterWrite === 'function' ? options.afterWrite : null;

    const initial = options.initial === undefined ? { x: 0, y: 0 } : requirePoint(options.initial, 'MotionController.initial');

    /** 浮点位置累加器（**绝不把取整后的值当累加基准**，否则低速会卡住）。 */
    this.position = { x: initial.x, y: initial.y };
    /** 最后一次真正写进窗口的整数位置（`snapshot().x/y` 的来源）。 */
    this.written = { x: Math.round(initial.x), y: Math.round(initial.y) };
    /** 当前运动模式（**已经生效**的那个）。 */
    this.mode = 'off';
    /** 用户意图（交互打断只清 `mode`，保留本字段，见 §5.1 注释 1）。 */
    this.desiredMode = 'off';
    /** 位置写入权（L3 的令牌）。 */
    this.owner = OWNER_TOKENS.NONE;
    /** 当前速度（DIP/秒，浮点累加器的伴生量）。 */
    this.velocity = 0;
    /** 当前朝向（`-1` 面左 / `1` 面右）。 */
    this.facing = -1;
    /** 跟随相位（`idle` / `chase` / `arrived`）。 */
    this.phase = 'idle';
    /** 当前步态（`none` / `walk` / `run`）。 */
    this.gait = 'none';
    /** 是否已到达（上一拍的结果）。 */
    this.arrived = true;
    /** 收到并受理的拍数。 */
    this.ticks = 0;
    /** 真正做了运动解算的拍数（`mode==='off'` 时为 0）。 */
    this.samples = 0;
    /** 本类自己读光标的次数（follow 复用轮询器的读数 ⇒ 通常不增长；roam 恒不读）。 */
    this.cursorReads = 0;
    /** 同一拍被重复通知的次数（诊断：hint 与定时器撞在同一拍）。 */
    this.duplicateTicks = 0;
    /** 最近的拍号（去重基准）。 */
    this.lastTickId = -1;
    /** 挂起原因集合（`hidden` 等）。 */
    this.suspendedReasons = new Set();
    /** 当前订阅的退订函数（null = 未订阅）。 */
    this.detachHandle = null;
    /** 是否已 `start()`。 */
    this.started = false;
    /** 上一次下发事实的指纹（只在字段变化时发，§8.2）。 */
    this.lastEmitKey = '';
    /** 明确拒绝过的意图次数（诊断 + 用例判据）。 */
    this.refusals = 0;
    /** 最近一次拒绝原因。 */
    this.lastRefusal = '';
    /**
     * 渲染层最近上报的行为状态（**主进程侧的记忆**，S4.1 闸门的判据）。
     *
     * <p>初值 `idle` 是刻意的：还没收到任何上报时不能假定"睡着"（那会让桌宠永远不动），
     * 也不能假定"在跑"（那是另一道闸的事）。</p>
     */
    this.behavior = 'idle';
    /** 漫游排期（目标 / 超时 / 下一轮 / 停留）。 */
    this.roam = { target: null, deadlineAt: 0, nextAt: 0, dwellUntil: 0 };
    /** 上一次成功读到的工作区（只在"这一拍读到脏值"时兜底，不跨拍复用做判定）。 */
    this.lastWorkArea = null;
  }

  /**
   * 开始工作（幂等）：模式已生效时立刻订阅那一拍。
   *
   * @returns {void}
   */
  start() {
    this.started = true;
    this.attachIfActive();
  }

  /**
   * 停止工作（幂等）：退订、清模式、速度归零。
   *
   * <p>窗口销毁时调用。此后 `snapshot()` 仍可读（诊断用例需要），但一次都不会再写位置。</p>
   *
   * @returns {void}
   */
  stop() {
    this.started = false;
    this.detach();
    this.mode = 'off';
    this.desiredMode = 'off';
    this.owner = OWNER_TOKENS.NONE;
    this.velocity = 0;
    this.gait = 'none';
    this.phase = 'idle';
    this.arrived = true;
    this.roam.target = null;
  }

  /**
   * 设置模式（**类图里的签名**，不返回受理结果）。
   *
   * <p>需要知道"受理没受理"的调用方（IPC 处理器）用 {@link MotionController#trySetMode}，
   * 它返回 `{ok, error}`。两个入口共用同一份逻辑，本方法只是丢掉返回值。</p>
   *
   * @param {'off'|'follow'|'roam'} mode 目标模式
   * @param {'prefs'|'idle-chain'|'interaction'|'dev'} reason 原因
   * @returns {void}
   */
  setMode(mode, reason) {
    this.trySetMode(mode, reason);
  }

  /**
   * 设置模式并返回受理结果（IPC 用）。
   *
   * <p>四条拒绝条件（安全方向永远是"别动"）：</p>
   * <ol>
   *   <li>枚举非法（`mode` / `reason` 必须命中白名单）；</li>
   *   <li>窗口处于挂起态（隐藏期间不许开启运动）；</li>
   *   <li>**行为状态闸门**：渲染层最近上报的行为态属于 {@link BLOCKED_BEHAVIORS}
   *       （`sleeping` / `sleep` / `drag`）⇒ `{ok:false, reason:'behavior-blocked'}`，
   *       并计入 `refusals`。这是**主进程侧**的独立防线，不依赖渲染层自己守；</li>
   *   <li>偏好不允许：`reduced-motion === true` 一律拒绝开启；`follow` / `roam` 未开启也拒绝
   *       （渲染层只是请求方，主进程是决定方）。</li>
   * </ol>
   *
   * @param {'off'|'follow'|'roam'} mode 目标模式
   * @param {'prefs'|'idle-chain'|'interaction'|'dev'} reason 原因
   * @returns {{ok: boolean, error?: string, reason?: string}} 受理结果
   */
  trySetMode(mode, reason) {
    if (!MOTION_MODES.includes(mode)) {
      return this.refuse(`非法 mode：${JSON.stringify(mode)}`);
    }
    if (!MOTION_REASONS.includes(reason)) {
      return this.refuse(`非法 reason：${JSON.stringify(reason)}`);
    }
    if (mode !== 'off') {
      if (this.suspendedReasons.size > 0) {
        return this.refuse(`窗口不可见（挂起原因：${[...this.suspendedReasons].join(',')}），拒绝开启 ${mode}`);
      }
      if (this.isBehaviorBlocked()) {
        // 这里**必须**用 refuse()（计入 refusals）且带上可判定的 reason：
        // "被行为态挡住"和"被偏好挡住"对排障的人是两件完全不同的事。
        const blocked = this.refuse(`行为态「${this.behavior}」下拒绝开启 ${mode}`);
        return { ...blocked, reason: MOTION_BEHAVIOR_GATE.REASON };
      }
      const prefs = this.readPrefs() || {};
      if (prefs.reducedMotion === true) {
        return this.refuse('用户要求减少动态（reduced-motion），拒绝开启自主运动');
      }
      if (mode === 'follow' && prefs.follow !== true) {
        return this.refuse('偏好未开启「跟随鼠标」');
      }
      if (mode === 'roam' && prefs.roam !== true) {
        return this.refuse('偏好未开启「自由漫游」');
      }
    }

    this.lastRefusal = '';
    // 交互打断（优先级 3）只清"生效模式"，保留用户意图：手一离开跟随要能继续（§5.1 注释 1）
    if (mode === 'off' && reason !== 'interaction') this.desiredMode = 'off';
    if (mode !== 'off') this.desiredMode = mode;
    this.mode = mode;

    if (mode === 'off') {
      this.velocity = 0;
      this.gait = 'none';
      this.phase = 'idle';
      this.arrived = true;
      this.roam.target = null;
      this.owner = this.owner === OWNER_TOKENS.DRAG ? OWNER_TOKENS.DRAG : OWNER_TOKENS.NONE;
      this.detach();
      this.emit('arrived');
      return { ok: true };
    }

    this.owner = this.owner === OWNER_TOKENS.DRAG ? OWNER_TOKENS.DRAG : OWNER_TOKENS.LOCOMOTION;
    this.phase = 'idle';
    this.arrived = false;
    if (mode === 'roam') {
      // 第一次目标立刻选（用户刚勾上就想看它走一走），之后的间隔按 §6.2 随机
      this.roam.target = null;
      this.roam.nextAt = this.clock.now();
      this.roam.deadlineAt = 0;
      this.roam.dwellUntil = 0;
    }
    this.attachIfActive();
    return { ok: true };
  }

  /**
   * 记一次拒绝（**拒绝必须是可读的**：真机上"猫不动"要有原因可查）。
   *
   * @param {string} error 原因
   * @returns {{ok: false, error: string}} 统一拒绝结果
   */
  refuse(error) {
    this.refusals += 1;
    this.lastRefusal = error;
    return { ok: false, error };
  }

  /**
   * 当前行为状态是否让运动被闸住。
   *
   * <p>判据只有一条：`behavior` 命中 {@link BLOCKED_BEHAVIORS}。写成方法而不是散落的
   * `includes` 调用，是因为"哪几种行为态该禁"必须只有一处（`check-pet-motion` 与本类的
   * 用例都读同一份导出的常量）。</p>
   *
   * @returns {boolean} true = 该行为态下不许开启自主运动
   */
  isBehaviorBlocked() {
    return BLOCKED_BEHAVIORS.includes(this.behavior);
  }

  /**
   * 记录渲染层上报的行为状态（**只读上报，不是命令**）。
   *
   * <p>渲染层通过既有 `pet:motion-intent` 载荷里的可选 `behavior` 字段上报（不新开通道，
   * 通道数是有限资源）。主进程只是**记住**它，然后自己的闸门用它判事。</p>
   *
   * <p>两件事必须同时成立才叫"防线"：</p>
   * <ol>
   *   <li>之后 `trySetMode('roam'|'follow')` 会被拒（{@link BLOCKED_BEHAVIORS}）；</li>
   *   <li>**正在动的**必须立刻停下——否则"先开着漫游、再睡着"这条真机路径上，
   *       猫会带着睡姿继续滑行。这里走 `setMode('off','interaction')`，
   *       与既有交互打断同一语义（保留用户意图，醒来后可再请求）。</li>
   * </ol>
   *
   * @param {unknown} behavior 行为态字符串（非法值忽略：宁可不动，不许把垃圾当状态）
   * @returns {boolean} 是否因此把运动停掉了
   */
  reportBehavior(behavior) {
    if (typeof behavior !== 'string' || behavior.length === 0) return false;
    this.behavior = behavior;
    if (this.mode === 'off') return false;
    if (!this.isBehaviorBlocked()) return false;
    this.setMode('off', 'interaction');
    return true;
  }

  /**
   * 偏好变更（菜单勾选变化后由窗口层调用）。
   *
   * <p>只做"收回"不做"开启"：偏好打开不代表立刻开始动（渲染层会按行为状态自己请求），
   * 但偏好关掉/要求减少动态时**必须立刻停**——否则用户在菜单里取消了勾选，猫还在跑。</p>
   *
   * @param {{follow?: boolean, roam?: boolean, reducedMotion?: boolean}} prefs 新偏好
   * @returns {boolean} 是否因此把运动停掉了
   */
  applyPrefs(prefs) {
    if (prefs === null || typeof prefs !== 'object') return false;
    if (this.mode === 'off') return false;
    if (prefs.reducedMotion === true) {
      this.setMode('off', 'prefs');
      return true;
    }
    if (this.mode === 'follow' && prefs.follow !== true) {
      this.setMode('off', 'prefs');
      return true;
    }
    if (this.mode === 'roam' && prefs.roam !== true) {
      this.setMode('off', 'prefs');
      return true;
    }
    return false;
  }

  /**
   * 拖拽开始：**结构性抢占**（L3）。
   *
   * <p>不是"在回调里判一下 owner 就跳过"，而是把回调从订阅表里**摘掉**：
   * 从这一帧起，定时器每拍都碰不到运动逻辑（设计 §4.1 L3 / P-M06 的判据）。</p>
   *
   * @returns {boolean} 恒为 true（保留返回值是为了让调用方能断言"受理了"）
   */
  beginDrag() {
    this.owner = OWNER_TOKENS.DRAG;
    this.detach();
    this.velocity = 0;
    this.gait = 'none';
    this.phase = 'idle';
    this.arrived = true;
    this.roam.target = null;
    return true;
  }

  /**
   * 拖拽中的位置（**唯一写入点的另一个调用者**，仍走 `applyPosition`）。
   *
   * @param {number} screenX 光标屏幕坐标 X（DIP）
   * @param {number} screenY 光标屏幕坐标 Y（DIP）
   * @param {number} offsetX 光标相对窗口左上角的偏移 X（DIP）
   * @param {number} offsetY 光标相对窗口左上角的偏移 Y（DIP）
   * @returns {boolean} 是否真的写了窗口位置
   * @throws {TypeError} 参数不是有限数值
   */
  dragTo(screenX, screenY, offsetX, offsetY) {
    const cursorX = requireFiniteNumber(screenX, 'dragTo.screenX');
    const cursorY = requireFiniteNumber(screenY, 'dragTo.screenY');
    const offX = requireFiniteNumber(offsetX, 'dragTo.offsetX');
    const offY = requireFiniteNumber(offsetY, 'dragTo.offsetY');
    const candidate = { x: cursorX - offX, y: cursorY - offY };
    const area = this.readWorkArea(this.centerOf(candidate));
    if (area === null) return false;
    const target = clampTargetToWorkArea({
      workArea: area,
      windowSize: this.size,
      target: candidate,
      // 拖拽的边界就是工作区本身（用户把猫拖到屏幕边上应该能贴边）
      marginDip: 0,
    });
    this.position = { x: target.x, y: target.y };
    return this.applyPosition(OWNER_TOKENS.DRAG, target.x, target.y);
  }

  /**
   * 拖拽结束：把写入权还给运动（若还有运动）并恢复订阅。
   *
   * @returns {void}
   */
  endDrag() {
    this.owner = this.mode === 'off' ? OWNER_TOKENS.NONE : OWNER_TOKENS.LOCOMOTION;
    this.velocity = 0;
    this.phase = 'idle';
    this.attachIfActive();
  }

  /**
   * 立刻把窗口夹回可见区（显示器增删 / 分辨率变化后调用）。
   *
   * <p><b>只夹取、不做跨版本迁移</b>（QA D-02）：实时 bounds 的立绘原点就是当前值，
   * 补偿量恒为 0；这里若误用启动期的迁移函数，每次显示器事件都会累积漂移。</p>
   *
   * <p>窗口层已经把"该去哪儿"算好了（它用的是既有的 `clampIntoWorkArea`，语义不变），
   * 通过可选的 `candidate` 传进来；不传则用当前位置。</p>
   *
   * @param {{x: number, y: number}} [candidate] 窗口层算出的目标左上角（DIP）
   * @returns {boolean} 是否真的写了窗口位置（位置没变 ⇒ false，不许白写）
   */
  reclampNow(candidate) {
    const from = candidate === undefined ? this.position : requirePoint(candidate, 'reclampNow.candidate');
    const area = this.readWorkArea(this.centerOf(from));
    if (area === null) return false;
    const target = clampTargetToWorkArea({
      workArea: area,
      windowSize: this.size,
      target: from,
      marginDip: 0,
    });
    const previous = this.owner;
    this.owner = OWNER_TOKENS.RECLAMP;
    try {
      this.position = { x: from.x, y: from.y };
      const wrote = this.applyPosition(OWNER_TOKENS.RECLAMP, target.x, target.y);
      // 无论是否写入，浮点累加器都要与窗口对齐（否则下一拍会朝旧位置走）
      this.position = { x: target.x, y: target.y };
      return wrote;
    } finally {
      this.owner = previous;
    }
  }

  /**
   * 置/清一个挂起原因（`hidden` / `menu` / `renderer-gone`）。
   *
   * <p>挂起 = **退订 + 速度归零**：窗口不可见时运动一次都不该发生（0 采样 0 写入）。
   * 恢复时若模式还生效就重新订阅（不需要额外的"恢复"动作）。</p>
   *
   * @param {string} reason 原因
   * @param {boolean} on 置上还是清掉
   * @returns {void}
   * @throws {TypeError} 原因为空
   */
  setSuspended(reason, on) {
    const key = String(reason || '');
    if (key === '') throw new TypeError('[pet-motion] MotionController.setSuspended: reason 不能为空');
    if (on === true) {
      this.suspendedReasons.add(key);
      this.detach();
      this.velocity = 0;
      this.gait = 'none';
      this.phase = 'idle';
      this.arrived = true;
      this.roam.target = null;
      return;
    }
    this.suspendedReasons.delete(key);
    this.attachIfActive();
  }

  /**
   * 收到一拍（由 {@link HitPoller#onSample} 驱动）。
   *
   * <p>四道早退，顺序固定：①拍号去重（同一拍只积分一次）→ ②挂起 → ③写入权不在运动
   * → ④模式为 off。前两道是"根本不该动"，后两道是"现在轮不到我"。</p>
   *
   * @param {{tickId?: number, point?: {x: number, y: number}}} sample 采样（可只带 `tickId`）
   * @returns {boolean} 这一拍是否真的做了运动解算
   */
  onSample(sample) {
    const source = sample && typeof sample === 'object' ? sample : {};
    const tickId = Number(source.tickId);
    if (Number.isFinite(tickId)) {
      if (tickId <= this.lastTickId) {
        // 同一拍被第二次叫醒（hint 与定时器撞车）：不积分、不写入
        this.duplicateTicks += 1;
        return false;
      }
      this.lastTickId = tickId;
    }
    this.ticks += 1;
    if (this.suspendedReasons.size > 0) return false;
    if (this.owner !== OWNER_TOKENS.LOCOMOTION) return false;
    if (this.mode === 'off') return false;
    if (this.mode === 'follow') return this.stepFollow(source);
    return this.stepRoam(source);
  }

  /**
   * 跟随一拍（S03，§6.1）。
   *
   * @param {{point?: {x: number, y: number}}} sample 采样（`point` 由轮询器给，省一次系统调用）
   * @returns {boolean} 是否完成解算
   */
  stepFollow(sample) {
    this.samples += 1;
    const point = this.resolveCursorPoint(sample);
    if (point === null) {
      this.velocity = 0;
      this.gait = 'none';
      return false;
    }
    const center = this.centerOf(this.position);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const distance = Math.hypot(dx, dy);

    this.phase = decideFollowPhase({ distanceDip: distance, phase: this.phase });
    this.facing = decideFacing({ dx, currentFacing: this.facing });

    if (this.phase !== 'chase') {
      // 停止半径内：立刻停住（不写位置），并把"到达"告诉渲染层
      this.velocity = 0;
      this.gait = 'none';
      this.arrived = true;
      this.emit('arrived');
      return true;
    }

    this.gait = decideGait({
      distanceDip: distance,
      currentGait: this.gait === 'none' ? 'walk' : this.gait,
    });
    const maxSpeed = this.gait === 'run' ? MOTION.runMaxDipPerSec : MOTION.walkMaxDipPerSec;
    // 刹车约束：剩余距离内必须停得住（decel 是减速度，比 accel 更大 ⇒ 这条是上界而非主约束）
    const brakeLimit = Math.sqrt(2 * MOTION.decelDipPerSec2 * distance);
    const step = this.integrate(MOTION.tickMs, {
      from: this.position,
      to: { x: this.position.x + dx, y: this.position.y + dy },
      speedLimit: Math.min(maxSpeed, brakeLimit),
    });
    this.velocity = step.speed;
    this.arrived = false;
    this.position = { x: step.x, y: step.y };
    this.applyPosition(OWNER_TOKENS.LOCOMOTION, step.x, step.y);
    this.emit('moving');
    return true;
  }

  /**
   * 漫游一拍（S01，§6.2）。
   *
   * <p><b>完全不读光标</b>（漫游不需要光标 ⇒ `cursorReads` 不增长，§8.3 的判据）。
   * 工作区**每拍重读**：跨屏 / 分辨率变化后下一拍就按新工作区算，不跨拍缓存。</p>
   *
   * @param {{point?: object}} _sample 采样（漫游不使用，保留形状统一）
   * @returns {boolean} 是否完成解算
   */
  stepRoam(_sample) {
    this.samples += 1;
    const now = this.clock.now();
    const center = this.centerOf(this.position);
    const area = this.readWorkArea(center);
    if (area === null) {
      this.velocity = 0;
      this.gait = 'none';
      return false;
    }

    if (this.roam.target === null) {
      if (now < this.roam.nextAt) {
        // 间隔未到：站定（不写位置）
        if (this.gait !== 'none' || this.velocity !== 0) {
          this.velocity = 0;
          this.gait = 'none';
          this.arrived = true;
          this.emit('arrived');
        }
        return true;
      }
      this.roam.target = pickRoamTarget({
        workArea: area,
        windowSize: this.size,
        rng: this.rng,
      });
      this.roam.deadlineAt = now + MOTION.roamMaxDurationMs;
    }

    if (now > this.roam.deadlineAt) {
      // 单次时长上限（§6.2）：超时即放弃目标并站定，绝不允许"一直追不上的目标拖着猫跑"
      this.roam.target = null;
      this.velocity = 0;
      this.gait = 'none';
      this.arrived = true;
      this.scheduleNextRoam(now);
      this.emit('aborted');
      return true;
    }

    const target = this.roam.target;
    const dx = target.x - this.position.x;
    const dy = target.y - this.position.y;
    const distance = Math.hypot(dx, dy);
    this.facing = decideFacing({ dx, currentFacing: this.facing });
    this.gait = decideGait({
      distanceDip: distance,
      currentGait: this.gait === 'none' ? 'walk' : this.gait,
    });
    const maxSpeed = this.gait === 'run' ? MOTION.runMaxDipPerSec : MOTION.walkMaxDipPerSec;
    const brakeLimit = Math.sqrt(2 * MOTION.decelDipPerSec2 * distance);
    const step = this.integrate(MOTION.tickMs, {
      from: this.position,
      to: target,
      speedLimit: Math.min(maxSpeed, brakeLimit),
    });
    this.velocity = step.speed;
    this.position = { x: step.x, y: step.y };
    this.applyPosition(OWNER_TOKENS.LOCOMOTION, step.x, step.y);

    if (step.arrived) {
      // 到达：站定 roamDwellMs，之后才开始下一轮计时
      this.velocity = 0;
      this.gait = 'none';
      this.arrived = true;
      this.roam.target = null;
      this.roam.dwellUntil = now + MOTION.roamDwellMs;
      this.scheduleNextRoam(this.roam.dwellUntil);
      this.emit('arrived');
      return true;
    }
    this.arrived = false;
    this.emit('moving');
    return true;
  }

  /**
   * 排下一轮漫游（间隔在 `[roamMinIntervalMs, roamMaxIntervalMs]` 内均匀随机）。
   *
   * @param {number} fromMs 起算时刻（到达后是"停留结束"，放弃后是"现在"）
   * @returns {void}
   */
  scheduleNextRoam(fromMs) {
    const span = MOTION.roamMaxIntervalMs - MOTION.roamMinIntervalMs;
    const draw = Number(this.rng());
    const ratio = Number.isFinite(draw) && draw >= 0 && draw < 1 ? draw : 0.5;
    this.roam.nextAt = fromMs + MOTION.roamMinIntervalMs + ratio * span;
  }

  /**
   * 走一步运动学（薄包装，隔离"这一步用哪组常量"）。
   *
   * @param {number} dtMs 本拍时长（毫秒）
   * @param {{from: {x: number, y: number}, to: {x: number, y: number}, speedLimit: number}} options 入参
   * @returns {{x: number, y: number, speed: number, arrived: boolean}} 步进结果（浮点 DIP）
   */
  integrate(dtMs, options) {
    return stepToward({
      from: options.from,
      to: options.to,
      speedLimit: options.speedLimit,
      accel: MOTION.accelDipPerSec2,
      currentSpeed: this.velocity,
      dtMs,
    });
  }

  /**
   * **唯一的位置写入点**（设计 §4.1 L2）。
   *
   * <p>三分支，顺序固定：①令牌不匹配（这次写入不属于调用者）→ ②取整后未变（不白写，
   * 省一次 DWM 调用）→ ③真正写。取整只发生在**这里**，浮点累加器不受影响。</p>
   *
   * @param {'none'|'locomotion'|'drag'|'reclamp'} token 调用者持有的写入权
   * @param {number} x 目标 X（DIP，可浮点）
   * @param {number} y 目标 Y（DIP，可浮点）
   * @returns {boolean} 是否真的写了
   */
  applyPosition(token, x, y) {
    if (token !== this.owner) return false;
    const nx = Math.round(Number(x));
    const ny = Math.round(Number(y));
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;
    if (nx === this.written.x && ny === this.written.y) return false;
    this.written = { x: nx, y: ny };
    this.setWindowPosition(nx, ny);
    if (this.afterWrite) this.afterWrite({ x: nx, y: ny });
    return true;
  }

  /**
   * 向渲染层下发一条运动事实（**只在字段变化时发**，§8.2）。
   *
   * <p>指纹刻意不含速度：速度每拍都在变，把它算进去等于每拍发一条（62 条/秒）。
   * 口径与设计一致——`phase`/`gait`/`facing`/`pos` 整数变化才发。</p>
   *
   * @param {'moving'|'arrived'|'aborted'} phase 阶段
   * @returns {boolean} 是否真的发了
   */
  emit(phase) {
    const gait = phase === 'moving' ? this.gait : 'none';
    const pos = { x: this.written.x, y: this.written.y };
    const key = `${phase}|${gait}|${this.facing}|${pos.x}|${pos.y}`;
    if (key === this.lastEmitKey) return false;
    this.lastEmitKey = key;
    this.send({
      type: 'motion',
      phase,
      gait,
      facing: this.facing,
      speedDipPerSec: roundToHundredth(phase === 'moving' ? this.velocity : 0),
      pos,
      displayId: Number(this.readDisplayId(this.centerOf(this.position))) || 0,
    });
    return true;
  }

  /**
   * 只读快照（dev 后门与 CDP 采样用，§8.1 `pet:motion-snapshot`）。
   *
   * @returns {object} 快照
   */
  snapshot() {
    return {
      mode: this.mode,
      desiredMode: this.desiredMode,
      owner: this.owner,
      x: this.written.x,
      y: this.written.y,
      position: { x: this.position.x, y: this.position.y },
      velocityDipPerSec: roundToHundredth(this.velocity),
      gait: this.gait,
      facing: this.facing,
      phase: this.phase,
      arrived: this.arrived,
      ticks: this.ticks,
      samples: this.samples,
      cursorReads: this.cursorReads,
      duplicateTicks: this.duplicateTicks,
      suspendReason: [...this.suspendedReasons].join(','),
      target: this.roam.target === null ? null : { x: this.roam.target.x, y: this.roam.target.y },
      refusals: this.refusals,
      lastRefusal: this.lastRefusal,
      behavior: this.behavior,
      behaviorBlocked: this.isBehaviorBlocked(),
    };
  }

  /** 订阅这一拍（幂等：已订阅就不重复订阅，避免一拍积分两次）。 */
  attachIfActive() {
    if (this.detachHandle !== null) return;
    if (!this.started) return;
    if (this.mode === 'off') return;
    if (this.suspendedReasons.size > 0) return;
    if (this.owner !== OWNER_TOKENS.LOCOMOTION) return;
    this.detachHandle = this.subscribeSample((sample) => this.onSample(sample));
  }

  /** 退订这一拍（幂等；L3 的"结构性解除"就是这一句）。 */
  detach() {
    if (this.detachHandle === null) return;
    const handle = this.detachHandle;
    this.detachHandle = null;
    handle();
  }

  /**
   * 取本拍的光标点：优先复用轮询器已经读到的那一份（§8.3：不重复读）。
   *
   * @param {{point?: {x: number, y: number}}} sample 采样
   * @returns {{x: number, y: number}|null} 光标点；读不到时 null
   */
  resolveCursorPoint(sample) {
    const point = sample && typeof sample === 'object' ? sample.point : null;
    if (point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))) {
      return { x: Number(point.x), y: Number(point.y) };
    }
    try {
      const raw = this.readCursor();
      this.cursorReads += 1;
      if (raw && Number.isFinite(Number(raw.x)) && Number.isFinite(Number(raw.y))) {
        return { x: Number(raw.x), y: Number(raw.y) };
      }
    } catch {
      // 读光标失败：这一拍不推进（保持上一拍位置），绝不猜一个坐标继续跑
    }
    return null;
  }

  /**
   * 窗口位置对应的"宠物中心"（立绘箱中心，DIP）。
   *
   * @param {{x: number, y: number}} position 窗口左上角
   * @returns {{x: number, y: number}} 中心点
   */
  centerOf(position) {
    return {
      x: position.x + this.artOrigin.x + this.artSize.width / 2,
      y: position.y + this.artOrigin.y + this.artSize.height / 2,
    };
  }

  /**
   * 读某个点所在显示器的工作区（**每拍调用一次，不跨拍缓存**）。
   *
   * @param {{x: number, y: number}} point 屏幕点（DIP）
   * @returns {{x: number, y: number, width: number, height: number}|null} 工作区
   */
  readWorkArea(point) {
    try {
      const area = this.workAreaReader(point);
      const rect = requireRect(area, 'MotionController.workArea');
      if (rect.width > 0 && rect.height > 0) {
        this.lastWorkArea = rect;
        return rect;
      }
    } catch {
      // 读到脏值：本拍用上一次的有效工作区兜底（不能用它跨拍做判定）
    }
    return this.lastWorkArea;
  }
}

module.exports = {
  MOTION,
  FOLLOW_PHASES,
  GAITS,
  OWNER_TOKENS,
  MOTION_MODES,
  MOTION_REASONS,
  MotionController,
  BLOCKED_BEHAVIORS,
  MOTION_BEHAVIOR_GATE,
  decideFollowPhase,
  decideGait,
  stepToward,
  decideFacing,
  resolveRoamBounds,
  clampTargetToWorkArea,
  pickRoamTarget,
};
