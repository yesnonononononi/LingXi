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
 *   <li>CSS 变量默认值与几何文件一致（首帧兜底值不能与真源漂移）。</li>
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
  const expectations = [
    ['--pet-art-w', geometry.artWidth],
    ['--pet-art-h', geometry.artHeight],
    ['--pet-art-glow-pad', geometry.glowPad],
    ['--pet-art-bubble-h', geometry.bubbleHeight],
  ];
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
 * 跑完整门禁。
 *
 * @param {{ verbose?: boolean }} [options] 运行选项
 * @returns {{ ok: boolean, problems: string[], geometry: object, derived: object }}
 */
export function runGate(options = {}) {
  const verbose = options.verbose === true;
  const problems = [];
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
        `[1/6] 几何自洽: artWidth=${derived.artWidth} artHeight=${derived.artHeight} window=${derived.window.width}×${derived.window.height}`,
      );
    }
  } catch (err) {
    problems.push(`几何文件校验失败: ${(err && err.message) || err}`);
    return { ok: false, problems, geometry: null, derived: null };
  }

  // 2. 墨迹自洽：改了 inkHeight 却没更新包围盒，这里必须红
  if (verbose) console.log('[2/6] 墨迹自洽（artHeight × visibleRatioY ≈ inkHeight）');
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
  if (verbose) console.log('[3/6] 运行时资产清单');
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
  if (verbose) console.log('[4/6] 美术契约');
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
  if (verbose) console.log('[5/6] 源码扫描');
  for (const relative of SCAN_FILES) {
    const absolute = resolve(FRONTEND_ROOT, relative);
    try {
      push(scanSource(absolute));
      if (verbose) console.log(`  · ${relative} 已扫描`);
    } catch (err) {
      problems.push(`源码不可读: ${relative}（${(err && err.message) || err}）`);
    }
  }

  // 6. CSS 变量默认值与几何真源一致
  if (verbose) console.log('[6/6] CSS 变量默认值');
  try {
    push(checkCssVariables(resolve(FRONTEND_ROOT, 'src/pet/pet.css'), geometry));
  } catch (err) {
    problems.push(`pet.css 不可读: ${(err && err.message) || err}`);
  }

  return { ok: problems.length === 0, problems, geometry, derived };
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
  if (result.ok) {
    console.log(
      '✅ gate:pet 通过：几何 2:3 自洽、墨迹一致、资产清单/尺寸/sha256 对齐、美术契约一致、无旧魔法数',
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
