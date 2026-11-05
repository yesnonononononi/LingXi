#!/usr/bin/env node
/**
 * 构建期 adapter：把美术三套异构 `manifest.json` 归一到唯一运行时形态。
 *
 * <p><b>为什么必须有这一层：</b>6 批 manifest 不是一套契约，是<b>三种写法并存</b>——</p>
 * <ul>
 *   <li><b>`legacy-v1`</b>（`sit`）：`files[]` 扁平条目，`display` 是 156×234，单帧静姿；</li>
 *   <li><b>`files-sequences-v2`</b>（`lie`）：`files[]` + `sequences{down,neutral,up}` +
 *       `aliases`（7 个帧位只有 3 张不同像素），**`frames` 字段为 0**——
 *       任何"按 frames 遍历"的写法都会把整批当成空批次；</li>
 *   <li><b>`frames-nested-v3`</b>（`sleep/walk/run/jump`）：`frames[]` 里嵌
 *       `master{bbox}`（母版域）+ `native{bbox}`（native 域），父帧还有扁平 `bbox`。</li>
 * </ul>
 *
 * <p><b>允许各批不同，但归一的动作必须显式：</b>每批一个 adapter，字段按白名单消费，
 * 遇到<b>未知结构或字段漂移一律硬失败</b>（抛出中文原因），绝不"猜一下继续跑"。
 * 异构性因此被关在构建期，运行时只认 `frontend/pet-poses.json`（零分支）。</p>
 *
 * <p><b>不改美术文件</b>：本模块只读 `docs/assets/desktop-pet/poses/&lt;batch&gt;/manifest.json`，
 * 不扫目录（美术正在 `poses/jump/` 并行产右向帧，未登记文件当它不存在 ⇒ 零抖动）。</p>
 *
 * <p><b>两处采集规则（都踩过坑）：</b></p>
 * <ol>
 *   <li>墨迹 bbox 一律换成 <b>native 域</b>：v3 有 `native.bbox` 就直接用，
 *       否则用母版 `bbox ÷ masterScale`；</li>
 *   <li>`bodyAnchor` 是 **native 域**，`anchor` 是母版域且<b>不进运行时清单</b>
 *       （`anchor.y / 2` 在 4 个直立批"碰巧"等于 `bodyAnchor.y`，在 lie/sleep 差 13.5
 *       native ⇒ 运行时只许读 `bodyAnchor`）。</li>
 * </ol>
 *
 * @module scripts/pet-pose-adapters
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** 美术源根（相对仓库根，排障用；引擎不读）。 */
export const SOURCE_ROOT = 'docs/assets/desktop-pet/poses';

/**
 * 工程侧显式登记的**可播清单**（`playable` 的唯一来源）。
 *
 * <p>美术 6 批 `status` 全是 `awaiting-static-review`——"已交付"与"被工程接受"是两件事。
 * 改这个常量必须同时改 `tests/petPoseAdapters.test.ts` 的期望，不可能"悄悄跑起来"。</p>
 */
export const ACCEPTED_BATCHES = Object.freeze(['sit']);

/** 每批的 adapter 归属（显式登记，不做启发式猜测；检测结果与它不符即硬失败）。 */
export const BATCH_SPECS = Object.freeze([
  Object.freeze({ posture: 'sit', adapter: 'legacy-v1' }),
  Object.freeze({ posture: 'lie', adapter: 'files-sequences-v2' }),
  Object.freeze({ posture: 'sleep', adapter: 'frames-nested-v3' }),
  Object.freeze({ posture: 'walk', adapter: 'frames-nested-v3' }),
  Object.freeze({ posture: 'run', adapter: 'frames-nested-v3' }),
  Object.freeze({ posture: 'jump', adapter: 'frames-nested-v3' }),
]);

/**
 * 帧时长（毫秒）**由工程侧拥有**：美术 6 批里 0 个时序字段（`duration|frameMs|fps|timing|loop`
 * 全部未命中），任务书 §8 明确"速度/停留时长属配置，交工程侧"。
 *
 * <p>`sit` 与 `lie` 的 `hold` 是**单帧静止姿态**，时长为 0（不推进），
 * 但绝不为"看起来像动画"加假帧（D-03 口径）。</p>
 */
export const FRAME_TIMING = Object.freeze({
  sit: Object.freeze({ hold: 0 }),
  lie: Object.freeze({ enter: 120, hold: 0, exit: 120 }),
  sleep: Object.freeze({ cycle: 1800 }),
  walk: Object.freeze({ cycle: 110 }),
  run: Object.freeze({ cycle: 90 }),
  jump: Object.freeze({ once: 130 }),
});

/** 未登记批次的降级原因（**常量**，不随美术 manifest 抖动；否则 `--check` 会天天红）。 */
export const DEFERRED_REASONS = Object.freeze({
  sit: '切片 1 之前的空清单骨架：sit 由构建脚本回写登记',
  lie: '切片 3（卧姿语义）：运行资产未导出',
  sleep: '切片 3（卧姿语义）：运行资产未导出',
  walk: '切片 2：运行资产未导出',
  run: '切片 2：运行资产未导出',
  jump: '切片 2：运行资产未导出（美术左右 10 帧已交齐，等切片 2 接漫游）',
});

