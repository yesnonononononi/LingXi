/**
 * sequence 运行资产门禁（G-S1…G-S3）。
 *
 * <p><b>为什么序列需要自己的一套门禁：</b>pose 的门禁守的是"身体像素"（包络 / 时序 / 域），
 * 序列守的是"<b>编排</b>"——哪一步放哪一帧、时序是否真的往前走、清单与盘是否逐字节对齐。
 * 这两类问题的失败形态完全不同：pose 错了是"裁边/不跳脚"，序列错了是"云在空中卡住"
 * 或者"清单说有 8 步，运行时只演了 7 步"。所以判据必须分开写。</p>
 *
 * <h2>三条判据</h2>
 * <ul>
 *   <li><b>G-S1 清单与磁盘对齐</b>：缺文件 / 多文件 / 体积 / sha256 / 编码格式（必须
 *       `webp-lossless`）/ 像素尺寸，逐项比对；口径与 pose 侧同构（都是"清单是唯一真源，
 *       盘上不许有它没登记的东西"）；</li>
 *   <li><b>G-S2 编排完整性</b>：每步引用的 frameId 必须存在、时序严格单调递增
 *       （`ms > 0` 且前缀和单调）、`loop` / `onEnd` 语义自洽、层序与层几何自洽；</li>
 *   <li><b>G-S3 预算</b>：`SEQUENCE_TOTAL_MAX_BYTES`（真源 `scripts/pet-budget.mjs`）。</li>
 * </ul>
 *
 * <p><b>防空集通过</b>：清单里一个场景都没有、或某场景一步都没有，一律判红——
 * "没东西可查"不等于"查过了没问题"（本仓已有两次因此返工）。</p>
 *
 * <p>用法：</p>
 * <pre>
 *   node scripts/check-pet-sequences.mjs            # 门禁
 *   node scripts/check-pet-sequences.mjs --verbose  # 打印每条判据
 * </pre>
 *
 * @module scripts/check-pet-sequences
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DENSITIES,
  DEFAULT_SEQUENCE_OUT_DIR,
  GENERATED_BY,
  SEQUENCES_JSON_PATH,
  SEQUENCE_URL_HOST,
  runBuildSequences,
} from './build-pet-sequences.mjs';
import { SEQUENCE_TOTAL_MAX_BYTES } from './pet-budget.mjs';

/** 序列帧**唯一允许**的编码格式（与 pose 同口径：无损）。 */
export const LOSSLESS_FORMAT = 'webp-lossless';

/** 合法的层 kind。 */
export const LAYER_KINDS = Object.freeze(['pose-frames', 'sequence-frames']);

/** 合法的 `onEnd` 取值（`null` 表示"循环场景不该声明收尾"）。 */
export const SCENE_ENDS = Object.freeze(['return-stand', 'hold-last']);

/** 合法的层 id。 */
export const LAYER_IDS = Object.freeze(['protagonist', 'companion', 'hands']);

/**
 * 清单里允许出现的键（构建期这一侧的正向白名单）。
 *
 * <p>运行时（`src/pet/sequences/manifest.ts`）有一份**逐项相等**的副本，并由
 * `tests/petSequenceManifest.test.ts` 做对账——本轮不允许新增 `pet-sequences.schema.json`
 * （文件白名单），所以用"两份实现 + 一条对账用例"替代"一份 JSON 真源"。</p>
 */
export const SEQUENCE_SCHEMA_KEYS = Object.freeze({
  root: Object.freeze([
    'version',
    'generatedBy',
    'sourceRoot',
    'scale',
    'stage',
    'layers',
    'scenes',
    'frames',
    'totals',
    'provenance',
    'deferred',
  ]),
  scale: Object.freeze(['stageToCss']),
  stage: Object.freeze(['width', 'height']),
  layer: Object.freeze(['id', 'kind', 'canvas', 'sourceCanvas', 'anchor', 'grip']),
  size: Object.freeze(['width', 'height']),
  point: Object.freeze(['x', 'y']),
  scene: Object.freeze(['loop', 'onEnd', 'steps']),
  step: Object.freeze(['ms', 'frames', 'companionCenterX', 'companionFootY', 'companionDy', 'phase']),
  frame: Object.freeze(['layer', 'slot', 'width', 'height', 'bytes', 'sha256', 'format', 'url']),
  totals: Object.freeze(['scenes', 'steps', 'bytes1x', 'bytes2x', 'durationMs']),
  provenance: Object.freeze(['adapter', 'manifestSha256', 'consumedKeys']),
  deferred: Object.freeze(['scene', 'reason']),
});

