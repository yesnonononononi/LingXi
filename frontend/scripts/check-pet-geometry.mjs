#!/usr/bin/env node
/**
 * 桌宠几何门禁：`npm run gate:pet`。
 *
 * <p><b>为什么需要门禁：</b>这轮"不好看"的根因是**同一个尺寸在四处独立硬编码**（主进程常量、
 * CSS 变量、命中矩形、资产宽高比），改一个漏三个，而且症状（立绘被切角 / 尾巴被裁）很难一眼归因。
 * 注释不管用，测试也管不到 CSS 与主进程，所以用脚本钉死：</p>
 *
 * <ol>
 *   <li>几何文件自洽：立绘箱严格 2:3、派生字段是最新的、窗口公式正确；</li>
 *   <li>资产头解析：母版 PNG 与运行时 WebP 的真实像素宽高比都是 2:3，且运行时分辨率满足 DPR 要求；</li>
 *   <li>源码无旧魔法数：`pet-window.cjs` / `pet.css` / `layout.ts` 内不得再出现 288/316/320/420；
 *       不得出现 `rotate(-90deg)`（横图掰竖的旧写法）与 `object-fit: cover`（裁切即切尾巴）；</li>
 *   <li>CSS 变量默认值与几何文件一致（首帧兜底值不能与真源漂移）；</li>
 *   <li>可见比例与 `alpha-report.json` 一致（美术重出图后的漂移检测）。</li>
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
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALPHA_REPORT_PATH,
  ART_ASPECT,
  ASPECT_TOLERANCE,
  FRONTEND_ROOT,
  GEOMETRY_PATH,
  checkAlphaReportAgreement,
  readJsonFile,
  rebuild,
} from './build-pet-geometry.mjs';

/** 母版立绘（只读美术交付物，不进 public）。 */
export const MASTER_ART_PATH = resolve(
  FRONTEND_ROOT,
  '..',
  'docs',
  'assets',
  'desktop-pet',
  'v2',
  'front-standing.png',
);
/** 运行时资产目录（由 T05 的 build-pet-assets.mjs 产出）。 */
export const RUNTIME_ASSET_DIR = resolve(FRONTEND_ROOT, 'public', 'live2d', 'pet-v2');
/** 运行时立绘（@1x / @2x；渲染层按 devicePixelRatio 选，不赌 srcset）。 */
export const RUNTIME_ART = {
  '@1x': resolve(RUNTIME_ASSET_DIR, 'front-standing@1x.webp'),
  '@2x': resolve(RUNTIME_ASSET_DIR, 'front-standing@2x.webp'),
};

/** 旧的裸魔法数（立绘箱 288×316 / 窗口 320×420）：必须一个都不剩。 */
export const FORBIDDEN_MAGIC_NUMBERS = [288, 316, 320, 420];

/** 需要扫描的源码（相对 frontend/）。 */
const SCAN_FILES = ['electron/pet-window.cjs', 'src/pet/pet.css', 'src/pet/layout.ts'];

/** 明令禁止的旧写法：正则 + 人话说明。 */
const FORBIDDEN_PATTERNS = [
  { pattern: /rotate\(\s*-90deg\s*\)/i, reason: '横图掰竖的旧写法：v2 已经是正立图，再转 90° 就是躺着的猫' },
  { pattern: /object-fit\s*:\s*cover/i, reason: 'cover 会按容器裁切，v2 右侧尾巴留白仅 5px，裁了就是切尾巴' },
  { pattern: /width\s*:\s*var\(--pet-art-h\)/i, reason: '立绘宽高对调是旋转时代的写法，现已按 2:3 立绘箱等比 contain' },
];

/**
 * 读 PNG 的 IHDR 拿真实宽高。
 *
 * @param {string} filePath PNG 路径
 * @returns {{ width: number, height: number, format: string }} 像素尺寸
 */
export function readPngSize(filePath) {
  const buffer = readFileSync(filePath);
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    throw new Error(`${filePath} 不是合法 PNG（签名 ${signature}）`);
  }
  // IHDR 必须是第一个 chunk：8 字节签名 + 4 字节长度 + 4 字节类型 → 数据从第 16 字节开始
  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') throw new Error(`${filePath} 第一个 chunk 不是 IHDR（实际 ${chunkType}）`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
}

/**
 * 读 WebP 的真实宽高（支持 VP8 有损 / VP8L 无损 / VP8X 扩展三种容器）。
 *
 * <p>自己解析头部而不是引依赖：门禁脚本要能在 CI 的裸 node 里跑，不该为了两个整数装图像库。</p>
 *
 * @param {string} filePath WebP 路径
 * @returns {{ width: number, height: number, format: string }} 像素尺寸
 */
export function readWebpSize(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length < 30) throw new Error(`${filePath} 太小，不是合法 WebP`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error(`${filePath} 缺少 RIFF 头`);
  if (buffer.subarray(8, 12).toString('ascii') !== 'WEBP') throw new Error(`${filePath} 缺少 WEBP 标识`);
  const chunk = buffer.subarray(12, 16).toString('ascii');

  if (chunk === 'VP8 ' || chunk === 'VP8L') {
    if (chunk === 'VP8L') {
      // 无损：1 字节签名 0x2f + 14bit 宽 + 14bit 高（都是「值 - 1」）
      if (buffer[20] !== 0x2f) throw new Error(`${filePath} 的 VP8L 签名非法`);
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        format: 'webp-lossless',
      };
    }
    // 有损：3 字节帧标签 + 3 字节起始码 9d 01 2a，随后 14bit 宽 + 14bit 高
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      throw new Error(`${filePath} 的 VP8 起始码非法`);
    }
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
      format: 'webp-lossy',
    };
  }
  if (chunk === 'VP8X') {
    // 扩展：4 字节标志 + 3 字节（宽-1） + 3 字节（高-1），小端
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return { width, height, format: 'webp-extended' };
  }
  throw new Error(`${filePath} 的 WebP chunk 类型未知：${chunk}`);
}

