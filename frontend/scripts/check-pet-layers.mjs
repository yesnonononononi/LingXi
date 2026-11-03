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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_JSON_PATH, sha256Of } from './build-pet-assets.mjs';
import { FRONTEND_ROOT, readJsonFile } from './build-pet-geometry.mjs';
import { readImageSize } from './pet-image-headers.mjs';
import {
  DEFAULT_LAYER_OUT_DIR,
  EXTERNAL_LAYER_IDS,
  LAYERS_JSON_PATH,
  LAYERS_TOTAL_BUDGET,
  LAYER_BYTE_BUDGET,
  REQUIRED_FILE_FIELDS,
  SUPPORTED_FORMATS,
  defaultLayerSourceDir,
  diskPathOf,
  maskPathsOf,
} from './build-pet-layers.mjs';
import {
  FACE_REGION_MASTER,
  FACE_TILE_BYTE_BUDGET,
  FACE_TILE_SIZES,
  FACE_TOTAL_BYTE_BUDGET,
  verifyFaceRegionAgainstLayerMasters,
} from './build-pet-face-tiles.mjs';

/**
 * 脸层的层 id（与 `build-pet-face-tiles.mjs` / `layered-presentation.ts` 同值）。
 *
 * <p>取 `EXTERNAL_LAYER_IDS[0]` 而不是再写一遍字面量：脸层的 `files` 由脸贴片生成器独占，
 * "谁不来自 P1 母版"这件事只能有一个真源。</p>
 */
export const FACE_LAYER_ID = EXTERNAL_LAYER_IDS[0];

/**
 * `face.rect` 必须落在的层序窗口（母版像素 `z`）。
 *
 * <p>必须 `>` `body-occluder(30)`（盖住底图里画好的中性脸）且 `<` `ahoge(40)`
 * （呆毛/蝴蝶结永远压在脸之上，表情切换不能把它们刷掉）。上界用
 * `layers/plan.ts` 的 `SAFE_OVERLAY_Z = 35`：缺脸层时要让整条链路回落到 `composite`，
 * 这是"无脸层也能看见表情"的兼容路径（设计文档 §3.1）。</p>
 */
export const FACE_Z_BOUNDS = Object.freeze({ minExclusive: 30, maxExclusive: 40, maxSafe: 35 });

/** 允许的分辨率档位。 */
export const SUPPORTED_DENSITIES = ['1x', '2x'];

/** 允许的混合模式。 */
export const SUPPORTED_BLENDS = ['normal', 'multiply', 'screen'];

/** 允许的层角色（与 `types.ts` 的 `LayerRole` 同步）。 */
export const SUPPORTED_ROLES = ['animatable', 'support'];

/** 画布比例容差（与几何门禁一致：0.2%）。 */
export const ASPECT_TOLERANCE = 0.002;

/** 动作目录路径（与层清单同属分层契约，共用一次门禁）。 */
export const MOTIONS_JSON_PATH = resolve(FRONTEND_ROOT, 'pet-motions.json');

/** 必须在目录里出现的动作 id（顺序与 `MotionId` 联合类型一致）。 */
export const REQUIRED_MOTION_IDS = [
  'idle',
  'tap',
  'happy',
  'angry',
  'surprised',
  'sleepy',
  'sad',
  'drag',
  'wake',
];

/** 允许的指令层。 */
export const MOTION_LAYERS = ['base', 'transient', 'ambient'];

