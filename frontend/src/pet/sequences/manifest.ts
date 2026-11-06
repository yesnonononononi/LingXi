/**
 * 序列清单的读入 / 校验 / 访问器 / 舞台→CSS 换算。
 *
 * <p><b>唯一真源是 `frontend/pet-sequences.json`</b>（与 `pet-poses.json` 同法：TS 直接 import）。
 * 引擎只认这一份，不读美术 `gif-v1/manifest.json`——那是构建期输入，
 * 归一的活由 `scripts/pet-sequence-adapters.mjs` 干完。</p>
 *
 * <p><b>本模块的三条硬职责：</b></p>
 * <ol>
 *   <li><b>加载即校验</b>：缺字段 / 负数 / 帧 id 不存在 / 时序倒流，一律在**加载时**抛
 *       {@link TypeError}，而不是等画面上跳一下才发现；</li>
 *   <li><b>自证</b>：`totals` 必须与逐帧/逐步累加相等（"清单说自己 8 步 3180 ms"这件事
 *       要能被独立复算，而不是相信生成器）；</li>
 *   <li><b>舞台→CSS 只有一个换算入口</b>：{@link stageToCssOf} 与 {@link companionBoxOf}。
 *       比例一律取 `scale.stageToCss`，源码里不许出现 `0.15234375` 这类裸字面量。</li>
 * </ol>
 *
 * @module pet/sequences/manifest
 */
import { ART_ORIGIN, PET_GEOMETRY, type PetGeometry } from '../layout';
import sequencesSource from '../../../pet-sequences.json';
import type {
  PetSequences,
  SequenceCssBox,
  SequenceDeferredScene,
  SequenceDensity,
  SequenceFrameFile,
  SequenceLayer,
  SequenceLayerId,
  SequenceLayerKind,
  SequencePoint,
  SequenceProvenance,
  SequenceScene,
  SequenceSceneEnd,
  SequenceScale,
  SequenceSize,
  SequenceStage,
  SequenceStep,
} from './types';
import { SEQUENCE_DENSITIES, SEQUENCE_LAYER_IDS } from './types';

/** `pet-sequences.json` 里声明的 schema 版本（改了字段语义才自增）。 */
export const SEQUENCES_VERSION = 1;

/** 生成脚本标识（与 `scripts/build-pet-sequences.mjs` 的常量同值）。 */
export const SEQUENCES_GENERATED_BY = 'scripts/build-pet-sequences.mjs';

/** `lxa://` 的 host（与构建脚本同值；URL 由清单给出，这里只做前缀断言）。 */
export const SEQUENCE_URL_HOST = 'pet-sequences';

/** 合法的层来源。 */
const LAYER_KINDS: readonly SequenceLayerKind[] = ['pose-frames', 'sequence-frames'];

/** 合法的场景收尾语义。 */
const SCENE_ENDS: readonly SequenceSceneEnd[] = ['return-stand', 'hold-last'];

/** 帧文件键的形态：`<scene>/<slot>@<density>.webp`。 */
const FRAME_KEY_PATTERN = /^([^/]+)\/([^/@]+)@(1x|2x)\.webp$/;

/**
 * 清单允许出现的键（**正向白名单**，避免"生产者写入 → 消费端丢弃"）。
 *
 * <p>与 `scripts/check-pet-sequences.mjs` 的 `SEQUENCE_SCHEMA_KEYS` **逐项相等**，
 * 由 `tests/petSequenceManifest.test.ts` 对账（本轮不允许新增独立的 schema JSON 文件，
 * 所以用"两份实现 + 一条对账用例"替代"一份 JSON 真源"）。</p>
 */
export const SEQUENCE_SCHEMA_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
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
 * 断言是普通对象（非数组、非 null）。
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 对象
 * @throws {TypeError} 不是对象
 */
