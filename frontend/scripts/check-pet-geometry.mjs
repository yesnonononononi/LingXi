#!/usr/bin/env node
/**
 * 桌宠几何与资产门禁：`npm run gate:pet`。
 *
 * <p><b>为什么需要门禁：</b>这轮"不好看"的根因是**同一个尺寸在四处独立硬编码**（主进程常量、
 * CSS 变量、命中矩形、资产宽高比），改一个漏三个，而且症状（立绘被切角 / 尾巴被裁）很难一眼归因。
 * 注释不管用，测试也管不到 CSS 与主进程，所以用脚本钉死：</p>
 *
 * <ol>
 *   <li>几何文件自洽：立绘箱严格 2:3、派生字段是最新的、窗口公式正确；</li>
 *   <li>墨迹自洽：`artHeight × visibleRatioY ≈ inkHeight`（改了 inkHeight 没改包围盒，这里红）；</li>
 *   <li>运行时资产：按 `pet-assets.json` 逐文件校验尺寸/2:3/体积/sha256，且必须是当前 v3 产物；</li>
 *   <li>美术契约（源目录在场时才跑）：`manifest.json` 的画布、色彩空间、alpha 模式、8 档表情、
 *       眨眼映射与我们接入的一致；源不在（CI 上）跳过并打印原因；</li>
 *   <li>源码无旧魔法数：`pet-window.cjs` / `pet.css` / `layout.ts` 内不得再出现 288/316/320/420；
 *       不得出现 `rotate(-90deg)`（横图掰竖的旧写法）与 `object-fit: cover`（裁切即切尾巴）；</li>
 *   <li>CSS 变量默认值与几何文件一致（首帧兜底值不能与真源漂移）；</li>
 *   <li><b>命中矩形运行时断言</b>（M9 返修）：把 `electron/pet-hit-region.cjs` 真的跑起来，
 *       用门禁里**独立复算**的矩形逐字段（1e-9）比对，并用模块自己的 `containsPoint` 断言
 *       六个透明留白点必须不命中、立绘中心必须命中，再断言矩形明显小于窗口。
 *       文本匹配只留作补充项——它防得住"抄数字"，防不住"算完不用"。</li>
 * </ol>
 *
 * 用法：
 * <pre>
 *   node scripts/check-pet-geometry.mjs            # 门禁
 *   node scripts/check-pet-geometry.mjs --verbose  # 打印每项检查明细
 * </pre>
 *
 * @module scripts/check-pet-geometry
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ART_ASPECT,
  ASPECT_TOLERANCE,
  FRONTEND_ROOT,
  readJsonFile,
  rebuild,
} from './build-pet-geometry.mjs';
import {
  ART_EXPRESSION_IDS,
  ASSETS_JSON_PATH,
  DEFAULT_OUT_DIR,
  detectSourceDir,
  readRuntimeManifest,
  verifyManifestAgainstDisk,
} from './build-pet-assets.mjs';

/** 运行时资产目录（由 `build-pet-assets.mjs` 产出，来源是美术 `runtime/`）。 */
export const RUNTIME_ASSET_DIR = DEFAULT_OUT_DIR;

/** 旧的裸魔法数（立绘箱 288×316 / 窗口 320×420）：必须一个都不剩。 */
export const FORBIDDEN_MAGIC_NUMBERS = [288, 316, 320, 420];

/** 需要扫描的源码（相对 frontend/）。 */
const SCAN_FILES = ['electron/pet-window.cjs', 'src/pet/pet.css', 'src/pet/layout.ts'];

/** 明令禁止的旧写法：正则 + 人话说明。 */
const FORBIDDEN_PATTERNS = [
  { pattern: /rotate\(\s*-90deg\s*\)/i, reason: '横图掰竖的旧写法：v3 已经是正立图，再转 90° 就是躺着的猫' },
  { pattern: /object-fit\s*:\s*cover/i, reason: 'cover 会按容器裁切，v3 右侧尾巴留白很窄，裁了就是切尾巴' },
  { pattern: /width\s*:\s*var\(--pet-art-h\)/i, reason: '立绘宽高对调是旋转时代的写法，现已按 2:3 立绘箱等比 contain' },
];

// 图像头解析搬到了无依赖的 pet-image-headers.mjs（避免 build-pet-assets → check-pet-geometry → 循环）
export { readImageSize, readPngSize, readWebpSize } from './pet-image-headers.mjs';

/**
 * 去掉源码里的注释，避免注释里的数字命中魔法数扫描。
 *
 * <p>只做"够用"的处理：块注释整段删除、行注释截断。不做完整词法分析——
 * 门禁只需要降低误报，不需要 100% 精确。</p>
 *
 * @param {string} source 源码文本
 * @returns {string} 去注释后的文本（保留换行以便报行号）
 */
export function stripComments(source) {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, (matched) => matched.replace(/[^\n]/g, ' '));
  return withoutBlock
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index >= 0 ? line.slice(0, index) : line;
    })
    .join('\n');
}

/**
 * 扫描源码里的旧魔法数与禁用写法。
 *
 * @param {string} filePath 绝对路径
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function scanSource(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const code = stripComments(raw);
  const problems = [];
  const lines = code.split('\n');
  lines.forEach((line, index) => {
    for (const magic of FORBIDDEN_MAGIC_NUMBERS) {
      // 前后不能再接数字/小数点，避免 1288 这类误报
      const pattern = new RegExp(`(^|[^0-9.])${magic}([^0-9.]|$)`);
      if (pattern.test(line)) {
        problems.push(`${filePath}:${index + 1} 出现旧魔法数 ${magic}（尺寸必须来自 pet-geometry.json）`);
      }
    }
  });
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) problems.push(`${filePath} 命中禁用写法 ${pattern}：${reason}`);
  }
  return problems;
}

/**
 * 校验 CSS 里的变量默认值与几何文件一致（首帧兜底值不能漂移）。
 *
 * @param {string} cssPath pet.css 路径
 * @param {object} geometry 几何对象
 * @returns {string[]} 问题列表
 */