/** 允许的关键帧属性。 */
export const MOTION_PROPERTIES = ['rotate', 'translateX', 'translateY', 'scale', 'opacity'];

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
 * 校验动作目录里的**层轨道**是否与层清单自洽（M6-b 新增）。
 *
 * <p><b>为什么这几条必须有：</b>动作目录里的 `layerId` 是手写的字符串，一旦与层清单对不上，
 * 症状是"某个部件不动"或"某层被转错方向"，而控制台一条日志都没有。更糟的是支撑层
 * （底绘 / 身体遮挡 / 前景遮挡）：<b>它们转一下就会露出补绘缝</b>，比穿模更难察觉。
 * 所以这三条不是"风格检查"，而是"改坏了必须构建失败"。</p>
 *
 * <ul>
 *   <li>每个 `track.layerId` 必须存在于 `pet-layers.json`（拼错即失败）；</li>
 *   <li>`role: 'support'` 的层永不出现在任何轨道里（支撑层只参与合成）；</li>
 *   <li>`property` 必须在白名单内（`rotate/translateX/translateY/scale/opacity`）；</li>
 *   <li>`mirror` 的目标必须是同一动作里的另一条轨道（否则镜像复制不到关键帧）；</li>
 *   <li>`follow.source` 若写成某个层 id，该层必须是可动层（`bodySway`/`bodyTilt` 这类信号名不校验）。</li>
 * </ul>
 *
 * @param {unknown} source 动作目录原文
 * @param {object|null} manifest 层清单（为 null 时只做目录内自洽校验，跳过跨文件检查）
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function validateMotionTracksAgainstLayers(source, manifest) {
  const problems = [];
  if (!source || typeof source !== 'object') return problems;
  const motions = source.motions;
  if (!motions || typeof motions !== 'object') return problems;
  const layers = manifest && Array.isArray(manifest.layers) ? manifest.layers : [];
  const byId = new Map();
  for (const layer of layers) {
    if (layer && typeof layer.layerId === 'string') byId.set(layer.layerId, layer);
  }

  for (const [id, def] of Object.entries(motions)) {
    const path = `motions.${id}`;
    if (!def || typeof def !== 'object' || !Array.isArray(def.tracks)) continue;
    const trackIds = new Set(def.tracks.map((track) => (track && typeof track.layerId === 'string' ? track.layerId : '')));
    def.tracks.forEach((track, index) => {
      const trackPath = `${path}.tracks[${index}]`;
      if (!track || typeof track !== 'object') return;
      if (!MOTION_PROPERTIES.includes(track.property)) {
        problems.push(`${trackPath}.property 只允许 ${MOTION_PROPERTIES.join(' / ')}，实际为 ${String(track.property)}`);
      }
      const layerId = track.layerId;
      if (typeof layerId !== 'string' || layerId.length === 0) return;
      if (EXTERNAL_LAYER_IDS.includes(layerId)) {
        // C7：脸层不接受任何动作轨道。给它派轨道就等于让表情贴片跟着尾巴/耳朵转，脸会被带歪。
        problems.push(
          `${trackPath}.layerId=${layerId} 是脸层（C7）：脸层只换贴片、不接受动画轨道，请删掉这条 track`,
        );
        return;
      }
      if (byId.size > 0 && !byId.has(layerId)) {
        problems.push(`${trackPath}.layerId=${layerId} 在 pet-layers.json 里不存在（层名拼错或层已被删）`);
        return;
      }
      const layer = byId.get(layerId);
      if (layer && layer.role === 'support') {
        problems.push(`${trackPath}.layerId=${layerId} 是支撑层（role=support），支撑层永不接受动画（转一下就会露补绘缝）`);
      }
      if (typeof track.mirror === 'string' && !trackIds.has(track.mirror)) {
        problems.push(`${trackPath}.mirror=${track.mirror} 不是同一动作里的轨道（镜像复制不到关键帧）`);
      }
      const followSource = track.follow && typeof track.follow === 'object' ? track.follow.source : undefined;
      if (typeof followSource === 'string' && byId.has(followSource)) {
        const sourceLayer = byId.get(followSource);
        if (sourceLayer && sourceLayer.role === 'support') {
          problems.push(`${trackPath}.follow.source=${followSource} 是支撑层，不能作为动画驱动源`);
        }
      }
    });
  }
  return problems;
}