/** 姿态态下显式交付的降级（"没做"与"做坏了"必须是两句不同的话）。 */
export const POSE_DEGRADATIONS = Object.freeze(['no-face-overlay', 'no-blink']);

/** adapter 名（与 `src/pet/poses/types.ts` 的联合类型逐字一致）。 */
export const ADAPTER_IDS = Object.freeze(['legacy-v1', 'files-sequences-v2', 'frames-nested-v3']);

/**
 * G-08 的硬阈值：同批同 facing 的帧锚点与批级 `bodyAnchor` 之差的上限（native px）。
 *
 * <p>数值来自设计 §A1.7：2 native px ≈ 0.3 CSS px，肉眼不可见；超过它就意味着某帧的接地基线
 * 与整批不一致（"跳脚"）。<b>这是守门值，任何"当前这批差 3.1 就先放过去"的改动都是错的。</b></p>
 */
export const ANCHOR_SPREAD_MAX_NATIVE = 2;

/**
 * adapter 失败（结构不认识 / 字段漂移 / 数据自相矛盾）。
 *
 * <p>单独一个错误类型，是为了让构建脚本能把它和"文件读不到"分开报——
 * 前者是契约问题（要改 adapter 或美术），后者是环境问题（要检出资产）。</p>
 */
export class PoseAdapterError extends Error {
  /**
   * @param {string} message 中文原因
   * @param {string} [batch] 出问题的批次
   */
  constructor(message, batch = '') {
    super(batch ? `[${batch}] ${message}` : message);
    this.name = 'PoseAdapterError';
    this.batch = batch;
  }
}

/**
 * 断言是对象（非数组、非 null）。
 *
 * @param {unknown} value 原始值
 * @param {string} name 字段路径
 * @param {string} batch 批次名（报错用）
 * @returns {Record<string, unknown>} 对象
 */
function requireObject(value, name, batch) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PoseAdapterError(`${name} 必须是对象，实际为 ${JSON.stringify(value)}`, batch);
  }
  return value;
}

/**
 * 断言是有限数值。
 *
 * @param {unknown} value 原始值
 * @param {string} name 字段路径
 * @param {string} batch 批次名
 * @returns {number} 数值
 */
function requireNumber(value, name, batch) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new PoseAdapterError(`${name} 必须是有限数值，实际为 ${JSON.stringify(value)}`, batch);
  }
  return num;
}

/**
 * 断言是非空字符串。
 *
 * @param {unknown} value 原始值
 * @param {string} name 字段路径
 * @param {string} batch 批次名
 * @returns {string} 字符串
 */
function requireString(value, name, batch) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PoseAdapterError(`${name} 必须是非空字符串，实际为 ${JSON.stringify(value)}`, batch);
  }
  return value;
}

/**
 * 断言是非空数组。
 *
 * @param {unknown} value 原始值
 * @param {string} name 字段路径
 * @param {string} batch 批次名
 * @returns {unknown[]} 数组
 */
function requireArray(value, name, batch) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PoseAdapterError(`${name} 必须是非空数组`, batch);
  }
  return value;
}

/**
 * 从文件名得到运行时帧 id（去掉 `@2x.png` 与目录前缀）。
 *
 * @param {string} file 源文件名（如 `sit_neutral@2x.png`）
 * @returns {string} 帧 id（如 `sit_neutral`）
 */
export function frameIdOf(file) {
  const base = String(file).split('/').pop() ?? '';
  const trimmed = base.replace(/@\d+x\.png$/i, '').replace(/\.png$/i, '');
  if (trimmed.length === 0) throw new PoseAdapterError(`无法从文件名推出帧 id：${file}`);
  return trimmed;
}

/**
 * 读母版倍率（两种写法：`masterScale: 2` 或 `masterScale: { factor: 2 }`）。
 *
 * @param {unknown} raw 原始值
 * @param {string} batch 批次名
 * @returns {number} 倍率（1 或 2）
 */
export function masterScaleOf(raw, batch) {
  const value = typeof raw === 'object' && raw !== null ? raw.factor : raw;
  const factor = requireNumber(value, 'masterScale', batch);
  if (!(factor >= 1)) throw new PoseAdapterError(`masterScale 必须 ≥1，实际为 ${factor}`, batch);
  return factor;
}

/**
 * 按结构识别 adapter（**识别结果必须与 `BATCH_SPECS` 的登记一致**，否则硬失败）。
 *
 * @param {Record<string, unknown>} manifest 美术 manifest
 * @param {string} batch 批次名
 * @returns {'legacy-v1'|'files-sequences-v2'|'frames-nested-v3'} adapter 名
 */
