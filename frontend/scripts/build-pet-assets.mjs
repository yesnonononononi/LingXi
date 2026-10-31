#!/usr/bin/env node
/**
 * 桌宠资产管线：**校验 + 接入**（美术已产出运行时 WebP），必要时才转码。
 *
 * <p><b>为什么不重新从 PNG 生成：</b>美术侧已经产出 `runtime/` 下的 36 个 WebP（@1x/@2x 两套），
 * 并且给出了逐文件的 `sha256`。工程侧再转一遍会在仓库里留下"两套来源不同的运行时资产"——
 * 尺寸、色值、羽化边缘都可能差一点，出问题无法归因。所以默认路径是
 * **校验美术产物 → 拷进 `public/` → 生成清单**，不重编码。</p>
 *
 * <p><b>三种模式（自动识别）：</b></p>
 * <ol>
 *   <li><b>composite</b>（当前）：源目录有 `runtime/manifest.json` 且含 `composites/*.webp`
 *       —— 用美术已合成的完整帧，换表情＝换整张帧图，<b>零合成算术</b>。
 *       这是美术 `composition` 字段的首选路径；</li>
 *   <li><b>overlay</b>：只有 `expressions/*`（整头贴片）+ `body-without-head` —— 走
 *       「无头身体 + 整头」互斥合成，<b>绝不把整头叠在完整立绘的半透明边缘上</b>；</li>
 *   <li><b>transcode</b>：源里只有 `front-standing.png` 母版（美术未出 runtime 时）——
 *       用可选依赖 `sharp` 降采样，缺 sharp 且无产物时明确报错（不静默跳过）。</li>
 * </ol>
 *
 * <p><b>源目录可配置（不许硬编码）：</b>`--source <dir>` &gt; `PET_ASSET_SOURCE` &gt;
 * 依次探测 `docs/assets/desktop-pet/v3` / `.lingxi/assets/pet`（美术暂存区）/
 * `docs/assets/desktop-pet/v2`。美术资产迁库后重跑即可，代码不用改。</p>
 *
 * <p><b>对"源不完整"优雅降级：</b>源目录不存在、缺母版、缺 runtime 清单、表情只交付了一半——
 * 一律打印中文提示并给出明确退出码，绝不抛未捕获异常。</p>
 *
 * <p>用法（在 `frontend/` 下）：</p>
 * <pre>
 *   node scripts/build-pet-assets.mjs                     # 自动探测源目录
 *   node scripts/build-pet-assets.mjs --source ../../.lingxi/assets/pet --verbose
 *   node scripts/build-pet-assets.mjs --check             # 只校验（不写盘）
 * </pre>
 *
 * @module scripts/build-pet-assets
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART_ASPECT, ASPECT_TOLERANCE, FRONTEND_ROOT, GEOMETRY_PATH, readJsonFile } from './build-pet-geometry.mjs';
import { readImageSize } from './pet-image-headers.mjs';

/** 脚本所在目录。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** 向上探测的层数上限（worktree / 主工作树两种布局都要覆盖）。 */
const ANCESTOR_DEPTH = 6;

/** 源目录层级：数字越小越优先。v3 是长期归宿，暂存区次之，v2 只作历史兜底。 */
const SOURCE_TIERS = { v3: 0, staging: 1, v2: 2 };

/**
 * 向上逐层探测美术源目录候选。
 *
 * <p><b>为什么不用固定相对路径：</b>隔离工作树在 `.lingxi/work/<task>/frontend`，
 * 主工作树在 `<repo>/frontend`，两者到仓库根的距离不同。写死 `../../` 在另一种布局下会指向
 * 不存在的目录，然后静默回落到 v2——这种"看起来跑通了其实用的是旧资产"最难查。
 * 所以按层级探测，把探测结果打出来。</p>
 *
 * @param {string} [startDir] 起点目录（缺省 `frontend/`）
 * @returns {string[]} 候选绝对路径（按优先级排序：v3 → 暂存区 → v2；同层由近到远）
 */
export function discoverSourceCandidates(startDir = FRONTEND_ROOT) {
  const candidates = [];
  let cursor = resolve(startDir);
  for (let depth = 0; depth < ANCESTOR_DEPTH; depth += 1) {
    candidates.push({ path: resolve(cursor, 'docs', 'assets', 'desktop-pet', 'v3'), tier: SOURCE_TIERS.v3, depth });
    candidates.push({ path: resolve(cursor, '.lingxi', 'assets', 'pet'), tier: SOURCE_TIERS.staging, depth });
    candidates.push({ path: resolve(cursor, 'docs', 'assets', 'desktop-pet', 'v2'), tier: SOURCE_TIERS.v2, depth });
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  candidates.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.depth - b.depth));
  return candidates.map((item) => item.path);
}

/** 源目录候选（由 {@link discoverSourceCandidates} 计算，便于报错时列出）。 */
export const SOURCE_CANDIDATES = discoverSourceCandidates();