export function checkCssVariables(cssPath, geometry) {
  const css = readFileSync(cssPath, 'utf8');
  const problems = [];
  const margin = geometry.effectMargin ?? null;
  const expectations = [
    ['--pet-art-w', geometry.artWidth],
    ['--pet-art-h', geometry.artHeight],
    ['--pet-art-glow-pad', geometry.glowPad],
    ['--pet-art-bubble-h', geometry.bubbleHeight],
  ];
  // 四边特效边距是 M3 之后的新真源：首帧兜底值必须与 JSON 一致，否则首帧窗口会闪一下
  if (margin) {
    expectations.push(['--pet-effect-top', margin.top]);
    expectations.push(['--pet-effect-right', margin.right]);
    expectations.push(['--pet-effect-bottom', margin.bottom]);
    expectations.push(['--pet-effect-left', margin.left]);
  }
  for (const [name, expected] of expectations) {
    const match = new RegExp(`${name}\\s*:\\s*([0-9.]+)px`).exec(css);
    if (!match) {
      problems.push(`${cssPath} 缺少 CSS 变量 ${name}（首帧兜底值）`);
      continue;
    }
    const actual = Number(match[1]);
    if (Math.abs(actual - expected) > 0.001) {
      problems.push(`${cssPath} 的 ${name}=${actual}px 与几何真源 ${expected}px 不一致`);
    }
  }
  return problems;
}

/**
 * 校验主进程窗口尺寸确实从 `effectMargin` 派生（而不是自己抄一份单值）。
 *
 * <p>为什么用文本断言而不是 `require` 主进程文件：`pet-window.cjs` 顶部就 require 了 electron，
 * 在纯 node 里跑不起来。但"窗口尺寸算错"的后果（立绘被窗口边缘裁掉）非常难二分定位，
 * 所以这里退一步，用最笨也最稳的办法钉死**表达式形态**：
 * 只要有人把 `left + right` 改回 `glowPad × 2`，这里立刻红。</p>
 *
 * @param {string} windowPath `electron/pet-window.cjs` 的绝对路径
 * @returns {string[]} 问题列表
 */
export function checkWindowDerivation(windowPath) {
  const code = stripComments(readFileSync(windowPath, 'utf8'));
  const problems = [];
  if (!/EFFECT_MARGIN\s*=\s*GEOMETRY\.effectMargin/.test(code)) {
    problems.push(`${windowPath} 没有从 GEOMETRY.effectMargin 取四边边距（窗口尺寸会与真源脱钩）`);
  }
  if (/GLOW_PAD\s*\*\s*2/.test(code)) {
    problems.push(`${windowPath} 仍在用 glowPad × 2 算窗口（effectMargin 非对称时会算错，立绘会被窗口裁切）`);
  }
  if (!/PET_WIDTH\s*=\s*ART_WIDTH\s*\+\s*EFFECT_MARGIN\.left\s*\+\s*EFFECT_MARGIN\.right/.test(code)) {
    problems.push(`${windowPath} 的 PET_WIDTH 必须写成 ART_WIDTH + EFFECT_MARGIN.left + EFFECT_MARGIN.right`);
  }
  if (!/PET_HEIGHT\s*=\s*ART_HEIGHT\s*\+\s*EFFECT_MARGIN\.top\s*\+\s*EFFECT_MARGIN\.bottom\s*\+\s*BUBBLE_H/.test(code)) {
    problems.push(`${windowPath} 的 PET_HEIGHT 必须写成 ART_HEIGHT + EFFECT_MARGIN.top + EFFECT_MARGIN.bottom + BUBBLE_H`);
  }
  return problems;
}

/**
 * **合成几何**：敏感性断言的输入（与真源**明显不同**的一份合法几何）。
 *
 * <p><b>它解决什么（G-01 的整体绕过）：</b>只用真几何调 `deriveHitRect`，验的是"当前这份几何下
 * 值对不对"——**单点值测试**。于是两种写法能整体骗过门禁：①直接返回烘焙常量
 * （用指数写法 `5.874248e1` 还能躲掉文本扫描）；②忽略入参、自己 `require('../pet-geometry.json')`
 * 再算（门禁传的正好就是同一份真几何 ⇒ 结果一致）。两者在几何未变时永远等于期望值。</p>
 *
 * <p>换一份**明显不同**的几何再问一次"你会不会跟着变"，验的就是**函数性质**：
 * 烘焙常量给不出这份几何的答案，忽略入参的实现也变不出第二个结果。</p>
 *
 * <p>数值刻意取得与真源差别很大（立绘 200×300 vs 156×234、边距 30/20/12/10 vs 56/56/24/18、
 * 气泡 60 vs 72、包围盒 0.1~0.9 vs 真实值），任何"其实没算"的实现都会在这里露出真值。</p>
 */
const HIT_SYNTHETIC_GEOMETRY = {
  artWidth: 200,
  artHeight: 300,
  bubbleHeight: 60,
  effectMargin: { top: 10, right: 20, bottom: 12, left: 30 },
  visibleBounds: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.95 },
};

/** 逐字段比较容差（浮点复算必须给容差，否则最后一个二进制位就会假红）。 */
const HIT_FIELD_TOLERANCE = 1e-9;

/**
 * "对入参敏感"的最小差异（像素）。
 *
 * <p>换了一份 200×300 的合成几何后，真实派生的矩形与真几何下的矩形至少会差几十像素；
 * 要求"至少一个字段差 &gt; 1px"只排除"数值抖动"，不放过"完全没变"。</p>
 */
const HIT_SENSITIVITY_MIN_DELTA = 1;

/**
 * 命中矩形面积 / 窗口面积的上限。
 *
 * <p>0.9 是"明显小于整窗"的宽松门槛：真实命中矩形约占 34%（152.65×209.47 / 268×348），
 * 留出足够余量给未来的墨迹变化，同时任何"接近整窗"的退化都会越界。</p>
 */
const HIT_AREA_RATIO_MAX = 0.9;

/**
 * 装载 `electron/pet-hit-region.cjs`（CJS）并保证拿到磁盘上的最新版本。
 *
 * <p><b>为什么必须清 require 缓存：</b>门禁与变异自检可能在同一进程里多次调用本函数
 * （或被 `--watch` 反复触发）。带缓存的话"文件已经改坏了、门禁仍按旧模块判过"，
 * 那就又退回"看起来在验、实际没验"的老问题。</p>
 *
 * @param {string} modulePath 模块绝对路径
 * @returns {object} 模块导出对象
 * @throws {Error} 文件缺失 / 语法错误时抛（由调用方转成 problem，不让门禁整体崩）
 */