/**
 * 断言对象是普通对象（不可信输入的第一道）。
 *
 * @param {unknown} value 待检查值
 * @returns {boolean} 是否普通对象
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 收集一个对象里未在白名单登记的键。
 *
 * @param {unknown} value 对象
 * @param {readonly string[]} allowed 允许的键
 * @param {string} path 路径（报错用）
 * @param {string[]} out 收集器
 */
function collectUnknownKeys(value, allowed, path, out) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value))) {
    if (!allowed.includes(key)) out.push(`${path}.${key} 出现未声明的键（只允许：${allowed.join(' / ')}）`);
  }
}

/**
 * 校验整份清单没有 schema 未声明的键（G-S2 的一部分）。
 *
 * @param {unknown} manifest 清单
 * @returns {string[]} 问题列表
 */
export function checkUnknownKeys(manifest) {
  if (!isPlainObject(manifest)) return ['清单不是对象，无法校验 schema 键'];
  const record = /** @type {Record<string, any>} */ (manifest);
  const problems = [];
  collectUnknownKeys(record, SEQUENCE_SCHEMA_KEYS.root, 'manifest', problems);
  collectUnknownKeys(record.scale, SEQUENCE_SCHEMA_KEYS.scale, 'manifest.scale', problems);
  collectUnknownKeys(record.stage, SEQUENCE_SCHEMA_KEYS.stage, 'manifest.stage', problems);
  collectUnknownKeys(record.totals, SEQUENCE_SCHEMA_KEYS.totals, 'manifest.totals', problems);
  collectUnknownKeys(record.provenance, SEQUENCE_SCHEMA_KEYS.provenance, 'manifest.provenance', problems);
  for (const [index, layer] of (Array.isArray(record.layers) ? record.layers : []).entries()) {
    const path = `manifest.layers[${index}]`;
    collectUnknownKeys(layer, SEQUENCE_SCHEMA_KEYS.layer, path, problems);
    if (!isPlainObject(layer)) {
      problems.push(`${path} 不是对象`);
      continue;
    }
    collectUnknownKeys(layer.canvas, SEQUENCE_SCHEMA_KEYS.size, `${path}.canvas`, problems);
    collectUnknownKeys(layer.sourceCanvas, SEQUENCE_SCHEMA_KEYS.size, `${path}.sourceCanvas`, problems);
    collectUnknownKeys(layer.anchor, SEQUENCE_SCHEMA_KEYS.point, `${path}.anchor`, problems);
    collectUnknownKeys(layer.grip, SEQUENCE_SCHEMA_KEYS.point, `${path}.grip`, problems);
  }
  for (const [sceneId, scene] of Object.entries(isPlainObject(record.scenes) ? record.scenes : {})) {
    const path = `manifest.scenes.${sceneId}`;
    collectUnknownKeys(scene, SEQUENCE_SCHEMA_KEYS.scene, path, problems);
    const steps = isPlainObject(scene) && Array.isArray(scene.steps) ? scene.steps : [];
    steps.forEach((step, index) => collectUnknownKeys(step, SEQUENCE_SCHEMA_KEYS.step, `${path}.steps[${index}]`, problems));
  }
  for (const [key, frame] of Object.entries(isPlainObject(record.frames) ? record.frames : {})) {
    collectUnknownKeys(frame, SEQUENCE_SCHEMA_KEYS.frame, `manifest.frames.${key}`, problems);
  }
  for (const [index, item] of (Array.isArray(record.deferred) ? record.deferred : []).entries()) {
    collectUnknownKeys(item, SEQUENCE_SCHEMA_KEYS.deferred, `manifest.deferred[${index}]`, problems);
  }
  return problems;
}