export function detectAdapter(manifest, batch) {
  const hasFrames = Array.isArray(manifest.frames) && manifest.frames.length > 0;
  const hasSequences = typeof manifest.sequences === 'object' && manifest.sequences !== null;
  const hasFiles = Array.isArray(manifest.files) && manifest.files.length > 0;
  if (hasFrames) return 'frames-nested-v3';
  if (hasSequences && hasFiles) return 'files-sequences-v2';
  if (hasFiles) return 'legacy-v1';
  throw new PoseAdapterError(
    `manifest 结构不认识（frames=${JSON.stringify(manifest.frames ?? null)}，` +
      `sequences=${hasSequences}，files=${hasFiles}）：三种已知形态都不是，拒绝猜`,
    batch,
  );
}

/**
 * 读取可选数值（缺省 / null 都返回 null）。
 *
 * @param {unknown} value 原始值
 * @param {string} name 字段路径
 * @param {string} batch 批次名
 * @returns {number|null} 数值或 null
 */
function optionalNumber(value, name, batch) {
  if (value === undefined || value === null) return null;
  return requireNumber(value, name, batch);
}

/**
 * 归一化美术自报的锚点离散度（`bodyAnchor.spreadNative` 可能是标量，也可能是按朝向的对象）。
 *
 * <p><b>为什么必须收下它：</b>G-08 的判据是"同批同 facing 的帧锚点与批级锚点差 ≤ 2 native"。
 * 逐帧锚点只在美术的 `measuredNativeTorsoX` 文本里（`sleep_neutral:732.74 sleep_breath_in:732.75…`），
 * 运行时不重算，所以<b>美术自报的汇总值就是唯一证据</b>。把它丢掉，G-08 会退化成恒等式
 * （自造锚点 ⇒ 差恒为 0 ⇒ 永远绿）。</p>
 *
 * @param {unknown} spreadRaw 原始 `spreadNative`
 * @param {unknown} maxDeviationRaw 原始 `maxDeviationNative`
 * @param {string} batch 批次名
 * @returns {{spreadNative: number|null, maxDeviationNative: number|null}} 归一后的离散度
 */
export function normalizeAnchorSpread(spreadRaw, maxDeviationRaw, batch) {
  let spread = null;
  if (spreadRaw !== undefined && spreadRaw !== null) {
    if (typeof spreadRaw === 'object') {
      // 多朝向批（`run`）逐朝向报：取最大值作为"批内最坏情况"
      const values = Object.entries(spreadRaw).map(([facing, value]) =>
        requireNumber(value, `bodyAnchor.spreadNative['${facing}']`, batch),
      );
      spread = values.length === 0 ? null : Math.max(...values);
    } else {
      spread = requireNumber(spreadRaw, 'bodyAnchor.spreadNative', batch);
    }
  }
  const maxDeviation = optionalNumber(maxDeviationRaw, 'bodyAnchor.maxDeviationNative', batch);
  for (const [label, value] of [
    ['spreadNative', spread],
    ['maxDeviationNative', maxDeviation],
  ]) {
    if (value === null) continue;
    if (value < 0) throw new PoseAdapterError(`bodyAnchor.${label} 不能为负，实际为 ${value}`, batch);
    if (value > ANCHOR_SPREAD_MAX_NATIVE) {
      throw new PoseAdapterError(
        `bodyAnchor.${label}=${value} 超过 G-08 上限 ${ANCHOR_SPREAD_MAX_NATIVE} native：` +
          '同批帧锚点与批级锚点差太大，说明这批帧不是同一个接地基线（不许放宽阈值）',
        batch,
      );
    }
  }
  return { spreadNative: spread, maxDeviationNative: maxDeviation };
}

/**
 * 归一化批级锚点（native 域），并为缺席朝向做**显式**降级。
 *
 * <p>规则（顺序固定）：</p>
 * <ol>
 *   <li>manifest 有 `bodyAnchor.byFacing` ⇒ 按朝向取，源记为 `measured-per-facing`；</li>
 *   <li>没有 `byFacing` ⇒ 批级单值套两个朝向，源记为 `batch-single`；</li>
 *   <li>有 `byFacing` 但缺某个朝向（`jump` 右向帧在产时正是这种状态）⇒ 该朝向按画布镜像
 *       推导（`nativeCanvas.width − x`），源记为 `mirror-derived`，并写进 `warnings`。
 *       <b>绝不静默</b>：推导出来的锚点会进包络断言，将来对不上就是红。</li>
 * </ol>
 *
 * @param {Record<string, unknown>} manifest 美术 manifest
 * @param {number} nativeCanvasWidth native 画布宽
 * @param {string} batch 批次名
 * @returns {{byFacing: Record<string,{x:number,y:number}>, byFacingSource: string, spreadNative: number|null, maxDeviationNative: number|null, warnings: string[]}}
 *   归一后的锚点
 */