function loadHitRegionModule(modulePath) {
  const loader = createRequire(import.meta.url);
  const resolvedPath = loader.resolve(modulePath);
  delete loader.cache[resolvedPath];
  return loader(resolvedPath);
}

/**
 * 把几何真源规整成"可用来独立复算"的一组数值。
 *
 * <p>与 `electron/pet-hit-region.cjs` 的 `resolveMargin` **各自实现**：门禁这一侧必须能独立
 * 指出"你算出来的跟我不一样"，共用一份实现就变成自证了。</p>
 *
 * @param {object} geometry 几何对象
 * @returns {{ok: boolean, values?: object}} `ok=false` 表示字段不全（调用方转成 problem）
 */
export function readHitGeometryValues(geometry) {
  if (!geometry || typeof geometry !== 'object') return { ok: false };
  const margin = geometry.effectMargin && typeof geometry.effectMargin === 'object' ? geometry.effectMargin : null;
  const bounds = geometry.visibleBounds && typeof geometry.visibleBounds === 'object' ? geometry.visibleBounds : null;
  const values = {
    artWidth: Number(geometry.artWidth),
    artHeight: Number(geometry.artHeight),
    bubbleHeight: Number(geometry.bubbleHeight),
    marginTop: Number(margin ? margin.top : geometry.glowPad),
    marginLeft: Number(margin ? margin.left : geometry.glowPad),
    marginRight: Number(margin ? margin.right : geometry.glowPad),
    marginBottom: Number(margin ? margin.bottom : geometry.glowPad),
    boundsLeft: bounds ? Number(bounds.left) : Number.NaN,
    boundsTop: bounds ? Number(bounds.top) : Number.NaN,
    boundsRight: bounds ? Number(bounds.right) : Number.NaN,
    boundsBottom: bounds ? Number(bounds.bottom) : Number.NaN,
  };
  const usable = Object.values(values).every((value) => Number.isFinite(value));
  return usable ? { ok: true, values } : { ok: false };
}

/**
 * **独立复算**命中矩形（窗口坐标）。
 *
 * <p>公式来自设计（与渲染层 `layout.ts` 的 `visibleBox()` 同源）：
 * `原点 = (margin.left, margin.top + bubbleHeight)`，`矩形 = 原点 + 立绘箱 × 归一化包围盒`。
 * 门禁自己写一遍，绝不 import 被检查模块的任何函数——两边算出来相等才有判别力。</p>
 *
 * @param {object} values {@link readHitGeometryValues} 的输出
 * @returns {{x: number, y: number, width: number, height: number}} 期望矩形
 */
export function computeExpectedHitRect(values) {
  return {
    x: values.marginLeft + values.artWidth * values.boundsLeft,
    y: values.marginTop + values.bubbleHeight + values.artHeight * values.boundsTop,
    width: values.artWidth * (values.boundsRight - values.boundsLeft),
    height: values.artHeight * (values.boundsBottom - values.boundsTop),
  };
}

/**
 * 由几何真源派生的窗口尺寸（与 `PET_WIDTH/PET_HEIGHT` 同一公式）。
 *
 * @param {object} values {@link readHitGeometryValues} 的输出
 * @returns {{width: number, height: number}} 窗口尺寸
 */
export function computeWindowSize(values) {
  return {
    width: values.artWidth + values.marginLeft + values.marginRight,
    height: values.artHeight + values.marginTop + values.marginBottom + values.bubbleHeight,
  };
}

/**
 * 门禁自己的"点在矩形内"判定（**半开区间**，与被检查模块的口径一致但不共用代码）。
 *
 * @param {{x: number, y: number, width: number, height: number}} rect 矩形（窗口坐标）
 * @param {number} x 点 x
 * @param {number} y 点 y
 * @returns {boolean} 是否在矩形内
 */
