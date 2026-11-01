#!/usr/bin/env node
/**
 * 分层资产构建脚本：P1 美术母版（`docs/assets/desktop-pet/p1/`）→ 运行时 WebP + `pet-layers.json` 回填。
 *
 * <p><b>它做两件事，且只做这两件：</b></p>
 * <ol>
 *   <li>把 9 张 **2048×3072 的整画布母版 PNG** 按 `@1x`(160×240) / `@2x`(320×480) 转成 WebP，
 *       落到 `public/live2d/pet-p1/layers/`（`lxa://pet-p1/layers/…` 直接可读）；</li>
 *   <li>把"磁盘上真实存在的层文件"写回 `pet-layers.json` 的 `files[density]`
 *       （`file/url/width/height/bytes/sha256/format`，与 `pet-assets.json` 的 `frames` 同构）。</li>
 * </ol>
 *
 * <p><b>层的语义一个人都不许改：</b>`layerId/z/pivot/rect/role/source` 是人写的契约，
 * 本脚本只碰 `files`。改语义请改 JSON 后跑 `gate:pet:layers`。</p>
 *
 * <p><b>为什么必须容忍"源不完整"：</b>分层件是美术产能的外部依赖。缺目录时打印中文原因并
 * **优雅退出 0**（不改 JSON、不抛未捕获异常），因为"代码已合、资产未到"必须是合法中间态。
 * 但**字段缺失不是"源不完整"**：一旦某个 `files[density]` 存在，它的七个字段一个都不许缺，
 * 由 `check-pet-layers.mjs` 显式报错（设计 §9.3 的纪律）。</p>
 *
 * <p><b>掩膜只作构建期校验输入：</b>`support/masks/<id>_visible.png` / `_hidden.png` 共 12 个，
 * 用来确认"美术确实给了可见/被遮挡补绘的分离"，**绝不进运行时包**；本脚本只校验存在性，
 * `preview.html` / `source/` / `tools/` 同样一律不碰。</p>
 *
 * <p>用法：</p>
 * <pre>
 *   node scripts/build-pet-layers.mjs                 # 转码 + 回填 files
 *   node scripts/build-pet-layers.mjs --check         # 只校验不回写（门禁用，发现过期就失败）
 *   node scripts/build-pet-layers.mjs --source &lt;dir&gt;  # 指定 P1 母版目录
 *   node scripts/build-pet-layers.mjs --out &lt;dir&gt;     # 指定运行时输出目录
 *   node scripts/build-pet-layers.mjs --verbose       # 打印每一步
 *   node scripts/build-pet-layers.mjs --quality 82    # 体积超预算时调 WebP 质量（不改画布尺寸）
 *   node scripts/build-pet-layers.mjs --lossy        # 强制有损（默认 lossless，与压平帧同口径）
 * </pre>
 *
 * @module scripts/build-pet-layers
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_JSON_PATH, WEBP_OPTIONS, loadSharp, sha256Of } from './build-pet-assets.mjs';
import { FRONTEND_ROOT, readJsonFile } from './build-pet-geometry.mjs';
import { readImageSize } from './pet-image-headers.mjs';

/** 层清单文件路径（仓库内，生成物）。 */
export const LAYERS_JSON_PATH = resolve(FRONTEND_ROOT, 'pet-layers.json');

/** 运行时输出目录（`public/live2d/pet-p1/layers`，与压平帧的 `pet-v3` 并列）。 */
export const DEFAULT_LAYER_OUT_DIR = resolve(FRONTEND_ROOT, 'public', 'live2d', 'pet-p1', 'layers');

/** P1 母版目录相对仓库根的路径（美术入库位置，见 `e719b17a`）。 */
export const P1_RELATIVE_DIR = ['docs', 'assets', 'desktop-pet', 'p1'];

/** 掩膜子目录（相对 P1 母版目录）。用片段数组而不是 `resolve(...)`：后者在 Windows 上会返回绝对路径。 */
export const MASK_SUBDIR = ['support', 'masks'];

/** 允许的分辨率档位（与 `src/pet/layers/manifest.ts` 的 `SUPPORTED_DENSITIES` 同步）。 */
export const DENSITY_IDS = ['1x', '2x'];