/**
 * 校验动作目录（`frontend/pet-motions.json`）的**构建期安全子集**。
 *
 * <p>权威校验器是 `src/pet/layers/motion-catalog.ts` 的 `validateCatalog`（运行期与单测用）。
 * 这里只复核那些"改坏了会让构建带病上线"的硬约束：版本、9 个动作齐全、
 * 时长与循环自洽、优先级/层/属性白名单、关键帧闭合，以及**跨文件**的层轨道自洽
 * （见 {@link validateMotionTracksAgainstLayers}）。两边是否漂移由
 * `tests/petMotionCompiler.test.ts` 的交叉断言盯着（同一份坏目录必须被两边同时点名）。</p>
 *
 * @param {unknown} source 目录原文
 * @param {object|null} [manifest] 层清单（缺省 = 跳过跨文件校验）
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function validateMotionsFile(source, manifest = null) {
  const problems = [];
  if (!source || typeof source !== 'object') return ['动作目录必须是对象'];
  if (source.version !== 1) problems.push(`动作目录 version 必须为 1，实际为 ${String(source.version)}`);
  const defaults = source.defaults ?? {};
  if (!Number.isFinite(defaults.samples) || defaults.samples < 3 || defaults.samples > 64) {
    problems.push('动作目录 defaults.samples 必须落在 3..64');
  }
  if (!Number.isFinite(defaults.maxLagMs) || defaults.maxLagMs <= 0) {
    problems.push('动作目录 defaults.maxLagMs 必须是正数');
  }
  const motions = source.motions;
  if (!motions || typeof motions !== 'object' || Array.isArray(motions)) return [...problems, '动作目录 motions 必须是对象'];

  for (const id of REQUIRED_MOTION_IDS) {
    if (!Object.prototype.hasOwnProperty.call(motions, id)) problems.push(`动作目录缺少动作 ${id}`);
  }
  for (const [id, def] of Object.entries(motions)) {
    const path = `motions.${id}`;
    if (!REQUIRED_MOTION_IDS.includes(id)) problems.push(`${path}: 未知动作 id`);
    if (!def || typeof def !== 'object') {
      problems.push(`${path} 必须是对象`);
      continue;
    }
    if (![0, 1, 2].includes(def.priority)) problems.push(`${path}.priority 只允许 0 / 1 / 2`);
    if (typeof def.loop !== 'boolean') problems.push(`${path}.loop 必须是布尔值`);
    if (def.durationMs !== null && (!Number.isFinite(def.durationMs) || def.durationMs <= 0)) {
      problems.push(`${path}.durationMs 必须是正数或 null`);
    }
    if (def.loop === true && def.durationMs !== null) problems.push(`${path} loop=true 时 durationMs 必须为 null`);
    if (!MOTION_LAYERS.includes(def.layer)) problems.push(`${path}.layer 只允许 ${MOTION_LAYERS.join(' / ')}`);
    if (def.expression !== null && def.expression !== undefined) {
      if (typeof def.expression !== 'object' || typeof def.expression.id !== 'string') {
        problems.push(`${path}.expression 必须是 {id, durationMs} 或 null`);
      } else if (!Number.isFinite(def.expression.durationMs) || def.expression.durationMs <= 0) {
        problems.push(`${path}.expression.durationMs 必须是正数`);
      }
    }
    if (!Array.isArray(def.tracks)) {
      problems.push(`${path}.tracks 必须是数组`);
      continue;
    }
    def.tracks.forEach((track, index) => {
      const trackPath = `${path}.tracks[${index}]`;
      if (!track || typeof track !== 'object') {
        problems.push(`${trackPath} 必须是对象`);
        return;
      }
      if (typeof track.layerId !== 'string' || track.layerId.length === 0) {
        problems.push(`${trackPath}.layerId 必须是非空字符串`);
      }
      if (!MOTION_PROPERTIES.includes(track.property)) {
        problems.push(`${trackPath}.property 只允许 ${MOTION_PROPERTIES.join(' / ')}`);
      }
      if (track.follow !== undefined && track.spring !== undefined) {
        problems.push(`${trackPath} 同时出现 follow 与 spring（只能二选一）`);
      }
      if (track.mirror !== undefined) return; // 镜像轨道的关键帧来自源轨道
      const frames = track.keyframes;
      if (!Array.isArray(frames) || frames.length < 2) {
        problems.push(`${trackPath}.keyframes 至少需要 2 个关键帧`);
        return;
      }
      if (Number(frames[0].at) !== 0) problems.push(`${trackPath}.keyframes 首帧 at 必须为 0`);
      let previous = -1;
      frames.forEach((frame, frameIndex) => {
        if (!Number.isFinite(frame?.at) || frame.at < 0 || frame.at > 1) {
          problems.push(`${trackPath}.keyframes[${frameIndex}].at 必须落在 0..1`);
          return;
        }
        if (frame.at <= previous) problems.push(`${trackPath}.keyframes[${frameIndex}].at 必须严格递增`);
        previous = frame.at;
        if (!Number.isFinite(frame.value)) problems.push(`${trackPath}.keyframes[${frameIndex}].value 必须是有限数值`);
      });
    });
  }
  // 跨文件：轨道必须落在真实存在且可动的层上（支撑层永不接受动画）
  problems.push(...validateMotionTracksAgainstLayers(source, manifest));
  return problems;
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
    } else if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > canvasWidth || rect.y + rect.height > canvasHeight) {
      // rect 用母版像素（与 anchor 同单位）：P1 交件每层都是整张 2048×3072
      problems.push(
        `${prefix}.rect (${rect.x}, ${rect.y}, ${rect.width}×${rect.height}) 越出母版画布 ${canvasWidth}×${canvasHeight}`,
      );
    }

    if (layer.allowedRegion !== undefined) {
      const region = layer.allowedRegion;
      const regionOk =
        region &&
        isFiniteNumber(region.x) &&
        isFiniteNumber(region.y) &&
        isFiniteNumber(region.width) &&
        region.width > 0 &&
        isFiniteNumber(region.height) &&
        region.height > 0;
      if (!regionOk) {
        problems.push(`${prefix}.allowedRegion 必须含有限数值 x/y 与正的 width/height`);
      } else if (
        region.x < 0 ||
        region.y < 0 ||
        region.x + region.width > canvasWidth ||
        region.y + region.height > canvasHeight
      ) {
        problems.push(`${prefix}.allowedRegion 越出母版画布（可动区域必须是画布内的子矩形）`);
      }
    }

    if (!SUPPORTED_ROLES.includes(layer.role)) {
      problems.push(`${prefix}.role 只允许 ${SUPPORTED_ROLES.join(' / ')}，实际为 ${String(layer.role)}`);
    }
    if (typeof layer.source !== 'string' || layer.source.length === 0) {
      problems.push(`${prefix}.source 必须是非空字符串（美术源文件名主干，如 01_tail_base）`);
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
      const isFaceLayer = layer.layerId === FACE_LAYER_ID;
      // 普通层：layers/<layerId>@<density>.webp；脸层：face/<expressionId>@<density>.webp
      // （脸层放的是"某个表情在该档密度下的脸区贴片"，不是整层图，命名口径天然不同）
      const expectedName = `layers/${layer.layerId}@${density}`;
      const fileName = String(file.file);
      const nameOk = isFaceLayer
        ? /^face\/[A-Za-z][A-Za-z0-9]*@(1x|2x)\.webp$/.test(fileName)
        : fileName.startsWith(`${expectedName}.`);
      if (typeof file.file !== 'string' || !nameOk) {
        problems.push(
          isFaceLayer
            ? `${prefix}.files.${density}.file 必须形如 face/<expressionId>@${density}.webp，实际为 ${fileName}`
            : `${prefix}.files.${density}.file 必须形如 ${expectedName}.webp，实际为 ${fileName}`,
        );
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
 * 与磁盘对账（字段齐全、文件存在、体积、sha256、像素尺寸、2:3 比例）。
 *
 * <p><b>"缺字段"是硬错而不是跳过：</b>层清单是生成物，缺一个字段说明回填没跑或跑了一半；
 * 静默跳过会让"看起来绿了其实少一档"这种故障留到线上。所以只要某一层出现了 `files`，
 * 它就必须把 `manifest.densities` 里**每一档**都写全。</p>
 *
 * @param {object} manifest 层清单
 * @param {{ outDir?: string }} [options] 选项
 * @returns {string[]} 问题列表
 */
