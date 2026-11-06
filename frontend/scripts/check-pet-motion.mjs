#!/usr/bin/env node
/**
 * 桌宠运动门禁：`gate:pet` 的运动段（设计 §10.2 的 G-M1…G-M11）。
 *
 * <p><b>为什么这一片必须靠静态门禁兜住：</b>M3 的缺陷几乎都是**结构性的**——
 * "多了第二个时钟"、"多了第二个位置写入者"、"手感数字抄了第二份"、"隐藏时还在采样"。
 * 它们单看每一行都合理，只有放回整体结构里才成为缺陷；而一旦成为缺陷，
 * 症状就是"猫抽搐 / 瞬移 / 趴着走"这种没人能从日志里定位的现象。所以这里用最笨的文本
 * 断言把 11 条结构约束逐条钉死，并且**每条失败都必须点名文件与行**。</p>
 *
 * <p><b>判据清单（编号与任务书 G-M1…G-M11 一致）：</b></p>
 * <ol>
 *   <li><b>G-M1</b> `electron/pet-motion.cjs` 里不许出现定时器全局函数（**注释也算**）——
 *       唯一 ticker 是命中轮询器的那一拍，运动只能订阅它；</li>
 *   <li><b>G-M2</b> `electron/**` 的**代码**里不许出现 `scaleFactor` / `devicePixelRatio` /
 *       `zoomFactor` / `dpi` / `scaleX`（两个坐标系同为 DIP，任何缩放都会让位置随 DPI 漂移）；</li>
 *   <li><b>G-M3</b> `src/pet/**` 的代码里不许出现 `scaleFactor` / `zoomFactor` / `scaleX`；
 *       `devicePixelRatio` **只许用于选密度档**（同一处 ±3 行内必须出现 `density`）；</li>
 *   <li><b>G-M4</b> 手感数字只许在 `MOTION` 里：被扫描文件不得把 MOTION 常量名赋成字面量，
 *       也不得在"运动语义行"（radius/speed/accel/gait/follow/roam/dip/distance）上出现
 *       220/96/420/320/480/960/24 这些已知字面量；</li>
 *   <li><b>G-M5</b> `pet-window.cjs` 的 `setPosition` 调用必须为 **0** 次；</li>
 *   <li><b>G-M6</b> `pet-window.cjs` 对 `../pet-motion.cjs` 的 require 必须在**函数体/条件路径**上
 *       且必须存在（与 `pet-geometry.json` 同一套打包推理）；</li>
 *   <li><b>G-M7</b> 渲染层不许出现 facing 滞回数值、不许镜像，朝向**必须来自 IPC**；</li>
 *   <li><b>G-M8</b> 单一位置写入者：`applyPosition` 定义唯一，位置写入调用点唯一且在它体内；</li>
 *   <li><b>G-M9</b> 隐藏/睡眠/门禁关闭时 0 采样：探针必须先判 `shouldSample` 后读快照，
 *       且守卫体覆盖 hidden / suspended / gateOpen / 睡姿；</li>
 *   <li><b>G-M10</b> 单一通道名：渲染层 `'pet:motion-intent'` 恰好一次、意图载荷无 x/y，
 *       主进程侧不许自造别的 `pet:motion-*` 通道；</li>
 *   <li><b>G-M11</b> H6 条件式 require 保持：`main.cjs` 对 `./pet-window.cjs` 的 require
 *       必须是条件路径，且 `main.cjs` 不许 require `pet-motion.cjs`。</li>
 * </ol>
 *
 * <p><b>关于"红"的态度：</b>S4（`pet-window.cjs` 唯一写口接线）未完成时，G-M5 / G-M6 / G-M8
 * 会**如实报红**并写明"等 S4"。门禁不许为了让灯变绿而削弱判据——一条被削弱的判据
 * 会在真机上以"猫瞬移"的形式重新长回来。</p>
 *
 * <p><b>用法：</b></p>
 * <pre>
 *   node scripts/check-pet-motion.mjs             # 门禁（逐条打印，失败 exit 1）
 *   node scripts/check-pet-motion.mjs --verbose   # 额外打印扫描到的文件数
 * </pre>
 *
 * @module scripts/check-pet-motion
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRONTEND_ROOT } from './build-pet-geometry.mjs';
import { stripComments } from './check-pet-geometry.mjs';

/** 运动真源（唯一 ticker / 唯一位置写口的所在地）。 */
const MOTION_FILE = 'electron/pet-motion.cjs';
/** 主进程窗口模块（位置写入权的接线处）。 */
const WINDOW_FILE = 'electron/pet-window.cjs';
/** 命中轮询器（唯一 ticker 的所在地）。 */
const POLLER_FILE = 'electron/pet-hit-poller.cjs';
/** 主进程入口（H6 条件 require）。 */
const MAIN_FILE = 'electron/main.cjs';
/** 托盘/右键菜单（文案与阈值单一真源，本门禁只查阈值）。 */
const MENU_FILE = 'electron/pet-menu.cjs';
/** 渲染层入口。 */
const RENDER_FILE = 'src/pet/main.ts';
/** 渲染层行为状态机。 */
const STATE_MACHINE_FILE = 'src/pet/behavior/state-machine.ts';
/** 只读采样器（G-M9 的 0 采样守卫判据点）。 */
const PROBE_FILE = 'scripts/pet-motion-probe.cjs';