/**
 * 兜底密度目标（拿不到 `pet-assets.json` 时用它）。
 *
 * <p>两个值都是从 2048×3072 的 2:3 母版精确缩下来的整数尺寸（160×240 / 320×480），
 * 与压平帧完全同尺寸 —— 只有同尺寸，分层渲染与压平帧才是"逐像素可比"的。</p>
 */
export const FALLBACK_DENSITY_TARGETS = {
  '1x': { width: 160, height: 240 },
  '2x': { width: 320, height: 480 },
};

/** 每个层文件条目必须有的字段（与 `pet-assets.json` 的 `frames[id][density]` 同构）。 */
export const REQUIRED_FILE_FIELDS = ['file', 'url', 'width', 'height', 'bytes', 'sha256', 'format'];

/** 允许的运行时编码（`webp-lossless` 与压平帧同口径，`webp` 为超预算时的降级）。 */
export const SUPPORTED_FORMATS = ['webp', 'webp-lossless'];

/**
 * 单层体积预算（设计文档附录 C.1：@1x ≤45KB、@2x ≤120KB）。
 *
 * <p>单位按 1024 计（KiB）——这在附录里没写明，本脚本选 KiB 并在这里写死一个数字，
 * 免得"120KB"在两个人眼里差 1024 字节。超预算的处理顺序是**先降编码**（lossless → lossy），
 * 画布尺寸与 2:3 比例一律不动。</p>
 */
export const LAYER_BYTE_BUDGET = {
  '1x': 45 * 1024,
  '2x': 120 * 1024,
};

/** 9 层合计的增量预算（附录 C.1：层增量 ≤1.6MB，两档合计）。 */
export const LAYERS_TOTAL_BUDGET = Math.round(1.6 * 1024 * 1024);


/** 画布比例容差（与几何门禁一致：0.2%）。 */
export const ASPECT_TOLERANCE = 0.002;

/**
 * 向上找到仓库根（含 `.git` 或 `.lingxi` 的那一层）。
 *
 * <p>与 `build-pet-assets.mjs` 的探测同因：隔离工作树在 `.lingxi/work/<task>/frontend`，
 * 主工作树在 `<repo>/frontend`，写死 `../..` 在另一种布局下会指到不存在的目录。</p>
 *
 * @param {string} [startDir] 起点目录（缺省 `frontend/`）
 * @returns {string} 仓库根绝对路径（找不到时退回 `frontend/` 的父目录）
 */
export function discoverRepoRoot(startDir = FRONTEND_ROOT) {
  let cursor = resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(resolve(cursor, '.git')) || existsSync(resolve(cursor, '.lingxi'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolve(startDir, '..');
}

/**
 * 未指定 `--source` 时的 P1 母版目录。
 *
 * @returns {string} 绝对路径
 */
export function defaultLayerSourceDir() {
  return resolve(discoverRepoRoot(), ...P1_RELATIVE_DIR);
}

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 参数列表（不含 node 与脚本名）
 * @returns {{ check: boolean, verbose: boolean, source: string, out: string, quality: number, lossless: boolean }}
 */
export function parseArgs(argv) {
  const args = { check: false, verbose: false, source: '', out: '', quality: WEBP_OPTIONS.quality, lossless: true };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--check') args.check = true;
    else if (item === '--verbose') args.verbose = true;
    // 显式要求有损（体积吃紧时用）；`--quality` 同样视为"我要有损"
    else if (item === '--lossy') args.lossless = false;
    else if (item === '--lossless') args.lossless = true;
    else if (item === '--source') {
      args.source = argv[index + 1] ?? '';
      index += 1;
    } else if (item === '--out') {
      args.out = argv[index + 1] ?? '';
      index += 1;
    } else if (item === '--quality') {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value >= 40 && value <= 100) {
        args.quality = Math.round(value);
        // 显式给质量 = 明确要走有损编码（lossless 下 quality 无意义）
        args.lossless = false;
      }
      index += 1;
    }
  }
  return args;
}