function rectContainsPoint(rect, x, y) {
  if (!rect) return false;
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/**
 * 按 `expected` 矩形**动态派生**探测点（不再硬编码窗口坐标）。
 *
 * <p>G-02 的根因就是"点表硬编码"：几何一旦合法演进，旧点会落进新的命中区，门禁却报
 * "命中矩形退化成整窗"，把嫌疑指向了错的对象。改为按期望矩形取"紧贴边界外 1px"的点后，
 * 这些点在任何几何下都天生在命中区之外（除非实现算错）。</p>
 *
 * <p>点的构成（≥6 个）：左/右/上/下边界外 1px（派生结果落在窗口外则跳过，不报错）、
 * 窗口左上角 `(0,0)`、窗口右下角 `(window.width-1, window.height-1)`。
 * 另外单独给一个**必然在命中区内**的墨迹点：`expected` 的中心。</p>
 *
 * @param {{x: number, y: number, width: number, height: number}} expected 期望矩形
 * @param {{width: number, height: number}} window 窗口尺寸
 * @returns {{x: number, y: number, label: string}[]} 探测点（窗口坐标）
 */
export function deriveProbePoints(expected, window) {
  const centerX = expected.x + expected.width / 2;
  const centerY = expected.y + expected.height / 2;
  const candidates = [
    { x: expected.x - 1, y: centerY, label: '左边界外 1px' },
    { x: expected.x + expected.width + 1, y: centerY, label: '右边界外 1px' },
    { x: centerX, y: expected.y - 1, label: '上边界外 1px' },
    { x: centerX, y: expected.y + expected.height + 1, label: '下边界外 1px' },
    { x: 0, y: 0, label: '窗口左上角' },
    { x: window.width - 1, y: window.height - 1, label: '窗口右下角' },
  ];
  // 派生点可能落到窗口外（边距为 0 时就会有负坐标）：跳过而不是报错，它本来就不是有效探测点
  return candidates.filter(
    (point) => point.x >= 0 && point.y >= 0 && point.x < window.width && point.y < window.height,
  );
}

/**
 * 探测点分诊：**两条分开的判据、两句分开的文案**（G-02）。
 *
 * <p>以前只要"点被命中"就统一报"命中矩形退化成整窗"，把"探测点表过期"（几何合法演进）与
 * "真缺陷"混成一条，实测中四组合法变更全被误判。现在先看该点按几何派生**该不该**命中：</p>
 *
 * <ul>
 *   <li>不在 expected 内、却在 actual 内 ⇒ **真缺陷**（actual 比几何派生的大）；</li>
 *   <li>既在 expected 内、也在 actual 内 ⇒ **点表过期**（几何已合法演进），只作提示，不判红；</li>
 *   <li>在 expected 内、却不在 actual 内 ⇒ **真缺陷**（命中区比几何派生的小，用户点不到）；</li>
 *   <li>两边都不在 ⇒ 正常。</li>
 * </ul>
 *
 * @param {string} scope 场景标签（`真几何` / `合成几何`）
 * @param {object} containsPointActual 被检查模块的 `containsPoint`
 * @param {{x: number, y: number, width: number, height: number}} actual 模块派生出的矩形
 * @param {{x: number, y: number, width: number, height: number}} expected 门禁独立复算的矩形
 * @param {{width: number, height: number}} window 窗口尺寸
 * @param {string} filePath 被检查文件（报错用）
 * @param {{x: number, y: number, label: string}[]} [points] 探测点（缺省时按 expected 动态派生，
 *   显式传入仅为单测需要——它让"点表过期 ⇒ 只提示"这条分支可以被直接验证）
 * @returns {{problems: string[], notices: string[]}} 两类结果
 */
export function triageProbePoints(scope, containsPointActual, actual, expected, window, filePath, points) {
  const problems = [];
  const notices = [];
  const probes = Array.isArray(points) ? points : deriveProbePoints(expected, window);
  for (const point of probes) {
    const expectedInside = rectContainsPoint(expected, point.x, point.y);
    const actualInside = containsPointActual(actual, point.x, point.y) === true;
    if (expectedInside && actualInside) {
      notices.push(
        `${filePath}（${scope}）探测点「${point.label}」(${point.x}, ${point.y}) 已落在合法命中区内：` +
          `该探测点表已随几何演进过期，需随几何同批更新（与 tests/petHitRegion.test.cjs 的 C2 同步），` +
          `**不许**为变绿放宽容差或删点`,
      );
      continue;
    }
    if (!expectedInside && actualInside) {
      problems.push(
        `${filePath}（${scope}）探测点「${point.label}」(${point.x}, ${point.y}) 按几何派生不该命中，却被判为命中：` +
          `透明留白被命中（actual 比几何派生的大），命中矩形退化成整窗会让透明留白也吃鼠标` +
          `（actual=${JSON.stringify(actual)}；expected=${JSON.stringify(expected)}）`,
      );
      continue;
    }
    if (expectedInside && !actualInside) {
      problems.push(
        `${filePath}（${scope}）探测点「${point.label}」(${point.x}, ${point.y}) 按几何派生应当命中，却被判为不命中：` +
          `命中区比几何派生的小，用户会点不到（actual=${JSON.stringify(actual)}；expected=${JSON.stringify(expected)}）`,
      );
    }
  }
  return { problems, notices };
}


/**
 * 校验命中矩形确实从 `pet-geometry.json` 派生（M9）——**运行时行为断言**。
 *
 * <p><b>为什么不能只做文本匹配（这轮返修的根因）：</b>文本断言守的是"源码里出现过某标识符"，
 * 不是"算出来的矩形是对的"。实测案例：把 `deriveHitRect()` 的返回值换成
 * `{x:0,y:0,width:268,height:348}`（退化整窗）后，`resolveVisibleBounds(geometry)` 这个**调用
 * 还留在代码里**（只是结果没被使用），于是 `/visibleBounds/` 依旧命中 ⇒ 门禁放行，而
 * `test:pet` 红 5 例。任何"算完不用"的写法都能这样绕过。所以这里改成**真的把模块跑起来**：</p>
 *
 * <ol>
 *   <li>用 `createRequire` 载入 CJS 模块（本脚本仍是纯 ESM、零 electron 依赖）；</li>
 *   <li>读真实几何真源，调用 `deriveHitRect(geometry)` 拿到实际矩形；</li>
 *   <li>**在本文件里独立复算**一份期望值（公式自己写，不复用被检查模块的任何函数），
 *       逐字段按 `1e-9` 容差断言，失败时打印 actual / expected 两个对象；</li>
 *   <li>探测点断言：点**按 `expected` 动态派生**（边界外 1px + 窗口两角），再用模块自己的
 *       `containsPoint` 判；分诊见 {@link triageProbePoints}（"点表过期"只提示，"透明留白被命中"才判红）；</li>
 *   <li>反退化断言：矩形宽高必须都小于窗口，面积必须小于窗口的 90%；</li>
 *   <li><b>敏感性断言（G-01）</b>：换一份**明显不同**的合成几何再问一次 —— 既比对复算值，
 *       又要求"两份几何的返回值必须不同"。这是**性质测试**：单点值测试永远杀不掉
 *       "烘焙常量"与"忽略入参"这两类整体绕过，因为它们在本份几何下正好等于期望值。</li>
 * </ol>
 *
 * @param {string} hitRegionPath `electron/pet-hit-region.cjs` 的绝对路径
 * @param {object} [geometryArg] 几何真源（缺省时自读 `pet-geometry.json`，保持单参调用可用）
 * @param {{width: number, height: number}} [windowArg] 窗口尺寸（缺省时由几何派生）
 * @returns {{problems: string[], notices: string[]}} 失败项与提示项（提示不影响退出码）
 */
export function checkHitDerivationDetailed(hitRegionPath, geometryArg, windowArg) {
  const problems = [];
  const notices = [];


  let code = '';
  try {
    code = stripComments(readFileSync(hitRegionPath, 'utf8'));
  } catch (err) {
    problems.push(`${hitRegionPath} 不可读（${(err && err.message) || err}）`);
    return problems;
  }

  // ---------------------------------------------------------------- 几何真源
  let geometry = geometryArg;
  if (!geometry || typeof geometry !== 'object') {
    try {
      geometry = readJsonFile(resolve(FRONTEND_ROOT, 'pet-geometry.json'));
    } catch (err) {
      problems.push(`pet-geometry.json 不可读，命中矩形无法校验（${(err && err.message) || err}）`);
      return problems;
    }
  }

  const realRead = readHitGeometryValues(geometry);
  if (!realRead.ok) {
    problems.push(
      `pet-geometry.json 字段不完整（artWidth/artHeight/bubbleHeight/effectMargin/visibleBounds 必须都是有限数值），命中矩形无法校验`,
    );
    return { problems, notices };
  }
  const realValues = realRead.values;
  const expected = computeExpectedHitRect(realValues);
  // 窗口尺寸：调用方给了就用（`build-pet-geometry.mjs` 的派生值），否则按同一公式自己算
  const window =
    windowArg && Number.isFinite(Number(windowArg.width)) && Number.isFinite(Number(windowArg.height))
      ? { width: Number(windowArg.width), height: Number(windowArg.height) }
      : computeWindowSize(realValues);

  // ---------------------------------------------------------------- 运行时断言（真几何）
  let region = null;
  try {
    region = loadHitRegionModule(hitRegionPath);
  } catch (err) {
    problems.push(`${hitRegionPath} 无法加载，命中矩形无法校验（${(err && err.message) || err}）`);
    return { problems, notices };
  }
  if (!region || typeof region.deriveHitRect !== 'function') {
    problems.push(`${hitRegionPath} 没有导出 deriveHitRect（门禁的运行时断言无法执行，等于空转）`);
    return { problems, notices };
  }

  let actual = null;
  try {
    actual = region.deriveHitRect(geometry);
  } catch (err) {
    problems.push(`${hitRegionPath} 的 deriveHitRect(geometry) 抛错：${(err && err.message) || err}`);
  }

  if (!actual || typeof actual !== 'object') {
    problems.push(`${hitRegionPath} 的 deriveHitRect(geometry) 没有返回矩形对象：actual=${JSON.stringify(actual)}`);
  } else {
    // 逐字段比对（容差 1e-9）：任何一位偏了都算不一致，失败时把两个对象都打出来
    const mismatched = ['x', 'y', 'width', 'height'].filter((field) => {
      const value = Number(actual[field]);
      return !Number.isFinite(value) || Math.abs(value - expected[field]) > HIT_FIELD_TOLERANCE;
    });
    if (mismatched.length > 0) {
      problems.push(
        `${hitRegionPath} 的 deriveHitRect(geometry) 与门禁独立复算不一致：字段 ${mismatched.join('/')}；` +
          `actual=${JSON.stringify(actual)}；expected=${JSON.stringify(expected)}（逐字段容差 ${HIT_FIELD_TOLERANCE}）`,
      );
    }

    // 探测点断言：点由 expected 动态派生，再交给模块自己的 containsPoint 判（见 triageProbePoints）
    if (typeof region.containsPoint !== 'function') {
      problems.push(`${hitRegionPath} 没有导出 containsPoint（探测点断言无法执行，门禁退化成空转）`);
    } else {
      const triage = triageProbePoints('真几何', region.containsPoint, actual, expected, window, hitRegionPath);
      problems.push(...triage.problems);
      notices.push(...triage.notices);

      // 对照组：命中矩形的中心必须命中（只断言"都不命中"会被"命中区恒 false"骗过）
      const inkX = expected.x + expected.width / 2;
      const inkY = expected.y + expected.height / 2;
      if (region.containsPoint(actual, inkX, inkY) !== true) {
        problems.push(
          `${hitRegionPath} 的 containsPoint 认为命中矩形中心 (${inkX.toFixed(2)}, ${inkY.toFixed(2)}) 不在命中区内` +
            `（actual=${JSON.stringify(actual)}；命中区不许缩成空集）`,
        );
      }
    }

    // 反退化：矩形必须"明显小于窗口"，否则等于整窗吃鼠标（文案与"探测点过期"分开）
    const rectWidth = Number(actual.width);
    const rectHeight = Number(actual.height);
    const rectArea = rectWidth > 0 && rectHeight > 0 ? rectWidth * rectHeight : 0;
    const windowArea = window.width * window.height;
    if (!(rectWidth < window.width)) {
      problems.push(
        `${hitRegionPath} 的命中矩形宽度 ${rectWidth} 没有小于窗口宽度 ${window.width}：` +
          `命中矩形退化成整窗会让透明留白也吃鼠标（actual=${JSON.stringify(actual)}）`,
      );
    }
    if (!(rectHeight < window.height)) {
      problems.push(
        `${hitRegionPath} 的命中矩形高度 ${rectHeight} 没有小于窗口高度 ${window.height}：` +
          `命中矩形退化成整窗会让透明留白也吃鼠标（actual=${JSON.stringify(actual)}）`,
      );
    }
    if (!(rectArea < windowArea * HIT_AREA_RATIO_MAX)) {
      problems.push(
        `${hitRegionPath} 的命中矩形面积 ${rectArea.toFixed(2)} 占窗口 ${window.width}×${window.height} 的` +
          ` ${((rectArea / windowArea) * 100).toFixed(2)}%，必须小于 ${(HIT_AREA_RATIO_MAX * 100).toFixed(0)}%：` +
          `命中矩形退化成整窗会让透明留白也吃鼠标`,
      );
    }
  }

  // ---------------------------------------------------------------- 敏感性断言（合成几何，G-01）
  // 这是本次返修的核心：**性质测试**。真几何下"值对不对"是单点值测试，烘焙常量与忽略入参
  // 的实现在这份几何上永远等于期望值；换一份明显不同的几何再问一次，它们就无处可藏。
  const syntheticGeometry = { ...geometry, ...HIT_SYNTHETIC_GEOMETRY };
  const syntheticRead = readHitGeometryValues(syntheticGeometry);
  if (!syntheticRead.ok) {
    // 门禁自身的配置错误（合成几何写漏了字段），与"被检查模块有问题"分开报
    problems.push('门禁配置错误：HIT_SYNTHETIC_GEOMETRY 字段不全，敏感性断言无法执行');
  } else {
    const syntheticValues = syntheticRead.values;
    const syntheticExpected = computeExpectedHitRect(syntheticValues);
    const syntheticWindow = computeWindowSize(syntheticValues);
    let syntheticActual = null;
    try {
      syntheticActual = region.deriveHitRect(syntheticGeometry);
    } catch (err) {
      problems.push(
        `${hitRegionPath} 的 deriveHitRect(合成几何) 抛错：${(err && err.message) || err}` +
          `（合法几何都必须能派生，不许只认真源那一份）`,
      );
    }

    if (syntheticActual && typeof syntheticActual === 'object') {
      const syntheticMismatched = ['x', 'y', 'width', 'height'].filter((field) => {
        const value = Number(syntheticActual[field]);
        return !Number.isFinite(value) || Math.abs(value - syntheticExpected[field]) > HIT_FIELD_TOLERANCE;
      });
      if (syntheticMismatched.length > 0) {
        problems.push(
          `${hitRegionPath} 的 deriveHitRect(合成几何) 与门禁独立复算不一致：字段 ${syntheticMismatched.join('/')}；` +
            `actual=${JSON.stringify(syntheticActual)}；expected=${JSON.stringify(syntheticExpected)}` +
            `（合成几何 artWidth=${HIT_SYNTHETIC_GEOMETRY.artWidth} artHeight=${HIT_SYNTHETIC_GEOMETRY.artHeight}` +
            ` bubbleHeight=${HIT_SYNTHETIC_GEOMETRY.bubbleHeight} effectMargin=${JSON.stringify(HIT_SYNTHETIC_GEOMETRY.effectMargin)}` +
            ` visibleBounds=${JSON.stringify(HIT_SYNTHETIC_GEOMETRY.visibleBounds)}）`,
        );
      }

      // 显式敏感性断言：换几何必须换结果
      const baseline = actual && typeof actual === 'object' ? actual : expected;
      const delta = Math.max(
        ...['x', 'y', 'width', 'height'].map((field) =>
          Math.abs(Number(syntheticActual[field]) - Number(baseline[field])),
        ),
      );
      if (!(delta > HIT_SENSITIVITY_MIN_DELTA)) {
        problems.push(
          `${hitRegionPath} 的 deriveHitRect 对入参不敏感 ⇒ 它没有按几何派生（烘焙常量或忽略入参），必须现算：` +
            `换了一份明显不同的合成几何后返回值几乎没变（最大字段差 ${Number.isFinite(delta) ? delta.toFixed(3) : 'NaN'}px，` +
            `要求 > ${HIT_SENSITIVITY_MIN_DELTA}px）；真几何=${JSON.stringify(baseline)}；合成几何=${JSON.stringify(syntheticActual)}`,
        );
      }

      // 合成几何下的探测点同样分诊（"算错方向"在任意几何下都该被抓住）
      if (typeof region.containsPoint === 'function') {
        const syntheticTriage = triageProbePoints(
          '合成几何',
          region.containsPoint,
          syntheticActual,
          syntheticExpected,
          syntheticWindow,
          hitRegionPath,
        );
        problems.push(...syntheticTriage.problems);
        notices.push(...syntheticTriage.notices);
      }
    }
  }

  // ---------------------------------------------------------------- 补充项（文本）
  // 文本匹配只能防抄数字，防不住"算完不用"；真正的守卫是上面的运行时断言。
  // 保留它是因为它多守一件运行时断言管不着的坏事：有人把公式**换成第二份常量**（比如
  // 58.74/108.19/152.65/209.47 或 PET_WIDTH/PET_HEIGHT），此时运行时值与真源仍可能"恰好"
  // 相等，只有源码形态能指出"这已经不是派生了"。
  if (!/visibleBounds/.test(code)) {
    problems.push(`${hitRegionPath} 没有用 geometry.visibleBounds（命中矩形必须由可见墨迹派生，不许用立绘箱）`);
  }
  if (!/effectMargin/.test(code)) {
    problems.push(`${hitRegionPath} 没有用 geometry.effectMargin（立绘原点必须从真源派生）`);
  }
  if (!/bubbleHeight/.test(code)) {
    problems.push(`${hitRegionPath} 没有用 geometry.bubbleHeight（立绘原点 y 必须包含气泡预留）`);
  }
  // 烘焙数字：命中矩形的四值（含两位小数）一个都不许出现
  if (/\b(58\.7|108\.1|152\.6|209\.4)\d*/.test(code)) {
    problems.push(`${hitRegionPath} 出现烘焙的命中矩形数值（必须现算，不许抄）`);
  }
  // 退化成整窗：命中矩形不许引用窗口尺寸
  if (/\bPET_WIDTH\b|\bPET_HEIGHT\b/.test(code)) {
    problems.push(`${hitRegionPath} 引用了 PET_WIDTH/PET_HEIGHT（命中矩形退化成整窗会让透明留白也吃鼠标）`);
  }
  return { problems, notices };
}

/**
 * 兼容包装：只要失败项（历史调用点与外部脚本用的是这个签名）。
 *
 * <p>提示项（"探测点表过期"）不进退出码，见 {@link checkHitDerivationDetailed} 的第三个返回值。</p>
 *
 * @param {string} hitRegionPath `electron/pet-hit-region.cjs` 的绝对路径
 * @param {object} [geometryArg] 几何真源
 * @param {{width: number, height: number}} [windowArg] 窗口尺寸
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function checkHitDerivation(hitRegionPath, geometryArg, windowArg) {
  return checkHitDerivationDetailed(hitRegionPath, geometryArg, windowArg).problems;
}

/**
 * 跑完整门禁。
 *
 * <p><b>`problems` 与 `notices` 的区别：</b>`problems` 决定退出码；`notices` 是**提示**
 * （例如"探测点表已随几何合法演进过期"），它说明某条断言已经失去判别对象，
 * 需要人工同批更新点表，但它**不是缺陷**，不判红——否则合法几何变更会被误报成"命中矩形退化"。</p>
 *
 * @param {{ verbose?: boolean }} [options] 运行选项
 * @returns {{ ok: boolean, problems: string[], notices: string[], geometry: object, derived: object }}
 */
export function runGate(options = {}) {
  const verbose = options.verbose === true;
  const problems = [];
  const notices = [];
  const push = (items) => problems.push(...items);

  // 1. 几何文件自洽 + 派生字段最新
  let geometry;
  let derived;
  try {
    const result = rebuild({ check: true });
    geometry = result.geometry;
    derived = result.derived;
    if (verbose) {
      console.log(
        `[1/7] 几何自洽: artWidth=${derived.artWidth} artHeight=${derived.artHeight} window=${derived.window.width}×${derived.window.height}`,
      );
    }
  } catch (err) {
    problems.push(`几何文件校验失败: ${(err && err.message) || err}`);
    return { ok: false, problems, notices, geometry: null, derived: null };
  }

  // 1b. effectMargin 自洽：四边非负；窗口宽度扣掉左右边距后必须恰好等于立绘箱宽度
  //     （气泡可用宽度 = window.width - left - right，这条一旦破了气泡会挤压或溢出）
  const margin = derived.effectMargin ?? null;
  if (!margin) {
    problems.push('deriveGeometry 未返回 effectMargin（真源缺少四边边距）');
  } else {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (!(Number(margin[side]) >= 0)) problems.push(`effectMargin.${side} 必须 >= 0，实际为 ${margin[side]}`);
    }
    if (derived.window.width - margin.left - margin.right !== derived.artWidth) {
      problems.push(
        `窗口宽度 ${derived.window.width} 扣掉左右边距(${margin.left}+${margin.right})后不等于立绘箱宽度 ${derived.artWidth}`,
      );
    }
    if (verbose) {
      console.log(
        `[1b/7] effectMargin=${margin.top}/${margin.right}/${margin.bottom}/${margin.left}，扣边距后宽度=${derived.window.width - margin.left - margin.right}`,
      );
    }
  }

  // 2. 墨迹自洽：改了 inkHeight 却没更新包围盒，这里必须红
  if (verbose) console.log('[2/7] 墨迹自洽（artHeight × visibleRatioY ≈ inkHeight）');
  const inkFromBox = derived.artHeight * geometry.visibleRatioY;
  if (Math.abs(inkFromBox - geometry.inkHeight) > 2) {
    problems.push(
      `墨迹高度不自洽：artHeight(${derived.artHeight}) × visibleRatioY(${geometry.visibleRatioY}) = ${inkFromBox.toFixed(2)}，` +
        `与 inkHeight=${geometry.inkHeight} 相差超过 2px`,
    );
  } else if (verbose) {
    console.log(`  · 墨迹高度 ${inkFromBox.toFixed(2)}px ≈ inkHeight ${geometry.inkHeight}px`);
  }

  // 3. 运行时资产：按清单逐文件校验（尺寸/2:3/体积/sha256/存在性）+ 孤儿文件
  if (verbose) console.log('[3/7] 运行时资产清单');
  push(verifyManifestAgainstDisk({ out: RUNTIME_ASSET_DIR, assetsJsonPath: ASSETS_JSON_PATH }));
  try {
    const assets = readJsonFile(ASSETS_JSON_PATH);
    const orphans = findOrphanAssets(RUNTIME_ASSET_DIR, assets);
    for (const orphan of orphans) {
      problems.push(
        `运行时目录存在清单未引用的孤儿文件: ${orphan}` +
          '（可能是旧转码模式的残留，会让人误以为有第二套资产来源）',
      );
    }
    if (verbose) {
      console.log(
        `  · assetId=${assets.assetId} mode=${assets.mode} 文件数=${assets.totals?.fileCount} 合计=${(Number(assets.totals?.bytes ?? 0) / 1024).toFixed(1)}KB`,
      );
      const neutral2x = assets.frames?.neutral?.['2x'];
      if (neutral2x) console.log(`  · neutral@2x ${neutral2x.width}×${neutral2x.height}，孤儿文件 ${orphans.length} 个`);
    }
  } catch (err) {
    problems.push(`运行时清单不可解析: ${(err && err.message) || err}`);
  }

  // 4. 美术契约（源目录在场才跑；CI 上没有美术源就跳过并说明）
  if (verbose) console.log('[4/7] 美术契约');
  const sourceDir = detectSourceDir();
  let runtimeManifest = null;
  try {
    runtimeManifest = readRuntimeManifest(sourceDir);
  } catch (err) {
    problems.push(`美术 runtime 清单不可读: ${(err && err.message) || err}`);
  }
  if (!runtimeManifest) {
    if (verbose) console.log(`  · 跳过（源目录无 runtime/manifest.json：${sourceDir}）`);
  } else {
    push(checkArtContract(geometry, runtimeManifest));
    if (verbose) console.log(`  · 已按美术契约校验 assetId=${runtimeManifest.assetId ?? '未标注'}`);
  }

  // 5. 源码无旧魔法数 / 禁用写法
  if (verbose) console.log('[5/7] 源码扫描');
  for (const relative of SCAN_FILES) {
    const absolute = resolve(FRONTEND_ROOT, relative);
    try {
      push(scanSource(absolute));
      if (verbose) console.log(`  · ${relative} 已扫描`);
    } catch (err) {
      problems.push(`源码不可读: ${relative}（${(err && err.message) || err}）`);
    }
  }

  // 6. 主进程窗口尺寸必须从 effectMargin 派生（不能自己抄一份单值）
  if (verbose) console.log('[6/7] 主进程窗口派生 + 命中矩形派生');
  try {
    push(checkWindowDerivation(resolve(FRONTEND_ROOT, 'electron/pet-window.cjs')));
  } catch (err) {
    problems.push(`electron/pet-window.cjs 不可读: ${(err && err.message) || err}`);
  }
  try {
    const hitResult = checkHitDerivationDetailed(
      resolve(FRONTEND_ROOT, 'electron/pet-hit-region.cjs'),
      geometry,
      derived && derived.window ? derived.window : undefined,
    );
    push(hitResult.problems);
    notices.push(...hitResult.notices);
    if (verbose && derived && derived.window) {
      console.log(
        `  · 命中矩形已按运行时值校验（窗口 ${derived.window.width}×${derived.window.height}，` +
          `探测点按几何动态派生 + 中心点，另加合成几何敏感性断言）`,
      );
    }
  } catch (err) {
    problems.push(`electron/pet-hit-region.cjs 不可读: ${(err && err.message) || err}`);
  }

  // 7. CSS 变量默认值与几何真源一致
  if (verbose) console.log('[7/7] CSS 变量默认值');
  try {
    push(checkCssVariables(resolve(FRONTEND_ROOT, 'src/pet/pet.css'), geometry));
  } catch (err) {
    problems.push(`pet.css 不可读: ${(err && err.message) || err}`);
  }

  return { ok: problems.length === 0, problems, notices, geometry, derived };
}