function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`[pet-sequences] ${name} 必须是对象，实际为 ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/**
 * 断言是有限数值。
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 数值
 * @throws {TypeError} 不是有限数值
 */
function requireNumber(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError(`[pet-sequences] ${name} 必须是有限数值，实际为 ${JSON.stringify(value)}`);
}

/**
 * 断言是**正**的有限数值（负数/零一律拒绝）。
 *
 * <p>为什么不用 {@link requireNumber} + 调用点判正：位置、尺寸、时长、字节数**全都要正**，
 * 漏一个判断就是"云从屏幕外飞进来"或"时序原地空转"。收成一个函数，就没有漏的余地。</p>
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 数值
 * @throws {TypeError} 不是正的有限数值
 */
function requirePositive(value: unknown, name: string): number {
  const num = requireNumber(value, name);
  if (num <= 0) throw new TypeError(`[pet-sequences] ${name} 必须 > 0，实际为 ${num}`);
  return num;
}

/**
 * 断言是非空字符串。
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 字符串
 * @throws {TypeError} 不是非空字符串
 */
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`[pet-sequences] ${name} 必须是非空字符串，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 断言是数组。
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 数组
 * @throws {TypeError} 不是数组
 */
function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`[pet-sequences] ${name} 必须是数组，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 断言字符串数组且非空。
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 字符串数组副本
 * @throws {TypeError} 不是非空字符串数组
 */
function requireStringArray(value: unknown, name: string): string[] {
  const array = requireArray(value, name);
  if (array.length === 0) throw new TypeError(`[pet-sequences] ${name} 不能为空数组`);
  return array.map((item, index) => requireString(item, `${name}[${index}]`));
}

/**
 * 断言对象只出现白名单里的键。
 *
 * @param value 对象
 * @param allowed 允许的键
 * @param name 字段路径
 * @throws {TypeError} 出现未登记的键
 */
function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  throw new TypeError(
    `[pet-sequences] ${name} 出现未声明的键「${unknown.join(' / ')}」（只允许：${allowed.join(' / ')}）` +
      '（静默忽略一个字段的代价，是运行时按错的方式演一遍）',
  );
}

/**
 * 归一化一个尺寸对象。
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 尺寸
 * @throws {TypeError} 形态非法
 */
function normalizeSize(value: unknown, name: string): SequenceSize {
  const record = requireObject(value, name);
  assertKnownKeys(record, SEQUENCE_SCHEMA_KEYS.size ?? [], name);
  return {
    width: requirePositive(record.width, `${name}.width`),
    height: requirePositive(record.height, `${name}.height`),
  };
}

/**
 * 归一化一个点。
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 点
 * @throws {TypeError} 形态非法
 */
function normalizePoint(value: unknown, name: string): SequencePoint {
  const record = requireObject(value, name);
  assertKnownKeys(record, SEQUENCE_SCHEMA_KEYS.point ?? [], name);
  return { x: requireNumber(record.x, `${name}.x`), y: requireNumber(record.y, `${name}.y`) };
}

/**
 * 归一化一个层，并校验"锚点必须落在母版画布内"（域混用的典型形态是锚点越界）。
 *
 * @param value 原始值
 * @param index 层序号
 * @returns 层
 * @throws {TypeError} 形态非法
 */
function normalizeLayer(value: unknown, index: number): SequenceLayer {
  const name = `pet-sequences.layers[${index}]`;
  const record = requireObject(value, name);
  assertKnownKeys(record, SEQUENCE_SCHEMA_KEYS.layer ?? [], name);
  const id = requireString(record.id, `${name}.id`);
  if (!(SEQUENCE_LAYER_IDS as readonly string[]).includes(id)) {
    throw new TypeError(`[pet-sequences] ${name}.id=${JSON.stringify(id)} 不是合法层 id（允许：${SEQUENCE_LAYER_IDS.join(' / ')}）`);
  }
  const kind = requireString(record.kind, `${name}.kind`);
  if (!(LAYER_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError(`[pet-sequences] ${name}.kind=${JSON.stringify(kind)} 不是合法来源（允许：${LAYER_KINDS.join(' / ')}）`);
  }
  if (kind !== 'sequence-frames') {
    // 主角层的像素来自 pet-poses.json，本清单只登记"它是主角层"，不带几何
    return { id: id as SequenceLayerId, kind: kind as SequenceLayerKind };
  }
  const canvas = normalizeSize(record.canvas, `${name}.canvas`);
  const sourceCanvas = normalizeSize(record.sourceCanvas, `${name}.sourceCanvas`);
  const anchor = normalizePoint(record.anchor, `${name}.anchor`);
  if (anchor.x > sourceCanvas.width || anchor.y > sourceCanvas.height) {
    throw new TypeError(
      `[pet-sequences] ${name}.anchor=(${anchor.x}, ${anchor.y}) 越出 sourceCanvas ` +
        `(${sourceCanvas.width}×${sourceCanvas.height})：锚点与画布不同域`,
    );
  }
  const grip = record.grip === undefined ? undefined : normalizePoint(record.grip, `${name}.grip`);
  if (grip !== undefined && grip.y > anchor.y) {
    throw new TypeError(
      `[pet-sequences] ${name}.grip.y=${grip.y} 低于 anchor.y=${anchor.y}：握持点必须在画布上方`,
    );
  }
  return { id: id as SequenceLayerId, kind: kind as SequenceLayerKind, canvas, sourceCanvas, anchor, grip };
}

/**
 * 归一化一个帧文件条目。
 *
 * @param value 原始值
 * @param key 注册表键（`<scene>/<slot>@<density>.webp`）
 * @returns 帧条目
 * @throws {TypeError} 形态非法 / 键与内容不一致
 */
function normalizeFrameFile(value: unknown, key: string): SequenceFrameFile {
  const name = `pet-sequences.frames.${key}`;
  const record = requireObject(value, name);
  assertKnownKeys(record, SEQUENCE_SCHEMA_KEYS.frame ?? [], name);
  const keyMatch = FRAME_KEY_PATTERN.exec(key);
  if (keyMatch === null) {
    throw new TypeError(`[pet-sequences] ${name} 的键不是 <scene>/<slot>@<density>.webp 形态`);
  }
  const [, keyScene, keySlot, keyDensity] = keyMatch;
  const layer = requireString(record.layer, `${name}.layer`);
  if (!(SEQUENCE_LAYER_IDS as readonly string[]).includes(layer)) {
    throw new TypeError(`[pet-sequences] ${name}.layer=${JSON.stringify(layer)} 不是合法层 id`);
  }
  const slot = requireString(record.slot, `${name}.slot`);
  if (slot !== keySlot) {
    throw new TypeError(`[pet-sequences] ${name}.slot=${JSON.stringify(slot)} 与键里的 slot「${keySlot}」不一致`);
  }
  const format = requireString(record.format, `${name}.format`);
  if (format !== 'webp-lossless' && format !== 'webp') {
    throw new TypeError(`[pet-sequences] ${name}.format=${JSON.stringify(format)} 只能是 webp-lossless / webp`);
  }
  const sha256 = requireString(record.sha256, `${name}.sha256`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new TypeError(`[pet-sequences] ${name}.sha256 必须是 64 位小写十六进制`);
  }
  const url = requireString(record.url, `${name}.url`);
  const expectedUrl = `lxa://${SEQUENCE_URL_HOST}/${keyScene}/${keySlot}@${keyDensity}.webp`;
  if (url !== expectedUrl) {
    throw new TypeError(`[pet-sequences] ${name}.url=${JSON.stringify(url)} 与键推导出的 ${expectedUrl} 不一致`);
  }
  return {
    layer: layer as SequenceLayerId,
    slot,
    width: requirePositive(record.width, `${name}.width`),
    height: requirePositive(record.height, `${name}.height`),
    bytes: requirePositive(record.bytes, `${name}.bytes`),
    sha256,
    format,
    url,
  };
}

