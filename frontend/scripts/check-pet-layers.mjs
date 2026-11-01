#!/usr/bin/env node
/**
 * 分层资产门禁：`npm run gate:pet:layers`（已并入 `npm run gate:pet`）。
 *
 * <p><b>为什么需要它：</b>`pet-layers.json` 是**生成物 + 手写契约的混合体**
 * （`layerId/z/pivot/rect` 人写，`files/sha256` 脚本回填）。这类文件最容易出现的故障不是崩溃，
 * 而是"悄悄不一致"：锚点抄错一位、`z` 撞车、文件被重出但 sha256 没回写、开了闸却没有层。
 * 这些症状在屏幕上只表现为"位置差 8px""某层被压住"，靠人眼看不出根因。</p>
 *
 * <p><b>与 `src/pet/layers/manifest.ts` 的关系：</b>本脚本是同一套规则的**门禁侧实现**
 * （`.mjs` 里不能 import TS）。两边是否漂移由 `tests/petLayerManifest.test.ts` 交叉验证：
 * 同一份坏清单必须被两边同时点名。这里额外做 TS 侧做不到的三件事：
 * 与 `pet-assets.json` 对账、与磁盘文件对账、缺件时**优雅降级而不是失败**。</p>
 *
 * <p>源不完整（P1 分层件未交付）时打印中文原因并退出 0：分层是外部产能依赖，
 * "代码已合、资产未到"必须是合法中间态。</p>
 *
 * @module scripts/check-pet-layers
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_JSON_PATH, DEFAULT_OUT_DIR, sha256Of } from './build-pet-assets.mjs';
import { FRONTEND_ROOT, readJsonFile } from './build-pet-geometry.mjs';
import { readImageSize } from './pet-image-headers.mjs';
import { LAYERS_JSON_PATH } from './build-pet-layers.mjs';

/** 允许的分辨率档位。 */
export const SUPPORTED_DENSITIES = ['1x', '2x'];

/** 允许的混合模式。 */
export const SUPPORTED_BLENDS = ['normal', 'multiply', 'screen'];

/** 画布比例容差（与几何门禁一致：0.2%）。 */
export const ASPECT_TOLERANCE = 0.002;

/** 锚点归一化对账容差（美术清单给的是 16 位小数，1e-6 足够严）。 */
export const ANCHOR_TOLERANCE = 1e-6;