export function normalizeBodyAnchor(manifest, nativeCanvasWidth, batch) {
  const raw = requireObject(manifest.bodyAnchor, 'bodyAnchor', batch);
  const baseX = requireNumber(raw.x, 'bodyAnchor.x', batch);
  const baseY = requireNumber(raw.y, 'bodyAnchor.y', batch);
  const spread = normalizeAnchorSpread(raw.spreadNative, raw.maxDeviationNative, batch);
  const declared = raw.byFacing;
  const warnings = [];
  if (declared === undefined) {
    // 单值兜底：两个朝向同值。这是 v2/v1 的正常形态（正面或卧姿不区分朝向）。
    return {
      byFacing: { '-1': { x: baseX, y: baseY }, '1': { x: baseX, y: baseY } },
      byFacingSource: 'batch-single',
      ...spread,
      warnings,
    };
  }
  const byFacingRaw = requireObject(declared, 'bodyAnchor.byFacing', batch);
  const byFacing = {};
  let derived = false;
  for (const facing of ['-1', '1']) {
    const entry = byFacingRaw[facing];
    if (entry === undefined) {
      const mirrored = nativeCanvasWidth - baseX;
      byFacing[facing] = { x: mirrored, y: baseY };
      derived = true;
      warnings.push(
        `bodyAnchor.byFacing 缺少朝向 ${facing} 的实测值，已按画布镜像推导 x=${mirrored}` +
          `（native 画布宽 ${nativeCanvasWidth} − 批级 ${baseX}）`,
      );
      continue;
    }
    const item = requireObject(entry, `bodyAnchor.byFacing['${facing}']`, batch);
    byFacing[facing] = {
      x: requireNumber(item.x, `bodyAnchor.byFacing['${facing}'].x`, batch),
      y: requireNumber(item.y, `bodyAnchor.byFacing['${facing}'].y`, batch),
    };
  }
  return { byFacing, byFacingSource: derived ? 'mirror-derived' : 'measured-per-facing', ...spread, warnings };
}

/**
 * 把一块母版 bbox 换成 native bbox。
 *
 * @param {Record<string, unknown>|null} nativeBbox 已有的 native bbox（可空）
 * @param {Record<string, unknown>} masterBbox 母版 bbox
 * @param {number} factor 倍率
 * @param {string} batch 批次名
 * @param {string} label 报错用的字段路径
 * @returns {{left:number, top:number, right:number, bottom:number}} native bbox
 */
function toNativeBbox(nativeBbox, masterBbox, factor, batch, label) {
  if (nativeBbox) {
    const box = requireObject(nativeBbox, `${label}.native.bbox`, batch);
    return {
      left: requireNumber(box.left, `${label}.native.bbox.left`, batch),
      top: requireNumber(box.top, `${label}.native.bbox.top`, batch),
      right: requireNumber(box.right, `${label}.native.bbox.right`, batch),
      bottom: requireNumber(box.bottom, `${label}.native.bbox.bottom`, batch),
    };
  }
  const box = requireObject(masterBbox, `${label}.bbox`, batch);
  return {
    left: requireNumber(box.left, `${label}.bbox.left`, batch) / factor,
    top: requireNumber(box.top, `${label}.bbox.top`, batch) / factor,
    right: requireNumber(box.right, `${label}.bbox.right`, batch) / factor,
    bottom: requireNumber(box.bottom, `${label}.bbox.bottom`, batch) / factor,
  };
}

/**
 * 造一条 clip（自动按 facing 分组；多朝向批次得到一对 clip）。
 *
 * @param {string} id 片段基础 id
 * @param {Array<{id:string, facing:number}>} frames 片段帧（按播放顺序）
 * @param {boolean} loop 是否循环
 * @param {number} frameMs 每帧时长
 * @param {'hold-last'|'return-stand'} [onEnd] 收尾动作
 * @returns {Array<Record<string, unknown>>} clip 列表（单朝向 → 1 条；多朝向 → 每朝向 1 条）
 */
export function buildClips(id, frames, loop, frameMs, onEnd) {
  const byFacing = new Map();
  for (const frame of frames) {
    const list = byFacing.get(frame.facing) ?? [];
    list.push(frame.id);
    byFacing.set(frame.facing, list);
  }
  const facings = [...byFacing.keys()].sort((a, b) => a - b);
  return facings.map((facing) => ({
    id,
    facing,
    frames: byFacing.get(facing),
    loop,
    frameMs: byFacing.get(facing).map(() => frameMs),
    ...(onEnd === undefined ? {} : { onEnd }),
  }));
}

/**
 * 归一化 `legacy-v1`（`sit`）：`files[]` 扁平条目 + 单帧静姿。
 *
 * @param {Record<string, unknown>} manifest 美术 manifest
 * @param {string} batch 批次名
 * @returns {Record<string, unknown>} 归一后的批次草稿
 */