/**
 * 归一化一个 step，并校验帧引用（**查不到 = 抛错**，不许静默跳过）。
 *
 * @param value 原始值
 * @param path 字段路径
 * @param sceneId 场景 id
 * @param layerIds 已声明的层 id
 * @param frames 已登记的帧表
 * @returns step
 * @throws {TypeError} 形态非法 / 帧 id 不存在
 */
function normalizeStep(
  value: unknown,
  path: string,
  sceneId: string,
  layerIds: readonly string[],
  frames: Readonly<Record<string, SequenceFrameFile>>,
  poseFrameLayers: ReadonlySet<string>,
): SequenceStep {
  const record = requireObject(value, path);
  assertKnownKeys(record, SEQUENCE_SCHEMA_KEYS.step ?? [], path);
  const ms = requirePositive(record.ms, `${path}.ms`);
  const framesRaw = requireObject(record.frames, `${path}.frames`);
  const refs: Partial<Record<SequenceLayerId, string | null>> = {};
  const keys = Object.keys(framesRaw);
  if (keys.length === 0) {
    throw new TypeError(`[pet-sequences] ${path}.frames 为空：这一步既不显示主角也不显示伙伴，等于黑场`);
  }
  for (const key of keys) {
    if (!layerIds.includes(key)) {
      throw new TypeError(`[pet-sequences] ${path}.frames.${key} 引用了未声明的层（已声明：${layerIds.join(' / ')}）`);
    }
    const slot = framesRaw[key];
    if (slot === null) {
      refs[key as SequenceLayerId] = null;
      continue;
    }
    const slotName = requireString(slot, `${path}.frames.${key}`);
    if (poseFrameLayers.has(key)) {
      // `pose-frames` 层的像素不归序列清单管：slot 是 `pet-poses.json` 的帧 id，
      // 只能由 `PoseController.showFrame` 解析。这里**不查本清单的帧表**——
      // 查了就等于把"姿态帧"复制成"序列帧"，两份数据迟早漂移。
      refs[key as SequenceLayerId] = slotName;
      continue;
    }
    for (const density of SEQUENCE_DENSITIES) {
      const frameKey = `${sceneId}/${slotName}@${density}.webp`;
      if (frames[frameKey] === undefined) {
        throw new TypeError(
          `[pet-sequences] ${path}.frames.${key} 引用了不存在的帧 ${frameKey}（查不到 = 判红，不许跳过）`,
        );
      }
    }
    refs[key as SequenceLayerId] = slotName;
  }
  /** @type {SequenceStep} */
  const step: {
    ms: number;
    frames: Readonly<Partial<Record<SequenceLayerId, string | null>>>;
    companionCenterX?: number;
    companionFootY?: number;
    companionDy?: number;
    phase?: string;
  } = { ms, frames: refs };
  if (record.companionCenterX !== undefined) {
    step.companionCenterX = requireNumber(record.companionCenterX, `${path}.companionCenterX`);
  }
  if (record.companionFootY !== undefined) {
    step.companionFootY = requireNumber(record.companionFootY, `${path}.companionFootY`);
  }
  if (record.companionDy !== undefined) {
    step.companionDy = requireNumber(record.companionDy, `${path}.companionDy`);
  }
  if (record.phase !== undefined) {
    step.phase = requireString(record.phase, `${path}.phase`);
  }
  return step;
}