/**
 * 判断是否为有限数值。
 *
 * @param {unknown} value 待判断值
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 校验层清单的结构与契约（纯函数，**不读磁盘**）。
 *
 * @param {object} manifest 层清单对象
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function validateManifestStructure(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['层清单必须是对象'];
  if (manifest.version !== 1) problems.push(`version 必须为 1，实际为 ${String(manifest.version)}`);
  if (typeof manifest.assetId !== 'string' || manifest.assetId.length === 0) problems.push('assetId 必须是非空字符串');
  if (typeof manifest.enabled !== 'boolean') problems.push(`enabled 必须是布尔值，实际为 ${String(manifest.enabled)}`);
  if (typeof manifest.assetBase !== 'string' || !manifest.assetBase.startsWith('lxa://')) {
    problems.push(`assetBase 必须以 lxa:// 开头，实际为 ${String(manifest.assetBase)}`);
  }

  const canvas = manifest.canvas ?? {};
  const canvasWidth = Number(canvas.width);
  const canvasHeight = Number(canvas.height);
  if (!isFiniteNumber(canvasWidth) || canvasWidth <= 0) problems.push('canvas.width 必须是正数');
  if (!isFiniteNumber(canvasHeight) || canvasHeight <= 0) problems.push('canvas.height 必须是正数');
  if (canvasWidth > 0 && canvasHeight > 0 && Math.abs(canvasWidth / canvasHeight - 2 / 3) > ASPECT_TOLERANCE) {
    problems.push(`canvas 必须是 2:3，实际为 ${canvasWidth}×${canvasHeight}`);
  }

  const nativeCanvas = manifest.nativeCanvas ?? {};
  if (Number(nativeCanvas.width) !== canvasWidth / 2 || Number(nativeCanvas.height) !== canvasHeight / 2) {
    problems.push(
      `nativeCanvas 必须是母版的一半（母版 = 原生最近邻 2× 放大），实际 ${String(nativeCanvas.width)}×${String(nativeCanvas.height)}`,
    );
  }

  const anchor = manifest.anchor ?? {};
  if (!isFiniteNumber(anchor.x) || !isFiniteNumber(anchor.y)) {
    problems.push('anchor 必须含有限数值 x/y（母版像素）');
  } else if (anchor.x < 0 || anchor.x > canvasWidth || anchor.y < 0 || anchor.y > canvasHeight) {
    problems.push(`anchor (${anchor.x}, ${anchor.y}) 越出画布 ${canvasWidth}×${canvasHeight}`);
  }

  const densities = Array.isArray(manifest.densities) ? manifest.densities : [];
  if (densities.length === 0) problems.push('densities 必须是非空数组');
  for (const density of densities) {
    if (!SUPPORTED_DENSITIES.includes(density)) problems.push(`不支持的密度 ${String(density)}（只允许 1x / 2x）`);
  }

  const layers = Array.isArray(manifest.layers) ? manifest.layers : null;
  if (!layers) {
    problems.push('layers 必须是数组');
    return problems;
  }
  if (manifest.enabled === true && layers.length === 0) {
    problems.push('enabled=true 但 layers 为空：开了闸却没有层，运行期会白屏，请先把层清单填满再开闸');
  }

  const seenIds = new Set();
  const seenZ = new Map();
  layers.forEach((layer, index) => {
    const prefix = `layers[${index}]`;
    if (!layer || typeof layer !== 'object') {
      problems.push(`${prefix} 必须是对象`);
      return;
    }
    if (typeof layer.layerId !== 'string' || layer.layerId.length === 0) {
      problems.push(`${prefix}.layerId 必须是非空字符串`);
    } else if (seenIds.has(layer.layerId)) {
      problems.push(`${prefix}.layerId 重复 ${layer.layerId}（layerId 全局唯一，改了等于让美术白画）`);
    } else {
      seenIds.add(layer.layerId);
    }

    if (!Number.isInteger(layer.z)) {
      problems.push(`${prefix}.z 必须是整数，实际为 ${String(layer.z)}`);
    } else if (seenZ.has(layer.z)) {
      problems.push(`${prefix}.z=${layer.z} 与 ${seenZ.get(layer.z)} 撞车（同 z 不允许）`);
    } else {
      seenZ.set(layer.z, layer.layerId ?? prefix);
    }

    if (typeof layer.parent !== 'string' || layer.parent.length === 0) {
      problems.push(`${prefix}.parent 必须是非空字符串（root 或别的层 id）`);
    } else if (layer.parent === layer.layerId) {
      problems.push(`${prefix}.parent 不得指向自己（惯性继承会自激）`);
    }

    const pivot = layer.pivot ?? {};
    for (const key of ['u', 'v']) {
      const value = pivot[key];
      if (!isFiniteNumber(value) || value < 0 || value > 1) {
        problems.push(`${prefix}.pivot.${key} 必须落在 0..1，实际为 ${String(value)}`);
      }
    }

    const rect = layer.rect ?? {};
    const rectOk =
      isFiniteNumber(rect.x) &&
      isFiniteNumber(rect.y) &&
      isFiniteNumber(rect.width) &&
      rect.width > 0 &&
      isFiniteNumber(rect.height) &&
      rect.height > 0;
    if (!rectOk) {
      problems.push(`${prefix}.rect 必须含有限数值 x/y 与正的 width/height`);
    } else if (
      rect.x < 0 ||
      rect.y < 0 ||
      rect.x + rect.width > Number(nativeCanvas.width) ||
      rect.y + rect.height > Number(nativeCanvas.height)
    ) {
      problems.push(
        `${prefix}.rect (${rect.x}, ${rect.y}, ${rect.width}×${rect.height}) 越出原生画布 ${String(nativeCanvas.width)}×${String(nativeCanvas.height)}`,
      );
    }

    if (!SUPPORTED_BLENDS.includes(layer.blend)) {
      problems.push(`${prefix}.blend 只允许 ${SUPPORTED_BLENDS.join(' / ')}，实际为 ${String(layer.blend)}`);
    }
    if (!isFiniteNumber(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) {
      problems.push(`${prefix}.opacity 必须落在 0..1，实际为 ${String(layer.opacity)}`);
    }
    if (!Array.isArray(layer.occludes)) {
      problems.push(`${prefix}.occludes 必须是数组（可以为空）`);
    }
    if (layer.required !== undefined && typeof layer.required !== 'boolean') {
      problems.push(`${prefix}.required 必须是布尔值，实际为 ${String(layer.required)}`);
    }

    const files = layer.files;
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      problems.push(`${prefix}.files 必须是对象（由 build-pet-layers.mjs 回填）`);
      return;
    }
    for (const [density, file] of Object.entries(files)) {
      if (!SUPPORTED_DENSITIES.includes(density)) {
        problems.push(`${prefix}.files.${density} 不支持的密度（只允许 1x / 2x）`);
        continue;
      }
      if (!file || typeof file !== 'object') {
        problems.push(`${prefix}.files.${density} 必须是对象`);
        continue;
      }
      const expectedName = `layers/${layer.layerId}@${density}`;
      if (typeof file.file !== 'string' || !file.file.startsWith(`${expectedName}.`)) {
        problems.push(`${prefix}.files.${density}.file 必须形如 ${expectedName}.webp，实际为 ${String(file.file)}`);
      }
      const base = typeof manifest.assetBase === 'string' ? manifest.assetBase.replace(/\/?$/, '/') : '';
      if (typeof file.url !== 'string' || file.url !== `${base}${file.file}`) {
        problems.push(`${prefix}.files.${density}.url 与 assetBase+file 不一致（会 404 且难归因）`);
      }
      if (!isFiniteNumber(file.width) || !isFiniteNumber(file.height) || file.width <= 0 || file.height <= 0) {
        problems.push(`${prefix}.files.${density} 缺少合法的 width/height`);
      }
      if (!isFiniteNumber(file.bytes) || file.bytes <= 0) {
        problems.push(`${prefix}.files.${density}.bytes 必须是正数`);
      }
      if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
        problems.push(`${prefix}.files.${density}.sha256 必须是 64 位小写十六进制`);
      }
    }
  });

  // occludes 只能引用已存在的层
  layers.forEach((layer, index) => {
    const list = Array.isArray(layer?.occludes) ? layer.occludes : [];
    for (const target of list) {
      if (!seenIds.has(target)) problems.push(`layers[${index}].occludes 引用了不存在的层 ${String(target)}`);
      else {
        const targetLayer = layers.find((item) => item.layerId === target);
        if (targetLayer && Number(targetLayer.z) >= Number(layer.z)) {
          problems.push(`layers[${index}].occludes 引用的层 ${target} 的 z 不小于自己（方向反了）`);
        }
      }
    }
  });

  return problems;
}

/**
 * 与 `pet-assets.json` 对账（画布、锚点归一化）。
 *
 * @param {object} manifest 层清单
 * @param {object} assets 资产清单
 * @returns {string[]} 问题列表
 */