/**
 * 找出输出目录里"清单没引用"的孤儿文件。
 *
 * <p><b>为什么这条检查重要：</b>早期我用 transcode 模式从 PNG 生成了
 * `pet-v3/front-standing@1x/@2x.webp`，后来改成接入美术的 `composites/` 完整帧，那两个文件就变成了
 * 仓库里的"第二套来源不同的运行时资产"——尺寸/色值/羽化边缘都可能与美术产物差一点，且没人引用。
 * 这类文件不会让任何测试变红，却会让人误以为存在两套资产。门禁必须能抓到。</p>
 *
 * @param {string} outDir 输出目录
 * @param {object} assets 清单对象（`pet-assets.json`）
 * @returns {string[]} 孤儿文件的相对路径（空 = 全部被引用）
 */
export function findOrphanAssets(outDir, assets) {
  const referenced = new Set();
  for (const group of [assets?.frames, assets?.patches]) {
    for (const byDensity of Object.values(group ?? {})) {
      for (const asset of Object.values(byDensity ?? {})) {
        if (asset && typeof asset.file === 'string') referenced.add(asset.file);
      }
    }
  }
  if (assets?.body) {
    for (const asset of Object.values(assets.body)) {
      if (asset && typeof asset.file === 'string') referenced.add(asset.file);
    }
  }
  const orphans = [];
  /**
   * 递归遍历目录。
   *
   * @param {string} current 当前目录
   */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const relativePath = relative(outDir, fullPath).split(sep).join('/');
      if (!referenced.has(relativePath)) orphans.push(relativePath);
    }
  };
  if (existsSync(outDir)) walk(outDir);
  return orphans;
}