function adaptLegacyV1(manifest, batch) {
  const canvas = requireObject(manifest.canvas, 'canvas', batch);
  const nativeCanvas = requireObject(manifest.nativeSourceCanvas, 'nativeSourceCanvas', batch);
  const factor = masterScaleOf(manifest.masterScale, batch);
  const files = requireArray(manifest.files, 'files', batch);
  const anchor = normalizeBodyAnchor(manifest, requireNumber(nativeCanvas.width, 'nativeSourceCanvas.width', batch), batch);
  const facing = -1;
  const frames = {};
  for (const entry of files) {
    const file = requireObject(entry, 'files[]', batch);
    const id = frameIdOf(requireString(file.file, 'files[].file', batch));
    const ink = toNativeBbox(null, file.bbox, factor, batch, `files[${id}]`);
    const foot = Array.isArray(manifest.contactPoints?.foot) ? Number(manifest.contactPoints.foot[0]) : Number.NaN;
    frames[id] = {
      id,
      facing,
      sourceFile: requireString(file.file, 'files[].file', batch),
      inkNative: ink,
      anchorNative: anchor.byFacing[String(facing)],
      airborneGapNative: 0,
      supportFootX: Number.isFinite(foot) ? foot / factor : null,
    };
  }
  const timing = FRAME_TIMING[batch];
  const frameIds = Object.keys(frames);
  if (frameIds.length !== 1) {
    throw new PoseAdapterError(
      `legacy-v1 只支持单帧静姿批，实际有 ${frameIds.length} 帧（多帧请改用显式 adapter）`,
      batch,
    );
  }
  const holdMs = Number.isFinite(timing?.hold) ? timing.hold : 0;
  return {
    posture: batch,
    assetId: requireString(manifest.assetId, 'assetId', batch),
    status: requireString(manifest.status, 'status', batch),
    masterScale: factor,
    canvas: { width: requireNumber(canvas.width, 'canvas.width', batch), height: requireNumber(canvas.height, 'canvas.height', batch) },
    nativeCanvas: {
      width: requireNumber(nativeCanvas.width, 'nativeSourceCanvas.width', batch),
      height: requireNumber(nativeCanvas.height, 'nativeSourceCanvas.height', batch),
    },
    bodyAnchor: {
      byFacing: anchor.byFacing,
      byFacingSource: anchor.byFacingSource,
      spreadNative: anchor.spreadNative,
      maxDeviationNative: anchor.maxDeviationNative,
    },
    frames,
    clips: [{ id: 'hold', facing, frames: frameIds, loop: false, frameMs: [holdMs], onEnd: 'hold-last' }],
    consumedKeys: ['canvas', 'nativeSourceCanvas', 'masterScale.factor', 'bodyAnchor.x', 'bodyAnchor.y', 'files[].file', 'files[].bbox', 'contactPoints.foot'],
    aliasesResolved: [],
    warnings: anchor.warnings,
  };
}

/**
 * 归一化 `files-sequences-v2`（`lie`）：`files[]` + `sequences` + `aliases`。
 *
 * <p>`aliases` 是权威的等价关系（7 个帧位只有 3 张不同像素），必须真的用上：
 * 否则导出量凭空翻一倍（省 57%）。这里把被别名的帧指向目标文件的像素。</p>
 *
 * @param {Record<string, unknown>} manifest 美术 manifest
 * @param {string} batch 批次名
 * @returns {Record<string, unknown>} 归一后的批次草稿
 */
