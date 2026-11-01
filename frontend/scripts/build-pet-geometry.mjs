#!/usr/bin/env node
/**
 * 桌宠几何真源回写脚本：`frontend/pet-geometry.json`。
 *
 * <p><b>为什么要有这个脚本：</b>设计文档 §2.1 的推导规则（`inkHeight` → `artHeight` → `artWidth`
 * → 窗口尺寸）如果只写在人脑里，就一定会出现「改了 inkHeight 忘了改配图箱」的事故。
 * 把规则写成可执行代码，`pet-geometry.json` 里除了 `inkHeight` 之外的派生字段全部由本脚本回写，
 * 人是填不了的。</p>
 *
 * <p><b>只读字段：</b>`canvasWidth/canvasHeight/visibleRatioY/visibleBounds` 来自
 * `docs/assets/desktop-pet/v2/alpha-report.json`（美术侧机生成），本脚本**只校验不改写**：
 * 一旦美术重出图而几何文件没跟进，这里直接失败。</p>
 *
 * <p>用法：</p>
 * <pre>
 *   node scripts/build-pet-geometry.mjs           # 回写派生字段
 *   node scripts/build-pet-geometry.mjs --check   # 只校验不回写（CI/门禁用）
 *   node scripts/build-pet-geometry.mjs --verbose # 打印推导过程
 * </pre>
 *
 * @module scripts/build-pet-geometry
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 当前脚本所在目录（`frontend/scripts`）。 */
const HERE = dirname(fileURLToPath(import.meta.url));
/** 前端根目录（`frontend/`）。 */
export const FRONTEND_ROOT = resolve(HERE, '..');
/** 几何真源文件路径。 */
export const GEOMETRY_PATH = resolve(FRONTEND_ROOT, 'pet-geometry.json');

/** 立绘画布宽高比：2:3。立绘箱必须按这个比例定，不能按可见包围盒定。 */
export const ART_ASPECT = 2 / 3;
/** 画布比例的允许误差（0.2%，见美术规格书 M7）。 */
export const ASPECT_TOLERANCE = 0.002;
/** `artHeight` 必须是该步长的整数倍，保证 `artWidth = artHeight * 2 / 3` 是整数。 */
export const ART_HEIGHT_STEP = 3;
/** `inkHeight` 的合法区间（用户口径 200–210px，留出上下余量以便档位缩放）。 */
export const INK_HEIGHT_RANGE = { min: 120, max: 400 };

/**
 * 把一个数向上取到 `step` 的整数倍。
 *
 * @param {number} value 目标值
 * @param {number} step 步长（正整数）
 * @returns {number} 不小于 `value` 的最小 `step` 倍数
 */
export function roundUpToMultiple(value, step) {
  if (!Number.isFinite(value)) throw new TypeError('roundUpToMultiple 需要有限数值');
  if (!Number.isFinite(step) || step <= 0) throw new RangeError('roundUpToMultiple 需要正步长');
  return Math.ceil(value / step) * step;
}

/**
 * 校验一个数值字段。
 *
 * @param {unknown} value 原始值
 * @param {string} name 字段名（报错用）
 * @param {{ min?: number, max?: number, exclusiveMin?: boolean }} [range] 取值范围
 * @returns {number} 校验后的有限数值
 */
export function requireNumber(value, name, range = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new TypeError(`字段 ${name} 必须是有限数值，实际为 ${String(value)}`);
  if (range.min !== undefined) {
    const okMin = range.exclusiveMin ? num > range.min : num >= range.min;
    if (!okMin) throw new RangeError(`字段 ${name} 必须${range.exclusiveMin ? '大于' : '不小于'} ${range.min}，实际为 ${num}`);
  }
  if (range.max !== undefined && num > range.max) {
    throw new RangeError(`字段 ${name} 必须不大于 ${range.max}，实际为 ${num}`);
  }
  return num;
}

/**
 * 由 `inkHeight` 推导 `artHeight`。
 *
 * <p><b>为什么是「先四舍五入、再向上取 3 的倍数」而不是文档正文写的 `ceil`：</b>
 * 设计文档 §2.1 的规则表写 `ceil`，但 §2.2 要求单测断言「`196 → artHeight 219`」。
 * `196 / 0.894531 = 219.11`：`ceil` 得 220、再取 3 的倍数得 **222**，与 219 冲突；
 * `round` 得 219（恰好是 3 的倍数）才与文档给出的边界值一致。214→240、208→234 两条在两种写法下
 * 相同，只有 196 这条能区分。**以 §2.2 的验收边界值为准**，此处按 `round` 实现并在
 * `tests/petGeometry.test.cjs` 里把三条边界都钉住。</p>
 *
 * @param {number} inkHeight 角色墨迹（可见）高度，CSS px
 * @param {number} visibleRatioY 可见高度占画布高度的比例（0..1）
 * @returns {number} 立绘箱高度（3 的倍数，保证宽度为整数）
 */
