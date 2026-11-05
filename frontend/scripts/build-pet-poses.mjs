#!/usr/bin/env node
/**
 * 桌宠姿态运行资产构建：adapter → WebP 导出 → 回写 `frontend/pet-poses.json`。
 *
 * <p><b>本脚本不新写任何编解码/哈希/尺寸实现</b>（设计 §A1.4 的硬要求）：</p>
 * <ul>
 *   <li>sharp 加载、WebP 选项、sha256 ← `build-pet-assets.mjs`（`loadSharp` / `WEBP_OPTIONS` / `sha256Of`）；</li>
 *   <li>转码内核与孤儿清理 ← `build-pet-layers.mjs`（`transcodeLayer` / `pruneOrphans`）；</li>
 *   <li>PNG/WebP 头解析 ← `pet-image-headers.mjs`。</li>
 * </ul>
 * <p>`transcodeLayer` 的 2:3 断言已被参数化成 `aspect`（默认值仍是 2:3 ⇒ 分层件行为逐字节不变），
 * 因为 pose 母版是 3072²（1:1）。除此以外一行编码逻辑都没有复制。</p>
 *
 * <p><b>`--check` 只读不写</b>：重跑 adapter 重建清单元数据，与已提交的 `pet-poses.json`
 * 逐字段比；并独立核验盘上 webp 的存在性 / 字节数 / sha256 / 编码格式。
 * "没检查"与"检查通过"永远是两句不同的话（美术目录缺失时会明确打印跳过原因）。</p>
 *
 * <p>用法：</p>
 * <pre>
 *   node scripts/build-pet-poses.mjs            # 导出 webp 并回写 pet-poses.json
 *   node scripts/build-pet-poses.mjs --check    # 只比对（漂移即非 0）
 *   node scripts/build-pet-poses.mjs --verbose  # 打印每个文件
 * </pre>
 *
 * @module scripts/build-pet-poses
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEOMETRY_PATH, readJsonFile } from './build-pet-geometry.mjs';
import { WEBP_OPTIONS, loadSharp, sha256Of } from './build-pet-assets.mjs';
import { discoverRepoRoot, transcodeLayer } from './build-pet-layers.mjs';
import { readImageSize } from './pet-image-headers.mjs';
import {
  ACCEPTED_BATCHES,
  DEFERRED_REASONS,
  POSE_DEGRADATIONS,
  SOURCE_ROOT,
  adaptAll,
} from './pet-pose-adapters.mjs';

/** 运行时清单路径（唯一真源）。 */
export const POSES_JSON_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pet-poses.json');

/** pose 运行资产输出目录（经 Vite 复制进 `dist/live2d/pet-poses`）。 */
export const DEFAULT_POSE_OUT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'live2d',
  'pet-poses',
);

/** `lxa://` 的 host（小写：standard scheme 会把 host 转小写）。 */
export const POSE_URL_HOST = 'pet-poses';

/** 单帧 `@2x` 体积上限（400 KiB：按分层件面积外推 172 KiB 的 2.3 倍留白）。 */
export const FRAME_2X_MAX_BYTES = 400 * 1024;

/** 全 pose 运行资产体积上限（6 MiB；切片后每片 ≤ 2 MiB）。 */
export const POSE_TOTAL_MAX_BYTES = 6 * 1024 * 1024;

/**
 * 站姿对齐点（native 域）——**一个实测出来的数据值，不是代码**。
 *
 * <p>取值方法（离线实测，`docs/assets/desktop-pet/v3/front-standing.png`，1024×1536 native）：
 * 用美术对 pose 用的同一个估计量——"墨迹高度 45%~85% 带内的蓝裙簇质心 x"
 * （判据 `b-r>=45 且 b>=150 且 g<b-20`）——测得 <b>479.70</b>；`y` 取站姿接地线 1454
 * （= 母版 `anchor.y 2908 ÷ 2`，与 4 个直立批的 `bodyAnchor.y` 逐值一致）。</p>
 *
 * <p>为什么不在构建时重测：设计 §A1.4 明确"PNG 解码/像素测量不引入，母版几何全部来自
 * manifest"。这条数据属于"配置"而非"测量流程"，改它就改这一行并跑
 * `npm run gate:pet:poses`（包络断言会立刻告诉你它是否还成立）。</p>
 */