/**
 * 校验层表（z 序即数组下标）与层几何。
 *
 * @param {Record<string, any>} manifest 清单
 * @returns {string[]} 问题列表
 */
export function checkLayers(manifest) {
  const problems = [];
  const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
  if (layers.length === 0) {
    problems.push('清单里没有任何层（layers 为空）：叠放序没有真源，运行时无从摆放');
    return problems;
  }
  const seen = new Set();
  for (const [index, layer] of layers.entries()) {
    if (!isPlainObject(layer)) {
      problems.push(`layers[${index}] 不是对象`);
      continue;
    }
    const id = String(layer.id ?? '');
    if (!LAYER_IDS.includes(id)) {
      problems.push(`layers[${index}].id=${JSON.stringify(layer.id)} 不是合法层 id（允许：${LAYER_IDS.join(' / ')}）`);
      continue;
    }
    if (seen.has(id)) problems.push(`层 ${id} 重复登记（同一层不许出现两次，否则 z 序无解）`);
    seen.add(id);
    if (!LAYER_KINDS.includes(String(layer.kind))) {
      problems.push(`层 ${id}.kind=${JSON.stringify(layer.kind)} 不是合法来源（允许：${LAYER_KINDS.join(' / ')}）`);
    }
    if (layer.kind === 'sequence-frames') {
      const canvas = layer.canvas ?? {};
      const sourceCanvas = layer.sourceCanvas ?? {};
      for (const [name, box] of [['canvas', canvas], ['sourceCanvas', sourceCanvas]]) {
        if (!(Number(box.width) > 0) || !(Number(box.height) > 0)) {
          problems.push(`层 ${id}.${name} 必须是正尺寸，实际 ${JSON.stringify(box)}`);
        }
      }
      const anchor = layer.anchor ?? {};
      if (!Number.isFinite(Number(anchor.x)) || !Number.isFinite(Number(anchor.y))) {
        problems.push(`层 ${id}.anchor 必须是有限数值（舞台域的对齐锚），实际 ${JSON.stringify(anchor)}`);
      } else if (Number(anchor.x) > Number(sourceCanvas.width) || Number(anchor.y) > Number(sourceCanvas.height)) {
        problems.push(
          `层 ${id}.anchor=(${anchor.x}, ${anchor.y}) 越出 sourceCanvas ` +
            `(${sourceCanvas.width}×${sourceCanvas.height})：锚点与画布不同域（这是四倍偏差那个坑）`,
        );
      }
      if (layer.grip !== undefined) {
        const grip = layer.grip;
        if (!Number.isFinite(Number(grip.x)) || !Number.isFinite(Number(grip.y))) {
          problems.push(`层 ${id}.grip 必须是有限数值，实际 ${JSON.stringify(grip)}`);
        } else if (Number(grip.y) > Number(anchor.y)) {
          problems.push(`层 ${id}.grip.y=${grip.y} 低于 anchor.y=${anchor.y}：握持点必须在画布上方（否则 gripStage 算到脚底下）`);
        }
      }
    }
  }
  return problems;
}

/**
 * 校验注册表里的帧条目（G-S1 的清单侧）。
 *
 * @param {Record<string, any>} manifest 清单
 * @returns {string[]} 问题列表
 */