/** 主进程侧扫描目录。 */
const ELECTRON_DIR = 'electron';
/** 渲染层扫描目录。 */
const RENDER_DIR = 'src/pet';

/** 主进程侧扫的扩展名。 */
const ELECTRON_EXTENSIONS = Object.freeze(['.cjs', '.js', '.mjs']);
/** 渲染层扫的扩展名。 */
const RENDER_EXTENSIONS = Object.freeze(['.ts', '.tsx']);

/** MOTION 里全部**常量名**（出现"名字 = 字面量"就说明有人抄了一份）。 */
const MOTION_CONSTANT_NAMES = Object.freeze([
  'tickMs',
  'followStartRadiusDip',
  'followStopRadiusDip',
  'gaitRunRadiusDip',
  'gaitWalkRadiusDip',
  'walkMinDipPerSec',
  'walkMaxDipPerSec',
  'runMinDipPerSec',
  'runMaxDipPerSec',
  'accelDipPerSec2',
  'decelDipPerSec2',
  'facingFlipHysteresisDip',
  'facingHysteresisDip',
  'roamMinIntervalMs',
  'roamMaxIntervalMs',
  'roamDwellMs',
  'roamMaxDurationMs',
  'roamCornerBias',
  'roamMarginDip',
]);

/**
 * 已知手感字面量（设计 §10.2 G-M4 原文列出的那一批）。
 *
 * <p>只在这几个数字**落在运动语义行上**时才判红：`24` 与 `480` 在仓库里还有完全无关的
 * 合法用途（`EDGE_MARGIN = 24`、点击动作 `durationMs: 480`），一刀切会把既有代码判红，
 * 而判据要守的是"**手感常量**不许有第二份"。</p>
 */
const KNOWN_HANDFEEL_NUMBERS = Object.freeze(['220', '96', '420', '320', '480', '960', '24']);

/** 认为"这一行在谈运动"的关键词（给字面量命中做上下文过滤）。 */
const MOTION_CONTEXT = /radius|speed|accel|decel|hysteresis|gait|follow|roam|\bdip\b|distance/i;

/** G-M4 的扫描范围（新增文件一开始就硬失败，见设计 U-M6）。 */
const BAKED_NUMBER_TARGETS = Object.freeze([
  WINDOW_FILE,
  MAIN_FILE,
  MENU_FILE,
  POLLER_FILE,
  RENDER_FILE,
  PROBE_FILE,
]);

/** 主进程侧允许出现的运动通道名（§8.1 只有这两条）。 */
const ALLOWED_MOTION_CHANNELS = Object.freeze(['pet:motion-intent', 'pet:motion-snapshot']);

/** 渲染层唯一的意图通道名。 */
const INTENT_CHANNEL = 'pet:motion-intent';