export const STAND_ALIGN = Object.freeze({
  xNative: 479.7,
  yNative: 1454,
  xSource: 'measured-blue-skirt-centroid',
});

/** 生成脚本标识（与 `src/pet/poses/manifest.ts` 的常量同值）。 */
export const GENERATED_BY = 'scripts/build-pet-poses.mjs';

/**
 * 从几何真源算出比例契约（`masterToCss === artWidth / canvasWidth`）。
 *
 * <p>nativeToCss 由 masterToCss 加倍得到：两档资产（母版 / native）是同一比例的两个尺度，
 * 这条等式是"换姿时角色大小恒定"的唯一依据。</p>
 *
 * @param {Record<string, unknown>} geometry 几何真源
 * @returns {{masterToCss: number, nativeToCss: number, artWidth: number, canvasWidth: number}} 比例契约
 */
export function computeScale(geometry) {
  const artWidth = Number(geometry?.artWidth);
  const canvasWidth = Number(geometry?.canvasWidth);
  if (!(artWidth > 0) || !(canvasWidth > 0)) {
    throw new RangeError('[pet-poses] 几何真源的 artWidth / canvasWidth 必须为正');
  }
  const masterToCss = artWidth / canvasWidth;
  return { masterToCss, nativeToCss: masterToCss * 2, artWidth, canvasWidth };
}

/**
 * 一个批次的 CSS 包络（相对对齐点）。
 *
 * <p>口径固定：**native 域的墨迹 bbox 减 native 域锚点，再乘 nativeToCss**。
 * 不混域、不取对称近似——窗口不是以对齐点为中心的（见 E-02），
 * 判据由 `tests/petPoseEnvelope.test.ts` 的 G-04 按 `[-(Px)+SAFE, (W-Px)-SAFE]` 做。</p>
 *
 * @param {Record<string, Record<string, unknown>>} frames 帧表
 * @param {{nativeToCss: number}} scale 比例契约
 * @returns {{left: number, right: number, top: number, bottom: number}} 包络
 */
export function envelopeOf(frames, scale) {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const frame of Object.values(frames)) {
    const anchor = frame.anchorNative;
    const ink = frame.inkNative;
    left = Math.min(left, (ink.left - anchor.x) * scale.nativeToCss);
    right = Math.max(right, (ink.right - anchor.x) * scale.nativeToCss);
    top = Math.min(top, (ink.top - anchor.y) * scale.nativeToCss);
    bottom = Math.max(bottom, (ink.bottom - anchor.y) * scale.nativeToCss);
  }
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new RangeError('[pet-poses] 包络计算失败：帧表为空');
  }
  return { left: round4(left), right: round4(right), top: round4(top), bottom: round4(bottom) };
}

/**
 * 保留 4 位小数（清单是"数据"，不该出现 0.30000000000000004 这种噪声）。
 *
 * @param {number} value 数值
 * @returns {number} 舍入后的数值
 */
function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * 一帧的目标像素尺寸（倍率肉眼看是密度档，实际由 `canvas × masterToCss × 密度` 决定）。
 *
 * @param {Record<string, unknown>} batch 批次
 * @param {{masterToCss: number}} scale 比例契约
 * @param {'1x'|'2x'} density 密度档
 * @returns {{width: number, height: number}} 像素尺寸
 */
export function targetSizeOf(batch, scale, density) {
  const factor = density === '2x' ? 2 : 1;
  return {
    width: Math.round(batch.canvas.width * scale.masterToCss * factor),
    height: Math.round(batch.canvas.height * scale.masterToCss * factor),
  };
}

/**
 * 盘上产物是否是无损 WebP（`VP8L` 块）。
 *
 * <p>不引解码器：RIFF 头里子块标签就写着 `VP8L`（无损）/ `VP8 `（有损）/ `VP8X`（扩展，
 * 其后的第一个子块同理）。只读前 64 字节。</p>
 *
 * @param {string} absolutePath 文件路径
 * @returns {'webp'|'webp-lossless'|null} 编码格式；不是 webp 时 null
 */