/**
 * 读任意支持格式的图片尺寸。
 *
 * @param {string} filePath 文件路径
 * @returns {{ width: number, height: number, format: string }} 像素尺寸
 */
export function readImageSize(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return readPngSize(filePath);
  if (lower.endsWith('.webp')) return readWebpSize(filePath);
  throw new Error(`不认识的文件类型（只支持 png / webp）: ${filePath}`);
}

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
 * 校验一张资产的头比例与分辨率。
 *
 * @param {string} filePath 资产路径
 * @param {{ minWidth: number, label: string }} options 最小宽度与报告标签
 * @param {boolean} verbose 是否打印明细
 * @returns {string[]} 问题列表
 */
export function checkAssetAspect(filePath, options, verbose) {
  const problems = [];
  let size;
  try {
    statSync(filePath);
    size = readImageSize(filePath);
  } catch (err) {
    problems.push(`资产不可读: ${filePath}（${(err && err.message) || err}）`);
    return problems;
  }
  const aspect = size.width / size.height;
  if (Math.abs(aspect - ART_ASPECT) / ART_ASPECT > ASPECT_TOLERANCE) {
    problems.push(
      `${options.label} 宽高比 ${aspect.toFixed(4)}（${size.width}×${size.height}）不是 2:3 ±0.2%`,
    );
  }
  if (size.width < options.minWidth) {
    problems.push(`${options.label} 宽度 ${size.width}px 小于要求的 ${options.minWidth}px`);
  }
  if (verbose) {
    console.log(
      `  · ${options.label}: ${size.width}×${size.height} (${size.format}) 比例 ${aspect.toFixed(4)}`,
    );
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
        `[1/5] 几何自洽: artWidth=${derived.artWidth} artHeight=${derived.artHeight} window=${derived.window.width}×${derived.window.height}`,
      );
    }
  } catch (err) {
    problems.push(`几何文件校验失败: ${(err && err.message) || err}`);
    return { ok: false, problems, geometry: null, derived: null };
  }

  // 2. 资产头比例 + 分辨率
  if (verbose) console.log('[2/5] 资产头解析');
  push(
    checkAssetAspect(
      MASTER_ART_PATH,
      { minWidth: geometry.artWidth * 2, label: '母版 front-standing.png' },
      verbose,
    ),
  );
  push(
    checkAssetAspect(
      RUNTIME_ART['@2x'],
      { minWidth: geometry.artWidth * 2, label: '运行时 @2x' },
      verbose,
    ),
  );
  push(
    checkAssetAspect(
      RUNTIME_ART['@1x'],
      { minWidth: geometry.artWidth, label: '运行时 @1x' },
      verbose,
    ),
  );
  // @1x 与 @2x 必须是同一张图的两档，比例漂移说明转码脚本用了不同的裁剪
  try {
    const one = readImageSize(RUNTIME_ART['@1x']);
    const two = readImageSize(RUNTIME_ART['@2x']);
    if (Math.abs(two.width / one.width - 2) > 0.01 || Math.abs(two.height / one.height - 2) > 0.01) {
      problems.push(
        `运行时 @1x/@2x 不是 2 倍关系: ${one.width}×${one.height} vs ${two.width}×${two.height}`,
      );
    }
    if (verbose) console.log(`  · @1x/@2x 倍率: ${(two.width / one.width).toFixed(3)}`);
  } catch {
    // 读不到时上面 checkAssetAspect 已经报过，不重复报
  }

  // 3. 源码无旧魔法数 / 禁用写法
  if (verbose) console.log('[3/5] 源码扫描');
  for (const relative of SCAN_FILES) {
    const absolute = resolve(FRONTEND_ROOT, relative);
    try {
      push(scanSource(absolute));
      if (verbose) console.log(`  · ${relative} 已扫描`);
    } catch (err) {
      problems.push(`源码不可读: ${relative}（${(err && err.message) || err}）`);
    }
  }

  // 4. CSS 变量默认值
  if (verbose) console.log('[4/5] CSS 变量默认值');
  try {
    push(checkCssVariables(resolve(FRONTEND_ROOT, 'src/pet/pet.css'), geometry));
  } catch (err) {
    problems.push(`pet.css 不可读: ${(err && err.message) || err}`);
  }

  // 5. 与美术 alpha 报告一致
  if (verbose) console.log('[5/5] alpha 报告一致性');
  try {
    const report = readJsonFile(ALPHA_REPORT_PATH);
    push(checkAlphaReportAgreement(geometry, report));
  } catch (err) {
    problems.push(`alpha-report.json 不可读: ${(err && err.message) || err}`);
  }

  return { ok: problems.length === 0, problems, geometry, derived };
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
    console.log('✅ gate:pet 通过：几何 2:3 一致、资产头比例正确、无旧魔法数');
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