/**
 * 归一化一个场景（含时序单调校验）。
 *
 * @param value 原始值
 * @param sceneId 场景 id
 * @param layerIds 已声明的层 id
 * @param frames 已登记的帧表
 * @returns 场景
 * @throws {TypeError} 形态非法 / 时序倒流
 */
function normalizeScene(
  value: unknown,
  sceneId: string,
  layerIds: readonly string[],
  frames: Readonly<Record<string, SequenceFrameFile>>,
  poseFrameLayers: ReadonlySet<string>,
): SequenceScene {
  const path = `pet-sequences.scenes.${sceneId}`;
  const record = requireObject(value, path);
  assertKnownKeys(record, SEQUENCE_SCHEMA_KEYS.scene ?? [], path);
  if (typeof record.loop !== 'boolean') {
    throw new TypeError(`[pet-sequences] ${path}.loop 必须是布尔值，实际为 ${JSON.stringify(record.loop)}`);
  }
  const loop = record.loop;
  const onEndRaw = record.onEnd === undefined ? null : record.onEnd;
  if (onEndRaw !== null && !(SCENE_ENDS as readonly unknown[]).includes(onEndRaw)) {
    throw new TypeError(`[pet-sequences] ${path}.onEnd=${JSON.stringify(onEndRaw)} 只能是 ${SCENE_ENDS.join(' / ')} 或 null`);
  }
  if (loop && onEndRaw !== null) {
    throw new TypeError(`[pet-sequences] ${path}：loop=true 却声明了 onEnd=${JSON.stringify(onEndRaw)}（循环场景没有"播完"）`);
  }
  if (!loop && onEndRaw === null) {
    throw new TypeError(`[pet-sequences] ${path}：loop=false 必须显式声明 onEnd（${SCENE_ENDS.join(' / ')}）`);
  }
  const stepsRaw = requireArray(record.steps, `${path}.steps`);
  if (stepsRaw.length === 0) {
    throw new TypeError(`[pet-sequences] ${path}.steps 为空：空序列不是可播放内容`);
  }
  const steps: SequenceStep[] = [];
  let elapsed = 0;
  for (const [index, raw] of stepsRaw.entries()) {
    const step = normalizeStep(raw, `${path}.steps[${index}]`, sceneId, layerIds, frames, poseFrameLayers);
    // 时序单调递增：ms 必须为正（已在 normalizeStep 卡住），这里再独立复算一遍累加，
    // 保证"清单里的时长"与"逐步累加"不会因为将来的字段改动而悄悄分叉
    if (elapsed + step.ms <= elapsed) {
      throw new TypeError(`[pet-sequences] ${path}.steps[${index}] 让累计时长不再递增（${elapsed} → ${elapsed + step.ms}）：时序倒流`);
    }
    elapsed += step.ms;
    steps.push(step);
  }
  return { loop, onEnd: onEndRaw as SequenceSceneEnd | null, steps };
}

