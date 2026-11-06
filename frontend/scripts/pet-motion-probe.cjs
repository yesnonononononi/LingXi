#!/usr/bin/env node
/**
 * 桌宠运动的**只读采样器**（设计 §10.1 的 L-C 层、§10.3 的 P-M17…P-M20、§10.4）。
 *
 * <p><b>为什么必须有它：</b>运动这一片有三类缺陷只能在**真机**上看见——轨迹抽搐/原地滑行
 * （P-M17）、竖直移动时莫名翻向（P-M18）、步态与速度不匹配（P-M19）、被镜像（P-M20）。
 * 它们都依赖真实 DWM 合成与真实窗口定位时序，假时钟里造不出来（§10.4 已写明理由）。
 * 所以本文件不是"又一个单测"，而是给主理人真机验收用的**采样与判读工具**。</p>
 *
 * <p><b>三条纪律（本文件的全部边界）：</b></p>
 * <ol>
 *   <li><b>只读</b>：不写窗口位置、不发 IPC、不改任何状态。它只调注入进来的
 *       `readState()`（读隐藏/挂起/姿态/门禁）与 `readSnapshot()`（读位置/朝向/步态），
 *       连"顺手套一个 setPosition 把宠物摆正"这种事都不做。</li>
 *   <li><b>0 采样守卫</b>（门禁 G-M9）：隐藏 / 睡眠 / 门禁关闭时**一条样本都不采**——
 *       采样会唤醒设备并污染轨迹。守卫收敛在 {@link shouldSample} 一处，
 *       调用点必须**先判后读**（`check-pet-motion.mjs` 有静态断言守着这条顺序）。</li>
 *   <li><b>不复制手感数字</b>（门禁 G-M4）：速度带、采样拍全部从
 *       `electron/pet-motion.cjs` 的 `MOTION` 读，本文件一个都不写死。</li>
 * </ol>
 *
 * <p><b>用法：</b></p>
 * <pre>
 *   node scripts/pet-motion-probe.cjs --self-check      # 判读器判别力自证（无需真机）
 *   node scripts/pet-motion-probe.cjs --live            # 真机采样（需 S4 的快照出口）
 *   node scripts/pet-motion-probe.cjs --help
 * </pre>
 *
 * <p>`--live` 现在会**明确失败**（退出码 2）并说清缺什么：S4 的 `pet:motion-snapshot`
 * 出口还没落地，此时"采到 0 条样本"绝不能报成"轨迹正常"——那是本文件最不能犯的错
 * （假绿比红更贵）。</p>
 *
 * @module scripts/pet-motion-probe
 */

'use strict';

const path = require('node:path');

/**
 * 运动配置真源（速度带 / 采样拍）。
 *
 * <p>用 `require` 而不是抄数字：G-M4 的判据是"阈值只有一份"，
 * 抄一份 56/96 进探针就等于给自己造了个第二真源。</p>
 */
const { MOTION } = require(path.join(__dirname, '..', 'electron', 'pet-motion.cjs'));

/** CSV 表头（一行一采样点；列序固定，便于表格/脚本读）。 */
const SAMPLE_COLUMNS = Object.freeze([
  't',
  'x',
  'y',
  'posture',
  'facing',
  'gait',
  'phase',
  'speed',
  'transform',
]);

/** 判据 id（与设计 §10.3 一一对应；problems 里出现的就是它们）。 */
const PROBE_CRITERIA = Object.freeze(['P-M17', 'P-M18', 'P-M19', 'P-M20']);

/** 一帧的位移阈值（DIP）：小于它的 Δ 视为"没动"，不参与方向判定（抖动不是方向）。 */
const NOISE_FLOOR_DIP = 1;

/** 算"在走/在跑"的姿态（只取本判据需要的两个值）。 */
const MOVING_POSTURES = Object.freeze(['walk', 'run']);

/**
 * 断言是有限数值。
 *
 * @param {unknown} value 待校验值
 * @param {string} name 参数名
 * @returns {number} 数值
 * @throws {TypeError} 不是有限数值
 */
function requireFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`[pet-motion-probe] ${name} 必须是有限数值，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 断言是 `{x, y}` 点。
 *
 * @param {unknown} value 待校验值
 * @param {string} name 参数名
 * @returns {{x: number, y: number}} 点
 * @throws {TypeError} 结构非法
 */
function requirePoint(value, name) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`[pet-motion-probe] ${name} 必须是 {x, y} 对象`);
  }
  const point = /** @type {{x?: unknown, y?: unknown}} */ (value);
  return {
    x: requireFiniteNumber(point.x, `${name}.x`),
    y: requireFiniteNumber(point.y, `${name}.y`),
  };
}

/**
 * **0 采样守卫**（门禁 G-M9 的唯一判据点）。
 *
 * <p>三类情形必须一条样本都不采，理由各不相同：</p>
 * <ol>
 *   <li><b>隐藏</b>：窗口不可见时位置无意义，采样只会把"隐藏期间的时间戳"混进轨迹；</li>
 *   <li><b>睡眠/趴着</b>：姿态是睡姿时运动必然已被关掉（P-M15），此时若还采到位移，
 *       那是"趴着滑行"的缺陷现场，不该被当作正常样本稀释掉；</li>
 *   <li><b>门禁关闭</b>：M3 运动门禁没开时，采样会误导读者以为功能在跑。</li>
 * </ol>
 *
 * <p>写成纯函数是刻意的：**它必须是单点判据**，否则守卫会在多个调用点漂移，
 * 而"某个调用点忘了判"正是这一条判据存在的理由。</p>
 *
 * @param {{hidden?: boolean, suspended?: boolean, posture?: string, gateOpen?: boolean}} state
 *   采样瞬间的状态（缺字段按"不采样"处理——宁可少采，不许把不确定当成在跑）
 * @returns {boolean} 是否允许采这一条
 */
function shouldSample(state) {
  if (state === null || typeof state !== 'object') return false;
  if (state.hidden === true) return false;
  if (state.suspended === true) return false;
  if (state.gateOpen !== true) return false;
  const posture = typeof state.posture === 'string' ? state.posture : '';
  // 睡姿用字面量逐个写出来（而不是查表）：门禁 G-M9 会静态断言这段守卫**覆盖睡眠**，
  // 而"查一个别处定义的表"在文本上是看不见的，判据会退化成空断言。
  if (posture === 'sleep' || posture === 'lie' || posture === 'sleeping') return false;
  return true;
}

/**
 * 把一次"读到的现场"归一成一行样本。
 *
 * <p>**读顺序是判据的一部分**：先 {@link shouldSample} 后读快照。反过来会先花一次
 * 系统调用读窗口位置，再因为隐藏而丢弃——那正是 G-M9 要禁止的"隐藏时仍在采样"。</p>
 *
 * @param {object} deps 采样依赖
 * @param {() => {hidden?: boolean, suspended?: boolean, posture?: string, gateOpen?: boolean}} deps.readState
 *   读状态（隐藏 / 挂起 / 姿态 / 门禁）
 * @param {() => {x: number, y: number, transform?: string, facing?: number, gait?: string,
 *   phase?: string, speed?: number}} deps.readSnapshot 读运动快照
 * @param {() => number} deps.now 读时间（毫秒）
 * @returns {object|null} 样本行；被守卫拦下时为 `null`（**不读快照**）
 * @throws {TypeError} 依赖缺失
 */
function sampleOnce(deps) {
  if (deps === null || typeof deps !== 'object') {
    throw new TypeError('[pet-motion-probe] sampleOnce 需要 {readState, readSnapshot, now} 对象');
  }
  for (const key of ['readState', 'readSnapshot', 'now']) {
    if (typeof deps[key] !== 'function') {
      throw new TypeError(`[pet-motion-probe] sampleOnce.${key} 必须是函数`);
    }
  }
  const state = deps.readState();
  // —— 0 采样守卫：必须在读快照之前 ——
  if (!shouldSample(state)) return null;
  const snapshot = deps.readSnapshot();
  const point = requirePoint(snapshot, 'sampleOnce.readSnapshot');
  const facing = snapshot.facing === 1 ? 1 : -1;
  return {
    t: requireFiniteNumber(deps.now(), 'sampleOnce.now'),
    x: point.x,
    y: point.y,
    posture: typeof state.posture === 'string' ? state.posture : 'stand',
    facing,
    gait: typeof snapshot.gait === 'string' ? snapshot.gait : 'none',
    phase: typeof snapshot.phase === 'string' ? snapshot.phase : 'unknown',
    speed: Number.isFinite(snapshot.speed) ? Number(snapshot.speed) : 0,
    transform: typeof snapshot.transform === 'string' ? snapshot.transform : '',
  };
}

/**
 * 按给定时刻序列采样（**不用定时器**：时点由调用方给，测试与真机同一条代码路径）。
 *
 * @param {object} deps 采样依赖（同 {@link sampleOnce}）
 * @param {readonly number[]} times 采样的绝对时刻（毫秒）
 * @returns {object[]} 样本行（被守卫拦下的时点不产生行）
 * @throws {TypeError|RangeError} 参数非法
 */
function collectSamples(deps, times) {
  if (!Array.isArray(times)) {
    throw new TypeError('[pet-motion-probe] collectSamples.times 必须是数组');
  }
  const rows = [];
  for (const [index, at] of times.entries()) {
    if (!Number.isFinite(at)) {
      throw new RangeError(`[pet-motion-probe] collectSamples.times[${index}] 不是有限数值`);
    }
    const row = sampleOnce(deps);
    if (row !== null) rows.push({ ...row, t: at });
  }
  return rows;
}

/**
 * 两点的欧氏距离。
 *
 * @param {{x: number, y: number}} a 起点
 * @param {{x: number, y: number}} b 终点
 * @returns {number} 距离（DIP）
 */
function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * 判读 P-M17：轨迹连续且**不许原地滑行**。
 *
 * <p>两条子判据：</p>
 * <ol>
 *   <li>`Σ|Δpos| ≥ 0.9 × 起终点直线距离` —— 否则是"走过去又绕回来"或者坐标在抖；</li>
 *   <li>姿态是 `walk`/`run` 的相邻样本之间 `|Δpos| > 0` —— 直接拒绝原地滑行
 *       （"姿态在走、位置不动"是 M3 最刺眼的缺陷形态）。</li>
 * </ol>
 *
 * @param {object[]} rows 样本行
 * @returns {string[]} 问题列表
 */
function checkTrajectory(rows) {
  const problems = [];
  if (rows.length < 2) {
    problems.push('P-M17 样本不足 2 条，无法判读轨迹（--live 未接通时必须是红，不是绿）');
    return problems;
  }
  let travelled = 0;
  for (let index = 1; index < rows.length; index += 1) {
    travelled += distance(rows[index - 1], rows[index]);
  }
  const straight = distance(rows[0], rows[rows.length - 1]);
  if (straight > 0 && travelled < straight * 0.9) {
    problems.push(
      `P-M17 轨迹不单调：走了 ${travelled.toFixed(1)} DIP，直线只有 ${straight.toFixed(1)} DIP（< 90%）`,
    );
  }
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (MOVING_POSTURES.includes(current.posture) && MOVING_POSTURES.includes(previous.posture)) {
      if (distance(previous, current) <= 0) {
        problems.push(
          `P-M17 原地滑行：t=${current.t}ms 姿态是 ${current.posture}，但位置没动（${current.x},${current.y}）`,
        );
        break;
      }
    }
  }
  return problems;
}

/**
 * 判读 P-M18：方向与朝向一致，竖直移动**不许翻向**。
 *
 * @param {object[]} rows 样本行
 * @returns {string[]} 问题列表
 */
function checkFacing(rows) {
  const problems = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    if (Math.abs(dx) > NOISE_FLOOR_DIP && Math.abs(dx) > Math.abs(dy)) {
      const expected = dx > 0 ? 1 : -1;
      if (current.facing !== expected) {
        problems.push(
          `P-M18 横向移动与朝向相反：t=${current.t}ms Δx=${dx.toFixed(1)} 但 facing=${current.facing}`,
        );
        break;
      }
    } else if (Math.abs(dy) > NOISE_FLOOR_DIP && Math.abs(dy) > Math.abs(dx)) {
      if (current.facing !== previous.facing) {
        problems.push(
          `P-M18 竖直移动翻了朝向：t=${current.t}ms Δy=${dy.toFixed(1)}，facing ${previous.facing} → ${current.facing}`,
        );
        break;
      }
    }
  }
  return problems;
}

/**
 * 判读 P-M19：速度落在步态带内（±20% 容差），且步态与速度不矛盾。
 *
 * <p>容差来自设计原文（`[gaitMin×0.8, gaitMax×1.2]`）：真机速度是"每拍位移 ÷ 拍长"，
 * 首末拍会被加减速与取整影响，卡死名义值只会天天误报。</p>
 *
 * @param {object[]} rows 样本行
 * @returns {string[]} 问题列表
 */
function checkSpeed(rows) {
  const problems = [];
  const bands = new Map([
    ['walk', { min: MOTION.walkMinDipPerSec, max: MOTION.walkMaxDipPerSec }],
    ['run', { min: MOTION.runMinDipPerSec, max: MOTION.runMaxDipPerSec }],
  ]);
  for (const row of rows) {
    const band = bands.get(row.gait);
    if (band === undefined) continue;
    const low = band.min * 0.8;
    const high = band.max * 1.2;
    if (row.speed < low || row.speed > high) {
      problems.push(
        `P-M19 速度越界：t=${row.t}ms gait=${row.gait} speed=${row.speed} 不在 [${low.toFixed(1)}, ${high.toFixed(1)}]`,
      );
      break;
    }
  }
  return problems;
}

/**
 * 判读 P-M20：没有镜像。
 *
 * @param {object[]} rows 样本行
 * @returns {string[]} 问题列表
 */
function checkMirror(rows) {
  const problems = [];
  for (const row of rows) {
    const transform = row.transform;
    if (transform.includes('scale(-1') || transform.includes('scaleX(-1)')) {
      problems.push(`P-M20 出现镜像变换：t=${row.t}ms transform="${transform}"`);
      break;
    }
  }
  return problems;
}

/**
 * 判读一批样本（P-M17…P-M20）。
 *
 * @param {object[]} rows 样本行（{@link collectSamples} 的产物）
 * @returns {{ok: boolean, problems: string[], metrics: {count: number, travelledDip: number,
 *   straightDip: number, durationMs: number}}} 判读结果
 * @throws {TypeError} 入参不是数组
 */
function analyzeSamples(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('[pet-motion-probe] analyzeSamples 需要样本数组');
  }
  const problems = [
    ...checkTrajectory(rows),
    ...checkFacing(rows),
    ...checkSpeed(rows),
    ...checkMirror(rows),
  ];
  let travelled = 0;
  for (let index = 1; index < rows.length; index += 1) {
    travelled += distance(rows[index - 1], rows[index]);
  }
  const first = rows.length > 0 ? rows[0] : { t: 0, x: 0, y: 0 };
  const last = rows.length > 0 ? rows[rows.length - 1] : { t: 0, x: 0, y: 0 };
  return {
    ok: problems.length === 0,
    problems,
    metrics: {
      count: rows.length,
      travelledDip: Number(travelled.toFixed(2)),
      straightDip: Number(distance(first, last).toFixed(2)),
      durationMs: last.t - first.t,
    },
  };
}

/**
 * 把样本导成 CSV（真机验收留档用）。
 *
 * @param {object[]} rows 样本行
 * @returns {string} CSV 文本（含表头，行分隔符为 `\n`）
 */
function toCsv(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('[pet-motion-probe] toCsv 需要样本数组');
  }
  const lines = [SAMPLE_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(SAMPLE_COLUMNS.map((column) => String(row[column] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 造一条"合格"的行走轨迹（自证用：判读器必须放行它）。
 *
 * @param {number} [count] 样本数
 * @param {number} [dxPerSample] 每拍横向位移（DIP）
 * @returns {object[]} 样本行
 */
function makeGoodWalk(count = 24, dxPerSample = 2) {
  const rows = [];
  const speed = MOTION.walkMinDipPerSec + (MOTION.walkMaxDipPerSec - MOTION.walkMinDipPerSec) / 2;
  for (let index = 0; index < count; index += 1) {
    rows.push({
      t: index * MOTION.tickMs,
      x: index * dxPerSample,
      y: 0,
      posture: 'walk',
      facing: 1,
      gait: 'walk',
      phase: 'moving',
      speed,
      transform: 'matrix(1, 0, 0, 1, 0, 0)',
    });
  }
  return rows;
}

/**
 * 判读器**判别力自证**：4 条坏轨迹必须被点名，1 条好轨迹必须放行。
 *
 * <p>这是 `--self-check` 的全部内容。它不证明"真机没问题"，只证明
 * **判读器不是永远绿**——没有这一步，`--live` 哪天接上了，一个恒绿的判读器
 * 会把所有缺陷都报成通过。</p>
 *
 * @returns {{ok: boolean, report: string[]}} 自证结果
 */
function selfCheck() {
  const report = [];
  const good = makeGoodWalk();
  const goodResult = analyzeSamples(good);
  report.push(`好轨迹（走 24 拍，横向匀速）：${goodResult.ok ? '放行 ✔' : `误报 ✖ ${goodResult.problems.join('; ')}`}`);

  /** 在好轨迹上改一处，再看判读器是否点名。 */
  const mutate = (mutator) => {
    const rows = good.map((row) => ({ ...row }));
    mutator(rows);
    return analyzeSamples(rows);
  };

  const inPlace = mutate((rows) => {
    for (const row of rows) {
      row.x = 0;
      row.y = 0;
    }
  });
  report.push(`原地滑行：${inPlace.ok ? '漏报 ✖' : `点名 ✔ ${inPlace.problems[0]}`}`);

  const wrongFacing = mutate((rows) => {
    for (const row of rows) row.facing = -1;
  });
  report.push(`横向移动朝向反：${wrongFacing.ok ? '漏报 ✖' : `点名 ✔ ${wrongFacing.problems[0]}`}`);

  const tooFast = mutate((rows) => {
    for (const row of rows) row.speed = MOTION.runMaxDipPerSec * 2;
  });
  report.push(`走速越界：${tooFast.ok ? '漏报 ✖' : `点名 ✔ ${tooFast.problems[0]}`}`);

  const mirrored = mutate((rows) => {
    for (const row of rows) row.transform = 'matrix(-1, 0, 0, 1, 0, 0) scaleX(-1)';
  });
  report.push(`镜像：${mirrored.ok ? '漏报 ✖' : `点名 ✔ ${mirrored.problems[0]}`}`);

  const ok = goodResult.ok && !inPlace.ok && !wrongFacing.ok && !tooFast.ok && !mirrored.ok;
  return { ok, report };
}

/** 用法文本。 */
const USAGE = [
  '用法：node scripts/pet-motion-probe.cjs <mode>',
  '',
  '  --self-check   判读器判别力自证（好轨迹放行 + 4 条坏轨迹必点名；无需真机）',
  '  --live         真机采样（需要 S4 的 pet:motion-snapshot 出口；当前不可用，退出码 2）',
  '  --help         打印本说明',
].join('\n');

/**
 * CLI 入口。
 *
 * @param {readonly string[]} argv 参数（不含 node 与脚本名）
 * @returns {number} 进程退出码（0 通过 / 1 判读失败 / 2 环境未就绪）
 */
function main(argv) {
  const mode = argv.find((item) => item.startsWith('--')) ?? '--help';
  if (mode === '--help') {
    console.log(USAGE);
    return 0;
  }
  if (mode === '--self-check') {
    const result = selfCheck();
    for (const line of result.report) console.log(`[motion-probe] ${line}`);
    if (result.ok) {
      console.log('✅ [motion-probe] 判读器判别力自证通过：好轨迹放行，4 条坏轨迹逐条点名');
      return 0;
    }
    console.error('❌ [motion-probe] 判读器判别力不足：见上面的漏报/误报');
    return 1;
  }
  if (mode === '--live') {
    console.error(
      [
        '❌ [motion-probe] 真机采样暂不可用（退出码 2，不是"通过"）：',
        '   原因：S4 的 pet:motion-snapshot 出口尚未落地（pet-window.cjs 条件 require',
        '   ../pet-motion.cjs 之后才会有 motion 快照）。此时采到 0 条样本绝不能报成绿。',
        '   就绪后本模式会：每 tickMs 读一次 snapshot() + 窗口位置，按 SAMPLE_COLUMNS 输出 CSV，',
        '   并用 analyzeSamples() 判读 P-M17…P-M20。',
      ].join('\n'),
    );
    return 2;
  }
  console.error(`[motion-probe] 未知模式 ${mode}\n${USAGE}`);
  return 2;
}

module.exports = {
  SAMPLE_COLUMNS,
  PROBE_CRITERIA,
  shouldSample,
  sampleOnce,
  collectSamples,
  analyzeSamples,
  toCsv,
  makeGoodWalk,
  selfCheck,
};

// 仅被直接执行时跑 CLI（被测试 require 时保持静默）
if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