export function validateAgainstDisk(manifest, options = {}) {
  const outDir = options.outDir ?? DEFAULT_LAYER_OUT_DIR;
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
  const densities = Array.isArray(manifest?.densities) && manifest.densities.length > 0 ? manifest.densities : SUPPORTED_DENSITIES;
  const canvas = manifest?.canvas ?? {};
  const canvasAspect = Number(canvas.width) / Number(canvas.height);
  const problems = [];

  for (const layer of layers) {
    const files = layer && layer.files && typeof layer.files === 'object' ? layer.files : {};
    const prefix = `层 ${String(layer && layer.layerId)}`;
    if (Object.keys(files).length === 0) {
      problems.push(`${prefix} 没有任何密度的文件条目（重跑 node scripts/build-pet-layers.mjs 回填）`);
      continue;
    }
    for (const density of densities) {
      const file = files[density];
      const label = `${prefix}@${density}`;
      if (!file || typeof file !== 'object') {
        problems.push(`${label} 缺少 files.${density}（清单只允许完整，不允许缺档）`);
        continue;
      }
      const missingFields = REQUIRED_FILE_FIELDS.filter((field) => file[field] === undefined || file[field] === null);
      if (missingFields.length > 0) {
        problems.push(`${label} 缺字段 ${missingFields.join(' / ')}（必须显式补齐，不允许静默跳过）`);
        continue;
      }
      const isFaceLayer = layer.layerId === FACE_LAYER_ID;
      // 脸层的 file 是 `face/<id>@<density>.webp`（相对 `lxa://pet-p1/`），而 outDir 是
      // `…/pet-p1/layers`：直接拼会得到 `…/layers/face/x.webp`——这个 bug 只在门禁里看得见，
      // 页面上只表现为 404。所以脸层取 outDir 的上一层再拼。
      const absolute = isFaceLayer
        ? resolve(dirname(outDir), String(file.file).replace(/\\/g, '/'))
        : diskPathOf(outDir, String(file.file));
      if (!existsSync(absolute)) {
        problems.push(
          `${label} 的文件不存在: ${absolute}（${isFaceLayer ? '重跑 build:pet-face' : '重跑 build:pet-layers'}）`,
        );
        continue;
      }
      const actualBytes = readFileSync(absolute).length;
      if (Number(file.bytes) !== actualBytes) {
        problems.push(`${label} 体积不一致：清单 ${file.bytes} vs 磁盘 ${actualBytes}（文件被重出但清单没回写）`);
      }
      if (!SUPPORTED_FORMATS.includes(file.format)) {
        problems.push(`${label} format 只允许 ${SUPPORTED_FORMATS.join(' / ')}，实际为 ${String(file.format)}`);
      }
      const budget = isFaceLayer ? FACE_TILE_BYTE_BUDGET[density] : LAYER_BYTE_BUDGET[density];
      if (isFiniteNumber(budget) && Number(file.bytes) > budget) {
        problems.push(`${label} 体积 ${Number(file.bytes)}B 超出单层预算 ${budget}B（先降编码质量，不要改画布尺寸）`);
      }
      const actualSha = sha256Of(absolute);
      if (actualSha !== file.sha256) {
        problems.push(`${label} sha256 不一致（文件被重出但清单没回写）`);
      }
      let size = null;
      try {
        size = readImageSize(absolute);
      } catch (err) {
        problems.push(`${label} 图像头解析失败: ${(err && err.message) || err}`);
        continue;
      }
      if (size.width !== Number(file.width) || size.height !== Number(file.height)) {
        problems.push(`${label} 像素尺寸不一致：清单 ${file.width}×${file.height} vs 实际 ${size.width}×${size.height}`);
      }
      if (isFaceLayer) {
        // 脸贴片是**脸区子矩形**，不是 2:3 画布，所以这里守的是"严格等于设计尺寸"（C4），
        // 而不是画布比例。尺寸漂 1px，贴片放进去就会在脸边缘留一条错位环。
        const expected = FACE_TILE_SIZES[density];
        if (!expected) {
          problems.push(`${label} 不支持的密度（脸贴片只允许 1x / 2x）`);
        } else if (size.width !== expected.width || size.height !== expected.height) {
          problems.push(`${label} 尺寸必须是 ${expected.width}×${expected.height}（C4），实际 ${size.width}×${size.height}`);
        }
      } else {
        const aspect = size.width / size.height;
        if (!(canvasAspect > 0) || Math.abs(aspect - canvasAspect) > ASPECT_TOLERANCE) {
          problems.push(
            `${label} 像素比例 ${size.width}×${size.height} 不是画布比例（${String(canvas.width)}×${String(canvas.height)}）：等比 contain 会留白或裁掉尾巴`,
          );
        }
      }
    }
  }

  // 合计预算：单层不超、合计也可能超（层数会变多）。两档合计对照"层增量 ≤1.6MB"。
  // 脸贴片单独记账：它属于另一个生成器、另一套预算（`FACE_TOTAL_BYTE_BUDGET`），
  // 混进层增量里会让"层预算还剩多少"变成糊涂账。
  let totalBytes = 0;
  let faceBytes = 0;
  let anyFile = false;
  for (const layer of layers) {
    const isFaceLayer = layer && layer.layerId === FACE_LAYER_ID;
    const files = layer && layer.files && typeof layer.files === 'object' ? layer.files : {};
    for (const file of Object.values(files)) {
      if (!file || !isFiniteNumber(file.bytes)) continue;
      anyFile = true;
      if (isFaceLayer) faceBytes += Number(file.bytes);
      else totalBytes += Number(file.bytes);
    }
  }
  if (anyFile && totalBytes > LAYERS_TOTAL_BUDGET) {
    problems.push(
      `分层资产合计 ${totalBytes}B 超出层增量预算 ${LAYERS_TOTAL_BUDGET}B（先降编码质量，不要改画布尺寸）`,
    );
  }
  if (faceBytes > FACE_TOTAL_BYTE_BUDGET) {
    problems.push(
      `脸贴片合计 ${faceBytes}B 超出总预算 ${FACE_TOTAL_BYTE_BUDGET}B（先降编码质量，不要改贴片尺寸）`,
    );
  }
  return problems;
}