function adaptFilesSequencesV2(manifest, batch) {
  const canvas = requireObject(manifest.canvas, 'canvas', batch);
  const nativeCanvas = requireObject(manifest.nativeSourceCanvas, 'nativeSourceCanvas', batch);
  const factor = masterScaleOf(manifest.masterScale, batch);
  const files = requireArray(manifest.files, 'files', batch);
  const nativeWidth = requireNumber(nativeCanvas.width, 'nativeSourceCanvas.width', batch);
  const anchor = normalizeBodyAnchor(manifest, nativeWidth, batch);
  const aliasesRaw = manifest.aliases === undefined ? {} : requireObject(manifest.aliases, 'aliases', batch);
  const aliases = {};
  for (const [from, to] of Object.entries(aliasesRaw)) {
    aliases[from] = requireString(to, `aliases['${from}']`, batch);
  }
  const facing = -1;
  /** 源文件名 → native bbox（解析别名用）。 */
  const inkByFile = {};
  for (const entry of files) {
    const file = requireObject(entry, 'files[]', batch);
    const name = requireString(file.file, 'files[].file', batch);
    inkByFile[name] = toNativeBbox(null, file.bbox, factor, batch, `files[${name}]`);
  }
  const resolveAlias = (name) => {
    let current = name;
    const seen = new Set();
    while (aliases[current] !== undefined) {
      if (seen.has(current)) throw new PoseAdapterError(`aliases 出现环：${[...seen].join(' → ')} → ${current}`, batch);
      seen.add(current);
      current = aliases[current];
    }
    return current;
  };
  const frames = {};
  const aliasesResolved = [];
  for (const entry of files) {
    const file = requireObject(entry, 'files[]', batch);
    const name = requireString(file.file, 'files[].file', batch);
    const target = resolveAlias(name);
    if (target !== name) aliasesResolved.push(`${name} → ${target}`);
    const ink = inkByFile[target];
    if (!ink) {
      throw new PoseAdapterError(`aliases['${name}'] 指向不存在的文件 ${target}`, batch);
    }
    const id = frameIdOf(name);
    frames[id] = {
      id,
      facing,
      sourceFile: target,
      inkNative: { ...ink },
      anchorNative: anchor.byFacing[String(facing)],
      airborneGapNative: 0,
      supportFootX: null,
    };
  }
  const sequences = requireObject(manifest.sequences, 'sequences', batch);
  const clipSpecs = [
    { sequence: 'down', clip: 'enter', onEnd: 'hold-last' },
    { sequence: 'neutral', clip: 'hold', onEnd: 'hold-last' },
    { sequence: 'up', clip: 'exit', onEnd: 'return-stand' },
  ];
  const clips = [];
  for (const spec of clipSpecs) {
    const list = sequences[spec.sequence];
    if (list === undefined) continue;
    const names = requireArray(list, `sequences.${spec.sequence}`, batch);
    const frameIds = names.map((item) => {
      const id = frameIdOf(requireString(item, `sequences.${spec.sequence}[]`, batch));
      if (!frames[id]) {
        throw new PoseAdapterError(`sequences.${spec.sequence} 引用了 files 里没有的帧 ${id}`, batch);
      }
      return id;
    });
    const ms = FRAME_TIMING[batch]?.[spec.clip] ?? 120;
    clips.push({
      id: spec.clip,
      facing,
      frames: frameIds,
      loop: false,
      frameMs: frameIds.map(() => ms),
      onEnd: spec.onEnd,
    });
  }
  if (clips.length === 0) throw new PoseAdapterError('sequences 里没有可播片段（down/neutral/up 全缺）', batch);
  return {
    posture: batch,
    assetId: requireString(manifest.assetId, 'assetId', batch),
    status: requireString(manifest.status, 'status', batch),
    masterScale: factor,
    canvas: { width: requireNumber(canvas.width, 'canvas.width', batch), height: requireNumber(canvas.height, 'canvas.height', batch) },
    nativeCanvas: { width: nativeWidth, height: requireNumber(nativeCanvas.height, 'nativeSourceCanvas.height', batch) },
    bodyAnchor: {
      byFacing: anchor.byFacing,
      byFacingSource: anchor.byFacingSource,
      spreadNative: anchor.spreadNative,
      maxDeviationNative: anchor.maxDeviationNative,
    },
    frames,
    clips,
    consumedKeys: ['canvas', 'nativeSourceCanvas', 'masterScale.factor', 'bodyAnchor.x', 'bodyAnchor.y', 'files[].file', 'files[].bbox', 'sequences.down', 'sequences.neutral', 'sequences.up', 'aliases'],
    aliasesResolved,
    warnings: anchor.warnings,
  };
}

/**
 * 归一化 `frames-nested-v3`（`sleep/walk/run/jump`）。
 *
 * <p>帧内 bbox 有三个候选（扁平 `bbox` 母版 / `master.bbox` 母版 / `native.bbox` native），
 * 取序固定为 **native → master → 扁平**：native 是实测原生，母版是它的 2× 最近邻放大，
 * 两者差 0.5 native（≈0.08 CSS），但"用哪个"必须定死，否则包络断言会在 0.1px 上抖。</p>
 *
 * @param {Record<string, unknown>} manifest 美术 manifest
 * @param {string} batch 批次名
 * @returns {Record<string, unknown>} 归一后的批次草稿
 */