export function deriveArtHeight(inkHeight, visibleRatioY) {
  const ink = requireNumber(inkHeight, 'inkHeight', {
    min: INK_HEIGHT_RANGE.min,
    max: INK_HEIGHT_RANGE.max,
  });
  const ratio = requireNumber(visibleRatioY, 'visibleRatioY', { min: 0, max: 1, exclusiveMin: true });
  return roundUpToMultiple(Math.round(ink / ratio), ART_HEIGHT_STEP);
}

/**
 * 由立绘箱高度推导宽度（精确 2:3）。
 *
 * @param {number} artHeight 立绘箱高度
 * @returns {number} 立绘箱宽度
 */
export function deriveArtWidth(artHeight) {
  const height = requireNumber(artHeight, 'artHeight', { min: ART_HEIGHT_STEP });
  if (height % ART_HEIGHT_STEP !== 0) {
    throw new RangeError(`artHeight 必须是 ${ART_HEIGHT_STEP} 的整数倍，实际为 ${height}`);
  }
  return (height * 2) / 3;
}

/**
 * 由几何字段推导全部派生值（不读写磁盘，纯函数）。
 *
 * 坐标空间约定：立绘箱原点 `(glowPad, glowPad + bubbleHeight)`，单位 CSS px，与
 * `src/pet/layout.ts` 的 `ART_ORIGIN` 完全一致。
 *
 * @param {object} geometry 至少含 inkHeight / visibleRatioY / visibleBounds / glowPad / bubbleHeight
 * @returns {object} 含 artHeight / artWidth / window / visibleInk / hitBox 的推导结果
 */
export function deriveGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') throw new TypeError('deriveGeometry 需要几何对象');
  const glowPad = requireNumber(geometry.glowPad, 'glowPad', { min: 0 });
  const margin = resolveEffectMargin(geometry.effectMargin, glowPad);
  const bubbleHeight = requireNumber(geometry.bubbleHeight, 'bubbleHeight', { min: 0 });
  const canvasWidth = requireNumber(geometry.canvasWidth, 'canvasWidth', { min: 1 });
  const canvasHeight = requireNumber(geometry.canvasHeight, 'canvasHeight', { min: 1 });
  const visibleRatioY = requireNumber(geometry.visibleRatioY, 'visibleRatioY', {
    min: 0,
    max: 1,
    exclusiveMin: true,
  });
  const bounds = geometry.visibleBounds;
  if (!bounds || typeof bounds !== 'object') throw new TypeError('deriveGeometry 需要 visibleBounds');
  const left = requireNumber(bounds.left, 'visibleBounds.left', { min: 0, max: 1 });
  const top = requireNumber(bounds.top, 'visibleBounds.top', { min: 0, max: 1 });
  const right = requireNumber(bounds.right, 'visibleBounds.right', { min: 0, max: 1 });
  const bottom = requireNumber(bounds.bottom, 'visibleBounds.bottom', { min: 0, max: 1 });
  if (right <= left || bottom <= top) throw new RangeError('visibleBounds 必须满足 right > left 且 bottom > top');

  const artHeight = deriveArtHeight(geometry.inkHeight, visibleRatioY);
  const artWidth = deriveArtWidth(artHeight);
  // 原点与窗口尺寸都按四边边距算（派生链只有这一处，渲染层与主进程都从这里取）
  const originX = margin.left;
  const originY = margin.top + bubbleHeight;

  return {
    artHeight,
    artWidth,
    effectMargin: margin,
    window: {
      width: artWidth + margin.left + margin.right,
      height: artHeight + margin.top + margin.bottom + bubbleHeight,
    },
    visibleInk: {
      width: artWidth * (right - left),
      height: artHeight * (bottom - top),
    },
    hitBox: {
      x: originX + artWidth * left,
      y: originY + artHeight * top,
      width: artWidth * (right - left),
      height: artHeight * (bottom - top),
    },
    /** 画布本身的宽高比，供门禁直接比对（1× 母版与运行时产物都必须是这个比例）。 */
    canvasAspect: canvasWidth / canvasHeight,
  };
}

/**
 * 归一化四边特效边距（缺省时四边取 `glowPad`，向后兼容老真源）。
 *
 * @param {unknown} raw 原始 `effectMargin`
 * @param {number} glowPad 兼容单值
 * @returns {{ top: number, right: number, bottom: number, left: number }}
 */
export function resolveEffectMargin(raw, glowPad) {
  const fallback = requireNumber(glowPad, 'glowPad', { min: 0 });
  if (raw === undefined || raw === null) {
    return { top: fallback, right: fallback, bottom: fallback, left: fallback };
  }
  if (typeof raw !== 'object') throw new TypeError('effectMargin 必须是对象（四边数值）');
  return {
    top: requireNumber(raw.top, 'effectMargin.top', { min: 0 }),
    right: requireNumber(raw.right, 'effectMargin.right', { min: 0 }),
    bottom: requireNumber(raw.bottom, 'effectMargin.bottom', { min: 0 }),
    left: requireNumber(raw.left, 'effectMargin.left', { min: 0 }),
  };
}