/**
 * 归一化整份清单（**入参一律不可信**：它来自构建脚本，而构建脚本读的是美术 manifest）。
 *
 * @param raw 原始 JSON
 * @param geometry 几何真源（默认 `PET_GEOMETRY`，测试可注入）
 * @returns 强类型清单
 * @throws {TypeError|RangeError} schema 不合法
 */
export function normalizePetSequences(raw: unknown, geometry: PetGeometry = PET_GEOMETRY): PetSequences {
  if (geometry === null || geometry === undefined) {
    throw new TypeError('[pet-sequences] 几何真源缺失：换算舞台坐标必须有它');
  }
  const source = requireObject(raw, 'pet-sequences');
  // 未知键闸门放在最前：报错要说"有个键不认识"，而不是"某个字段算出来不对"
  assertKnownKeys(source, SEQUENCE_SCHEMA_KEYS.root ?? [], 'pet-sequences');
  const version = requireNumber(source.version, 'pet-sequences.version');
  if (version !== SEQUENCES_VERSION) {
    throw new RangeError(`[pet-sequences] version=${version} 不是本引擎支持的 ${SEQUENCES_VERSION}`);
  }

  const scaleRaw = requireObject(source.scale, 'pet-sequences.scale');
  assertKnownKeys(scaleRaw, SEQUENCE_SCHEMA_KEYS.scale ?? [], 'pet-sequences.scale');
  const scale: SequenceScale = { stageToCss: requirePositive(scaleRaw.stageToCss, 'pet-sequences.scale.stageToCss') };

  const stageRaw = requireObject(source.stage, 'pet-sequences.stage');
  assertKnownKeys(stageRaw, SEQUENCE_SCHEMA_KEYS.stage ?? [], 'pet-sequences.stage');
  const stage: SequenceStage = {
    width: requirePositive(stageRaw.width, 'pet-sequences.stage.width'),
    height: requirePositive(stageRaw.height, 'pet-sequences.stage.height'),
  };

  const layersRaw = requireArray(source.layers, 'pet-sequences.layers');
  if (layersRaw.length === 0) {
    throw new TypeError('[pet-sequences] layers 不能为空：叠放序没有真源，运行时无从摆放');
  }
  const layers = layersRaw.map((item, index) => normalizeLayer(item, index));
  const layerIds = layers.map((layer) => layer.id);
  if (new Set(layerIds).size !== layerIds.length) {
    throw new TypeError(`[pet-sequences] layers 里出现重复的层 id（${layerIds.join(' / ')}）：同一层不许登记两次`);
  }

  const framesRaw = requireObject(source.frames, 'pet-sequences.frames');
  const frameKeys = Object.keys(framesRaw);
  if (frameKeys.length === 0) {
    throw new TypeError('[pet-sequences] frames 不能为空：本切片的核心产物就是这些运行帧');
  }
  // `pose-frames` 层的 slot 是 `pet-poses.json` 的帧 id，不登记在本清单的帧表里，
  // 所以校验 step 引用前要先把这些层挑出来（否则"合法的姿态帧引用"会被判成查不到的帧）。
  const poseFrameLayerIds = new Set(layers.filter((layer) => layer.kind === 'pose-frames').map((layer) => layer.id));
  const frames: Record<string, SequenceFrameFile> = {};
  for (const key of frameKeys) {
    const file = normalizeFrameFile(framesRaw[key], key);
    if (!layerIds.includes(file.layer)) {
      throw new TypeError(`[pet-sequences] frames.${key}.layer=${JSON.stringify(file.layer)} 不在 layers 里`);
    }
    frames[key] = file;
  }

  const scenesRaw = requireObject(source.scenes, 'pet-sequences.scenes');
  const sceneIds = Object.keys(scenesRaw);
  if (sceneIds.length === 0) {
    throw new TypeError('[pet-sequences] scenes 不能为空：序列资产至少要有 1 个可播场景');
  }
  const scenes: Record<string, SequenceScene> = {};
  for (const sceneId of sceneIds) {
    scenes[sceneId] = normalizeScene(scenesRaw[sceneId], sceneId, layerIds, frames, poseFrameLayerIds);
  }

  const totalsRaw = requireObject(source.totals, 'pet-sequences.totals');
  assertKnownKeys(totalsRaw, SEQUENCE_SCHEMA_KEYS.totals ?? [], 'pet-sequences.totals');
  const totals = {
    scenes: requireNumber(totalsRaw.scenes, 'pet-sequences.totals.scenes'),
    steps: requireNumber(totalsRaw.steps, 'pet-sequences.totals.steps'),
    bytes1x: requireNumber(totalsRaw.bytes1x, 'pet-sequences.totals.bytes1x'),
    bytes2x: requireNumber(totalsRaw.bytes2x, 'pet-sequences.totals.bytes2x'),
    durationMs: requireNumber(totalsRaw.durationMs, 'pet-sequences.totals.durationMs'),
  };
  // totals 自证：清单说"1 场景 8 步 3180 ms 10832 B"，这四个数必须能被独立复算出来
  let sum1x = 0;
  let sum2x = 0;
  for (const [key, file] of Object.entries(frames)) {
    if (key.endsWith('@1x.webp')) sum1x += file.bytes;
    else sum2x += file.bytes;
  }
  if (totals.bytes1x !== sum1x) {
    throw new RangeError(`[pet-sequences] totals.bytes1x=${totals.bytes1x} 与逐帧累加 ${sum1x} 不一致（totals 不自证）`);
  }
  if (totals.bytes2x !== sum2x) {
    throw new RangeError(`[pet-sequences] totals.bytes2x=${totals.bytes2x} 与逐帧累加 ${sum2x} 不一致（totals 不自证）`);
  }
  if (totals.scenes !== sceneIds.length) {
    throw new RangeError(`[pet-sequences] totals.scenes=${totals.scenes} 与实际场景数 ${sceneIds.length} 不一致`);
  }
  const stepCount = Object.values(scenes).reduce((sum, scene) => sum + scene.steps.length, 0);
  if (totals.steps !== stepCount) {
    throw new RangeError(`[pet-sequences] totals.steps=${totals.steps} 与逐步累加 ${stepCount} 不一致（totals 不自证）`);
  }
  const duration = Object.values(scenes).reduce(
    (sum, scene) => sum + scene.steps.reduce((inner, step) => inner + step.ms, 0),
    0,
  );
  if (totals.durationMs !== duration) {
    throw new RangeError(`[pet-sequences] totals.durationMs=${totals.durationMs} 与逐步累加 ${duration} 不一致（时长必须可自证）`);
  }

  const provenanceRaw = requireObject(source.provenance, 'pet-sequences.provenance');
  assertKnownKeys(provenanceRaw, SEQUENCE_SCHEMA_KEYS.provenance ?? [], 'pet-sequences.provenance');
  const manifestSha256 = requireString(provenanceRaw.manifestSha256, 'pet-sequences.provenance.manifestSha256');
  if (!/^[0-9a-f]{64}$/.test(manifestSha256)) {
    throw new TypeError('[pet-sequences] provenance.manifestSha256 必须是 64 位小写十六进制（漂移检测的锚）');
  }
  const provenance: SequenceProvenance = {
    adapter: requireString(provenanceRaw.adapter, 'pet-sequences.provenance.adapter'),
    manifestSha256,
    consumedKeys: requireStringArray(provenanceRaw.consumedKeys, 'pet-sequences.provenance.consumedKeys'),
  };

  const deferredRaw = source.deferred === undefined ? [] : requireArray(source.deferred, 'pet-sequences.deferred');
  const deferred: SequenceDeferredScene[] = deferredRaw.map((item, index) => {
    const path = `pet-sequences.deferred[${index}]`;
    const record = requireObject(item, path);
    assertKnownKeys(record, SEQUENCE_SCHEMA_KEYS.deferred ?? [], path);
    const scene = requireString(record.scene, `${path}.scene`);
    if (scenes[scene] !== undefined) {
      throw new TypeError(`[pet-sequences] deferred 里的 ${scene} 同时出现在 scenes 里（"没做"与"做了"不能同时成立）`);
    }
    return { scene, reason: requireString(record.reason, `${path}.reason`) };
  });

  return {
    version: SEQUENCES_VERSION,
    generatedBy: requireString(source.generatedBy, 'pet-sequences.generatedBy'),
    sourceRoot: requireString(source.sourceRoot, 'pet-sequences.sourceRoot'),
    scale,
    stage,
    layers,
    scenes,
    frames,
    totals,
    provenance,
    deferred,
  };
}