function adaptFramesNestedV3(manifest, batch) {
  const canvas = requireObject(manifest.canvas, 'canvas', batch);
  const nativeCanvas = requireObject(manifest.nativeSourceCanvas, 'nativeSourceCanvas', batch);
  const factor = masterScaleOf(manifest.masterScale, batch);
  const nativeWidth = requireNumber(nativeCanvas.width, 'nativeSourceCanvas.width', batch);
  const anchor = normalizeBodyAnchor(manifest, nativeWidth, batch);
  const rawFrames = requireArray(manifest.frames, 'frames', batch);
  const defaultFacing = Number.isFinite(Number(manifest.bodyAnchor?.facing)) ? Number(manifest.bodyAnchor.facing) : -1;
  const frames = {};
  const ordered = [];
  for (const entry of rawFrames) {
    const file = requireObject(entry, 'frames[]', batch);
    const id = requireString(file.id, 'frames[].id', batch);
    if (frames[id]) throw new PoseAdapterError(`frames[] 出现重复 id ${id}`, batch);
    const facingRaw = file.facing === undefined ? defaultFacing : Number(file.facing);
    if (facingRaw !== -1 && facingRaw !== 1) {
      throw new PoseAdapterError(`frames[${id}].facing 只能是 -1 或 1，实际为 ${String(file.facing)}`, batch);
    }
    const facing = facingRaw === 1 ? 1 : -1;
    const masterBbox = file.master && file.master.bbox ? file.master.bbox : file.bbox;
    const nativeBbox = file.native && file.native.bbox ? file.native.bbox : null;
    if (!masterBbox && !nativeBbox) {
      throw new PoseAdapterError(`frames[${id}] 既没有 master.bbox 也没有 bbox/native.bbox：无处取墨迹`, batch);
    }
    const ink = toNativeBbox(nativeBbox, masterBbox ?? nativeBbox, factor, batch, `frames[${id}]`);
    const gapRaw = file.contactPoints?.airborneGap;
    // 美术用 `airborneGap: null` 表达"该帧贴地"（support 有值、双脚最低墨迹就在地面线上）。
    // 运行时的同一件事是数值 0：基线扣减公式 `top + gap` 里 null 会被弱化成 NaN 或跳过，
    // 而 G-14 要求 anticipate/land 的值为 0 —— 所以在 adapter 这一层就把语义定死。
    const gap =
      gapRaw === null || gapRaw === undefined
        ? 0
        : requireNumber(gapRaw, `frames[${id}].contactPoints.airborneGap`, batch);
    const supportRaw = file.contactPoints?.support?.centerX;
    frames[id] = {
      id,
      facing,
      sourceFile: requireString(file.file, 'frames[].file', batch),
      inkNative: ink,
      anchorNative: anchor.byFacing[String(facing)],
      airborneGapNative: gap,
      supportFootX: supportRaw === undefined ? null : requireNumber(supportRaw, `frames[${id}].contactPoints.support.centerX`, batch),
    };
    ordered.push(frames[id]);
  }
  const timing = FRAME_TIMING[batch];
  if (!timing) throw new PoseAdapterError(`没有为批次 ${batch} 定义帧时长（FRAME_TIMING 缺项）`, batch);
  const ids = Object.keys(timing);
  if (ids.length !== 1) throw new PoseAdapterError(`frames-nested-v3 期望单一片段，实际 ${ids.join(',')}`, batch);
  const clipId = ids[0];
  const loop = batch === 'walk' || batch === 'run' || batch === 'sleep';
  const onEnd = batch === 'jump' ? 'return-stand' : 'hold-last';
  return {
    posture: batch,
    assetId: requireString(manifest.assetId, 'assetId', batch),
    status: requireString(manifest.status, 'status', batch),
    masterScale: factor,
    canvas: { width: requireNumber(canvas.width, 'canvas.width', batch), height: requireNumber(canvas.height, 'canvas.height', batch) },
    nativeCanvas: { width: nativeWidth, height: requireNumber(nativeCanvas.height, 'nativeSourceCanvas.height', batch) },
    bodyAnchor: {
      byFacing: anchor.byFacing,
      byFacingSource: anchor.byFacingSource,
      spreadNative: anchor.spreadNative,
      maxDeviationNative: anchor.maxDeviationNative,
    },
    frames,
    clips: buildClips(clipId, ordered, loop, timing[clipId], loop ? undefined : onEnd),
    consumedKeys: ['canvas', 'nativeSourceCanvas', 'masterScale', 'bodyAnchor.x', 'bodyAnchor.y', 'bodyAnchor.byFacing', 'frames[].id', 'frames[].facing', 'frames[].file', 'frames[].master.bbox', 'frames[].native.bbox', 'frames[].contactPoints.airborneGap', 'frames[].contactPoints.support.centerX'],
    aliasesResolved: [],
    warnings: anchor.warnings,
  };
}

/**
 * 按批次跑对应的 adapter，并**核对 `BATCH_SPECS` 的登记**（结构漂移即硬失败）。
 *
 * @param {Record<string, unknown>} manifest 美术 manifest
 * @param {{posture: string, adapter: string}} spec 登记项
 * @returns {Record<string, unknown>} 归一后的批次草稿
 */
export function adaptBatch(manifest, spec) {
  const batch = spec.posture;
  const detected = detectAdapter(manifest, batch);
  if (detected !== spec.adapter) {
    throw new PoseAdapterError(
      `结构识别结果是 ${detected}，但 BATCH_SPECS 登记的是 ${spec.adapter}：manifest 结构漂移了，` +
        '必须显式确认后改登记（不许按"能跑就行"放行）',
      batch,
    );
  }
  const declaredBatch = manifest.batch;
  if (declaredBatch !== undefined && declaredBatch !== batch) {
    throw new PoseAdapterError(`manifest.batch=${String(declaredBatch)} 与目录名 ${batch} 不一致`, batch);
  }
  if (spec.adapter === 'legacy-v1') return adaptLegacyV1(manifest, batch);
  if (spec.adapter === 'files-sequences-v2') return adaptFilesSequencesV2(manifest, batch);
  return adaptFramesNestedV3(manifest, batch);
}

/**
 * 计算源 manifest 的 sha256（漂移检测的锚）。
 *
 * @param {string} absolutePath manifest 绝对路径
 * @returns {string} 小写十六进制 sha256
 */