export function checkFrameRegistry(manifest) {
  const problems = [];
  const frames = isPlainObject(manifest.frames) ? manifest.frames : {};
  const keys = Object.keys(frames);
  if (keys.length === 0) {
    problems.push('清单的 frames 为空：没有登记任何运行帧（空表不是"合法中间态"，是本切片的核心产物缺失）');
    return problems;
  }
  const layerIds = new Set((Array.isArray(manifest.layers) ? manifest.layers : []).map((layer) => String(layer?.id ?? '')));
  let bytes1x = 0;
  let bytes2x = 0;
  for (const [key, frame] of Object.entries(frames)) {
    const path = `frames.${key}`;
    if (!isPlainObject(frame)) {
      problems.push(`${path} 不是对象`);
      continue;
    }
    const match = /^([^/]+)\/([^/@]+)@(1x|2x)\.webp$/.exec(key);
    if (!match) {
      problems.push(`${path} 的键不是 <scene>/<slot>@<density>.webp 形态（实际 ${key}）：盘上路径无从推导`);
      continue;
    }
    const [, sceneId, slot, density] = match;
    if (!DENSITIES.includes(density)) problems.push(`${path} 的密度档 ${density} 非法`);
    if (layerIds.size > 0 && !layerIds.has(String(frame.layer))) {
      problems.push(`${path}.layer=${JSON.stringify(frame.layer)} 不在 layers 里`);
    }
    if (String(frame.slot) !== slot) {
      problems.push(`${path}.slot=${JSON.stringify(frame.slot)} 与键里的 slot「${slot}」不一致（两者必须是同一个名字）`);
    }
    if (!(Number(frame.width) > 0) || !(Number(frame.height) > 0)) {
      problems.push(`${path} 的 width/height 必须是正数，实际 ${frame.width}×${frame.height}`);
    }
    if (!(Number(frame.bytes) > 0)) problems.push(`${path}.bytes=${frame.bytes} 必须 > 0`);
    if (!/^[0-9a-f]{64}$/.test(String(frame.sha256))) problems.push(`${path}.sha256 必须是 64 位小写十六进制`);
    if (frame.format !== LOSSLESS_FORMAT) {
      problems.push(`${path}.format=${JSON.stringify(frame.format)} 必须是 ${LOSSLESS_FORMAT}（有损会让边缘半透明被切）`);
    }
    const expectedUrl = `lxa://${SEQUENCE_URL_HOST}/${sceneId}/${slot}@${density}.webp`;
    if (frame.url !== expectedUrl) {
      problems.push(`${path}.url=${JSON.stringify(frame.url)} 与键推导出的 ${expectedUrl} 不一致`);
    }
    if (density === '1x') bytes1x += Number(frame.bytes);
    else bytes2x += Number(frame.bytes);
  }
  const totals = isPlainObject(manifest.totals) ? manifest.totals : {};
  if (Number(totals.bytes1x) !== bytes1x) {
    problems.push(`totals.bytes1x=${totals.bytes1x} 与逐帧累加 ${bytes1x} 不一致（totals 不自证）`);
  }
  if (Number(totals.bytes2x) !== bytes2x) {
    problems.push(`totals.bytes2x=${totals.bytes2x} 与逐帧累加 ${bytes2x} 不一致（totals 不自证）`);
  }
  return problems;
}

/**
 * 校验编排（G-S2）：帧引用存在、时序单调递增、loop / onEnd 自洽。
 *
 * @param {Record<string, any>} manifest 清单
 * @returns {string[]} 问题列表
 */