export function webpFormatOf(absolutePath) {
  if (!existsSync(absolutePath)) return null;
  const header = readFileSync(absolutePath).subarray(0, 64);
  if (header.length < 16) return null;
  if (header.subarray(0, 4).toString('ascii') !== 'RIFF' || header.subarray(8, 12).toString('ascii') !== 'WEBP') {
    return null;
  }
  const text = header.toString('latin1');
  if (text.includes('VP8L')) return 'webp-lossless';
  if (text.includes('VP8')) return 'webp';
  return null;
}

/**
 * 组装运行时清单（**纯函数**：给定草稿、帧文件信息、几何真源就能算出整份 JSON）。
 *
 * @param {object} options 选项
 * @param {Record<string, Record<string, unknown>>} options.drafts 已归一化的批次草稿
 * @param {Record<string, Record<string, Record<string, Record<string, {bytes:number, sha256:string, format:string}>>>>} options.assets
 *   帧文件信息：`assets[batch][frameId][density] = { bytes, sha256, format }`
 * @param {Record<string, unknown>} options.geometry 几何真源
 * @param {Array<{posture:string, reason:string}>} options.deferred 未导出批次
 * @param {string[]} [options.accepted] 可播清单
 * @returns {Record<string, unknown>} 运行时清单
 */
export function buildPosesManifest(options) {
  const geometry = options.geometry ?? readJsonFile(GEOMETRY_PATH);
  const scale = computeScale(geometry);
  const accepted = Array.isArray(options.accepted) ? options.accepted : [...ACCEPTED_BATCHES];
  const assets = options.assets ?? {};
  const drafts = options.drafts ?? {};
  const batches = {};
  let framesTotal = 0;
  let bytes1x = 0;
  let bytes2x = 0;
  for (const [posture, draft] of Object.entries(drafts)) {
    const frames = {};
    for (const [frameId, frame] of Object.entries(draft.frames)) {
      const entry = assets[posture]?.[frameId];
      if (!entry) {
        throw new RangeError(`[pet-poses] ${posture}/${frameId} 缺少导出信息（assets 里没有该帧）`);
      }
      frames[frameId] = {
        id: frame.id,
        facing: frame.facing,
        files: {
          '1x': assetFileOf(posture, frameId, '1x', entry['1x'], scale, draft),
          '2x': assetFileOf(posture, frameId, '2x', entry['2x'], scale, draft),
        },
        anchorNative: { x: round4(frame.anchorNative.x), y: round4(frame.anchorNative.y) },
        inkNative: {
          left: round4(frame.inkNative.left),
          top: round4(frame.inkNative.top),
          right: round4(frame.inkNative.right),
          bottom: round4(frame.inkNative.bottom),
        },
        airborneGapNative: frame.airborneGapNative === null ? null : round4(frame.airborneGapNative),
        supportFootX: frame.supportFootX === null || frame.supportFootX === undefined ? null : round4(frame.supportFootX),
      };
      framesTotal += 1;
      bytes1x += entry['1x'].bytes;
      bytes2x += entry['2x'].bytes;
    }
    batches[posture] = {
      posture,
      assetId: draft.assetId,
      status: draft.status,
      masterScale: draft.masterScale,
      canvas: { width: draft.canvas.width, height: draft.canvas.height },
      nativeCanvas: { width: draft.nativeCanvas.width, height: draft.nativeCanvas.height },
      bodyAnchor: {
        byFacing: {
          '-1': { x: round4(draft.bodyAnchor.byFacing['-1'].x), y: round4(draft.bodyAnchor.byFacing['-1'].y) },
          '1': { x: round4(draft.bodyAnchor.byFacing['1'].x), y: round4(draft.bodyAnchor.byFacing['1'].y) },
        },
        byFacingSource: draft.bodyAnchor.byFacingSource,
        // G-08 的证据链：美术自报的批内离散度必须**逐值进清单**（丢掉它，运行时就没法证明
        // "同批帧锚点一致"，判据会退化成恒等式）
        spreadNative: round4(draft.bodyAnchor.spreadNative ?? 0),
        maxDeviationNative: round4(draft.bodyAnchor.maxDeviationNative ?? 0),
      },
      envelopeCss: envelopeOf(draft.frames, scale),
      clips: draft.clips.map((clip) => clip),
      frames,
      provenance: draft.provenance,
    };
  }
  return {
    version: 1,
    generatedBy: GENERATED_BY,
    sourceRoot: SOURCE_ROOT,
    scale: {
      masterToCss: scale.masterToCss,
      nativeToCss: scale.nativeToCss,
      artWidth: scale.artWidth,
      canvasWidth: scale.canvasWidth,
    },
    align: { xNative: STAND_ALIGN.xNative, yNative: STAND_ALIGN.yNative, xSource: STAND_ALIGN.xSource },
    densities: ['1x', '2x'],
    batches,
    accepted: accepted.filter((posture) => batches[posture] !== undefined),
    deferred: options.deferred ?? [],
    degradations: [...POSE_DEGRADATIONS],
    totals: { frames: framesTotal, bytes1x, bytes2x },
  };
}