export function validateAgainstAssets(manifest, assets) {
  const problems = [];
  if (!assets || typeof assets !== 'object') return problems;
  const canvas = assets.canvas ?? {};
  const own = manifest.canvas ?? {};
  if (Number(canvas.width) !== Number(own.width) || Number(canvas.height) !== Number(own.height)) {
    problems.push(
      `层清单画布 ${String(own.width)}×${String(own.height)} 与 pet-assets.json 的 ${String(canvas.width)}×${String(canvas.height)} 不一致（必须同源）`,
    );
  }
  const anchor = assets.anchorNormalized ?? null;
  if (anchor && Number(own.width) > 0 && Number(own.height) > 0) {
    const x = Number(manifest.anchor?.x) / Number(own.width);
    const y = Number(manifest.anchor?.y) / Number(own.height);
    if (Math.abs(x - Number(anchor.x)) > ANCHOR_TOLERANCE || Math.abs(y - Number(anchor.y)) > ANCHOR_TOLERANCE) {
      problems.push(
        `层清单锚点归一化 (${x.toFixed(9)}, ${y.toFixed(9)}) 与 pet-assets.json (${Number(anchor.x).toFixed(9)}, ${Number(anchor.y).toFixed(9)}) 不一致（这条接缝必须逐位相同）`,
      );
    }
  }
  return problems;
}

/**
 * 与磁盘对账（文件存在、体积、sha256、像素尺寸）。
 *
 * @param {object} manifest 层清单
 * @param {{ outDir?: string, checkDisk?: boolean }} [options] 选项
 * @returns {string[]} 问题列表
 */