/**
 * 载入运行时清单（单例）。
 *
 * @returns 强类型清单
 * @throws {TypeError|RangeError} 清单不合法（加载即校验，绝不带病进画面）
 */
export function loadPetSequences(): PetSequences {
  return normalizePetSequences(sequencesSource);
}

/** 运行时清单单例（模块加载时校验一次）。 */
export const PET_SEQUENCES: PetSequences = loadPetSequences();

/**
 * 取一个层。
 *
 * @param sequences 清单
 * @param layerId 层 id
 * @returns 层；不存在时 null（缺席用 null 表达，不抛错——渲染路径抛错会让整只桌宠变黑）
 */
export function layerOf(sequences: PetSequences, layerId: SequenceLayerId): SequenceLayer | null {
  return sequences.layers.find((layer) => layer.id === layerId) ?? null;
}

/**
 * 取一个场景。
 *
 * @param sequences 清单
 * @param sceneId 场景 id
 * @returns 场景；不存在时 null
 */
export function sceneOf(sequences: PetSequences, sceneId: string): SequenceScene | null {
  return sequences.scenes[sceneId] ?? null;
}

/** 全部可播场景 id（排障 / 后门用）。 */
export function sceneIdsOf(sequences: PetSequences): string[] {
  return Object.keys(sequences.scenes);
}