/**
 * 从 `pet-assets.json` 取两档密度的像素尺寸（拿压平帧当唯一真源）。
 *
 * <p>为什么以压平帧为准：分层渲染的验收标准是"和压平帧逐像素一致"。层图与帧图尺寸一旦不同，
 * `object-fit: contain` 虽然还能摆对，但缩放插值不同，边界像素就会有差，比对永远对不上。</p>
 *
 * @param {string} [assetsPath] 资产清单路径
 * @returns {{ '1x': { width: number, height: number }, '2x': { width: number, height: number } }}
 */
export function resolveDensityTargets(assetsPath = ASSETS_JSON_PATH) {
  const targets = {
    '1x': { ...FALLBACK_DENSITY_TARGETS['1x'] },
    '2x': { ...FALLBACK_DENSITY_TARGETS['2x'] },
  };
  try {
    const assets = readJsonFile(assetsPath);
    const frame = assets && assets.frames ? assets.frames.neutral : null;
    for (const density of DENSITY_IDS) {
      const file = frame && frame[density] ? frame[density] : null;
      const width = Number(file && file.width);
      const height = Number(file && file.height);
      if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
        targets[density] = { width: Math.round(width), height: Math.round(height) };
      }
    }
  } catch {
    // 资产清单读不到就用兜底值：分层件的尺寸不该因为这个文件缺失而无法构建
  }
  return targets;
}

/**
 * 层在母版目录里的 PNG 路径。
 *
 * @param {string} sourceDir P1 母版目录
 * @param {string} source 层契约里的 `source`（如 `01_tail_base`、`support/underpainting`）
 * @returns {string} 绝对路径（posix/win32 分隔符都吃）
 */
export function sourcePathOf(sourceDir, source) {
  const relative = String(source).split(/[\\/]+/).filter((segment) => segment.length > 0);
  return `${resolve(sourceDir, ...relative)}.png`;
}

/**
 * 某层的两个掩膜路径（构建期校验输入，不进运行时包）。
 *
 * @param {string} sourceDir P1 母版目录
 * @param {string} source 层契约里的 `source`
 * @returns {{ visible: string, hidden: string }} 绝对路径
 */
export function maskPathsOf(sourceDir, source) {
  const stem = basename(String(source));
  const maskDir = resolve(sourceDir, ...MASK_SUBDIR);
  return {
    visible: resolve(maskDir, `${stem}_visible.png`),
    hidden: resolve(maskDir, `${stem}_hidden.png`),
  };
}

/**
 * 读 P1 美术清单里的 `file → sha256` 映射（缺失时返回空表）。
 *
 * <p>只用于**母版**校验：拆件被 PS 重存过而清单没更新时，这里会挡住"悄悄换了像素还回填成功"。</p>
 *
 * @param {string} sourceDir P1 母版目录
 * @returns {Map<string, string>} 文件名（如 `01_tail_base.png`）→ sha256
 */
export function readSourceDigests(sourceDir) {
  const digests = new Map();
  const manifestPath = resolve(sourceDir, 'manifest.json');
  if (!existsSync(manifestPath)) return digests;
  try {
    const manifest = readJsonFile(manifestPath);
    const files = Array.isArray(manifest && manifest.files) ? manifest.files : [];
    for (const entry of files) {
      if (entry && typeof entry.file === 'string' && typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)) {
        digests.set(entry.file, entry.sha256);
      }
    }
  } catch {
    // 清单损坏不阻塞构建：gate 会另行报"掩膜/清单"问题
  }
  return digests;
}

/**
 * 扫描母版目录：每层缺什么、掩膜齐不齐、母版摘要对不对。
 *
 * @param {{ layers: Array<object> }} manifest 层清单
 * @param {string} sourceDir P1 母版目录
 * @returns {{ present: boolean, reason: string, entries: Array<object>, problems: string[] }}
 *   `entries` 每项 = `{ layer, source, path, masks, masksRequired }`
 */