export function checkScenes(manifest) {
  const problems = [];
  const scenes = isPlainObject(manifest.scenes) ? manifest.scenes : {};
  const sceneIds = Object.keys(scenes);
  if (sceneIds.length === 0) {
    problems.push('清单里没有任何场景（scenes 为空）：序列资产至少要有 1 个可播场景');
    return problems;
  }
  const layerIds = (Array.isArray(manifest.layers) ? manifest.layers : []).map((layer) => String(layer?.id ?? ''));
  const frames = isPlainObject(manifest.frames) ? manifest.frames : {};
  const totals = isPlainObject(manifest.totals) ? manifest.totals : {};
  let stepTotal = 0;
  let durationMs = 0;

  for (const [sceneId, scene] of Object.entries(scenes)) {
    const path = `scenes.${sceneId}`;
    if (!isPlainObject(scene)) {
      problems.push(`${path} 不是对象`);
      continue;
    }
    const loop = scene.loop === true;
    const onEnd = scene.onEnd === undefined ? null : scene.onEnd;
    // loop / onEnd 语义自洽：循环场景永远不会"播完"，声明收尾就是自相矛盾
    if (loop && onEnd !== null) {
      problems.push(`${path}：loop=true 却声明了 onEnd=${JSON.stringify(onEnd)}（循环场景没有"播完"这回事）`);
    }
    if (!loop && onEnd === null) {
      problems.push(`${path}：loop=false 必须显式声明 onEnd（${SCENE_ENDS.join(' / ')}），否则"播完去哪"无人回答`);
    }
    if (!loop && onEnd !== null && !SCENE_ENDS.includes(String(onEnd))) {
      problems.push(`${path}.onEnd=${JSON.stringify(onEnd)} 不是合法取值（允许：${SCENE_ENDS.join(' / ')}）`);
    }
    const steps = Array.isArray(scene.steps) ? scene.steps : [];
    if (steps.length === 0) {
      problems.push(`${path} 没有任何 step（空序列不是可播放内容）`);
      continue;
    }
    let elapsed = 0;
    for (const [index, step] of steps.entries()) {
      const stepPath = `${path}.steps[${index}]`;
      if (!isPlainObject(step)) {
        problems.push(`${stepPath} 不是对象`);
        continue;
      }
      const ms = Number(step.ms);
      // 时序单调递增：ms 必须是正数，前缀和才会严格递增（0 会让调度器原地空转，负数是倒流）
      if (!Number.isFinite(ms) || ms <= 0) {
        problems.push(`${stepPath}.ms=${JSON.stringify(step.ms)} 必须是正的有限数值（时序必须单调递增）`);
      } else if (elapsed + ms <= elapsed) {
        problems.push(`${stepPath}.ms=${ms} 让累计时长不再递增（${elapsed} → ${elapsed + ms}）`);
      } else {
        elapsed += ms;
      }
      const frameRefs = isPlainObject(step.frames) ? step.frames : {};
      if (Object.keys(frameRefs).length === 0) {
        problems.push(`${stepPath}.frames 为空：这一步既不显示主角也不显示伙伴，等于一段黑场`);
      }
      for (const [layerId, slot] of Object.entries(frameRefs)) {
        if (layerIds.length > 0 && !layerIds.includes(layerId)) {
          problems.push(`${stepPath}.frames.${layerId} 引用了未在 layers 里声明的层`);
          continue;
        }
        if (slot === null) continue;
        if (typeof slot !== 'string' || slot.length === 0) {
          problems.push(`${stepPath}.frames.${layerId}=${JSON.stringify(slot)} 必须是非空 slot 名或 null`);
          continue;
        }
        for (const density of DENSITIES) {
          const key = `${sceneId}/${slot}@${density}.webp`;
          if (frames[key] === undefined) {
            problems.push(`${stepPath}.frames.${layerId} 引用了不存在的帧 ${key}（查不到 = 判红，不许跳过）`);
          }
        }
      }
      for (const coordinate of ['companionCenterX', 'companionFootY', 'companionDy']) {
        if (step[coordinate] === undefined) continue;
        if (!Number.isFinite(Number(step[coordinate]))) {
          problems.push(`${stepPath}.${coordinate}=${JSON.stringify(step[coordinate])} 必须是有限数值`);
        }
      }
    }
    stepTotal += steps.length;
    durationMs += elapsed;
  }

  if (Number(totals.steps) !== stepTotal) {
    problems.push(`totals.steps=${totals.steps} 与逐场景累加 ${stepTotal} 不一致（totals 不自证）`);
  }
  if (Number(totals.scenes) !== sceneIds.length) {
    problems.push(`totals.scenes=${totals.scenes} 与实际场景数 ${sceneIds.length} 不一致`);
  }
  if (Number(totals.durationMs) !== durationMs) {
    problems.push(`totals.durationMs=${totals.durationMs} 与逐步累加 ${durationMs} 不一致（时长必须可自证）`);
  }

  // deferred 与 scenes 不许两处都出现同一个场景（"登记了却没做"必须只有一种说法）
  const deferred = Array.isArray(manifest.deferred) ? manifest.deferred : [];
  for (const [index, item] of deferred.entries()) {
    const name = String(item?.scene ?? '');
    if (name.length === 0) problems.push(`deferred[${index}].scene 为空`);
    else if (scenes[name] !== undefined) problems.push(`deferred[${index}] 里的 ${name} 同时出现在 scenes 里（"没做"与"做了"不能同时成立）`);
    if (String(item?.reason ?? '').length === 0) problems.push(`deferred[${index}].reason 为空：降级必须说明理由`);
  }
  return problems;
}