/**
 * 运行目录里不许有孤儿文件（清单没引用的层图）。
 *
 * <p>孤儿文件不会让页面出错，但会让"包体积为什么比清单算出来的大"变成一个查不出的谜；
 * 更糟的是它可能被误当成"还在用的资产"而不敢删。构建脚本会自动清理，门禁负责发现。</p>
 *
 * @param {object} manifest 层清单
 * @param {{ outDir?: string }} [options] 选项
 * @returns {string[]} 问题列表
 */
export function validateNoOrphans(manifest, options = {}) {
  const outDir = options.outDir ?? DEFAULT_LAYER_OUT_DIR;
  if (!existsSync(outDir)) return [];
  const referenced = new Set();
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
  for (const layer of layers) {
    const files = layer && layer.files && typeof layer.files === 'object' ? layer.files : {};
    for (const file of Object.values(files)) {
      if (file && typeof file.file === 'string') referenced.add(basename(String(file.file)));
    }
  }
  const problems = [];
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (referenced.has(entry.name)) continue;
    problems.push(`运行目录存在孤儿文件 ${entry.name}（清单没有引用它；重跑 build:pet-layers 会自动清理）`);
  }
  return problems;
}

/**
 * 掩膜必须存在（构建期校验输入，**不进运行时包**）。
 *
 * <p>掩膜证明"可见像素 / 被遮挡补绘像素"是分开的；缺了它，以后想按掩膜做遮挡判断就只能重画。
 * 源目录整块不存在时（P1 未到货的中间态）不报错——那是"没到"而不是"做错"。</p>
 *
 * @param {object} manifest 层清单
 * @param {{ sourceDir?: string }} [options] 选项
 * @returns {string[]} 问题列表
 */