/** 位置写入 API（任何一处都算"写位置"）。 */
const POSITION_WRITE_PATTERN = /\b(setPosition|setBounds|setWindowPosition)\s*\(/;

/**
 * 递归列出一个目录下的文件（相对 `frontend/` 的 POSIX 路径）。
 *
 * @param {string} relativeDir 相对目录
 * @param {readonly string[]} extensions 扩展名白名单
 * @returns {string[]} 相对路径列表
 */
function listFiles(relativeDir, extensions) {
  const root = resolve(FRONTEND_ROOT, relativeDir);
  /** @type {string[]} */
  const found = [];
  /**
   * 递归。
   *
   * @param {string} absoluteDir 绝对目录
   * @param {string} relativeToDir 对应相对路径
   */
  const walk = (absoluteDir, relativeToDir) => {
    for (const entry of readdirSync(absoluteDir)) {
      const absolute = join(absoluteDir, entry);
      const relative = `${relativeToDir}/${entry}`;
      if (statSync(absolute).isDirectory()) {
        walk(absolute, relative);
      } else if (extensions.includes(extname(entry))) {
        found.push(relative);
      }
    }
  };
  walk(root, relativeDir);
  return found.sort();
}

/**
 * 从磁盘装载"门禁要看的所有文件"。
 *
 * <p>返回一张**完整**的路径 → 内容表，判据只读这张表（不各自去碰磁盘）：
 * 于是"喂一份坏样本"与"跑真仓库"走的是同一条代码路径——
 * `petMotionGate.test.cjs` 的判别力用例才真正证明了门禁本身。</p>
 *
 * @returns {Map<string, string>} 相对路径 → 文件内容
 */
export function loadSources() {
  /** @type {Map<string, string>} */
  const sources = new Map();
  const targets = [
    ...listFiles(ELECTRON_DIR, ELECTRON_EXTENSIONS),
    ...listFiles(RENDER_DIR, RENDER_EXTENSIONS),
    PROBE_FILE,
  ];
  for (const relative of targets) {
    sources.set(relative, readFileSync(resolve(FRONTEND_ROOT, relative), 'utf8'));
  }
  return sources;
}

/**
 * 按目录前缀挑出要被扫描的源码。
 *
 * @param {Map<string, string>} sources 源码表
 * @param {string} prefix 目录前缀（如 `electron`）
 * @param {readonly string[]} extensions 扩展名白名单
 * @returns {Array<{path: string, source: string}>} 命中项（按路径排序）
 */
function pickByPrefix(sources, prefix, extensions) {
  const picked = [];
  for (const [path, source] of sources) {
    if (!path.startsWith(`${prefix}/`)) continue;
    if (!extensions.includes(extname(path))) continue;
    picked.push({ path, source });
  }
  return picked.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * 求出某个字符下标所在的行号（1 起）。
 *
 * @param {string} source 源码
 * @param {number} index 字符下标
 * @returns {number} 行号
 */
function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * 逐行找出匹配（返回行号、去首尾空白的行文本与原始行）。
 *
 * <p>返回**原始行**是必需的：G-M6 / G-M11 的判据是"这一行是不是顶层裸 require"，
 * 而"顶层"只能用缩进判断——拿 `trim()` 之后的行永远看不出缩进。</p>
 *
 * @param {string} source 源码
 * @param {RegExp} pattern 正则（可带 `g`；本函数每次会复位）
 * @returns {Array<{line: number, text: string, raw: string}>} 命中列表
 */
function findMatches(source, pattern) {
  const found = [];
  for (const [index, raw] of source.split('\n').entries()) {
    pattern.lastIndex = 0;
    if (pattern.test(raw)) found.push({ line: index + 1, text: raw.trim(), raw });
  }
  return found;
}

/**
 * 取一个**函数/方法声明**的函数体（按大括号计数，能同时支持函数声明与 class 方法）。
 *
 * <p>为什么不能只认 `function name(`：`applyPosition` 在 S4 落地后是
 * `MotionController` 的**类方法**（`  applyPosition(token, x, y) {`），没有 `function` 关键字。
 * 只认函数声明会让判据退化成"找不到 applyPosition ⇒ 永远红"，与"永远绿"一样没用。</p>
 *
 * <p>为什么必须做括号计数而不是找下一行 `}`：方法体内有 `if`/嵌套块，取到第一个 `}` 会把
 * 真正的写入点切在切片之外（早期版本就这样漏过了一条判据）。</p>
 *
 * @param {string} source 源码
 * @param {string} name 函数/方法名
 * @returns {{body: string, line: number}|null} 函数体与其起始行号（找不到为 `null`）
 */
export function sliceDeclarationBody(source, name) {
  const patterns = [new RegExp(`function\\s+${name}\\s*\\(`), new RegExp(`^\\s*${name}\\s*\\([^)]*\\)\\s*\\{`, 'm')];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match === null) continue;
    const braceStart = source.indexOf('{', match.index);
    if (braceStart < 0) continue;
    let depth = 0;
    for (let index = braceStart; index < source.length; index += 1) {
      const char = source[index];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return { body: source.slice(match.index, index + 1), line: lineAt(source, match.index) };
        }
      }
    }
  }
  return null;
}

/**
 * 取一个具名函数的函数体（兼容旧的"到下一个两格缩进收尾"截取）。
 *
 * @param {string} source 源码
 * @param {string} signature 形如 `function applyPosition(`
 * @returns {string} 函数体（找不到时为空串）
 */
export function sliceFunctionBody(source, signature) {
  const name = /function\s+([A-Za-z_$][\w$]*)/.exec(signature)?.[1];
  if (name !== undefined) {
    const sliced = sliceDeclarationBody(source, name);
    if (sliced !== null) return sliced.body;
  }
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const end = source.indexOf('\n}', start);
  if (end > start) return source.slice(start, end);
  const fallback = source.indexOf('\n  }', start);
  return fallback > start ? source.slice(start, fallback) : source.slice(start);
}

/**
 * 在采样入口之后找 `shouldSample(...)` 的**调用**下标。
 *
 * <p>为什么不能直接 `indexOf('shouldSample(')`：文件里先出现的是
 * `function shouldSample(`（定义），拿它当"调用"会让顺序判据永远成立。
 * 所以从采样入口开始找，并跳过被 `function ` 修饰的那一处。</p>
 *
 * @param {string} source 源码
 * @param {number} from 从这里开始找（通常是采样入口的下标）
 * @returns {number} 调用处下标；找不到为 `-1`
 */