/**
 * 造一条 `PoseAssetFile`。
 *
 * @param {string} posture 批次
 * @param {string} frameId 帧 id
 * @param {'1x'|'2x'} density 密度档
 * @param {{bytes:number, sha256:string, format:string}} info 文件信息
 * @param {{masterToCss: number}} scale 比例契约
 * @param {Record<string, unknown>} batch 批次草稿
 * @returns {Record<string, unknown>} 文件条目
 */
function assetFileOf(posture, frameId, density, info, scale, batch) {
  const target = targetSizeOf(batch, scale, density);
  return {
    file: `poses/${posture}/${frameId}@${density}.webp`,
    url: `lxa://${POSE_URL_HOST}/${posture}/${frameId}@${density}.webp`,
    width: target.width,
    height: target.height,
    bytes: info.bytes,
    sha256: info.sha256,
    format: info.format,
  };
}

/**
 * 递归比较两个 JSON，收集差异路径（中文描述）。
 *
 * @param {unknown} actual 实际值（已提交的清单）
 * @param {unknown} expected 期望值（重建的清单）
 * @param {string} path 当前路径
 * @param {string[]} out 差异收集器
 * @param {number} [limit] 最多收集多少条（避免一次刷屏）
 */
export function diffJson(actual, expected, path, out, limit = 25) {
  if (out.length >= limit) return;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
      out.push(`${path}：期望数组 / 实际不是数组`);
      return;
    }
    if (actual.length !== expected.length) {
      out.push(`${path}：长度 ${actual.length} ≠ 期望 ${expected.length}`);
    }
    const length = Math.min(actual.length, expected.length);
    for (let index = 0; index < length; index += 1) {
      diffJson(actual[index], expected[index], `${path}[${index}]`, out, limit);
    }
    return;
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null) {
      out.push(`${path}：期望对象 / 实际 ${JSON.stringify(actual)}`);
      return;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      diffJson(actual[key], expected[key], `${path}.${key}`, out, limit);
    }
    return;
  }
  if (actual !== expected) {
    out.push(`${path}：实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`);
  }
}

/**
 * 列出输出目录里所有 webp（相对路径，正斜杠）。
 *
 * @param {string} outDir 输出目录
 * @returns {string[]} 相对路径列表
 */
export function listPoseFiles(outDir) {
  const collected = [];
  if (!existsSync(outDir)) return collected;
  /** 深度优先。 */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !/\.webp$/i.test(entry.name)) continue;
      collected.push(relative(outDir, full).split(sep).join('/'));
    }
  };
  walk(outDir);
  return collected;
}

/**
 * 读源母版 PNG 的尺寸并做 1:1 / 2:3 的**批次级**断言。
 *
 * @param {string} absolutePath 源 PNG
 * @param {Record<string, unknown>} batch 批次草稿
 * @returns {{width:number, height:number}} 尺寸
 */
function assertSourceSize(absolutePath, batch) {
  const size = readImageSize(absolutePath);
  const expectedAspect = batch.canvas.width / batch.canvas.height;
  const actualAspect = size.width / size.height;
  if (Math.abs(actualAspect - expectedAspect) > 0.002) {
    throw new RangeError(
      `[${batch.posture}] 母版 ${size.width}×${size.height} 的比例与 manifest.canvas ` +
        `${batch.canvas.width}×${batch.canvas.height} 不一致`,
    );
  }
  return size;
}