/**
 * 一帧的注册表键（`<scene>/<slot>@<density>.webp`，与盘上相对路径同一说法）。
 *
 * @param sceneId 场景 id
 * @param slot slot 名
 * @param density 密度档
 * @returns 键
 */
export function frameKeyOf(sceneId: string, slot: string, density: SequenceDensity): string {
  return `${sceneId}/${slot}@${density}.webp`;
}

/**
 * 取一帧的运行文件。
 *
 * @param sequences 清单
 * @param sceneId 场景 id
 * @param layerId 层 id（必须与该帧登记的层一致，否则返回 null——不静默跨层取帧）
 * @param slot slot 名
 * @param density 密度档
 * @returns 帧文件；不存在时 null
 */
export function frameFileOf(
  sequences: PetSequences,
  sceneId: string,
  layerId: SequenceLayerId,
  slot: string,
  density: SequenceDensity,
): SequenceFrameFile | null {
  const file = sequences.frames[frameKeyOf(sceneId, slot, density)];
  if (file === undefined) return null;
  return file.layer === layerId ? file : null;
}

/**
 * 舞台单位 → CSS px（**舞台域换算的唯一入口**）。
 *
 * @param value 舞台单位
 * @param scale 比例契约
 * @returns CSS px
 * @throws {TypeError} 入参不是有限数值
 */
export function stageToCssOf(value: number, scale: SequenceScale): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`[pet-sequences] stageToCssOf.value 必须是有限数值，实际为 ${String(value)}`);
  }
  if (!Number.isFinite(scale.stageToCss) || scale.stageToCss <= 0) {
    throw new TypeError(`[pet-sequences] stageToCssOf.scale.stageToCss 必须是正有限数值，实际为 ${String(scale.stageToCss)}`);
  }
  return value * scale.stageToCss;
}

/** 伙伴层的舞台基准位置（中心 x + 脚底线 y）。 */
export interface SequenceStageAnchor {
  /** 舞台中心 x。 */
  readonly centerX: number;
  /** 舞台脚底线 y。 */
  readonly footY: number;
}

/** {@link companionBoxOf} 的入参。 */
export interface CompanionBoxOptions {
  /** 本步。 */
  readonly step: SequenceStep;
  /** 伙伴层。 */
  readonly layer: SequenceLayer;
  /** 清单（读比例契约）。 */
  readonly sequences: PetSequences;
  /** 本步没写坐标时的基准位置（B1 由调用方给；B2 起逐步写进清单）。 */
  readonly base?: SequenceStageAnchor | null;
  /** 立绘箱原点（CSS px；缺省取几何真源）。 */
  readonly origin?: SequencePoint;
  /** 几何真源（缺省 `PET_GEOMETRY`，测试可注入）。 */
  readonly geometry?: PetGeometry;
}