export function scanLayerSource(manifest, sourceDir) {
  const result = { present: false, reason: '', entries: [], problems: [] };
  if (!sourceDir || !existsSync(sourceDir)) {
    result.reason = `P1 母版目录不存在: ${sourceDir || '(未指定)'}`;
    return result;
  }
  result.present = true;
  const layers = manifest && Array.isArray(manifest.layers) ? manifest.layers : [];
  const digests = readSourceDigests(sourceDir);
  for (const layer of layers) {
    if (!layer || typeof layer.layerId !== 'string') {
      result.problems.push('层清单里存在没有 layerId 的层');
      continue;
    }
    if (typeof layer.source !== 'string' || layer.source.length === 0) {
      result.problems.push(`层 ${layer.layerId} 的 source 为空（不知道去母版目录取哪张图）`);
      continue;
    }
    const path = sourcePathOf(sourceDir, layer.source);
    if (!existsSync(path)) {
      result.problems.push(`层 ${layer.layerId} 的母版文件不存在: ${path}`);
      continue;
    }
    const fileName = basename(path);
    const expected = digests.get(fileName);
    if (expected) {
      const actual = sha256Of(path);
      if (actual !== expected) {
        result.problems.push(`层 ${layer.layerId} 的母版 sha256 与美术清单不一致（母版被改过？）: ${fileName}`);
      }
    }
    const masks = maskPathsOf(sourceDir, layer.source);
    const masksRequired = layer.role === 'animatable';
    const missingMasks = [masks.visible, masks.hidden].filter((item) => !existsSync(item));
    if (masksRequired && missingMasks.length > 0) {
      result.problems.push(`层 ${layer.layerId} 缺少掩膜: ${missingMasks.map((item) => basename(item)).join(', ')}`);
    }
    result.entries.push({ layer, source: layer.source, path, masks, masksRequired });
  }
  return result;
}

/**
 * 把一张母版 PNG 转成一档密度的 WebP。
 *
 * <p><b>为什么必须转码而不是直接拷 PNG：</b>单张母版 100–170KB，9 层发 PNG 会直接吃掉首帧预算的
 * 好几倍，而且整画布 PNG 解码（2048×3072 × 9）在弱机上会造成可感知的白屏。
 * 转成 160×240 / 320×480 的 WebP 后单张只剩几 KB 到几十 KB。</p>
 *
 * <p><b>为什么默认 lossless：</b>压平帧（`pet-assets.json` 的 `frames`）本身就是
 * `webp-lossless`。分层渲染的验收标准是"与压平帧逐像素一致"，用有损编码会引入色度子采样误差
 * ——实测两只眼睛的色差能到 200+，肉眼可辨。lossless 下 9 层两档合计仅 240KB（预算 1.6MB），
 * 没有理由在唯一的验收接缝上省字节。**超预算时的正确降级是降编码，不是改画布尺寸。**</p>
 *
 * @param {any} sharp 已加载的 sharp（为空表示未安装）
 * @param {{ path: string, layerId: string, density: string }} job 转码任务
 * @param {string} outDir 输出目录
 * @param {{ width: number, height: number }} target 目标像素尺寸
 * @param {{ lossless?: boolean, quality?: number, maxBytes?: number }} [options] 编码选项
 * @returns {Promise<{ ok: boolean, reason: string, format: string, bytes: number, downgraded: boolean }>}
 *   失败时 `ok=false` 且 `reason` 是中文原因
 */
