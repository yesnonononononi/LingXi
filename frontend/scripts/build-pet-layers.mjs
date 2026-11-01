#!/usr/bin/env node
/**
 * 分层资产清单回写脚本：美术 `layers/` → `frontend/pet-layers.json`。
 *
 * <p><b>它只做一件事：把"磁盘上真实存在的层文件"写成 `files[density]` 字段</b>
 * （`file/url/width/height/bytes/sha256/format`，与 `pet-assets.json` 的 `frames` 同构）。
 * 层的语义（`layerId/z/pivot/rect`）是**人写的契约**，本脚本一个字都不改。</p>
 *
 * <p><b>为什么必须容忍"源不完整"：</b>分层件是美术产能的外部依赖（P1 未交付时目录根本不存在）。
 * 硬失败会让"代码已合、资产未到"的中间态无法通过构建。所以缺目录/缺文件一律打印中文原因并
 * **优雅退出 0**，不改 JSON、不抛未捕获异常。</p>
 *
 * <p>用法：</p>
 * <pre>
 *   node scripts/build-pet-layers.mjs                       # 回写 files/sha256
 *   node scripts/build-pet-layers.mjs --check               # 只校验不回写（门禁用）
 *   node scripts/build-pet-layers.mjs --source &lt;dir&gt;        # 指定美术分层源目录
 *   node scripts/build-pet-layers.mjs --out &lt;dir&gt;           # 指定运行时输出目录
 *   node scripts/build-pet-layers.mjs --verbose             # 打印每一步
 * </pre>
 *
 * @module scripts/build-pet-layers
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OUT_DIR, detectSourceDir, loadSharp, sha256Of } from './build-pet-assets.mjs';
import { FRONTEND_ROOT, readJsonFile } from './build-pet-geometry.mjs';
import { readImageSize } from './pet-image-headers.mjs';

/** 层清单文件路径（仓库内，生成物）。 */
export const LAYERS_JSON_PATH = resolve(FRONTEND_ROOT, 'pet-layers.json');

/** 未指定 `--source` 时的美术分层源目录（`detectSourceDir()/layers`）。 */
export function defaultLayerSourceDir() {
  return resolve(detectSourceDir(), 'layers');
}

/** 未指定 `--out` 时的运行时输出目录（`public/live2d/pet-v3/layers`，与 `pet-assets.json` 同级）。 */
export const DEFAULT_LAYER_OUT_DIR = resolve(DEFAULT_OUT_DIR, 'layers');

/** 层文件名约定：`<layerId>@<density>.<ext>`。 */
export const LAYER_FILE_PATTERN = /^([a-z0-9][a-z0-9-]*)@(1x|2x)\.(webp|png)$/;

/** 允许的分辨率档位（与 `src/pet/layers/manifest.ts` 的 `SUPPORTED_DENSITIES` 同步）。 */
export const DENSITY_IDS = ['1x', '2x'];

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 参数列表（不含 node 与脚本名）
 * @returns {{ check: boolean, verbose: boolean, source: string, out: string }}
 */
export function parseArgs(argv) {
  const args = { check: false, verbose: false, source: '', out: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--check') args.check = true;
    else if (item === '--verbose') args.verbose = true;
    else if (item === '--source') {
      args.source = argv[index + 1] ?? '';
      index += 1;
    } else if (item === '--out') {
      args.out = argv[index + 1] ?? '';
      index += 1;
    }
  }
  return args;
}

/**
 * 扫描美术分层源目录。
 *
 * @param {string} sourceDir 源目录绝对路径
 * @returns {{ present: boolean, parsed: { layerId: string, density: string, ext: string, name: string, path: string }[], unrecognized: string[], problems: string[] }}
 */
export function scanLayerSource(sourceDir) {
  const result = { present: false, parsed: [], unrecognized: [], problems: [] };
  if (!sourceDir || !existsSync(sourceDir)) {
    result.problems.push(`源目录不存在: ${sourceDir || '(未指定)'}`);
    return result;
  }
  result.present = true;
  let entries = [];
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true });
  } catch (err) {
    result.problems.push(`源目录不可读: ${sourceDir}（${(err && err.message) || err}）`);
    return result;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = LAYER_FILE_PATTERN.exec(entry.name);
    if (!match) {
      // 不是层文件：记一条但不算错误（美术可能放了预览图/说明文件）
      result.unrecognized.push(entry.name);
      continue;
    }
    result.parsed.push({
      layerId: match[1],
      density: match[2],
      ext: match[3],
      name: entry.name,
      path: resolve(sourceDir, entry.name),
    });
  }
  return result;
}

/**
 * 把一份源文件放进运行时目录（webp 直接拷贝，png 需要 sharp 转码）。
 *
 * @param {{ path: string, ext: string, name: string }} source 源文件信息
 * @param {string} outDir 输出目录
 * @param {import('sharp').Sharp | null} sharp 已加载的 sharp（可能为空）
 * @returns {Promise<string>} 处理结果说明（空串 = 成功）
 */