export function validateMasks(manifest, options = {}) {
  const sourceDir = options.sourceDir ?? defaultLayerSourceDir();
  if (!existsSync(sourceDir)) return [];
  const problems = [];
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
  for (const layer of layers) {
    if (!layer || layer.role !== 'animatable') continue;
    if (EXTERNAL_LAYER_IDS.includes(layer.layerId)) continue;
    if (typeof layer.source !== 'string' || layer.source.length === 0) continue;
    const masks = maskPathsOf(sourceDir, layer.source);
    for (const [kind, absolute] of Object.entries(masks)) {
      if (!existsSync(absolute)) {
        problems.push(`层 ${layer.layerId} 缺少 ${kind} 掩膜 ${basename(absolute)}（母版目录不完整）`);
      }
    }
  }
  return problems;
}

/**
 * P1 母版目录是否存在（决定"缺件"是中间态还是错误）。
 *
 * @param {string} [sourceDir] 母版目录
 * @returns {boolean}
 */
export function sourceDirPresent(sourceDir = defaultLayerSourceDir()) {
  return existsSync(sourceDir);
}

/**
 * 脸层契约（C7 / C8）的结构校验：层序、矩形、角色。
 *
 * <p><b>为什么这几条必须由门禁守：</b>它们全是"改一个数字就静默错"的字段：</p>
 * <ul>
 *   <li>`z` 提到 45（与 `bow` 并列/更大）⇒ 表情贴片会盖住蝴蝶结，切换表情时把那块刷没；</li>
 *   <li>`z` 降到 25 或更低 ⇒ 贴片会被 `body-occluder` 压住，表情又"看不见了"，
 *       而且 `layers/plan.ts` 的 `SAFE_OVERLAY_Z` 判定不再命中"缺脸层 ⇒ 回落 composite"，
 *       旧包上的兼容路径会失效；</li>
 *   <li>`rect` 改动 ⇒ 贴片与底图不再逐像素对齐（C3 会红，但 C3 需要像素读盘，
 *       这条结构断言先廉价地拦住）；</li>
 *   <li>`role` 改成 `support` ⇒ 表情会被当成"支撑层"静默跳过。</li>
 * </ul>
 *
 * @param {object} manifest 层清单
 * @returns {string[]} 问题列表（空 = 通过；清单里没有 face 层也返回问题——M1 契约要求有）
 */