/**
 * 构建（或校验）pose 运行资产。
 *
 * @param {object} [options] 选项
 * @param {boolean} [options.check] 只校验不回写
 * @param {boolean} [options.verbose] 打印每一步
 * @param {string} [options.repoRoot] 仓库根
 * @param {string} [options.outDir] 输出目录
 * @param {string} [options.posesJsonPath] 清单路径（测试用）
 * @param {string} [options.geometryPath] 几何真源路径（测试用）
 * @param {(message: string) => void} [options.log] 日志出口
 * @returns {Promise<{ok: boolean, check: boolean, problems: string[], notes: string[], manifest: Record<string, unknown>|null, written: boolean, removed: string[], deferred: Array<{posture:string, reason:string, status:string|null}>, totals: {frames:number, bytes1x:number, bytes2x:number} }>}
 *   构建结果
 */
export async function runBuild(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const verbose = options.verbose === true;
  const check = options.check === true;
  const repoRoot = options.repoRoot ?? discoverRepoRoot();
  const outDir = options.outDir ?? DEFAULT_POSE_OUT_DIR;
  const posesJsonPath = options.posesJsonPath ?? POSES_JSON_PATH;
  const geometryPath = options.geometryPath ?? GEOMETRY_PATH;
  const problems = [];
  const notes = [];

  const geometry = readJsonFile(geometryPath);
  const scale = computeScale(geometry);
  const adapted = adaptAll({ repoRoot, log: verbose ? log : () => {} });
  problems.push(...adapted.problems);

  const drafts = adapted.drafts;
  if (Object.keys(drafts).length === 0 && problems.length === 0) {
    notes.push('没有任何批次被登记为 accepted：清单会写成空表（资产未到是合法中间态）');
  }

  const sharp = await loadSharp();
  const assets = {};
  const removed = [];

  for (const [posture, draft] of Object.entries(drafts)) {
    assets[posture] = {};
    const batchDir = resolve(repoRoot, SOURCE_ROOT, posture);
    for (const [frameId, frame] of Object.entries(draft.frames)) {
      assets[posture][frameId] = {};
      const sourcePath = resolve(batchDir, frame.sourceFile);
      if (!existsSync(sourcePath)) {
        problems.push(`[${posture}] 源母版不存在：${sourcePath}`);
        continue;
      }
      try {
        assertSourceSize(sourcePath, draft);
      } catch (err) {
        problems.push((err && err.message) || String(err));
        continue;
      }
      for (const density of ['1x', '2x']) {
        const target = targetSizeOf(draft, scale, density);
        const expectedName = `${posture}/${frameId}@${density}.webp`;
        const diskPath = resolve(outDir, posture, `${frameId}@${density}.webp`);
        if (check) {
          if (!existsSync(diskPath)) {
            problems.push(`[${posture}] 缺少运行产物 ${expectedName}（请先跑 npm run build:pet-poses）`);
            continue;
          }
          const format = webpFormatOf(diskPath);
          if (!format) {
            problems.push(`[${posture}] ${expectedName} 不是合法 WebP`);
            continue;
          }
          assets[posture][frameId][density] = {
            bytes: statSync(diskPath).size,
            sha256: sha256Of(diskPath),
            format,
          };
          continue;
        }
        mkdirSync(dirname(diskPath), { recursive: true });
        const result = await transcodeLayer(
          sharp,
          { path: sourcePath, layerId: frameId, density },
          resolve(outDir, posture),
          target,
          {
            aspect: { w: draft.canvas.width, h: draft.canvas.height },
            lossless: true,
            quality: WEBP_OPTIONS.quality,
            maxBytes: FRAME_2X_MAX_BYTES,
          },
        );
        if (!result.ok) {
          problems.push(`[${posture}] ${frameId}@${density} 转码失败：${result.reason}`);
          continue;
        }
        if (result.downgraded) {
          notes.push(`[${posture}] ${frameId}@${density} 超过 400 KiB，已降为有损 WebP（${result.bytes} 字节）`);
        }
        if (verbose) log(`[pet-poses] 导出 ${expectedName} ${target.width}×${target.height} ${result.bytes}B ${result.format}`);
        assets[posture][frameId][density] = {
          bytes: result.bytes,
          sha256: sha256Of(diskPath),
          format: result.format,
        };
      }
    }
  }

  if (problems.length > 0) {
    return {
      ok: false,
      check,
      problems,
      notes,
      manifest: null,
      written: false,
      removed,
      deferred: adapted.deferred,
      totals: { frames: 0, bytes1x: 0, bytes2x: 0 },
    };
  }

  const manifest = buildPosesManifest({
    drafts,
    assets,
    geometry,
    deferred: adapted.deferred.map((item) => ({ posture: item.posture, reason: item.reason })),
  });

  // 体积守卫（与 `check-pet-not-shipped` 的 ≤8 MiB 是两道独立闸门：
  // 这里拦"生成时就超预算"，那里拦"进包后总量超上限"）
  const totalBytes = manifest.totals.bytes1x + manifest.totals.bytes2x;
  if (totalBytes > POSE_TOTAL_MAX_BYTES) {
    problems.push(
      `pose 运行资产合计 ${totalBytes} 字节超过预算 ${POSE_TOTAL_MAX_BYTES} 字节（${(totalBytes / 1024 / 1024).toFixed(2)} MiB）`,
    );
  }
  for (const [posture, batch] of Object.entries(manifest.batches)) {
    for (const [frameId, frame] of Object.entries(batch.frames)) {
      if (frame.files['2x'].bytes > FRAME_2X_MAX_BYTES) {
        problems.push(`[${posture}] ${frameId}@2x ${frame.files['2x'].bytes} 字节超过单帧上限 ${FRAME_2X_MAX_BYTES}`);
      }
    }
  }

  if (check) {
    if (!existsSync(posesJsonPath)) {
      problems.push(`清单不存在：${posesJsonPath}（请先跑 npm run build:pet-poses）`);
    } else {
      const committed = readJsonFile(posesJsonPath);
      // 期望值里带上已提交的 bytes/sha/format（--check 不解码，字节与哈希来自盘上核验）
      const expected = JSON.parse(JSON.stringify(manifest));
      for (const [posture, batch] of Object.entries(expected.batches)) {
        for (const [frameId, frame] of Object.entries(batch.frames)) {
          for (const density of ['1x', '2x']) {
            const committedFrame = committed.batches?.[posture]?.frames?.[frameId];
            const committedFile = committedFrame?.files?.[density];
            if (committedFile && assets[posture]?.[frameId]?.[density]) {
              frame.files[density].bytes = committedFile.bytes;
              frame.files[density].sha256 = committedFile.sha256;
              frame.files[density].format = committedFile.format;
            }
          }
        }
      }
      expected.totals.bytes1x = committed.totals?.bytes1x ?? expected.totals.bytes1x;
      expected.totals.bytes2x = committed.totals?.bytes2x ?? expected.totals.bytes2x;
      const diffs = [];
      diffJson(committed, expected, 'pet-poses', diffs);
      if (diffs.length > 0) {
        problems.push(`清单与美术 manifest 漂移（${diffs.length} 处）`);
        for (const line of diffs) problems.push(`   ${line}`);
      }
      // 独立核验：盘上文件与清单记录必须逐值相等（防"清单说 4096 字节、盘上是别的"）
      for (const [posture, batch] of Object.entries(committed.batches ?? {})) {
        for (const [frameId, frame] of Object.entries(batch.frames ?? {})) {
          for (const density of ['1x', '2x']) {
            const file = frame.files?.[density];
            if (!file) continue;
            const diskPath = resolve(outDir, posture, `${frameId}@${density}.webp`);
            if (!existsSync(diskPath)) {
              problems.push(`[${posture}] 清单登记了 ${frameId}@${density} 但盘上没有 ${diskPath}`);
              continue;
            }
            const bytes = statSync(diskPath).size;
            const sha256 = sha256Of(diskPath);
            if (bytes !== file.bytes) problems.push(`[${posture}] ${frameId}@${density} 字节数 ${bytes} ≠ 清单 ${file.bytes}`);
            if (sha256 !== file.sha256) problems.push(`[${posture}] ${frameId}@${density} sha256 与清单不一致`);
            const format = webpFormatOf(diskPath);
            if (format !== file.format) problems.push(`[${posture}] ${frameId}@${density} 编码格式 ${format} ≠ 清单 ${file.format}`);
          }
        }
      }
    }
  }

  if (problems.length > 0) {
    return {
      ok: false,
      check,
      problems,
      notes,
      manifest,
      written: false,
      removed,
      deferred: adapted.deferred,
      missing: adapted.missing,
      totals: manifest.totals,
    };
  }

  let written = false;
  if (!check) {
    // 孤儿清理：改了帧 id 之后留下的旧 webp（分层件同一套做法）。
    // 期望集合必须来自**本次刚算出的清单**，不能来自盘上的旧清单——
    // 否则首次构建会把刚导出的文件当成孤儿删掉。
    const expected = new Set();
    for (const [posture, batch] of Object.entries(manifest.batches)) {
      for (const [frameId] of Object.entries(batch.frames)) {
        for (const density of ['1x', '2x']) expected.add(`${posture}/${frameId}@${density}.webp`);
      }
    }
    const removedList = pruneExpectedOrphans(outDir, expected);
    removed.push(...removedList);
    writeFileSync(posesJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    written = true;
    log(
      `[pet-poses] 已写出 ${relative(repoRoot, posesJsonPath) || posesJsonPath}：` +
        `${Object.keys(manifest.batches).length} 批 / ${manifest.totals.frames} 帧 / ` +
        `${(totalBytes / 1024).toFixed(0)} KiB`,
    );
  }

  return {
    ok: true,
    check,
    problems,
    notes,
    manifest,
    written,
    removed,
    deferred: adapted.deferred,
    missing: adapted.missing,
    totals: manifest.totals,
  };
}

/**
 * 删掉输出目录里没有被本次清单引用的 webp（**只删 webp**，绝不碰 png 与目录）。
 *
 * @param {string} outDir 输出目录
 * @param {Set<string>} expected 期望保留的相对路径集合（形如 `sit/sit_neutral@2x.webp`）
 * @returns {string[]} 被删掉的相对路径
 */
export function pruneExpectedOrphans(outDir, expected) {
  if (!existsSync(outDir)) return [];
  const keep = expected instanceof Set ? expected : new Set();
  if (keep.size === 0) return [];
  const removed = [];
  for (const relativePath of listPoseFiles(outDir)) {
    if (keep.has(relativePath)) continue;
    rmSync(resolve(outDir, relativePath), { force: true });
    removed.push(relativePath);
  }
  return removed;
}

/**
 * CLI 入口。
 *
 * @returns {Promise<number>} 进程退出码（0 = 成功）
 */
export async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const verbose = args.includes('--verbose');
  try {
    const result = await runBuild({ check, verbose, log: (message) => console.log(message) });
    for (const note of result.notes) console.log(`[pet-poses] 注意：${note}`);
    if (result.deferred.length > 0) {
      const names = result.deferred.map((item) => `${item.posture}(${item.reason})`);
      console.log(`[pet-poses] deferred(D-01/切片)：${names.join('、')}`);
    }
    if (!result.ok) {
      console.error(`❌ ${check ? 'build-pet-poses --check' : 'build-pet-poses'} 失败：`);
      for (const problem of result.problems) console.error(`   - ${problem}`);
      return 1;
    }
    if (check) {
      console.log(
        `✅ pet-poses 漂移检查通过：${Object.keys(result.manifest?.batches ?? {}).length} 批 / ` +
          `${result.totals.frames} 帧 / 合计 ${((result.totals.bytes1x + result.totals.bytes2x) / 1024).toFixed(0)} KiB`,
      );
    } else {
      console.log(
        `✅ 已导出 pose 运行资产：${result.totals.frames} 帧 / 合计 ` +
          `${((result.totals.bytes1x + result.totals.bytes2x) / 1024).toFixed(0)} KiB` +
          (result.removed.length > 0 ? `，清理孤儿 ${result.removed.length} 个` : ''),
      );
    }
    return 0;
  } catch (err) {
    console.error(`❌ build-pet-poses 异常：${(err && err.message) || err}`);
    return 1;
  }
}

/** 当前脚本是否为入口（被测试 import 时保持静默）。 */
export const IS_ENTRY = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false;

if (IS_ENTRY) {
  process.exit(await main());
}