async function materializeFile(source, outDir, sharp) {
  mkdirSync(outDir, { recursive: true });
  if (source.ext === 'webp') {
    copyFileSync(source.path, resolve(outDir, source.name));
    return '';
  }
  if (!sharp) {
    return `${source.name} 是 PNG，但本机没有 sharp，跳过转码（请让美术直接交 WebP）`;
  }
  const targetName = source.name.replace(/\.png$/i, '.webp');
  await sharp(source.path).webp({ quality: 88, alphaQuality: 100, effort: 6 }).toFile(resolve(outDir, targetName));
  return '';
}

/**
 * 回填层清单的 `files` 字段。
 *
 * @param {{ sourceDir: string, outDir: string, check: boolean, verbose: boolean, log: (message: string) => void }} options 运行选项
 * @returns {Promise<{ skipped: boolean, reason: string, changed: string[], manifest: object, missing: string[] }>}
 */
export async function buildLayerManifest(options) {
  const { check, verbose } = options;
  const log = options.log ?? (() => {});
  const outDir = options.outDir ?? options.out ?? DEFAULT_LAYER_OUT_DIR;
  const manifest = readJsonFile(LAYERS_JSON_PATH);
  const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
  if (layers.length === 0) {
    const reason = '层清单为空（P1 分层件尚未交付），运行期走 composite，与今天等价';
    log(`[pet-layers] ${reason}`);
    return { skipped: true, reason, changed: [], manifest, missing: [] };
  }

  const sourceDir = options.sourceDir ?? options.source ?? defaultLayerSourceDir();
  const scan = scanLayerSource(sourceDir);
  if (!scan.present) {
    const reason = `${scan.problems.join('; ')}（分层件未到货时这是正常状态，运行期仍走 composite）`;
    log(`[pet-layers] 跳过回填：${reason}`);
    return { skipped: true, reason, changed: [], manifest, missing: [] };
  }
  for (const name of scan.unrecognized) {
    log(`[pet-layers] 忽略非层文件: ${name}（文件名必须是 <layerId>@1x|2x.webp）`);
  }

  const sharp = await loadSharp();
  const densities = Array.isArray(manifest.densities) && manifest.densities.length > 0 ? manifest.densities : DENSITY_IDS;
  const assetBase = typeof manifest.assetBase === 'string' ? manifest.assetBase : 'lxa://pet-v3/';
  const base = assetBase.endsWith('/') ? assetBase : `${assetBase}/`;
  const missing = [];
  const changed = [];

  for (const layer of layers) {
    if (!layer || typeof layer.layerId !== 'string') continue;
    const files = layer.files && typeof layer.files === 'object' ? { ...layer.files } : {};
    for (const density of densities) {
      const found = scan.parsed.find((item) => item.layerId === layer.layerId && item.density === density);
      if (!found) {
        missing.push(`${layer.layerId}@${density}`);
        delete files[density];
        continue;
      }
      const failure = await materializeFile(found, outDir, sharp);
      if (failure) {
        missing.push(`${layer.layerId}@${density}`);
        log(`[pet-layers] ${failure}`);
        continue;
      }
      const relativeName = found.ext === 'webp' ? found.name : found.name.replace(/\.png$/i, '.webp');
      const targetPath = resolve(outDir, relativeName);
      const size = readImageSize(targetPath);
      const file = {
        file: `layers/${relativeName}`,
        url: `${base}layers/${relativeName}`,
        width: size.width,
        height: size.height,
        bytes: readFileSync(targetPath).length,
        sha256: sha256Of(targetPath),
        format: relativeName.endsWith('.webp') ? 'webp' : 'png',
      };
      const before = JSON.stringify(files[density] ?? null);
      if (before !== JSON.stringify(file)) changed.push(`${layer.layerId}.files.${density}`);
      files[density] = file;
    }
    layer.files = files;
  }

  if (missing.length > 0) {
    log(`[pet-layers] 缺件 ${missing.length} 个：${missing.join(', ')}（缺件的层在运行期会被判为未就绪）`);
  }
  if (verbose) log(`[pet-layers] 已扫描 ${scan.parsed.length} 个层文件，输出目录 ${outDir}`);

  if (check) {
    if (changed.length > 0) {
      throw new Error(`pet-layers.json 的 files 字段过期，请运行 node scripts/build-pet-layers.mjs 回写：${changed.join('; ')}`);
    }
    return { skipped: false, reason: '', changed, manifest, missing };
  }
  if (changed.length > 0) {
    writeFileSync(LAYERS_JSON_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return { skipped: false, reason: '', changed, manifest, missing };
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
    const result = await buildLayerManifest({
      check: args.check,
      verbose: args.verbose,
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