export function validateFaceLayerContract(manifest) {
  const problems = [];
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
  const face = layers.find((layer) => layer && layer.layerId === FACE_LAYER_ID);
  if (!face) {
    problems.push(
      `C8 失败：层清单缺少 ${FACE_LAYER_ID} 层（M1 契约要求第 10 层 face：z=32、rect=脸区、role=animatable）`,
    );
    return problems;
  }
  const byId = new Map(layers.filter((layer) => layer && typeof layer.layerId === 'string').map((layer) => [layer.layerId, layer]));
  const occluder = byId.get('body-occluder');
  const ahoge = byId.get('ahoge');
  const z = Number(face.z);
  if (!Number.isInteger(z)) {
    problems.push(`C8 失败：${FACE_LAYER_ID}.z 必须是整数，实际为 ${String(face.z)}`);
  } else {
    if (occluder && !(z > Number(occluder.z))) {
      problems.push(`C8 失败：${FACE_LAYER_ID}.z=${z} 必须大于 body-occluder.z=${Number(occluder.z)}（否则贴片被底图压住，表情看不见）`);
    }
    if (ahoge && !(z < Number(ahoge.z))) {
      problems.push(`C8 失败：${FACE_LAYER_ID}.z=${z} 必须小于 ahoge.z=${Number(ahoge.z)}（否则表情会盖住呆毛/蝴蝶结）`);
    }
    if (!(z <= FACE_Z_BOUNDS.maxSafe)) {
      problems.push(
        `C8 失败：${FACE_LAYER_ID}.z=${z} 必须 ≤ SAFE_OVERLAY_Z(${FACE_Z_BOUNDS.maxSafe})：` +
          '缺脸层时要让 plan.ts 判定"必须整体回落 composite"，这是旧包的兼容路径',
      );
    }
  }
  if (face.role !== 'animatable') {
    problems.push(`C8 失败：${FACE_LAYER_ID}.role 必须是 animatable（实际 ${String(face.role)}），否则表情指令会被静默跳过`);
  }
  const rect = face.rect ?? {};
  const rectMatches =
    Number(rect.x) === FACE_REGION_MASTER.x &&
    Number(rect.y) === FACE_REGION_MASTER.y &&
    Number(rect.width) === FACE_REGION_MASTER.width &&
    Number(rect.height) === FACE_REGION_MASTER.height;
  if (!rectMatches) {
    problems.push(
      `C8 失败：${FACE_LAYER_ID}.rect (${String(rect.x)}, ${String(rect.y)}, ${String(rect.width)}×${String(rect.height)}) 与脸区真源 ` +
        `(${FACE_REGION_MASTER.x}, ${FACE_REGION_MASTER.y}, ${FACE_REGION_MASTER.width}×${FACE_REGION_MASTER.height}) 不一致（贴片会画偏）`,
    );
  }
  if (face.required !== true) {
    problems.push(`C8 失败：${FACE_LAYER_ID}.required 必须是 true（缺了它 layered 模式就看不见表情）`);
  }
  return problems;
}

/**
 * 跑完整的分层门禁。
 *
 * @param {{ verbose?: boolean, manifestPath?: string, outDir?: string, assetsPath?: string, sourceDir?: string, skipPixels?: boolean }} [options] 选项
 * @returns {Promise<{ ok: boolean, problems: string[], notes: string[], manifest: object | null, skipped: boolean }>} 门禁结果
 */