/** 美术资产暂存区（gitignored；存在时优先于 v2）。 */
export const STAGING_DIR = SOURCE_CANDIDATES.find((item) => item.includes('.lingxi')) ?? '';

/** 运行时输出目录（`public/` 下，Vite 原样复制、`lxa://` 直接可读）。 */
export const DEFAULT_OUT_DIR = resolve(FRONTEND_ROOT, 'public', 'live2d', 'pet-v3');

/** 机器可读清单（门禁与 node 测试的消费方，避免解析 TS）。 */
export const ASSETS_JSON_PATH = resolve(FRONTEND_ROOT, 'pet-assets.json');

/** 类型化清单（渲染层消费方，生成物，入库）。 */
export const MANIFEST_PATH = resolve(FRONTEND_ROOT, 'src', 'pet', 'assets', 'manifest.ts');

/** 母版文件名（transcode 模式与对账用）。 */
export const MASTER_FILE_NAME = 'front-standing.png';

/** 运行时两档密度（与美术 `runtime/` 的命名一致）。 */
export const DENSITIES = [
  { id: '1x', suffix: '@1x', minWidthRatio: 1 },
  { id: '2x', suffix: '@2x', minWidthRatio: 2 },
];

/** 美术清单里的表情 id 全集（用于对账，渲染层枚举是权威）。 */
export const ART_EXPRESSION_IDS = ['neutral', 'blink', 'surprised', 'sad', 'angry', 'shy', 'happy', 'sleepy'];

/** 美术清单里 `expr/E<n>_<id>.png` 的编号映射（仅用于 overlay 模式的母版对账）。 */
export const EXPRESSION_FILE_ALIASES = {
  neutral: ['neutral', 'E1_default'],
  blink: ['blink', 'E2_blink'],
  surprised: ['surprised', 'E3_surprised'],
  sad: ['sad', 'E4_sad'],
  angry: ['angry', 'E5_angry'],
  shy: ['shy', 'E6_shy'],
  happy: ['happy', 'E7_happy'],
  sleepy: ['sleepy', 'E8_sleepy'],
};

/** WebP 编码参数（仅 transcode 模式使用）。 */
export const WEBP_OPTIONS = { quality: 88, alphaQuality: 100, effort: 6 };

/**
 * 计算文件 sha256。
 *
 * @param {string} filePath 文件路径
 * @returns {string} 小写十六进制摘要
 */