/**
 * 校验美术 `runtime/manifest.json` 的契约字段与我们的接入是否一致。
 *
 * <p>只比对"我们真的依赖"的字段：画布比例、色彩空间、alpha 模式、8 档表情 id、
 * 眨眼三态映射、锚点归一化。**不校验 PSD 的 sha256**（Git LFS 对象的 sha256 与 oid 不是一回事，
 * 校验必然误报——主理人明确提醒过）。</p>
 *
 * @param {object} geometry 几何真源
 * @param {object} runtimeManifest 美术运行时清单
 * @returns {string[]} 问题列表
 */
export function checkArtContract(geometry, runtimeManifest) {
  const problems = [];
  const expectedExpressions = ART_EXPRESSION_IDS;
  const blink = runtimeManifest.blink ?? null;
  if (blink) {
    if (blink.open !== 'neutral' || blink.closed !== 'blink' || blink.half !== 'sleepy') {
      problems.push(
        `美术眨眼映射变了：open=${blink.open} closed=${blink.closed} half=${blink.half}，` +
          '渲染层 BLINK_EXPRESSION_MAP 需要同步更新',
      );
    }
    const eye = blink.eyeRegionNative;
    if (!eye || !(Number(eye.width) > 0) || !(Number(eye.height) > 0)) {
      problems.push('美术眨眼映射缺少合法的 eyeRegionNative（眼部原生区域）');
    }
  } else if (problems.length === 0) {
    // runtime 清单没有 blink 字段时不算错（母版 manifest 有），只在总清单缺时才提醒
    const masterManifestPath = resolve(detectSourceDir(), 'manifest.json');
    try {
      const master = readJsonFile(masterManifestPath);
      const masterBlink = master.blink ?? null;
      if (!masterBlink) problems.push('美术清单缺少眼睛部位的区域（blink）声明，标定页无法据此定位');
      else if (masterBlink.closed !== 'blink' || masterBlink.half !== 'sleepy') {
        problems.push(
          `美术眨眼映射变了：closed=${masterBlink.closed} half=${masterBlink.half}，渲染层需要同步`,
        );
      }
    } catch {
      // 母版清单不存在：已由"源目录在场"分支处理，不重复报
    }
  }

  const anchor = runtimeManifest.anchorNormalized;
  if (anchor) {
    if (!(anchor.x >= 0 && anchor.x <= 1 && anchor.y >= 0 && anchor.y <= 1)) {
      problems.push(`美术锚点越界: x=${anchor.x} y=${anchor.y}（归一化坐标必须落在 0..1）`);
    }
    // 脚底锚点必须落在我们算出的可见盒底边附近，否则"站在桌面上"会对不齐
    const bottom = geometry.visibleBounds.bottom;
    if (Math.abs(anchor.y - bottom) > 0.02) {
      problems.push(
        `美术脚底锚点 y=${anchor.y} 与几何可见盒底边 ${bottom} 相差超过 0.02（约 ${(0.02 * geometry.artHeight).toFixed(1)}px）`,
      );
    }
  }

  const expressionIds = Array.isArray(runtimeManifest.expressionIds) ? runtimeManifest.expressionIds : [];
  if (expressionIds.length > 0) {
    for (const id of expectedExpressions) {
      if (!expressionIds.includes(id)) problems.push(`美术清单缺少表情 ${id}（与渲染层枚举不一致）`);
    }
  }

  const canvas = runtimeManifest.canvas;
  if (canvas && Number(canvas.width) > 0 && Number(canvas.height) > 0) {
    const aspect = Number(canvas.width) / Number(canvas.height);
    if (Math.abs(aspect - ART_ASPECT) / ART_ASPECT > ASPECT_TOLERANCE) {
      problems.push(`美术画布 ${canvas.width}×${canvas.height} 不是 2:3`);
    }
  }
  if (runtimeManifest.colorSpace && runtimeManifest.colorSpace !== 'sRGB') {
    problems.push(`美术色彩空间是 ${runtimeManifest.colorSpace}，渲染链路假定 sRGB`);
  }
  if (runtimeManifest.alpha && runtimeManifest.alpha !== 'straight') {
    problems.push(`美术 alpha 是 ${runtimeManifest.alpha}，渲染链路假定 straight（不预乘）`);
  }
  return problems;
}

/**
 * CLI 入口。
 *
 * @returns {number} 进程退出码（0 = 门禁通过）
 */
export function main() {
  const verbose = process.argv.slice(2).includes('--verbose');
  const result = runGate({ verbose });
  // 提示项先打（即使门禁失败也要看见"点表过期"这条背景信息），但不影响退出码
  const notices = Array.isArray(result.notices) ? result.notices : [];
  if (notices.length > 0) {
    console.warn(`⚠️  gate:pet 提示 ${notices.length} 条（不影响退出码，需人工同批更新点表）：`);
    for (const notice of notices) console.warn(`   · ${notice}`);
  }
  if (result.ok) {
    console.log(
      '✅ gate:pet 通过：几何 2:3 自洽、四边 effectMargin 与窗口派生一致、墨迹一致、资产清单/尺寸/sha256 对齐、美术契约一致、无旧魔法数',
    );
    return 0;
  }
  console.error('❌ gate:pet 失败：');
  for (const problem of result.problems) console.error(`   - ${problem}`);
  return 1;
}

// 仅被直接执行时跑 CLI（被测试 import 时保持静默）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