/**
 * G-S3：预算与元信息自证。
 *
 * @param {Record<string, any>} manifest 清单
 * @returns {string[]} 问题列表
 */
export function checkVolume(manifest) {
  const problems = [];
  const totals = isPlainObject(manifest.totals) ? manifest.totals : {};
  const bytes1x = Number(totals.bytes1x);
  const bytes2x = Number(totals.bytes2x);
  if (!Number.isFinite(bytes1x) || !Number.isFinite(bytes2x)) {
    problems.push('totals.bytes1x / totals.bytes2x 不是有限数值');
    return problems;
  }
  const total = bytes1x + bytes2x;
  if (total > SEQUENCE_TOTAL_MAX_BYTES) {
    problems.push(
      `合计 ${total} B 超过预算 ${SEQUENCE_TOTAL_MAX_BYTES} B（sequence 有独立口袋：不许吃 pose 的 8 MiB 余量）`,
    );
  }
  if (total <= 0) problems.push('合计字节数为 0：没有任何运行资产被导出');
  return problems;
}

/**
 * 校验清单头（版本 / 生成器标识 / 比例）。
 *
 * @param {Record<string, any>} manifest 清单
 * @returns {string[]} 问题列表
 */
export function checkHeader(manifest) {
  const problems = [];
  if (Number(manifest.version) !== 1) problems.push(`version=${JSON.stringify(manifest.version)} 必须是 1`);
  if (manifest.generatedBy !== GENERATED_BY) {
    problems.push(`generatedBy=${JSON.stringify(manifest.generatedBy)} 必须是 ${GENERATED_BY}（手改清单会被这条抓住）`);
  }
  const scale = isPlainObject(manifest.scale) ? manifest.scale : {};
  const stageToCss = Number(scale.stageToCss);
  if (!Number.isFinite(stageToCss) || stageToCss <= 0) {
    problems.push(`scale.stageToCss=${JSON.stringify(scale.stageToCss)} 必须是正的有限数值`);
  }
  const stage = isPlainObject(manifest.stage) ? manifest.stage : {};
  if (!(Number(stage.width) > 0) || !(Number(stage.height) > 0)) {
    problems.push(`stage 必须是正尺寸，实际 ${JSON.stringify(stage)}`);
  }
  const provenance = isPlainObject(manifest.provenance) ? manifest.provenance : {};
  if (!/^[0-9a-f]{64}$/.test(String(provenance.manifestSha256))) {
    problems.push('provenance.manifestSha256 必须是 64 位小写十六进制（漂移检测的锚）');
  }
  if (!Array.isArray(provenance.consumedKeys) || provenance.consumedKeys.length === 0) {
    problems.push('provenance.consumedKeys 为空：字段漂移检测失去依据');
  }
  return problems;
}

/**
 * 母版 PNG 不许被顺手拷进 `public/`（与 pose 同一条纪律）。
 *
 * @param {string} outDir 运行目录
 * @returns {string[]} 问题列表
 */
export function checkNoPng(outDir) {
  if (!existsSync(outDir)) return [];
  const problems = [];
  /** 深度优先。 */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.png$/i.test(entry.name)) problems.push(`sequence 运行目录里出现 PNG：${full}（母版只许留在 docs/）`);
    }
  };
  walk(outDir);
  return problems;
}