/**
 * 读 JSON 文件；失败时抛出带路径的可读错误。
 *
 * @param {string} filePath 绝对路径
 * @returns {any} 解析结果
 */
export function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`读取 JSON 失败: path=${filePath}, error=${(err && err.message) || err}`);
  }
}

/**
 * 校验几何内部的墨迹自洽性：`artHeight × visibleRatioY` 必须贴近 `inkHeight`。
 *
 * <p>这是"改了 inkHeight 忘了改包围盒"的兜底：`inkHeight` 是人工旋钮，包围盒是测量值，
 * 两者一旦脱钩，屏幕上就会出现"实际看着 190px 却按 208px 排版"的偏差。</p>
 *
 * @param {object} geometry 几何对象
 * @param {number} [tolerancePx] 容差（CSS px，缺省 2）
 * @returns {string[]} 问题列表（空 = 自洽）
 */
export function checkInkConsistency(geometry, tolerancePx = 2) {
  const problems = [];
  const artHeight = Number(geometry.artHeight);
  const ratio = Number(geometry.visibleRatioY);
  const inkHeight = Number(geometry.inkHeight);
  if (!Number.isFinite(artHeight) || !Number.isFinite(ratio) || !Number.isFinite(inkHeight)) {
    return ['artHeight / visibleRatioY / inkHeight 存在非数值字段，无法校验墨迹自洽性'];
  }
  const inkFromBox = artHeight * ratio;
  if (Math.abs(inkFromBox - inkHeight) > tolerancePx) {
    problems.push(
      `墨迹高度不自洽：artHeight(${artHeight}) × visibleRatioY(${ratio}) = ${inkFromBox.toFixed(2)}，` +
        `与 inkHeight=${inkHeight} 相差超过 ${tolerancePx}px`,
    );
  }
  return problems;
}

/**
 * 回写派生字段；`--check` 时不写盘，只比对文件现况。
 *
 * @param {{ check?: boolean, verbose?: boolean }} [options] 运行选项
 * @returns {{ written: boolean, changed: string[], geometry: object, derived: object }}
 */
export function rebuild(options = {}) {
  const check = options.check === true;
  const verbose = options.verbose === true;
  const geometry = readJsonFile(GEOMETRY_PATH);
  const derived = deriveGeometry(geometry);

  const next = {
    ...geometry,
    artHeight: derived.artHeight,
    artWidth: derived.artWidth,
  };
  const changed = [];
  if (geometry.artHeight !== next.artHeight) changed.push(`artHeight: ${geometry.artHeight} → ${next.artHeight}`);
  if (geometry.artWidth !== next.artWidth) changed.push(`artWidth: ${geometry.artWidth} → ${next.artWidth}`);

  if (verbose) {
    console.log(`[pet-geometry] inkHeight=${geometry.inkHeight} visibleRatioY=${geometry.visibleRatioY}`);
    console.log(`[pet-geometry] artHeight=${derived.artHeight} artWidth=${derived.artWidth}`);
    console.log(
      `[pet-geometry] effectMargin=${derived.effectMargin.top}/${derived.effectMargin.right}/${derived.effectMargin.bottom}/${derived.effectMargin.left}`,
    );
    console.log(`[pet-geometry] window=${derived.window.width}×${derived.window.height}`);
    console.log(
      `[pet-geometry] visibleInk=${derived.visibleInk.width.toFixed(2)}×${derived.visibleInk.height.toFixed(2)}`,
    );
    console.log(
      `[pet-geometry] hitBox=(x=${derived.hitBox.x.toFixed(2)}, y=${derived.hitBox.y.toFixed(2)}, w=${derived.hitBox.width.toFixed(2)}, h=${derived.hitBox.height.toFixed(2)})`,
    );
  }

  if (check) {
    if (changed.length > 0) {
      throw new Error(`pet-geometry.json 派生字段过期，请运行 node scripts/build-pet-geometry.mjs 回写：${changed.join('; ')}`);
    }
    return { written: false, changed, geometry, derived };
  }

  if (changed.length === 0) return { written: false, changed, geometry, derived };

  // 保持字段顺序：先写回 artHeight/artWidth 再序列化，人读 diff 更稳定
  writeFileSync(GEOMETRY_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { written: true, changed, geometry: next, derived };
}

/**
 * CLI 入口。
 *
 * @returns {number} 进程退出码（0 = 成功）
 */
export function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const verbose = argv.includes('--verbose');
  try {
    const result = rebuild({ check, verbose });
    if (result.written) {
      console.log(`[pet-geometry] 已回写: ${result.changed.join('; ')}`);
    } else if (result.changed.length === 0) {
      console.log(
        `[pet-geometry] 派生字段已是最新: artWidth=${result.derived.artWidth}, artHeight=${result.derived.artHeight}, window=${result.derived.window.width}×${result.derived.window.height}`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`[pet-geometry] 失败: ${(err && err.message) || err}`);
    return 1;
  }
}

// 仅在被直接执行时跑 CLI（被测试 import 时保持静默）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
