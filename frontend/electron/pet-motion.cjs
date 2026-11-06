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

module.exports = {
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
};