export async function transcodeLayer(sharp, job, outDir, target, options = {}) {
  const fail = (reason) => ({ ok: false, reason, format: '', bytes: 0, downgraded: false });
  if (!sharp) return fail('未安装 sharp，无法转码（npm i -D sharp 后重试）');
  const sourceSize = readImageSize(job.path);
  const sourceAspect = sourceSize.width / sourceSize.height;
  if (Math.abs(sourceAspect - 2 / 3) > ASPECT_TOLERANCE) {
    return fail(`母版不是 2:3（${sourceSize.width}×${sourceSize.height}），等比 contain 会留白或裁切`);
  }
  const targetAspect = target.width / target.height;
  if (Math.abs(targetAspect - 2 / 3) > ASPECT_TOLERANCE) {
    return fail(`目标尺寸不是 2:3（${target.width}×${target.height}）`);
  }
  const outputPath = resolve(outDir, `${job.layerId}@${job.density}.webp`);
  const quality = Number.isFinite(options.quality) ? Number(options.quality) : WEBP_OPTIONS.quality;
  const maxBytes = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : 0;

  /**
   * 编一次码并返回字节数。
   *
   * @param {boolean} lossless 是否无损
   * @returns {Promise<number>} 字节数
   */
  const encode = async (lossless) => {
    const pipeline = sharp(job.path)
      // 母版与目标同为 2:3，fit:'fill' 不会产生形变；用 lanczos3 缩小以减少振铃
      .resize(target.width, target.height, { fit: 'fill', kernel: 'lanczos3' });
    const encoder = lossless
      ? pipeline.webp({ lossless: true, effort: 6 })
      : // alphaQuality 固定 100：分层件的价值就在羽化边缘，丢了就等于回到硬边
        pipeline.webp({ quality, alphaQuality: 100, effort: 6 });
    await encoder.toFile(outputPath);
    return readFileSync(outputPath).length;
  };

  let lossless = options.lossless !== false;
  let bytes = 0;
  try {
    bytes = await encode(lossless);
    if (lossless && maxBytes > 0 && bytes > maxBytes) {
      // 超预算先降编码（画布尺寸与 2:3 一律不动），并把降级事实写进返回值供脚本落日志
      lossless = false;
      bytes = await encode(false);
      return { ok: true, reason: '', format: 'webp', bytes, downgraded: true };
    }
  } catch (err) {
    return fail(`转码失败: ${(err && err.message) || err}`);
  }
  return { ok: true, reason: '', format: lossless ? 'webp-lossless' : 'webp', bytes, downgraded: false };
}

/**
 * 把清单里的 `file`（`layers/<name>.webp`，相对 `assetBase`）解成磁盘绝对路径。
 *
 * <p>注意口径差：`file` 是**相对 `lxa://pet-p1/`** 的（所以带 `layers/` 一级），
 * 而输出目录本身就是 `…/pet-p1/layers`。直接 `resolve(outDir, file)` 会拼出
 * `…/layers/layers/x.webp` —— 这个 bug 只在门禁里看得见，页面上只表现为 404。</p>
 *
 * @param {string} outDir 运行时层目录（`…/live2d/pet-p1/layers`）
 * @param {string} file 清单里的相对路径
 * @returns {string} 绝对路径
 */
export function diskPathOf(outDir, file) {
  const normalized = String(file).replace(/\\/g, '/');
  const trimmed = normalized.startsWith('layers/') ? normalized.slice('layers/'.length) : normalized;
  return resolve(outDir, trimmed);
}

/**
 * 删掉输出目录里没有被清单引用的层文件（改了 layerId 之后留下的孤儿）。
 *
 * @param {string} outDir 输出目录
 * @param {Set<string>} expected 期望的文件名集合
 * @returns {string[]} 被删掉的文件名
 */
export function pruneOrphans(outDir, expected) {
  if (!existsSync(outDir)) return [];
  const removed = [];
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.webp$/i.test(entry.name)) continue;
    if (expected.has(entry.name)) continue;
    rmSync(resolve(outDir, entry.name), { force: true });
    removed.push(entry.name);
  }
  return removed;
}

/**
 * 构建（或校验）分层运行时资产。
 *
 * @param {object} [options] 选项
 * @param {boolean} [options.check] 只校验不回写（发现过期就抛错）
 * @param {boolean} [options.verbose] 打印每一步
 * @param {string} [options.sourceDir] P1 母版目录
 * @param {string} [options.outDir] 运行时输出目录
 * @param {number} [options.quality] WebP 质量（40..100，仅在有损回退时生效）
 * @param {boolean} [options.lossless] 是否优先用 lossless 编码（默认 true，超预算自动降有损）
 * @param {string} [options.manifestPath] 层清单路径（测试用）
 * @param {string} [options.assetsPath] 资产清单路径（测试用）
 * @param {(message: string) => void} [options.log] 日志出口
 * @returns {Promise<{ skipped: boolean, reason: string, changed: string[], manifest: object|null, missing: string[], problems: string[], bytes: { '1x': number, '2x': number }, maxBytes: { '1x': number, '2x': number }, downgraded: string[] }>}
 */