export async function runLayerGate(options = {}) {
  const verbose = options.verbose === true;
  const manifestPath = options.manifestPath ?? LAYERS_JSON_PATH;
  const assetsPath = options.assetsPath ?? ASSETS_JSON_PATH;
  const problems = [];
  const notes = [];
  let manifest = null;
  try {
    manifest = readJsonFile(manifestPath);
  } catch (err) {
    return {
      ok: false,
      problems: [`层清单不可读: ${(err && err.message) || err}`],
      notes,
      manifest: null,
      skipped: false,
    };
  }

  problems.push(...validateManifestStructure(manifest));
  // C7（脸层不许有动作轨道）在 validateMotionsFile 里；C8（层序/矩形/角色）在这里
  problems.push(...validateFaceLayerContract(manifest));

  let assets = null;
  if (existsSync(assetsPath)) {
    try {
      assets = readJsonFile(assetsPath);
      problems.push(...validateAgainstAssets(manifest, assets));
    } catch (err) {
      problems.push(`pet-assets.json 不可读: ${(err && err.message) || err}`);
    }
  }

  // 落盘类校验分两种状态：
  //   · 母版目录在 或 清单里已经有 files → 必须严格对齐（缺字段/缺文件/比例不对/孤儿 全部硬错）
  //   · 母版目录整块不在 且 files 全空 → "资产未到货"的合法中间态，跳过落盘校验并说明原因
  const sourceDir = options.sourceDir ?? defaultLayerSourceDir();
  const p1Present = sourceDirPresent(sourceDir);
  const layersWithFiles = (Array.isArray(manifest.layers) ? manifest.layers : []).filter(
    (layer) => layer && layer.files && typeof layer.files === 'object' && Object.keys(layer.files).length > 0,
  );
  const missingAssetState = !p1Present && layersWithFiles.length === 0;
  if (!missingAssetState) {
    problems.push(...validateAgainstDisk(manifest, { outDir: options.outDir ?? DEFAULT_LAYER_OUT_DIR }));
    problems.push(...validateNoOrphans(manifest, { outDir: options.outDir ?? DEFAULT_LAYER_OUT_DIR }));
    problems.push(...validateMasks(manifest, { sourceDir }));
  }

  // C2 / C3：脸区与各层母版的像素关系（"脸区可动层墨迹=0"、"neutral 贴片与 body-occluder 逐像素相等"）。
  // 这两条是整套分层方案"零重影"的基石，只能靠真像素判——但需要读母版 PNG，
  // 所以 P1 母版没到货时由被调用方自动跳过并返回说明（"没检查"必须说出来）。
  if (options.skipPixels !== true) {
    const faceCheck = await verifyFaceRegionAgainstLayerMasters(manifest, {
      sourceDir,
      verbose,
      log: (message) => console.log(message),
    });
    problems.push(...faceCheck.problems);
    notes.push(...faceCheck.notes);
    if (verbose && !faceCheck.skipped) console.log('[pet-layers] C2/C3 脸区像素校验已执行');
  }

  // 动作目录同属分层契约：一起进这道门禁，避免"层齐了但动作数据写坏"带病上线
  const motionsPath = options.motionsPath ?? MOTIONS_JSON_PATH;
  try {
    const motions = readJsonFile(motionsPath);
    problems.push(...validateMotionsFile(motions, manifest));
    if (verbose) console.log(`[pet-layers] 动作目录动作数=${Object.keys(motions.motions ?? {}).length}`);
  } catch (err) {
    problems.push(`动作目录不可读: ${(err && err.message) || err}`);
  }

  const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
  const skipped = layers.length === 0;
  if (verbose) {
    console.log(
      `[pet-layers] enabled=${String(manifest.enabled)} 层数=${layers.length} 密度=${(manifest.densities ?? []).join('/')}` +
        ` 画布=${String(manifest.canvas?.width)}×${String(manifest.canvas?.height)}`,
    );
    if (skipped) console.log('[pet-layers] 层清单为空：P1 分层件未交付，运行期走 composite（与今天等价）');
    if (missingAssetState) console.log('[pet-layers] P1 母版目录不存在且 files 未回填：跳过落盘校验（资产未到货的合法中间态）');
    if (layersWithFiles.length > 0) {
      const totals = { '1x': 0, '2x': 0 };
      let maxBy = { '1x': 0, '2x': 0 };
      for (const layer of layersWithFiles) {
        for (const density of ['1x', '2x']) {
          const file = layer.files[density];
          if (!file) continue;
          totals[density] += Number(file.bytes) || 0;
          maxBy[density] = Math.max(maxBy[density], Number(file.bytes) || 0);
        }
      }
      console.log(
        `[pet-layers] 体积 @1x 合计=${totals['1x']}B 单张最大=${maxBy['1x']}B；` +
          `@2x 合计=${totals['2x']}B 单张最大=${maxBy['2x']}B`,
      );
    }
  }
  for (const note of notes) console.log(`[pet-layers] ${note}`);
  return { ok: problems.length === 0, problems, notes, manifest, skipped, missingAssetState, p1Present };
}

/**
 * CLI 入口。
 *
 * @returns {Promise<number>} 进程退出码（0 = 通过）
 */
export async function main() {
  const verbose = process.argv.slice(2).includes('--verbose');
  try {
    const result = await runLayerGate({ verbose });
    if (result.ok) {
      console.log(
        result.skipped
          ? '✅ gate:pet:layers 通过：层清单为空且结构合法（P1 未交付，运行期走 composite）'
          : result.missingAssetState
            ? '✅ gate:pet:layers 通过：层契约自洽（P1 母版未到货、files 未回填，运行期走 composite）'
            : '✅ gate:pet:layers 通过：层契约自洽、锚点与资产清单一致、files 与磁盘对齐（字段齐全/体积/sha256/2:3 比例）、无孤儿文件、掩膜齐备、脸层契约与脸区像素校验（C2/C3/C7/C8）通过',
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
  main().then((code) => process.exit(code));
}

// `FRONTEND_ROOT` 供测试定位仓库内路径（避免测试自己拼绝对路径）
export const FRONTEND_DIR = FRONTEND_ROOT;