export function sha256Of(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * 动态加载 `sharp`（可选构建期依赖）。
 *
 * @returns {Promise<any | null>} sharp 模块；不可用返回 null
 */
export async function loadSharp() {
  try {
    const module = await import('sharp');
    return module.default ?? module;
  } catch {
    return null;
  }
}

/**
 * 把绝对路径转成相对仓库根的 POSIX 风格路径（清单里只写相对路径，换机器不影响 diff）。
 *
 * <p>仓库根取"向上第一个包含 `.git` 祖先或 `.lingxi` 的目录"，找不到就退回 `frontend/` 上一级。</p>
 *
 * @param {string} absolutePath 绝对路径
 * @returns {string} 相对路径（不在仓库内时返回绝对路径）
 */
export function toRepoRelative(absolutePath) {
  let cursor = resolve(FRONTEND_ROOT);
  let root = resolve(FRONTEND_ROOT, '..');
  for (let depth = 0; depth < ANCESTOR_DEPTH; depth += 1) {
    if (existsSync(resolve(cursor, '.git')) || existsSync(resolve(cursor, '.lingxi'))) {
      root = cursor;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const relativePath = relative(root, absolutePath);
  if (relativePath.startsWith('..')) return absolutePath.split(sep).join('/');
  return relativePath.split(sep).join('/');
}

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 参数（不含 node 与脚本名）
 * @returns {{ source: string, sourceExplicit: boolean, out: string, check: boolean, verbose: boolean }}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  /**
   * 取开关值（支持 `--x v` 与 `--x=v`）。
   *
   * @param {string} name 开关名
   * @returns {string | null} 值
   */
  const valueOf = (name) => {
    const index = args.indexOf(name);
    if (index >= 0 && index + 1 < args.length) return args[index + 1];
    const prefixed = args.find((item) => item.startsWith(`${name}=`));
    return prefixed ? prefixed.slice(name.length + 1) : null;
  };
  const sourceArg = valueOf('--source') || process.env.PET_ASSET_SOURCE || '';
  const outArg = valueOf('--out') || process.env.PET_ASSET_OUT || '';
  const explicit = sourceArg.length > 0;
  return {
    source: explicit ? resolve(process.cwd(), sourceArg) : detectSourceDir(),
    sourceExplicit: explicit,
    out: outArg ? resolve(process.cwd(), outArg) : DEFAULT_OUT_DIR,
    check: args.includes('--check'),
    verbose: args.includes('--verbose'),
  };
}

/**
 * 自动探测源目录（第一个存在的候选）。
 *
 * @returns {string} 源目录绝对路径（都不存在时返回首选候选，便于报错点名）
 */
export function detectSourceDir() {
  const found = SOURCE_CANDIDATES.find((candidate) => existsSync(candidate));
  return found ?? SOURCE_CANDIDATES[0];
}

/**
 * 读几何真源。
 *
 * @returns {{ artWidth: number, artHeight: number, inkHeight: number }} 立绘箱与墨迹高度
 */
export function readArtSize() {
  const geometry = readJsonFile(GEOMETRY_PATH);
  return {
    artWidth: Number(geometry.artWidth),
    artHeight: Number(geometry.artHeight),
    inkHeight: Number(geometry.inkHeight),
  };
}

/**
 * 读美术的母版清单（`manifest.json`）。
 *
 * <p><b>为什么需要读两份清单：</b>美术把 `blink`（眨眼三态映射）、`expressionIds`、`canvas`、
 * `masterScale`、`composition` 放在母版 `manifest.json`；把逐文件的尺寸/sha256 放在
 * `runtime/manifest.json`。我们既需要"契约"也需要"逐文件对账"，所以两份都要读。</p>
 *
 * @param {string} sourceDir 源目录
 * @returns {object | null} 母版清单；不存在时 null
 */
export function readMasterManifest(sourceDir) {
  const filePath = resolve(sourceDir, 'manifest.json');
  if (!existsSync(filePath)) return null;
  return readJsonFile(filePath);
}

/**
 * 读美术的运行时清单（`runtime/manifest.json`）。
 *
 * @param {string} sourceDir 源目录
 * @returns {object | null} 清单对象；不存在时 null
 */
export function readRuntimeManifest(sourceDir) {
  const candidates = [resolve(sourceDir, 'runtime', 'manifest.json')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) return null;
  return readJsonFile(found);
}

/**
 * 在美术清单里按类型挑文件。
 *
 * @param {object} manifest 美术清单（`files` 数组）
 * @param {(entry: object) => boolean} predicate 过滤条件
 * @returns {object[]} 命中的条目
 */
export function pickFiles(manifest, predicate) {
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  return files.filter((entry) => entry && typeof entry.file === 'string' && predicate(entry));
}

/**
 * 校验单个美术产物：存在、尺寸 2:3、字节数与 sha256 与清单一致、宽度满足密度要求。
 *
 * @param {string} sourceDir 源目录
 * @param {object} entry 美术清单条目
 * @param {{ minWidth: number, label: string }} expect 期望
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function verifyArtEntry(sourceDir, entry, expect) {
  const problems = [];
  const filePath = resolve(sourceDir, 'runtime', entry.file);
  if (!existsSync(filePath)) {
    problems.push(`美术清单声明的文件不存在: runtime/${entry.file}`);
    return problems;
  }
  const bytes = statSync(filePath).size;
  if (Number.isFinite(Number(entry.bytes)) && Number(entry.bytes) !== bytes) {
    problems.push(`runtime/${entry.file} 体积 ${bytes}B 与清单 ${entry.bytes}B 不一致`);
  }
  if (typeof entry.sha256 === 'string' && entry.sha256.length === 64) {
    const actual = sha256Of(filePath);
    if (actual !== entry.sha256) {
      problems.push(`runtime/${entry.file} sha256 与清单不一致（文件可能被改动）`);
    }
  }
  let size;
  try {
    size = readImageSize(filePath);
  } catch (err) {
    problems.push(`runtime/${entry.file} 头解析失败: ${(err && err.message) || err}`);
    return problems;
  }
  if (Number.isFinite(Number(entry.width)) && Number(entry.width) !== size.width) {
    problems.push(`runtime/${entry.file} 宽度 ${size.width} 与清单 ${entry.width} 不一致`);
  }
  const aspect = size.width / size.height;
  if (Math.abs(aspect - ART_ASPECT) / ART_ASPECT > ASPECT_TOLERANCE) {
    problems.push(`${expect.label} 宽高比 ${aspect.toFixed(4)}（${size.width}×${size.height}）不是 2:3`);
  }
  if (size.width < expect.minWidth) {
    problems.push(`${expect.label} 宽度 ${size.width}px 小于要求的 ${expect.minWidth}px`);
  }
  return problems;
}

/**
 * 把产物拷进输出目录（保持子目录结构），返回拷贝后的元信息。
 *
 * @param {string} sourceDir 源目录
 * @param {string} outDir 输出目录
 * @param {string} relativeFile 相对 `runtime/` 的路径（POSIX 风格）
 * @returns {{ file: string, url: string, width: number, height: number, bytes: number, sha256: string, format: string }}
 */
export function copyRuntimeFile(sourceDir, outDir, relativeFile) {
  const from = resolve(sourceDir, 'runtime', relativeFile);
  const to = resolve(outDir, relativeFile);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  const size = readImageSize(to);
  return {
    file: relativeFile,
    url: `lxa://${WELL_KNOWN_PROTOCOL_HOST}/${relativeFile}`,
    width: size.width,
    height: size.height,
    bytes: statSync(to).size,
    sha256: sha256Of(to),
    format: size.format,
  };
}

/** `lxa://` 的 host 段（`electron/lx-protocol.cjs` 用 host 当作相对路径首段）。 */
export const WELL_KNOWN_PROTOCOL_HOST = 'pet-v3';

/**
 * 用 sharp 把母版转成目标尺寸的 WebP（transcode 模式）。
 *
 * @param {any} sharp sharp 模块
 * @param {string} masterPath 母版
 * @param {string} outputPath 产物
 * @param {{ width: number, height: number }} target 目标尺寸
 * @returns {Promise<{ width: number, height: number, size: number }>} 产物信息
 */
export async function transcode(sharp, masterPath, outputPath, target) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const info = await sharp(masterPath)
    .resize(target.width, target.height, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp(WEBP_OPTIONS)
    .toFile(outputPath);
  return { width: info.width, height: info.height, size: info.size };
}

/**
 * 探测当前源目录可用的合成模式。
 *
 * @param {string} sourceDir 源目录
 * @param {object | null} runtimeManifest 美术运行时清单
 * @returns {'composite' | 'overlay' | 'transcode' | 'none'} 模式
 */
export function detectMode(sourceDir, runtimeManifest) {
  const composites = pickFiles(runtimeManifest, (entry) => entry.file.startsWith('composites/'));
  if (composites.length > 0) return 'composite';
  const patches = pickFiles(runtimeManifest, (entry) => entry.file.startsWith('expressions/'));
  if (patches.length > 0) return 'overlay';
  if (existsSync(resolve(sourceDir, MASTER_FILE_NAME))) return 'transcode';
  return 'none';
}

/**
 * composite / overlay 模式：校验并把美术产物拷进 `public/`。
 *
 * @param {string} sourceDir 源目录
 * @param {string} outDir 输出目录
 * @param {object} runtimeManifest 美术运行时清单
 * @param {'composite' | 'overlay'} mode 模式
 * @param {object} geometry 几何
 * @param {(message: string) => void} log 日志出口
 * @returns {{ ok: boolean, problems: string[], frames: object, patches: object, body: object | null }}
 */
export function ingestRuntime(sourceDir, outDir, runtimeManifest, mode, geometry, log) {
  const problems = [];
  const frames = {};
  const patches = {};
  let body = null;

  const expected = (density) => ({
    minWidth: mode === 'composite' ? geometry.artWidth * density.minWidthRatio : geometry.artWidth * density.minWidthRatio,
    label: `${density.id} 档`,
  });

  if (mode === 'composite') {
    for (const id of ART_EXPRESSION_IDS) {
      for (const density of DENSITIES) {
        const entry = pickFiles(
          runtimeManifest,
          (item) => item.file === `composites/${id}${density.suffix}.webp`,
        )[0];
        if (!entry) {
          problems.push(`美术清单缺少 composites/${id}${density.suffix}.webp（表情 ${id} 的 ${density.id} 档）`);
          continue;
        }
        problems.push(...verifyArtEntry(sourceDir, entry, expected(density)));
        if (problems.length > 0) continue;
        const copied = copyRuntimeFile(sourceDir, outDir, entry.file);
        frames[id] = { ...(frames[id] ?? {}), [density.id]: copied };
      }
    }
    // neutral 是所有表情的兜底底图，缺了整条链路都不成立
    if (!frames.neutral) problems.push('composite 模式要求至少存在 neutral 的完整帧');
    if (problems.length === 0) log(`已接入 ${Object.keys(frames).length} 个表情 × ${DENSITIES.length} 档完整帧`);
    return { ok: problems.length === 0, problems, frames, patches, body };
  }

  // overlay 模式：无头身体 + 整头贴片（互斥合成，绝不叠在完整立绘上）
  for (const density of DENSITIES) {
    const entry = pickFiles(runtimeManifest, (item) => item.file === `body-without-head${density.suffix}.webp`)[0];
    if (!entry) {
      problems.push(`美术清单缺少 body-without-head${density.suffix}.webp`);
      continue;
    }
    problems.push(...verifyArtEntry(sourceDir, entry, expected(density)));
    if (problems.length > 0) continue;
    body = { ...(body ?? {}), [density.id]: copyRuntimeFile(sourceDir, outDir, entry.file) };
  }
  for (const id of ART_EXPRESSION_IDS) {
    for (const density of DENSITIES) {
      const entry = pickFiles(
        runtimeManifest,
        (item) => item.file === `expressions/${id}${density.suffix}.webp`,
      )[0];
      if (!entry) {
        problems.push(`美术清单缺少 expressions/${id}${density.suffix}.webp`);
        continue;
      }
      problems.push(...verifyArtEntry(sourceDir, entry, expected(density)));
      if (problems.length > 0) continue;
      patches[id] = { ...(patches[id] ?? {}), [density.id]: copyRuntimeFile(sourceDir, outDir, entry.file) };
    }
  }
  return { ok: problems.length === 0, problems, frames, patches, body };
}

/**
 * transcode 模式：从母版生成两档 WebP。
 *
 * @param {string} sourceDir 源目录
 * @param {string} outDir 输出目录
 * @param {object} geometry 几何
 * @param {boolean} check 是否只校验
 * @param {(message: string) => void} log 日志出口
 * @param {(message: string) => void} error 错误出口
 * @returns {Promise<{ ok: boolean, frames: object }>} 结果
 */
export async function transcodeMaster(sourceDir, outDir, geometry, check, log, error) {
  const masterPath = resolve(sourceDir, MASTER_FILE_NAME);
  const sharp = await loadSharp();
  const frames = { neutral: {} };
  const targets = [
    { id: '1x', suffix: '@1x', width: Math.max(160, geometry.artWidth), height: Math.round(Math.max(160, geometry.artWidth) * 1.5) },
    { id: '2x', suffix: '@2x', width: Math.max(320, geometry.artWidth * 2), height: Math.round(Math.max(320, geometry.artWidth * 2) * 1.5) },
  ];
  for (const target of targets) {
    const outputPath = resolve(outDir, `front-standing${target.suffix}.webp`);
    if (!check) {
      if (sharp) {
        log(`转码 ${target.id} → ${target.width}×${target.height}`);
        await transcode(sharp, masterPath, outputPath, target);
      } else if (!existsSync(outputPath)) {
        error('[pet-assets] 既没有 sharp，产物也不存在，无法生成运行时立绘。');
        error('[pet-assets] 请任选其一：① npm install --no-save sharp 后重跑；② 直接使用美术的 runtime/ 产物');
        error(`[pet-assets] 期望产物：${outputPath}`);
        return { ok: false, frames: {} };
      } else {
        log(`⚠ 未检测到 sharp，跳过转码，仅校验已有产物: ${outputPath}`);
      }
    }
    if (!existsSync(outputPath)) {
      error(`[pet-assets] 产物不存在: ${outputPath}`);
      return { ok: false, frames: {} };
    }
    const size = readImageSize(outputPath);
    const aspect = size.width / size.height;
    if (Math.abs(aspect - ART_ASPECT) / ART_ASPECT > ASPECT_TOLERANCE) {
      error(`[pet-assets] ${outputPath} 宽高比 ${aspect.toFixed(4)} 不是 2:3`);
      return { ok: false, frames: {} };
    }
    frames.neutral[target.id] = {
      file: `front-standing${target.suffix}.webp`,
      url: `lxa://${WELL_KNOWN_PROTOCOL_HOST}/front-standing${target.suffix}.webp`,
      width: size.width,
      height: size.height,
      bytes: statSync(outputPath).size,
      sha256: sha256Of(outputPath),
      format: size.format,
    };
  }
  return { ok: true, frames };
}

/**
 * 生成 `pet-assets.json` 内容（纯函数，便于测试）。
 *
 * @param {object} input 清单数据
 * @returns {object} 清单对象
 */
export function buildAssetsJson(input) {
  const all = [];
  for (const byDensity of Object.values(input.frames ?? {})) {
    for (const asset of Object.values(byDensity ?? {})) if (asset) all.push(asset);
  }
  for (const byDensity of Object.values(input.patches ?? {})) {
    for (const asset of Object.values(byDensity ?? {})) if (asset) all.push(asset);
  }
  if (input.body) {
    for (const asset of Object.values(input.body)) if (asset) all.push(asset);
  }
  const totals = { fileCount: all.length, bytes: all.reduce((sum, item) => sum + Number(item.bytes ?? 0), 0) };
  return {
    version: 1,
    generatedBy: 'scripts/build-pet-assets.mjs',
    assetId: input.assetId,
    sourceDir: input.sourceDir,
    mode: input.mode,
    canvas: input.canvas,
    nativeCanvas: input.nativeCanvas,
    colorSpace: input.colorSpace,
    alpha: input.alpha,
    masterScale: input.masterScale,
    anchorNormalized: input.anchorNormalized,
    headEndByScale: input.headEndByScale,
    blink: input.blink,
    expressionIds: input.expressionIds ?? ART_EXPRESSION_IDS,
    densities: DENSITIES.map((density) => ({ id: density.id, suffix: density.suffix })),
    frames: input.frames,
    patches: input.patches,
    body: input.body,
    totals,
  };
}

/**
 * 生成类型化清单 `src/pet/assets/manifest.ts`。
 *
 * <p>类型化包装只是 `import → 类型 + 访问器`，不重复数据：门禁与 node 测试读
 * `pet-assets.json`，渲染层读本文件，两者永远同一份数据。</p>
 *
 * @returns {string} 文件文本
 */
export function renderManifestTs() {
  return `/**
 * 桌宠运行时资产清单（**生成物，勿手改**）。
 *
 * <p>数据源是仓库根的 \`frontend/pet-assets.json\`（由 \`npm run build:pet-assets\` 生成并入库），
 * 本文件只做类型化与访问器。为什么不把数据直接写在这里：门禁脚本与 node 测试要读同一份数据，
 * 解析 TS 文本太脆，所以数据落 JSON、类型留 TS。</p>
 *
 * <p><b>注意：</b>母版 2048×3072 是 1024×1536 原生画布的**最近邻 2× 放大**
 * （美术清单 \`masterScale.addsDetail=false\`），<b>不含额外细节</b>。别在注释或文档里声称"2× 高清母版"。</p>
 *
 * @module pet/assets/manifest
 */
import assetsSource from '../../../pet-assets.json';
import type { ExpressionId } from '../presentation/types';

/** 密度标识。 */
export type PetDensity = '1x' | '2x';

/** 一个运行时资产文件。 */
export interface PetAssetFile {
  /** 相对输出目录的路径（POSIX 风格）。 */
  readonly file: string;
  /** \`lxa://\` URL。 */
  readonly url: string;
  /** 像素宽度。 */
  readonly width: number;
  /** 像素高度。 */
  readonly height: number;
  /** 文件体积（字节）。 */
  readonly bytes: number;
  /** sha256（与美术清单对账）。 */
  readonly sha256: string;
  /** 容器格式。 */
  readonly format: string;
}

/** 按密度组织的资产表。 */
export type PetDensityMap = Partial<Record<PetDensity, PetAssetFile>>;

/** 眨眼三态映射（与美术清单 \`blink\` 字段一致）。 */
export interface PetBlinkMapping {
  /** 睁眼表情。 */
  readonly open: ExpressionId;
  /** 闭眼表情。 */
  readonly closed: ExpressionId;
  /** 半闭表情（三态的中间帧）。 */
  readonly half: ExpressionId;
  /** 眼部原生区域（1024×1536 坐标系）。 */
  readonly eyeRegionNative: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

/** 资产清单（结构见 \`pet-assets.json\`）。 */
export interface PetAssets {
  /** 清单结构版本。 */
  readonly version: number;
  /** 生成器标识。 */
  readonly generatedBy: string;
  /** 美术资产 id。 */
  readonly assetId: string;
  /** 源目录（相对仓库根，排障用）。 */
  readonly sourceDir: string;
  /** 合成模式：\`composite\`（整帧）/ \`overlay\`（无头身体 + 整头）/ \`transcode\`（本地转码）。 */
  readonly mode: 'composite' | 'overlay' | 'transcode';
  /** 母版画布尺寸。 */
  readonly canvas: { readonly width: number; readonly height: number };
  /** 原生画布尺寸（母版是它的最近邻放大）。 */
  readonly nativeCanvas: { readonly width: number; readonly height: number };
  /** 色彩空间。 */
  readonly colorSpace: string;
  /** alpha 模式（\`straight\` = 不预乘）。 */
  readonly alpha: string;
  /** 母版放大信息（\`addsDetail=false\` = 没有真 2× 细节）。 */
  readonly masterScale: { readonly factor: number; readonly kernel: string; readonly addsDetail: boolean };
  /** 脚底锚点（归一化）。 */
  readonly anchorNormalized: { readonly x: number; readonly y: number };
  /** 各密度下头部结束的 y 像素（用于未来分层件的裁剪）。 */
  readonly headEndByScale: Readonly<Record<PetDensity, number>>;
  /** 眨眼映射。 */
  readonly blink: PetBlinkMapping;
  /** 美术声明的 8 档表情 id（用于与渲染层枚举对账）。 */
  readonly expressionIds: readonly ExpressionId[];
  /** 支持的密度。 */
  readonly densities: readonly { readonly id: PetDensity; readonly suffix: string }[];
  /** 每个表情在各密度下的完整帧（composite / transcode 模式）。 */
  readonly frames: Readonly<Partial<Record<ExpressionId, PetDensityMap>>>;
  /** 每个表情的整头贴片（overlay 模式）。 */
  readonly patches: Readonly<Partial<Record<ExpressionId, PetDensityMap>>>;
  /** 无头身体（overlay 模式）。 */
  readonly body: PetDensityMap | null;
  /** 汇总与预算。 */
  readonly totals: { readonly fileCount: number; readonly bytes: number };
}

/** 运行时资产清单。 */
export const PET_ASSETS: PetAssets = assetsSource as unknown as PetAssets;

/**
 * 取指定密度的表情完整帧 URL。
 *
 * @param id 表情 id
 * @param density 密度（缺省 \`2x\`）
 * @returns \`lxa://\` URL；该档缺失时回落另一档，再没有返回空串
 */
export function expressionFrameUrl(id: ExpressionId, density: PetDensity = '2x'): string {
  const byDensity = PET_ASSETS.frames[id];
  if (!byDensity) return '';
  return byDensity[density]?.url ?? byDensity['2x']?.url ?? byDensity['1x']?.url ?? '';
}

/**
 * 表情完整帧 URL 表（直接喂给 \`SpritePresentation\`）。
 *
 * @param density 密度（缺省 \`2x\`）
 * @returns 表情 id → URL（未交付的档不在表里）
 */
export function expressionFrameUrls(density: PetDensity = '2x'): Partial<Record<ExpressionId, string>> {
  const result: Partial<Record<ExpressionId, string>> = {};
  for (const [id, byDensity] of Object.entries(PET_ASSETS.frames)) {
    const url = byDensity?.[density]?.url ?? byDensity?.['2x']?.url ?? byDensity?.['1x']?.url;
    if (url) result[id as ExpressionId] = url;
  }
  return result;
}

/**
 * 默认立绘 URL（\`neutral\` 完整帧）。
 *
 * @param density 密度（缺省 \`2x\`）
 * @returns \`lxa://\` URL
 */
export function petArtUrl(density: PetDensity = '2x'): string {
  return expressionFrameUrl('neutral', density);
}

/**
 * 无头身体 URL（overlay 模式；composite 模式返回空串）。
 *
 * @param density 密度（缺省 \`2x\`）
 * @returns \`lxa://\` URL 或空串
 */
export function bodyUrl(density: PetDensity = '2x'): string {
  return PET_ASSETS.body?.[density]?.url ?? PET_ASSETS.body?.['2x']?.url ?? '';
}

/** 眨眼三态映射（渲染层的眨眼调度器与这里同源）。 */
export const PET_BLINK_MAPPING: PetBlinkMapping = PET_ASSETS.blink;
`;
}

/**
 * 校验磁盘上的输出目录与已生成的清单是否一致（门禁与测试共用）。
 *
 * @param {{ out?: string, assetsJsonPath?: string }} [options] 覆盖路径
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function verifyManifestAgainstDisk(options = {}) {
  const out = options.out ?? DEFAULT_OUT_DIR;
  const assetsJsonPath = options.assetsJsonPath ?? ASSETS_JSON_PATH;
  const problems = [];
  if (!existsSync(assetsJsonPath)) {
    problems.push(`清单文件不存在: ${assetsJsonPath}`);
    return problems;
  }
  let assets;
  try {
    assets = readJsonFile(assetsJsonPath);
  } catch (err) {
    problems.push(`清单 JSON 解析失败: ${(err && err.message) || err}`);
    return problems;
  }
  const entries = [];
  for (const byDensity of Object.values(assets.frames ?? {})) {
    for (const asset of Object.values(byDensity ?? {})) if (asset) entries.push(asset);
  }
  for (const byDensity of Object.values(assets.patches ?? {})) {
    for (const asset of Object.values(byDensity ?? {})) if (asset) entries.push(asset);
  }
  if (assets.body) {
    for (const asset of Object.values(assets.body)) if (asset) entries.push(asset);
  }
  if (entries.length === 0) problems.push('清单里没有任何运行时资产（frames/patches/body 全空）');
  for (const asset of entries) {
    const filePath = resolve(out, asset.file);
    if (!existsSync(filePath)) {
      problems.push(`清单声明的文件不存在: ${asset.file}`);
      continue;
    }
    const bytes = statSync(filePath).size;
    if (bytes !== Number(asset.bytes)) {
      problems.push(`${asset.file} 体积 ${bytes}B 与清单 ${asset.bytes}B 不一致`);
    }
    if (typeof asset.sha256 === 'string' && asset.sha256.length === 64) {
      const actual = sha256Of(filePath);
      if (actual !== asset.sha256) problems.push(`${asset.file} sha256 与清单不一致`);
    }
    try {
      const size = readImageSize(filePath);
      if (size.width !== Number(asset.width) || size.height !== Number(asset.height)) {
        problems.push(`${asset.file} 尺寸 ${size.width}×${size.height} 与清单 ${asset.width}×${asset.height} 不一致`);
      }
      const aspect = size.width / size.height;
      if (Math.abs(aspect - ART_ASPECT) / ART_ASPECT > ASPECT_TOLERANCE) {
        problems.push(`${asset.file} 宽高比 ${aspect.toFixed(4)} 不是 2:3`);
      }
    } catch (err) {
      problems.push(`${asset.file} 头解析失败: ${(err && err.message) || err}`);
    }
  }
  const totals = entries.reduce((sum, item) => sum + Number(item.bytes ?? 0), 0);
  if (Number.isFinite(Number(assets.totals?.bytes)) && Number(assets.totals.bytes) !== totals) {
    problems.push(`清单 totals.bytes=${assets.totals.bytes} 与实际合计 ${totals} 不一致`);
  }
  return problems;
}

/**
 * 主流程。
 *
 * @param {{ source: string, out: string, check: boolean, verbose: boolean }} options 运行选项
 * @returns {Promise<number>} 退出码（0 = 成功，1 = 失败/源不可用）
 */
export async function run(options) {
  const { source, out, check, verbose } = options;
  const log = (message) => console.log(`[pet-assets] ${message}`);
  const error = (message) => console.error(message);

  if (!existsSync(source)) {
    error(`[pet-assets] 源目录不存在: ${source}`);
    error('[pet-assets] 用 --source <dir> 指定美术资产目录（例如 .lingxi/assets/pet 暂存区）');
    error(`[pet-assets] 已探测的候选：${SOURCE_CANDIDATES.map((item) => toRepoRelative(item)).join(' | ')}`);
    return 1;
  }

  const geometry = readArtSize();
  const runtimeManifest = readRuntimeManifest(source);
  const mode = detectMode(source, runtimeManifest);
  if (verbose) {
    log(`源目录 ${toRepoRelative(source)}`);
    log(`模式 ${mode}${runtimeManifest ? `；美术清单 assetId=${runtimeManifest.assetId ?? '未标注'}` : '；未发现美术清单'}`);
  }

  if (mode === 'none') {
    error(`[pet-assets] 源目录既没有 runtime/manifest.json，也没有母版 ${MASTER_FILE_NAME}: ${source}`);
    error('[pet-assets] 已跳过（不生成产物、不改清单）；资产到位后重跑本脚本即可');
    return 1;
  }

  let ingested;
  if (mode === 'composite' || mode === 'overlay') {
    ingested = ingestRuntime(source, out, runtimeManifest, mode, geometry, log);
    for (const problem of ingested.problems) error(`[pet-assets] ${problem}`);
    if (!ingested.ok) return 1;
  } else {
    const result = await transcodeMaster(source, out, geometry, check, log, error);
    if (!result.ok) return 1;
    ingested = { frames: result.frames, patches: {}, body: null };
  }

  const masterEntry = pickFiles(runtimeManifest, (entry) => entry.file === MASTER_FILE_NAME)[0];
  const masterManifest = readMasterManifest(source);
  const masterAnchor = masterManifest?.anchor;
  const canvas = masterManifest?.canvas ?? runtimeManifest?.canvas ?? { width: geometry.artWidth, height: geometry.artHeight };
  const nativeCanvas =
    masterManifest?.nativeSourceCanvas ?? runtimeManifest?.nativeSourceCanvas ?? canvas;
  // 美术把脚底锚点两处都给了：母版清单是像素坐标 (1024, 2908)，运行时清单是归一化 (0.5, 0.9466)
  const anchorNormalized =
    runtimeManifest?.anchorNormalized ??
    (masterAnchor && Number(canvas.width) > 0
      ? {
          x: Number(masterAnchor.x) / Number(canvas.width),
          y: Number(masterAnchor.y) / Number(canvas.height),
        }
      : { x: 0.5, y: 0.5 });

  const assets = buildAssetsJson({
    assetId: masterManifest?.assetId ?? runtimeManifest?.assetId ?? 'lingxi-pet-local-transcode',
    sourceDir: toRepoRelative(source),
    mode,
    canvas,
    nativeCanvas,
    colorSpace: masterManifest?.colorSpace ?? runtimeManifest?.colorSpace ?? 'sRGB',
    alpha: masterManifest?.alpha ?? runtimeManifest?.alpha ?? 'straight',
    masterScale: masterManifest?.masterScale ?? runtimeManifest?.masterScale ?? { factor: 1, kernel: 'none', addsDetail: false },
    anchorNormalized,
    headEndByScale: runtimeManifest?.headEndByScale ?? masterManifest?.headEndByScale ?? { '1x': 0, '2x': 0 },
    // 眨眼映射与 8 档表情 id 是**母版清单**的契约（运行时不带），缺了就按渲染层枚举兜底
    blink: masterManifest?.blink ?? {
      open: 'neutral',
      closed: 'blink',
      half: 'sleepy',
      eyeRegionNative: { left: 0, top: 0, width: 0, height: 0 },
    },
    expressionIds: Array.isArray(masterManifest?.expressionIds) ? masterManifest.expressionIds : [...ART_EXPRESSION_IDS],
    frames: ingested.frames,
    patches: ingested.patches,
    body: ingested.body,
    masterBytes: masterEntry?.bytes ?? 0,
  });

  if (check) {
    const problems = verifyManifestAgainstDisk({ out });
    for (const problem of problems) error(`[pet-assets] ${problem}`);
    return problems.length === 0 ? 0 : 1;
  }

  const jsonText = `${JSON.stringify(assets, null, 2)}\n`;
  const previous = existsSync(ASSETS_JSON_PATH) ? readFileSync(ASSETS_JSON_PATH, 'utf8') : '';
  if (previous !== jsonText) {
    writeFileSync(ASSETS_JSON_PATH, jsonText, 'utf8');
    log(`已更新 ${toRepoRelative(ASSETS_JSON_PATH)}`);
  } else {
    log('pet-assets.json 无变化');
  }
  const tsText = renderManifestTs();
  const previousTs = existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, 'utf8') : '';
  if (previousTs !== tsText) {
    mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
    writeFileSync(MANIFEST_PATH, tsText, 'utf8');
    log(`已更新 ${toRepoRelative(MANIFEST_PATH)}`);
  } else {
    log('manifest.ts 无变化');
  }
  log(`运行时资产 ${assets.totals.fileCount} 个文件，合计 ${(assets.totals.bytes / 1024).toFixed(1)}KB`);
  return 0;
}

// 仅被直接执行时跑 CLI（被测试 import 时保持静默）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run(parseArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[pet-assets] 未预期异常: ${(err && err.stack) || err}`);
      process.exit(1);
    });
}