export async function buildLayerAssets(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const verbose = options.verbose === true;
  const check = options.check === true;
  const quality = Number.isFinite(options.quality) ? Number(options.quality) : WEBP_OPTIONS.quality;
  const lossless = options.lossless !== false;
  const manifestPath = options.manifestPath ?? LAYERS_JSON_PATH;
  const manifest = readJsonFile(manifestPath);
  const layers = manifest && Array.isArray(manifest.layers) ? manifest.layers : [];
  const sourceDir = options.sourceDir ?? defaultLayerSourceDir();
  const outDir = options.outDir ?? DEFAULT_LAYER_OUT_DIR;
  const emptyTotals = { '1x': 0, '2x': 0 };
  const emptyReport = {
    skipped: true,
    reason: '',
    changed: [],
    manifest,
    missing: [],
    problems: [],
    bytes: { ...emptyTotals },
    maxBytes: { ...emptyTotals },
    downgraded: [],
  };

  if (layers.length === 0) {
    const reason = '层清单为空（P1 未交付时这是正常状态，运行期走 composite）';
    log(`[pet-layers] 跳过：${reason}`);
    return { ...emptyReport, reason };
  }

  const scan = scanLayerSource(manifest, sourceDir);
  if (!scan.present) {
    const reason = `${scan.reason}（分层件未到货时这是正常状态，运行期仍走 composite）`;
    log(`[pet-layers] 跳过回填：${reason}`);
    return { ...emptyReport, reason };
  }
  if (scan.problems.length > 0) {
    // 源目录在但母版/掩膜不全：这是"做错"而不是"没到货"，必须显式失败
    throw new Error(`P1 母版不完整（${scan.problems.length} 项）：${scan.problems.join('; ')}`);
  }

  const sharp = await loadSharp();
  const densities = manifest && Array.isArray(manifest.densities) && manifest.densities.length > 0 ? manifest.densities : DENSITY_IDS;
  const targets = resolveDensityTargets(options.assetsPath ?? ASSETS_JSON_PATH);
  const assetBase = manifest && typeof manifest.assetBase === 'string' ? manifest.assetBase : 'lxa://pet-p1/';
  const base = assetBase.endsWith('/') ? assetBase : `${assetBase}/`;
  if (!check) mkdirSync(outDir, { recursive: true });

  const missing = [];
  const changed = [];
  const expected = new Set();
  const downgraded = [];
  const bytesByDensity = { ...emptyTotals };
  const maxByDensity = { ...emptyTotals };

  for (const entry of scan.entries) {
    const layer = entry.layer;
    const files = layer.files && typeof layer.files === 'object' ? { ...layer.files } : {};
    for (const density of densities) {
      const target = targets[density];
      if (!target) {
        missing.push(`${layer.layerId}@${density}`);
        continue;
      }
      const outputName = `${layer.layerId}@${density}.webp`;
      const targetPath = resolve(outDir, outputName);
      if (check) {
        // 校验模式不转码：只核对清单里是否已有这一档（文件本身由门禁与磁盘对账）
        if (!files[density]) changed.push(`${layer.layerId}.files.${density}`);
        continue;
      }
      const outcome = await transcodeLayer(
        sharp,
        { path: entry.path, layerId: layer.layerId, density },
        outDir,
        target,
        { lossless, quality, maxBytes: LAYER_BYTE_BUDGET[density] ?? 0 },
      );
      if (!outcome.ok) {
        missing.push(`${layer.layerId}@${density}`);
        log(`[pet-layers] ${layer.layerId}@${density} ${outcome.reason}`);
        continue;
      }
      if (outcome.downgraded) {
        downgraded.push(`${layer.layerId}@${density}`);
        log(
          `[pet-layers] ${layer.layerId}@${density} lossless 超出预算 ${LAYER_BYTE_BUDGET[density]}B，` +
            `已降为 quality=${quality} 有损（画布尺寸不变）`,
        );
      }
      expected.add(outputName);
      const size = readImageSize(targetPath);
      const file = {
        file: `layers/${outputName}`,
        url: `${base}layers/${outputName}`,
        width: size.width,
        height: size.height,
        bytes: outcome.bytes,
        sha256: sha256Of(targetPath),
        format: outcome.format,
      };
      bytesByDensity[density] += outcome.bytes;
      maxByDensity[density] = Math.max(maxByDensity[density], outcome.bytes);
      if (JSON.stringify(files[density] ?? null) !== JSON.stringify(file)) changed.push(`${layer.layerId}.files.${density}`);
      files[density] = file;
    }
    layer.files = files;
  }

  const totalBytes = bytesByDensity['1x'] + bytesByDensity['2x'];
  if (verbose) {
    log(
      `[pet-layers] 体积 @1x 合计=${bytesByDensity['1x']}B 单张最大=${maxByDensity['1x']}B（单层上限 ${LAYER_BYTE_BUDGET['1x']}B）；` +
        `@2x 合计=${bytesByDensity['2x']}B 单张最大=${maxByDensity['2x']}B（单层上限 ${LAYER_BYTE_BUDGET['2x']}B）；` +
        `两档合计=${totalBytes}B（层增量上限 ${LAYERS_TOTAL_BUDGET}B）`,
    );
  }
  if (!check && totalBytes > LAYERS_TOTAL_BUDGET) {
    throw new Error(
      `分层资产合计 ${totalBytes}B 超出层增量预算 ${LAYERS_TOTAL_BUDGET}B（先降编码质量，不要改画布尺寸）`,
    );
  }

  if (missing.length > 0) {
    log(`[pet-layers] 缺件 ${missing.length} 个：${missing.join(', ')}（缺件的层在运行期会被判为未就绪）`);
  }
  if (manifest && manifest.enabled === true && missing.length > 0) {
    // 开闸前必须齐全：少一层就是穿模或露缝，宁可构建失败也不要"看起来成功"
    throw new Error(`开闸状态下仍有 ${missing.length} 个层文件缺失：${missing.join(', ')}（请先补齐 @1x/@2x WebP 再开闸）`);
  }
  if (verbose) log(`[pet-layers] 母版 ${scan.entries.length} 层，密度 ${densities.join('/')}，输出 ${outDir}`);

  if (check) {
    if (changed.length > 0) {
      throw new Error(`pet-layers.json 的 files 字段过期，请运行 node scripts/build-pet-layers.mjs 回写：${changed.join('; ')}`);
    }
    return { skipped: false, reason: '', changed, manifest, missing, problems: [], bytes: bytesByDensity, maxBytes: maxByDensity, downgraded };
  }

  const removed = pruneOrphans(outDir, expected);
  if (removed.length > 0) log(`[pet-layers] 清理孤儿文件 ${removed.length} 个: ${removed.join(', ')}`);
  if (changed.length > 0) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {
    skipped: false,
    reason: '',
    changed,
    manifest,
    missing,
    problems: [],
    bytes: bytesByDensity,
    maxBytes: maxByDensity,
    downgraded,
  };
}