export function sha256OfFile(absolutePath) {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

/**
 * 读入并归一化全部批次。
 *
 * <p>返回**草稿**（还没有 webp 文件信息），由 `build-pet-poses.mjs` 决定哪些要转码、
 * 哪些只记降级原因。`missing` 里的批次不算错误（美术未交付是合法中间态），
 * 但 `problems`（结构漂移、字段缺失）必须让构建红。</p>
 *
 * @param {object} [options] 选项
 * @param {string} options.repoRoot 仓库根（绝对路径）
 * @param {string[]} [options.accepted] 可播清单（默认 {@link ACCEPTED_BATCHES}）
 * @param {(message: string) => void} [options.log] 日志出口
 * @returns {{drafts: Record<string, Record<string, unknown>>, deferred: Array<{posture:string, reason:string, status:string|null, warnings:string[]}>, missing: string[], problems: string[]}}
 *   归一结果
 */
export function adaptAll(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const accepted = Array.isArray(options.accepted) ? options.accepted : [...ACCEPTED_BATCHES];
  const repoRoot = requireString(options.repoRoot, 'adaptAll.repoRoot', 'adaptAll');
  const drafts = {};
  const deferred = [];
  const missing = [];
  const problems = [];
  for (const spec of BATCH_SPECS) {
    const dir = resolve(repoRoot, SOURCE_ROOT, spec.posture);
    const manifestPath = resolve(dir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      missing.push(spec.posture);
      log(`[pet-poses] 跳过 ${spec.posture}：${manifestPath} 不存在（资产未交付）`);
      continue;
    }
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const draft = adaptBatch(manifest, spec);
      draft.provenance = {
        adapter: spec.adapter,
        manifestSha256: sha256OfFile(manifestPath),
        consumedKeys: draft.consumedKeys,
        aliasesResolved: draft.aliasesResolved,
      };
      if (accepted.includes(spec.posture)) {
        drafts[spec.posture] = draft;
        for (const warning of draft.warnings ?? []) log(`[pet-poses] 注意 ${spec.posture}：${warning}`);
      } else {
        deferred.push({
          posture: spec.posture,
          reason: DEFERRED_REASONS[spec.posture] ?? '未登记 accepted',
          status: draft.status,
          warnings: draft.warnings ?? [],
        });
        log(`[pet-poses] ${spec.posture} 暂不导出（deferred）：${DEFERRED_REASONS[spec.posture] ?? '未登记 accepted'}`);
      }
    } catch (err) {
      const message = err instanceof PoseAdapterError ? err.message : `${spec.posture}: ${(err && err.message) || err}`;
      problems.push(message);
      log(`[pet-poses] 失败 ${message}`);
    }
  }
  problems.push(...detectUnregisteredBatches(repoRoot, log));
  return { drafts, deferred, missing, problems };
}

/**
 * 找出源目录里**未在 {@link BATCH_SPECS} 登记**的批次目录（QA 盲区 B-5）。
 *
 * <p><b>守的是什么：</b>美术新交一批资产（`docs/assets/desktop-pet/poses/<new>/manifest.json`）时，
 * 如果构建只遍历 `BATCH_SPECS`，那批会被**静默忽略**——构建成功、`--check` 成功、
 * 运行时空清单，于是"美术交了、工程说没收到"这种扯皮又出现一次。所以这里反向扫目录：
 * 只要 `poses/` 下出现未登记的子目录，就报问题让构建红。</p>
 *
 * <p>为什么算 `problems` 而不是 `warnings`：这不是"可以用但要注意"的降级
 * （不登记 ⇒ 永远不进清单），必须有人去 `BATCH_SPECS` 补一行登记或删掉目录。</p>
 *
 * @param {string} repoRoot 仓库根
 * @param {(message: string) => void} log 日志出口
 * @returns {string[]} 问题列表（每个未登记目录一条）
 */
function detectUnregisteredBatches(repoRoot, log) {
  const problems = [];
  const posesRoot = resolve(repoRoot, SOURCE_ROOT);
  if (!existsSync(posesRoot)) return problems;
  const registered = new Set(BATCH_SPECS.map((spec) => spec.posture));
  let entries;
  try {
    entries = readdirSync(posesRoot, { withFileTypes: true });
  } catch (err) {
    return [`[pet-poses] 无法枚举源目录 ${posesRoot}：${(err && err.message) || err}`];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (registered.has(entry.name)) continue;
    const hasManifest = existsSync(resolve(posesRoot, entry.name, 'manifest.json'));
    const message =
      `[pet-poses] 源目录 ${SOURCE_ROOT}/${entry.name} 是未登记批次` +
      `（${hasManifest ? '有 manifest.json 但 BATCH_SPECS 里没有该姿态' : '没有 manifest.json，也不是已知姿态'}）：` +
      '新批次必须先在 scripts/pet-pose-adapters.mjs 的 BATCH_SPECS 里登记 adapter，' +
      '否则资产永远进不了 pet-poses.json（构建成功但运行时空清单）';
    problems.push(message);
    log(message);
  }
  return problems;
}