export function validateAgainstDisk(manifest, options = {}) {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
  const problems = [];
  for (const layer of layers) {
    const files = layer?.files ?? {};
    const densities = Object.keys(files);
    if (densities.length === 0) {
      if (manifest.enabled === true) problems.push(`层 ${String(layer?.layerId)} 没有任何密度的文件，开闸后该层必然缺失`);
      continue;
    }
    for (const [density, file] of Object.entries(files)) {
      const absolute = resolve(outDir, String(file.file));
      if (!existsSync(absolute)) {
        // 缺件在"未开闸"时是正常中间态：只报错不崩，且给出可执行提示
        if (manifest.enabled === true) problems.push(`层 ${layer.layerId}@${density} 的文件不存在: ${absolute}`);
        continue;
      }
      const actualBytes = readFileSync(absolute).length;
      if (Number(file.bytes) !== actualBytes) {
        problems.push(`层 ${layer.layerId}@${density} 体积不一致：清单 ${file.bytes} vs 磁盘 ${actualBytes}（请重跑 build:pet-layers）`);
      }
      const actualSha = sha256Of(absolute);
      if (actualSha !== file.sha256) {
        problems.push(`层 ${layer.layerId}@${density} sha256 不一致（文件被重出但清单没回写）`);
      }
      try {
        const size = readImageSize(absolute);
        if (size.width !== Number(file.width) || size.height !== Number(file.height)) {
          problems.push(
            `层 ${layer.layerId}@${density} 像素尺寸不一致：清单 ${file.width}×${file.height} vs 实际 ${size.width}×${size.height}`,
          );
        }
      } catch (err) {
        problems.push(`层 ${layer.layerId}@${density} 图像头解析失败: ${(err && err.message) || err}`);
      }
    }
  }
  if (manifest.enabled === true) {
    for (const density of Array.isArray(manifest.densities) ? manifest.densities : []) {
      for (const layer of layers) {
        if (!layer?.files?.[density]) problems.push(`开闸状态下层 ${String(layer?.layerId)} 缺少 ${density} 档文件`);
      }
    }
  }
  return problems;
}

/**
 * 跑完整的分层门禁。
 *
 * @param {{ verbose?: boolean, manifestPath?: string, outDir?: string, assetsPath?: string }} [options] 选项
 * @returns {{ ok: boolean, problems: string[], manifest: object | null, skipped: boolean }}
 */
export function runLayerGate(options = {}) {
  const verbose = options.verbose === true;
  const manifestPath = options.manifestPath ?? LAYERS_JSON_PATH;
  const assetsPath = options.assetsPath ?? ASSETS_JSON_PATH;
  const problems = [];
  let manifest = null;
  try {
    manifest = readJsonFile(manifestPath);
  } catch (err) {
    return { ok: false, problems: [`层清单不可读: ${(err && err.message) || err}`], manifest: null, skipped: false };
  }

  problems.push(...validateManifestStructure(manifest));

  let assets = null;
  if (existsSync(assetsPath)) {
    try {
      assets = readJsonFile(assetsPath);
      problems.push(...validateAgainstAssets(manifest, assets));
    } catch (err) {
      problems.push(`pet-assets.json 不可读: ${(err && err.message) || err}`);
    }
  }

  problems.push(...validateAgainstDisk(manifest, { outDir: options.outDir ?? DEFAULT_OUT_DIR }));

  const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
  const skipped = layers.length === 0;
  if (verbose) {
    console.log(
      `[pet-layers] enabled=${String(manifest.enabled)} 层数=${layers.length} 密度=${(manifest.densities ?? []).join('/')}` +
        ` 画布=${String(manifest.canvas?.width)}×${String(manifest.canvas?.height)}`,
    );
    if (skipped) console.log('[pet-layers] 层清单为空：P1 分层件未交付，运行期走 composite（与今天等价）');
  }
  return { ok: problems.length === 0, problems, manifest, skipped };
}

/**
 * CLI 入口。
 *
 * @returns {number} 进程退出码（0 = 通过）
 */
export function main() {
  const verbose = process.argv.slice(2).includes('--verbose');
  try {
    const result = runLayerGate({ verbose });
    if (result.ok) {
      console.log(
        result.skipped
          ? '✅ gate:pet:layers 通过：层清单为空且结构合法（P1 未交付，运行期走 composite）'
          : '✅ gate:pet:layers 通过：层契约自洽、锚点与资产清单一致、文件与磁盘对齐',
      );
      return 0;
    }
    console.error('❌ gate:pet:layers 失败：');
    for (const problem of result.problems) console.error(`   - ${problem}`);
    return 1;
  } catch (err) {
    // 兜底：门禁脚本自己崩掉会让 CI 变成"红但没原因"，这里必须转成人话
    console.error(`❌ gate:pet:layers 异常: ${(err && err.message) || err}`);
    return 1;
  }
}

// 仅被直接执行时跑 CLI（被测试 import 时保持静默）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

// `FRONTEND_ROOT` 供测试定位仓库内路径（避免测试自己拼绝对路径）
export const FRONTEND_DIR = FRONTEND_ROOT;