/**
/** {@link alignedLayerBoxOf} 的入参。 */
export interface AlignedLayerBoxOptions {
  /** 层（必须有 `canvas` 与 `anchor`）。 */
  readonly layer: SequenceLayer;
  /** 清单（读比例契约）。 */
  readonly sequences: PetSequences;
  /** 站姿对齐点（native 域；来自 `pet-poses.json` 的 `align`）。 */
  readonly align: SequencePoint;
  /** 立绘箱原点（CSS px；缺省取几何真源）。 */
  readonly origin?: SequencePoint;
  /** 几何真源（缺省 `PET_GEOMETRY`，测试可注入）。 */
  readonly geometry?: PetGeometry;
}

/**
 * 算"与坐姿画布同域"的层（主角 / 手掌）在这一步的 CSS 盒子（**位置计算的唯一入口**）。
 *
 * <p>公式与 pose 的 `poseBoxOf` **逐字符同构**（这不是巧合，是刻意的）：
 * `left = origin.x + (align.x − anchor.x) × stageToCss`、
 * `top = origin.y + (align.y − anchor.y) × stageToCss`，尺寸 = `canvas × stageToCss`。
 * 于是"序列里的主角帧"与"姿态层的坐姿帧"落在同一个像素盒里 —— 手掌层要长在手腕上，
 * 靠的正是这条同构（美术 `sit_hug_hands_native.png` 与坐姿母版同画布同锚点）。</p>
 *
 * <p>`stageToCss`（舞台域 → CSS）与 pose 的 `nativeToCss` 是**同一个数**（0.15234375），
 * 由清单的 `scale.stageToCss` 给出，源码里不许出现字面量。</p>
 *
 * @param options 入参
 * @returns CSS 盒子；层缺 canvas/anchor 时 null
 */
export function alignedLayerBoxOf(options: AlignedLayerBoxOptions): SequenceCssBox | null {
  const layer = options.layer;
  const canvas = layer.canvas;
  const anchor = layer.anchor;
  if (canvas === undefined || anchor === undefined) return null;
  const scale = options.sequences.scale;
  const geometry = options.geometry ?? PET_GEOMETRY;
  const origin = options.origin ?? ART_ORIGIN(geometry);
  return {
    left: origin.x + stageToCssOf(options.align.x - anchor.x, scale),
    top: origin.y + stageToCssOf(options.align.y - anchor.y, scale),
    width: stageToCssOf(canvas.width, scale),
    height: stageToCssOf(canvas.height, scale),
  };
}

/**
 * 算伙伴层在这一步的 CSS 盒子（**位置计算的唯一入口**）。
 *
 * <p>公式（设计 §7.5，已用美术数据逐值验证）：</p>
 * <pre>
 * css_left = (centerX − canvas.width/2) × stageToCss + origin.x
 * css_top  = (footY  − canvas.height)  × stageToCss + origin.y + dy × stageToCss
 * </pre>
 * <p>其中 `dy` 是逐帧的垂直位移（负数向上）。每次换步都重算一次，不累加——累加会在
 * 循环场景里越飘越高（"云朵飞到天花板"就是这么来的）。</p>
 *
 * @param options 入参
 * @returns CSS 盒子；层没有画布或既无本步坐标也无基准位置时 null
 */
export function companionBoxOf(options: CompanionBoxOptions): SequenceCssBox | null {
  const layer = options.layer;
  const canvas = layer.canvas;
  if (canvas === undefined) return null;
  const centerX = options.step.companionCenterX ?? options.base?.centerX;
  const footY = options.step.companionFootY ?? options.base?.footY;
  if (centerX === undefined || footY === undefined) return null;
  if (!Number.isFinite(centerX) || !Number.isFinite(footY)) return null;
  const scale = options.sequences.scale;
  const geometry = options.geometry ?? PET_GEOMETRY;
  const origin = options.origin ?? ART_ORIGIN(geometry);
  const dy = options.step.companionDy ?? 0;
  return {
    left: stageToCssOf(centerX - canvas.width / 2, scale) + origin.x,
    top: stageToCssOf(footY - canvas.height, scale) + origin.y + stageToCssOf(dy, scale),
    width: stageToCssOf(canvas.width, scale),
    height: stageToCssOf(canvas.height, scale),
  };
}