function indexOfGuardCall(source, from) {
  if (from < 0) return -1;
  const regex = /shouldSample\(/g;
  regex.lastIndex = from;
  let match = regex.exec(source);
  let found = -1;
  while (match !== null) {
    const prefix = source.slice(Math.max(0, match.index - 12), match.index);
    if (!/function\s+$/.test(prefix)) found = match.index;
    match = regex.exec(source);
  }
  return found;
}

/**
 * G-M1：`pet-motion.cjs` 不许出现定时器全局函数（**连注释都不许**）。
 *
 * @param {Map<string, string>} sources 源码表
 * @returns {string[]} 问题列表
 */
export function checkNoTicker(sources) {
  const source = sources.get(MOTION_FILE);
  if (typeof source !== 'string') return [`G-M1 缺少 ${MOTION_FILE}（运动真源不见了，门禁失效）`];
  const problems = [];
  for (const hit of findMatches(source, /\bsetInterval\b|\bsetTimeout\b/)) {
    problems.push(
      `G-M1 ${MOTION_FILE}:${hit.line} 出现定时器：${hit.text} —— 运动只能订阅命中轮询器那一拍（唯一 ticker），` +
        '自带第二个时钟会与它抢写位置',
    );
  }
  if (!source.includes('MOTION')) {
    problems.push(`G-M1 ${MOTION_FILE} 没有 MOTION（手感真源必须在这个文件里）`);
  }
  return problems;
}

/**
 * 扫一组文件的**代码**（去注释）里的禁词。
 *
 * @param {Array<{path: string, source: string}>} files 文件列表
 * @param {readonly string[]} tokens 禁词（区分大小写的标识符）
 * @param {string} id 判据 id（问题前缀）
 * @param {string} reason 为什么禁（写进问题里）
 * @returns {string[]} 问题列表
 */
function scanTokens(files, tokens, id, reason) {
  const problems = [];
  for (const { path, source } of files) {
    const code = stripComments(source);
    for (const [index, text] of code.split('\n').entries()) {
      for (const token of tokens) {
        const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${token}([^A-Za-z0-9_$]|$)`);
        if (pattern.test(text)) {
          problems.push(`${id} ${path}:${index + 1} 出现 ${token}（${reason}）`);
        }
      }
    }
  }
  return problems;
}

/**
 * G-M2：主进程侧 DIP 纯度与禁镜像。
 *
 * @param {Map<string, string>} sources 源码表
 * @returns {string[]} 问题列表
 */
export function checkElectronDipPurity(sources) {
  const files = pickByPrefix(sources, ELECTRON_DIR, ELECTRON_EXTENSIONS);
  if (files.length === 0) return [`G-M2 没有扫描到任何 ${ELECTRON_DIR}/* 源码（门禁失效）`];
  return [
    ...scanTokens(
      files,
      ['scaleFactor', 'devicePixelRatio', 'zoomFactor', 'dpi'],
      'G-M2',
      '两个坐标系同为 DIP，任何缩放/像素比换算都会让位置随 DPI 漂移',
    ),
    ...scanTokens(files, ['scaleX'], 'G-M2', '主进程不许镜像（朝向只由 facing 表达）'),
  ];
}

/**
 * 求某一行的"语句上下文"（用于判断这次 `devicePixelRatio` 是否在为选密度档服务）。
 *
 * <p>做法：从该行向上扩到"上一行以 `;` / `{` / `}` 结尾"为止，向下扩到"本行含 `;`"为止，
 * 上下各最多 8 行。多行调用的形态（`const LAYER_DENSITY = pickLayerDensity(` 换行写参数）
 * 因此仍能落进同一条语句；而"另起一行写了个无关的 DPR 计算"不会被相邻的密度代码顺带放行
 * （按固定 ±3 行开窗就会误放，`petMotionGate.test.cjs` 有一条用例专钉这一点）。</p>
 *
 * @param {readonly string[]} lines 源码各行
 * @param {number} index 命中行下标（0 起）
 * @returns {string} 语句上下文文本
 */
function statementContext(lines, index) {
  const maxSpread = 8;
  let start = index;
  while (start > 0 && index - start < maxSpread) {
    const previous = lines[start - 1].trimEnd();
    if (previous.endsWith(';') || previous.endsWith('{') || previous.endsWith('}')) break;
    start -= 1;
  }
  let end = index;
  while (end < lines.length - 1 && end - index < maxSpread) {
    if (lines[end].includes(';')) break;
    end += 1;
  }
  return lines.slice(start, end + 1).join('\n');
}

/**
 * G-M3：渲染层 DIP 纯度（`devicePixelRatio` 只许用于选密度档）与禁镜像。
 *
 * @param {Map<string, string>} sources 源码表
 * @returns {string[]} 问题列表
 */
export function checkRenderDipPurity(sources) {
  const files = pickByPrefix(sources, RENDER_DIR, RENDER_EXTENSIONS);
  if (files.length === 0) return [`G-M3 没有扫描到任何 ${RENDER_DIR}/**/*.ts（门禁失效）`];
  const problems = [
    ...scanTokens(files, ['scaleFactor', 'zoomFactor'], 'G-M3', '渲染层不做缩放换算，尺寸全部走 DIP'),
    ...scanTokens(files, ['scaleX'], 'G-M3', '镜像渲染（P-M20）一律禁止'),
  ];
  for (const { path, source } of files) {
    const lines = stripComments(source).split('\n');
    for (const [index, text] of lines.entries()) {
      if (!/devicePixelRatio/.test(text)) continue;
      if (!/density/i.test(statementContext(lines, index))) {
        problems.push(
          `G-M3 ${path}:${index + 1} 用 devicePixelRatio 做了与"选密度档"无关的事：${text.trim()} —— ` +
            'DPR 只许喂密度选档，不许参与坐标或尺寸推导',
        );
      }
    }
  }
  return problems;
}

/**
 * G-M4：手感数字不许复制（阈值只许来自 `MOTION`）。
 *
 * @param {Map<string, string>} sources 源码表
 * @returns {string[]} 问题列表
 */
export function checkNoBakedHandfeel(sources) {
  const problems = [];
  for (const path of BAKED_NUMBER_TARGETS) {
    const source = sources.get(path);
    if (typeof source !== 'string') {
      problems.push(`G-M4 缺少被扫描文件 ${path}（改名后请同步本门禁的清单）`);
      continue;
    }
    const lines = stripComments(source).split('\n');
    for (const [index, text] of lines.entries()) {
      for (const name of MOTION_CONSTANT_NAMES) {
        if (new RegExp(`\\b${name}\\b\\s*[:=]\\s*-?\\d`).test(text)) {
          problems.push(
            `G-M4 ${path}:${index + 1} 自己定义了 ${name} 的数值：${text.trim()} —— ` +
              `手感阈值只许来自 ${MOTION_FILE} 的 MOTION`,
          );
        }
      }
      if (!MOTION_CONTEXT.test(text)) continue;
      for (const number of KNOWN_HANDFEEL_NUMBERS) {
        if (new RegExp(`(^|[^0-9.])${number}([^0-9.]|$)`).test(text)) {
          problems.push(
            `G-M4 ${path}:${index + 1} 在运动语义行上出现烘焙数字 ${number}：${text.trim()} —— ` +
              '阈值必须从 MOTION 读，复制一份就是第二真源',
          );
        }
      }
    }
  }
  return problems;
}

/**
 * G-M5：`pet-window.cjs` 的 `setPosition` 调用必须为 0。
 *
 * @param {Map<string, string>} sources 源码表
 * @returns {string[]} 问题列表
 */
export function checkWindowPositionWriter(sources) {
  const source = sources.get(WINDOW_FILE);
  if (typeof source !== 'string') return [`G-M5 缺少 ${WINDOW_FILE}（门禁失效）`];
  const problems = [];
  for (const hit of findMatches(stripComments(source), /\bsetPosition\s*\(/)) {
    problems.push(
      `G-M5 ${WINDOW_FILE}:${hit.line} 直接写了窗口位置：${hit.text} —— 位置写入权只归 ` +
        `${MOTION_FILE} 的 applyPosition（单一写者），S4 收口后这条必须为 0`,
    );
  }
  return problems;
}

/**
 * G-M6：`pet-window.cjs` 对 `../pet-motion.cjs` 的 require 必须在函数体/条件路径上。
 *
 * @param {Map<string, string>} sources 源码表
 * @returns {string[]} 问题列表
 */
export function checkWindowMotionRequire(sources) {
  const source = sources.get(WINDOW_FILE);
  if (typeof source !== 'string') return [`G-M6 缺少 ${WINDOW_FILE}（门禁失效）`];
  // 两个合法写法都接受：窗口模块与运动真源同在 `electron/`，所以 `./pet-motion.cjs` 才是正解；
  // 早期写成 `../pet-motion.cjs`（把它当 frontend/ 下的文件）会指到不存在的位置。
  const hits = findMatches(source, /require\(\s*'\.{1,2}\/pet-motion\.cjs'\s*\)/);
  if (hits.length === 0) {
    return [
      `G-M6 ${WINDOW_FILE} 尚未 require('./pet-motion.cjs')（等 S4 接线）—— ` +
        '接线时必须是函数体/条件路径上的 require，不许写成顶层裸 require',
    ];
  }
  const problems = [];
  for (const hit of hits) {
    const indented = /^\s{2,}/.test(hit.raw);
    const conditional = hit.text.includes('?') || hit.text.includes('&&') || hit.text.includes('||');
    if (!indented && !conditional) {
      problems.push(
        `G-M6 ${WINDOW_FILE}:${hit.line} 对 pet-motion.cjs 是顶层裸 require：${hit.text} —— ` +
          '必须放在函数体或条件路径里（与 pet-geometry.json 同一套打包推理）',
      );
    }
  }
  return problems;
}

/**
 * G-M7：渲染层朝向纪律（不复制滞回数值、不镜像、朝向来自 IPC）。
 *
 * @param {Map<string, string>} sources 源码表
 * @returns {string[]} 问题列表
 */
export function checkRenderFacing(sources) {
  const targets = [RENDER_FILE, STATE_MACHINE_FILE].filter((path) => typeof sources.get(path) === 'string');
  if (targets.length < 2) return [`G-M7 缺少 ${RENDER_FILE} 或 ${STATE_MACHINE_FILE}（门禁失效）`];
  const files = targets.map((path) => ({ path, source: sources.get(path) }));
  const problems = [...scanTokens(files, ['scaleX'], 'G-M7', '渲染层不许镜像，朝向只由 facing 表达')];
  for (const { path, source } of files) {
    for (const [index, text] of stripComments(source).split('\n').entries()) {
      if (!/hysteresis|facing/i.test(text)) continue;
      if (/(^|[^0-9.])24([^0-9.]|$)/.test(text)) {
        problems.push(
          `G-M7 ${path}:${index + 1} 出现 facing 滞回数值：${text.trim()} —— ` +
            '滞回只在 MOTION.facingFlipHysteresisDip，渲染层一个数值都不许复制',
        );
      }
    }
  }
  const renderCode = stripComments(sources.get(RENDER_FILE));
  if (!/applyFacingIfMoving\(\s*fact\.facing\s*\)/.test(renderCode)) {
    problems.push(
      `G-M7 ${RENDER_FILE} 找不到把 IPC 朝向交给 applyFacingIfMoving(fact.facing) 的调用 —— ` +
        '朝向必须由主进程按滞回决定后下发',
    );
  }
  for (const hit of findMatches(renderCode, /facing\s*=[^=].*(screenX|clientX|cursorX)/i)) {
    problems.push(`G-M7 ${RENDER_FILE}:${hit.line} 从光标横坐标自行推朝向：${hit.text} —— 判定权属于主进程`);
  }
  return problems;
}

/**
 * G-M8：单一位置写入者（`applyPosition` 定义唯一，写入点唯一且在它体内）。
 *
 * @param {Map<string, string>} sources 源码表
 * @returns {string[]} 问题列表
 */
export function checkSinglePositionWriter(sources) {
  const source = sources.get(MOTION_FILE);
  if (typeof source !== 'string') return [`G-M8 缺少 ${MOTION_FILE}（门禁失效）`];
  const code = stripComments(source);
  // 定义可以是函数声明、箭头/函数值，或 class 方法（S4 落地后正是最后一种）。
  const functionDefinitions = (code.match(/function\s+applyPosition\s*\(/g) ?? []).length;
  const valueDefinitions = (code.match(/(?:const|let|var)\s+applyPosition\s*=/g) ?? []).length;
  const methodDefinitions = (code.match(/^\s+applyPosition\s*\([^)]*\)\s*\{/gm) ?? []).length;
  const definitions = functionDefinitions + valueDefinitions + methodDefinitions;
  if (definitions === 0) {
    return [
      `G-M8 ${MOTION_FILE} 里还没有 applyPosition（等 S4 落地唯一写口）—— ` +
        '它必须是位置写入的唯一出口：定义一处、写入调用一处，且都在它体内',
    ];
  }
  const problems = [];
  if (definitions > 1) {
    problems.push(
      `G-M8 ${MOTION_FILE} 出现 ${definitions} 处 applyPosition 定义` +
        `（函数声明 ${functionDefinitions} / 值定义 ${valueDefinitions} / 方法 ${methodDefinitions}）—— 唯一写者只能有一处`,
    );
  }
  const sliced = sliceDeclarationBody(code, 'applyPosition');
  if (sliced === null) {
    problems.push(`G-M8 ${MOTION_FILE} 取不到 applyPosition 的函数体（签名变了请同步本门禁）`);
    return problems;
  }
  const writesInside = findMatches(sliced.body, POSITION_WRITE_PATTERN);
  if (writesInside.length !== 1) {
    problems.push(
      `G-M8 ${MOTION_FILE}:${sliced.line} 的 applyPosition 体内有 ${writesInside.length} 处位置写入调用（必须恰好 1 处）`,
    );
  }
  const writesAll = findMatches(code, POSITION_WRITE_PATTERN);
  if (writesAll.length !== writesInside.length) {
    problems.push(
      `G-M8 ${MOTION_FILE}:${writesAll.map((hit) => hit.line).join(',')} 在 applyPosition 之外还有位置写入` +
        `（全集 ${writesAll.length} 处 / 体内 ${writesInside.length} 处）`,
    );
  }
  return problems;
}

/**
 * G-M9：隐藏/睡眠/门禁关闭时 0 采样（探针必须先判守卫后读快照）。
 *
 * @param {Map<string, string>} sources 源码表
 * @returns {string[]} 问题列表
 */
export function checkProbeGuards(sources) {
  const source = sources.get(PROBE_FILE);
  if (typeof source !== 'string') return [`G-M9 缺少 ${PROBE_FILE}（只读采样器不见了）`];
  const code = stripComments(source);
  const problems = [];
  const sampleStart = code.indexOf('function sampleOnce(');
  if (sampleStart < 0) {
    return [`G-M9 ${PROBE_FILE} 找不到 sampleOnce（采样入口变了请同步本门禁）`];
  }
  // 判据只看**采样入口之后**的顺序：文件里先出现的 `function shouldSample(` 是定义，不是调用。
  const guardCall = indexOfGuardCall(code, sampleStart);
  const snapshotRead = code.indexOf('readSnapshot()', sampleStart);
  if (guardCall < 0) {
    return [`G-M9 ${PROBE_FILE} 的 sampleOnce 里找不到 shouldSample(...) 守卫调用（隐藏/睡眠/门禁关闭时必须 0 采样）`];
  }
  if (snapshotRead < 0) {
    return [`G-M9 ${PROBE_FILE} 的 sampleOnce 里找不到快照读取点（采样入口变了请同步本门禁）`];
  }
  if (guardCall > snapshotRead) {
    problems.push(
      `G-M9 ${PROBE_FILE} 在 sampleOnce 里先读快照（第 ${lineAt(code, snapshotRead)} 行）` +
        `再判守卫（第 ${lineAt(code, guardCall)} 行）—— 隐藏期间仍会白采样一次，顺序必须反过来`,
    );
  }
  const body = sliceFunctionBody(code, 'function shouldSample(');
  if (body === '') {
    problems.push(`G-M9 ${PROBE_FILE} 取不到 shouldSample 的函数体（门禁失效）`);
    return problems;
  }
  for (const [token, why] of [
    ['hidden', '窗口隐藏'],
    ['suspended', '挂起'],
    ['gateOpen', '运动门禁关闭'],
    ['sleep', '睡眠/趴着'],
  ]) {
    if (!body.includes(token)) {
      problems.push(`G-M9 ${PROBE_FILE} 的 shouldSample 没有覆盖"${why}"（缺少 ${token} 判据）`);
    }
  }
  return problems;
}

/**
 * G-M10：单一通道名 + 意图载荷无坐标。
 *
 * @param {Map<string, string>} sources 源码表
 * @returns {string[]} 问题列表
 */
export function checkSingleChannel(sources) {
  const renderSource = sources.get(RENDER_FILE);
  if (typeof renderSource !== 'string') return [`G-M10 缺少 ${RENDER_FILE}（门禁失效）`];
  const problems = [];
  const code = stripComments(renderSource);
  const occurrences = code.split(`'${INTENT_CHANNEL}'`).length - 1;
  if (occurrences !== 1) {
    problems.push(
      `G-M10 ${RENDER_FILE} 里 '${INTENT_CHANNEL}' 在**代码**中出现 ${occurrences} 次（必须恰好 1 次：通道名是单一真源）`,
    );
  }
  const interfaceStart = code.indexOf('interface MotionIntent');
  if (interfaceStart < 0) {
    problems.push(`G-M10 ${RENDER_FILE} 找不到 interface MotionIntent（契约缺失）`);
  } else {
    const interfaceEnd = code.indexOf('}', interfaceStart);
    const block = code.slice(interfaceStart, interfaceEnd > interfaceStart ? interfaceEnd : interfaceStart + 400);
    if (/^\s*[xy]\??\s*:/m.test(block)) {
      problems.push(`G-M10 ${RENDER_FILE} 的 interface MotionIntent 里有坐标字段 —— 意图只许表达"要不要动、为什么"`);
    }
  }
  for (const { path, source } of pickByPrefix(sources, ELECTRON_DIR, ELECTRON_EXTENSIONS)) {
    for (const literal of new Set(stripComments(source).match(/'pet:motion-[a-z-]+'/g) ?? [])) {
      const name = literal.slice(1, -1);
      if (!ALLOWED_MOTION_CHANNELS.includes(name)) {
        problems.push(`G-M10 ${path} 自造了运动通道 ${literal}（只允许 ${ALLOWED_MOTION_CHANNELS.join(' / ')}）`);
      }
    }
  }
  return problems;
}

/**
 * G-M11：H6 条件式 require 保持。
 *
 * @param {Map<string, string>} sources 源码表
 * @returns {string[]} 问题列表
 */
export function checkPackagingInvariant(sources) {
  const source = sources.get(MAIN_FILE);
  if (typeof source !== 'string') return [`G-M11 缺少 ${MAIN_FILE}（门禁失效）`];
  const requires = findMatches(source, /require\('\.\/pet-window\.cjs'\)/);
  if (requires.length === 0) {
    return [`G-M11 ${MAIN_FILE} 找不到 require('./pet-window.cjs')（改名后请同步本门禁）`];
  }
  const problems = [];
  for (const hit of requires) {
    const indented = /^\s{2,}/.test(hit.raw);
    const conditional = hit.text.includes('?') || hit.text.includes('&&') || hit.text.includes('||');
    if (!indented || !conditional) {
      problems.push(
        `G-M11 ${MAIN_FILE}:${hit.line} 对 './pet-window.cjs' 是顶层裸 require：${hit.text} —— ` +
          '打包版桌宠恒关，靠"条件 require 不执行"才不崩；改成顶层 require 会在启动阶段直接抛',
      );
    }
  }
  for (const hit of findMatches(source, /require\(\s*'[^']*pet-motion\.cjs'\s*\)/)) {
    problems.push(
      `G-M11 ${MAIN_FILE}:${hit.line} require 了 pet-motion.cjs：${hit.text} —— ` +
        '运动只许被 pet-window.cjs 在条件路径上要求，main.cjs 顶层 require 会让打包版崩',
    );
  }
  return problems;
}

/** 全部判据（顺序即输出顺序）。 */
const CRITERIA = Object.freeze([
  { id: 'G-M1', title: 'pet-motion.cjs 无自重时钟', run: checkNoTicker },
  { id: 'G-M2', title: '主进程 DIP 纯度 + 禁镜像', run: checkElectronDipPurity },
  { id: 'G-M3', title: '渲染层 DIP 纯度（DPR 只选密度）+ 禁镜像', run: checkRenderDipPurity },
  { id: 'G-M4', title: '手感数字不许复制', run: checkNoBakedHandfeel },
  { id: 'G-M5', title: 'pet-window.cjs setPosition 计 0', run: checkWindowPositionWriter },
  { id: 'G-M6', title: 'pet-window.cjs 条件 require pet-motion', run: checkWindowMotionRequire },
  { id: 'G-M7', title: '渲染层朝向纪律（IPC 供值、无滞回数值）', run: checkRenderFacing },
  { id: 'G-M8', title: '单一位置写入者（applyPosition 唯一）', run: checkSinglePositionWriter },
  { id: 'G-M9', title: '隐藏/睡眠/门禁关闭时 0 采样', run: checkProbeGuards },
  { id: 'G-M10', title: '单一通道名 + 意图无坐标', run: checkSingleChannel },
  { id: 'G-M11', title: 'H6 条件式 require 保持', run: checkPackagingInvariant },
]);

/**
 * 跑完整门禁。
 *
 * @param {{sources?: Map<string, string>, verbose?: boolean}} [options] 运行选项
 *   `sources` 省略时从磁盘装载（{@link loadSources}）
 * @returns {{ok: boolean, problems: string[], criteria: Array<{id: string, title: string,
 *   ok: boolean, problems: string[]}>}} 结果
 */
export function runMotionGate(options = {}) {
  const sources = options.sources instanceof Map ? options.sources : loadSources();
  const criteria = CRITERIA.map((criterion) => {
    let problems;
    try {
      problems = criterion.run(sources);
    } catch (error) {
      problems = [`${criterion.id} 判据自身抛错：${String(error)}`];
    }
    return { id: criterion.id, title: criterion.title, ok: problems.length === 0, problems };
  });
  const problems = criteria.flatMap((criterion) => criterion.problems);
  if (options.verbose === true) {
    console.log(`[motion-gate] 扫描 ${sources.size} 个文件；判据 ${criteria.length} 条`);
  }
  return { ok: problems.length === 0, problems, criteria };
}

/**
 * CLI 入口。
 *
 * @returns {number} 进程退出码（0 全绿 / 1 有判据不满足）
 */
export function main() {
  const verbose = process.argv.slice(2).includes('--verbose');
  const result = runMotionGate({ verbose });
  for (const criterion of result.criteria) {
    console.log(`${criterion.ok ? '✅' : '❌'} ${criterion.id} ${criterion.title}`);
    for (const problem of criterion.problems) console.error(`   - ${problem}`);
  }
  if (result.ok) {
    console.log(
      `✅ gate:pet:motion 通过：${result.criteria.length} 条结构判据全绿（单一写者 / 单一时钟 / 单一真源 / 0 采样守卫）`,
    );
    return 0;
  }
  const failed = result.criteria.filter((criterion) => !criterion.ok).map((criterion) => criterion.id);
  console.error(`❌ gate:pet:motion 失败：${failed.join(' / ')} 未通过（共 ${result.problems.length} 条问题）`);
  return 1;
}

// 仅被直接执行时跑 CLI（被测试 import 时保持静默）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