/**
 * CLI 入口。
 *
 * @returns {Promise<number>} 进程退出码（0 = 成功）
 */
export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (message) => console.log(message);
  try {
    const result = await buildLayerAssets({
      check: args.check,
      verbose: args.verbose,
      quality: args.quality,
      lossless: args.lossless,
      sourceDir: args.source ? resolve(args.source) : undefined,
      outDir: args.out ? resolve(args.out) : DEFAULT_LAYER_OUT_DIR,
      log,
    });
    if (result.skipped) return 0;
    if (result.changed.length === 0) {
      log(`[pet-layers] files 字段已是最新（${result.manifest.layers.length} 层，缺件 ${result.missing.length} 个）`);
    } else {
      log(`[pet-layers] 已回写 ${result.changed.length} 处: ${result.changed.join('; ')}`);
    }
    if (result.downgraded && result.downgraded.length > 0) {
      log(`[pet-layers] 因预算降级为有损的层：${result.downgraded.join(', ')}`);
    }
    return 0;
  } catch (err) {
    console.error(`[pet-layers] 失败: ${(err && err.message) || err}`);
    return 1;
  }
}

/** 当前脚本是否为入口（被 import 时保持静默）。 */
export const IS_ENTRY = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (IS_ENTRY) {
  main().then((code) => process.exit(code));
}