/**
 * 跑全部门禁判据。
 *
 * @param {object} [options] 选项
 * @param {boolean} [options.verbose] 打印每条判据
 * @param {string} [options.sequencesJsonPath] 清单路径（测试用）
 * @param {string} [options.outDir] 运行目录（测试用）
 * @param {(message: string) => void} [options.log] 日志出口
 * @returns {Promise<{ok: boolean, problems: string[], notes: string[], totals: {scenes: number, steps: number, bytes1x: number, bytes2x: number, durationMs: number}}>} 门禁结果
 */
export async function runSequenceGate(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const verbose = options.verbose === true;
  const sequencesJsonPath = options.sequencesJsonPath ?? SEQUENCES_JSON_PATH;
  const outDir = options.outDir ?? DEFAULT_SEQUENCE_OUT_DIR;
  const problems = [];
  const notes = [];
  const emptyTotals = { scenes: 0, steps: 0, bytes1x: 0, bytes2x: 0, durationMs: 0 };

  if (!existsSync(sequencesJsonPath)) {
    return { ok: false, problems: [`清单不存在：${sequencesJsonPath}`], notes, totals: emptyTotals };
  }
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(sequencesJsonPath, 'utf8'));
  } catch (err) {
    return { ok: false, problems: [`清单不可解析：${(err && err.message) || err}`], notes, totals: emptyTotals };
  }
  if (!isPlainObject(manifest)) {
    return { ok: false, problems: ['清单不是对象'], notes, totals: emptyTotals };
  }
  const record = /** @type {Record<string, any>} */ (manifest);

  const groups = [
    ['G-S2/schema', () => checkUnknownKeys(record)],
    ['G-S2/header', () => checkHeader(record)],
    ['G-S2/layers', () => checkLayers(record)],
    ['G-S1/registry', () => checkFrameRegistry(record)],
    ['G-S2/scenes', () => checkScenes(record)],
    ['G-S3/budget', () => checkVolume(record)],
    ['G-S1/no-png', () => checkNoPng(outDir)],
  ];
  for (const [label, judge] of groups) {
    const found = judge();
    if (verbose) log(`[gate:pet:sequences] ${label}：${found.length === 0 ? 'OK' : `${found.length} 个问题`}`);
    problems.push(...found);
  }

  // G-S1 的磁盘侧：复用构建脚本的 --check（漂移 + 缺文件 + 多文件 + 体积 + sha256 + 格式 + 尺寸）
  const built = await runBuildSequences({
    check: true,
    verbose,
    sequencesJsonPath,
    outDir,
    log: verbose ? log : () => {},
  });
  problems.push(...built.problems);
  notes.push(...built.notes);

  const unique = [...new Set(problems)];
  return { ok: unique.length === 0, problems: unique, notes, totals: built.totals };
}

/**
 * CLI 入口。
 *
 * @returns {Promise<number>} 进程退出码
 */
export async function main() {
  const verbose = process.argv.slice(2).includes('--verbose');
  try {
    const result = await runSequenceGate({ verbose, log: (message) => console.log(message) });
    for (const note of result.notes) console.log(`[gate:pet:sequences] 注意：${note}`);
    const total = result.totals.bytes1x + result.totals.bytes2x;
    if (result.ok) {
      console.log(
        `✅ gate:pet:sequences 通过：清单与磁盘逐字节对齐、编排完整、体积 ${total} B ≤ 预算 ${SEQUENCE_TOTAL_MAX_BYTES} B`,
      );
      return 0;
    }
    console.error('❌ gate:pet:sequences 失败：');
    for (const problem of result.problems) console.error(`   - ${problem}`);
    return 1;
  } catch (err) {
    console.error(`❌ gate:pet:sequences 异常：${(err && err.message) || err}`);
    return 1;
  }
}

/** 当前脚本是否为入口（被测试 import 时保持静默）。 */
export const IS_ENTRY = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false;

if (IS_ENTRY) {
  process.exit(await main());
}
