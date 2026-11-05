/**
 * 运行时清单的读入 / 校验 / 访问器。
 *
 * <p><b>唯一真源是 `frontend/pet-poses.json`</b>（与 `pet-geometry.json` / `pet-assets.json`
 * 同法：TS 直接 import 成模块）。引擎**只认这一个文件**，不读美术 `poses/{batch}/manifest.json`
 * ——那是构建期的输入，三种写法并存且允许各批不同（`files[]` / `files[]+sequences` /
 * `frames[]`），归一的活由 `scripts/pet-pose-adapters.mjs` 在构建期干完。</p>
 *
 * <p><b>本模块的三条硬职责：</b></p>
 * <ol>
 *   <li><b>把域钉死</b>：JSON 里全是裸数字，进引擎前一律标成 `MasterPx` / `NativePx` / `CssPx`；</li>
 *   <li><b>拒绝错的资产</b>：比例不自洽、锚点越界（域混用的典型形态）、帧引用不存在、
 *       `frameMs` 与帧数不等长，一律在<b>加载时</b>抛错，而不是等到画面上跳一下；</li>
 *   <li><b>降级可见</b>：清单为空（资产未到）是<b>合法中间态</b>，`isPlayable` 全 false，
 *       引擎回落站姿——与 `build-pet-layers` 的"资产未到不报错"同口径。</li>
 * </ol>
 *
 * @module pet/poses/manifest
 */
import { PET_GEOMETRY, type PetGeometry } from '../layout';
import posesSource from '../../../pet-poses.json';
import {
  asCssPx,
  asMasterPx,
  asNativePx,
  masterScaleOf,
  masterToNative,
  standNativeCanvasWidth,
} from './units';
import type {
  AlignContract,
  BodyAnchor,
  Density,
  EnvelopeCss,
  Facing,
  FacingAnchor,
  NativePx,
  PetPoses,
  PoseAssetFile,
  PoseBatch,
  PoseClip,
  PoseDeferredBatch,
  PoseDegradation,
  PoseFrame,
  PosePostureId,
  PoseProvenance,
  PoseScale,
  PostureId,
} from './types';
import { POSTURE_IDS } from './types';
import { assertNoUnknownKeys } from './schema';

/** `pet-poses.json` 里声明的 schema 版本（改了字段语义才自增）。 */
export const PET_POSES_VERSION = 1;

/** 生成脚本标识（与 `scripts/build-pet-poses.mjs` 的常量同值，`--check` 会比对）。 */
export const PET_POSES_GENERATED_BY = 'scripts/build-pet-poses.mjs';

/** 比例等式的容差（C2 那条 `234/3072 = 156/2048` 必须是逐位相等）。 */
const SCALE_EPSILON = 1e-9;

/** `nativeToCss === masterToCss × 2` 的容差。 */
const DOUBLE_EPSILON = 1e-12;

/** 合法的密度档。 */
const DENSITIES: readonly Density[] = ['1x', '2x'];

/** 合法的美术声明状态。 */
const STATUSES = ['awaiting-static-review', 'approved', 'frozen'] as const;

/** 合法的 adapter 名。 */
const ADAPTERS = ['legacy-v1', 'files-sequences-v2', 'frames-nested-v3'] as const;

/** 合法的降级项。 */
const DEGRADATIONS: readonly PoseDegradation[] = ['no-face-overlay', 'no-blink'];

/**
 * 锚点与墨迹边界的容差（native px）。
 *
 * <p>沿用美术 C4 的 2 native 容差（= 0.30 CSS）：躯干质心必须落在该帧墨迹的水平范围内，
 * 差 2 px 以内算实测噪声（round 与 alpha 边界造成）。</p>
 */
const ANCHOR_TOLERANCE = 2;

/**
 * G-08 的硬阈值：同批同 facing 的帧锚点与批级 `bodyAnchor` 之差上限（native px）。
 *
 * <p>与 `scripts/pet-pose-adapters.mjs` 的 `ANCHOR_SPREAD_MAX_NATIVE` 同值同义——两侧都写死，
 * 是为了让"放宽阈值"必须同时改两处并被 `tests/petPoseAdapters.test.ts` 的对齐用例发现。</p>
 */
const ANCHOR_SPREAD_MAX_NATIVE = 2;

/**
 * 读取可选 native 数值（缺省 / null ⇒ null）。
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns native 数值或 null
 * @throws {TypeError} 存在但不是有限数值
 */
function optionalNativePx(value: unknown, name: string): NativePx | null {
  if (value === undefined || value === null) return null;
  return asNativePx(requireNumber(value, name));
}

/**
 * 断言是有限数值。
 *
 * @param value 原始值
 * @param name 字段路径（报错用）
 * @returns 数值
 * @throws {TypeError} 不是有限数值
 */
function requireNumber(value: unknown, name: string): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new TypeError(`[pet-poses] ${name} 必须是有限数值，实际为 ${String(value)}`);
  }
  return num;
}

/**
 * 断言朝向是 `-1` 或 `1`（**不做类型宽松转换**：`"1"` 与 `1` 不是一回事）。
 *
 * <p>为什么不用 {@link requireNumber} 再判范围：`Number("1") === 1`，会把字符串 `"1"`
 * 悄悄当合法朝向收下，正好掩盖"生产者写了字符串"这种真缺陷。这里要求
 * `typeof value === 'number'` 且严格等于 ±1。</p>
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 朝向
 * @throws {TypeError} 缺失/非数值/不是 ±1
 */
function requireFacing(value: unknown, name: string): Facing {
  if (value === undefined || value === null) {
    throw new TypeError(`[pet-poses] ${name} 缺失：朝向必须显式声明为 -1 或 1（不许默认成 -1）`);
  }
  if (typeof value !== 'number' || (value !== -1 && value !== 1)) {
    throw new TypeError(`[pet-poses] ${name} 只能是数值 -1 或 1，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 断言是字符串。
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 字符串
 * @throws {TypeError} 不是字符串
 */
function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`[pet-poses] ${name} 必须是非空字符串，实际为 ${String(value)}`);
  }
  return value;
}

/**
 * 断言是对象（非数组、非 null）。
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 对象
 * @throws {TypeError} 不是对象
 */
function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`[pet-poses] ${name} 必须是对象，实际为 ${String(value)}`);
  }
  return value as Record<string, unknown>;
}

/**
 * 断言是字符串数组。
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 数组副本
 * @throws {TypeError} 不是字符串数组
 */
function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`[pet-poses] ${name} 必须是字符串数组，实际为 ${JSON.stringify(value)}`);
  }
  return [...(value as string[])];
}

/**
 * 断言是数值数组。
 *
 * @param value 原始值
 * @param name 字段路径
 * @returns 数组副本
 * @throws {TypeError} 不是数值数组
 */
function requireNumberArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isFinite(Number(item)))) {
    throw new TypeError(`[pet-poses] ${name} 必须是数值数组，实际为 ${JSON.stringify(value)}`);
  }
  return (value as number[]).map((item) => Number(item));
}

/**
 * 校验比例契约与几何真源自洽（C2 的那条等式）。
 *
 * <p>`masterToCss === artWidth / canvasWidth` 不成立就说明有人"为了塞进窗口而缩放了资产"，
 * 或改了几何真源忘了重建清单。两种都不许带病上屏。</p>
 *
 * @param scale 清单里的比例契约
 * @param geometry 几何真源（默认 `PET_GEOMETRY`）
 * @throws {RangeError} 比例不自洽
 */
export function assertScaleConsistent(scale: PoseScale, geometry: PetGeometry = PET_GEOMETRY): void {
  if (!(geometry.canvasWidth > 0) || !(geometry.artWidth > 0)) {
    throw new RangeError('[pet-poses] 几何真源的 artWidth / canvasWidth 必须为正，否则比例等式无意义');
  }
  const expected = geometry.artWidth / geometry.canvasWidth;
  if (Math.abs(scale.masterToCss - expected) > SCALE_EPSILON) {
    throw new RangeError(
      `[pet-poses] 比例不自洽：masterToCss=${scale.masterToCss} 而 artWidth/canvasWidth=${expected}` +
        `（artWidth=${geometry.artWidth}, canvasWidth=${geometry.canvasWidth}）`,
    );
  }
  if (Math.abs(scale.artWidth - geometry.artWidth) > SCALE_EPSILON) {
    throw new RangeError(`[pet-poses] scale.artWidth=${scale.artWidth} 与几何真源 ${geometry.artWidth} 不一致`);
  }
  if (Math.abs(scale.canvasWidth - geometry.canvasWidth) > SCALE_EPSILON) {
    throw new RangeError(`[pet-poses] scale.canvasWidth=${scale.canvasWidth} 与几何真源 ${geometry.canvasWidth} 不一致`);
  }
  // nativeToCss 必须是 masterToCss 的两倍：写成加法而不是字面量乘法，
  // 免得本文件命中"禁裸 ×2"的静态扫描（那条扫描是给渲染/布局代码用的纪律）。
  const doubled = scale.masterToCss + scale.masterToCss;
  if (Math.abs(scale.nativeToCss - doubled) > DOUBLE_EPSILON) {
    throw new RangeError(
      `[pet-poses] nativeToCss=${scale.nativeToCss} 不等于 masterToCss 的两倍（${doubled}）`,
    );
  }
}

/**
 * 归一化一张图片条目。
 *
 * @param raw 原始值
 * @param name 字段路径
 * @returns 强类型条目
 */
function normalizeAssetFile(raw: unknown, name: string): PoseAssetFile {
  const source = requireObject(raw, name);
  const format = requireString(source.format, `${name}.format`);
  if (format !== 'webp' && format !== 'webp-lossless') {
    throw new TypeError(`[pet-poses] ${name}.format 只能是 webp / webp-lossless，实际为 ${format}`);
  }
  const sha256 = requireString(source.sha256, `${name}.sha256`).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new TypeError(`[pet-poses] ${name}.sha256 必须是 64 位小写十六进制，实际为 ${sha256}`);
  }
  return {
    file: requireString(source.file, `${name}.file`),
    url: requireString(source.url, `${name}.url`),
    width: requireNumber(source.width, `${name}.width`),
    height: requireNumber(source.height, `${name}.height`),
    bytes: requireNumber(source.bytes, `${name}.bytes`),
    sha256,
    format,
  };
}

/**
 * 归一化一个朝向锚点。
 *
 * @param raw 原始值
 * @param name 字段路径
 * @returns native 域锚点
 */
function normalizeFacingAnchor(raw: unknown, name: string): FacingAnchor {
  const source = requireObject(raw, name);
  return {
    x: asNativePx(requireNumber(source.x, `${name}.x`)),
    y: asNativePx(requireNumber(source.y, `${name}.y`)),
  };
}

/**
 * 归一化批级锚点。
 *
 * @param raw 原始值
 * @param name 字段路径
 * @returns 强类型锚点
 * @throws {TypeError} 朝向键缺失（两个朝向都必须存在）
 */
function normalizeBodyAnchor(raw: unknown, name: string): BodyAnchor {
  const source = requireObject(raw, name);
  const byFacingRaw = requireObject(source.byFacing, `${name}.byFacing`);
  const left = byFacingRaw['-1'];
  const right = byFacingRaw['1'];
  if (left === undefined || right === undefined) {
    throw new TypeError(`[pet-poses] ${name}.byFacing 必须同时声明 '-1' 与 '1'（缺朝向 = 该朝向不可播）`);
  }
  const sourceKind = requireString(source.byFacingSource, `${name}.byFacingSource`);
  if (sourceKind !== 'measured-per-facing' && sourceKind !== 'batch-single' && sourceKind !== 'mirror-derived') {
    throw new TypeError(`[pet-poses] ${name}.byFacingSource 非法：${sourceKind}`);
  }
  // G-08：美术自报的批内锚点离散度必须 ≤ 2 native。缺省（null）合法，但一旦声明就必须自证合格，
  // 否则"超限的那批"会带着 3 native 的偏差一路走到运行时（表现为某帧"跳脚"）。
  const spreadNative = optionalNativePx(source.spreadNative, `${name}.spreadNative`);
  const maxDeviationNative = optionalNativePx(source.maxDeviationNative, `${name}.maxDeviationNative`);
  for (const [label, value] of [
    ['spreadNative', spreadNative],
    ['maxDeviationNative', maxDeviationNative],
  ] as const) {
    if (value === null) continue;
    if (value < 0) throw new TypeError(`[pet-poses] ${name}.${label} 不能为负：${value}`);
    if (value > ANCHOR_SPREAD_MAX_NATIVE) {
      throw new TypeError(
        `[pet-poses] ${name}.${label}=${value} 超过 G-08 上限 ${ANCHOR_SPREAD_MAX_NATIVE} native`,
      );
    }
  }
  return {
    byFacing: {
      '-1': normalizeFacingAnchor(left, `${name}.byFacing['-1']`),
      '1': normalizeFacingAnchor(right, `${name}.byFacing['1']`),
    },
    byFacingSource: sourceKind,
    spreadNative,
    maxDeviationNative,
  };
}

/**
 * 归一化包络。
 *
 * @param raw 原始值
 * @param name 字段路径
 * @returns CSS 域包络
 */
function normalizeEnvelope(raw: unknown, name: string): EnvelopeCss {
  const source = requireObject(raw, name);
  return {
    left: asCssPx(requireNumber(source.left, `${name}.left`)),
    right: asCssPx(requireNumber(source.right, `${name}.right`)),
    top: asCssPx(requireNumber(source.top, `${name}.top`)),
    bottom: asCssPx(requireNumber(source.bottom, `${name}.bottom`)),
  };
}

/**
 * 归一化一个可播片段。
 *
 * @param raw 原始值
 * @param name 字段路径
 * @param batch 所属批次（校验帧引用与朝向一致）
 * @returns 片段
 * @throws {TypeError} `facing` 缺失/非法、帧引用不存在、帧朝向与片段不一致
 * @throws {RangeError} 时长与帧数不等长
 */
function normalizeClip(
  raw: unknown,
  name: string,
  batch: { frames: Readonly<Record<string, PoseFrame>>; clips?: readonly PoseClip[] },
): PoseClip {
  const source = requireObject(raw, name);
  // `facing` 必填且严格校验：缺失、`0`、`"1"`、`undefined` 全部抛错。
  // 绝不默认成 -1——否则"漏写 facing"与"左向片段"在数据上不可区分，
  // 而 adapter 早在切片 1 就为每个片段写了 facing（信息源头是有的，只是被丢弃过）。
  const facing = requireFacing(source.facing, `${name}.facing`);
  const frames = requireStringArray(source.frames, `${name}.frames`);
  const frameMs = requireNumberArray(source.frameMs, `${name}.frameMs`);
  if (frames.length === 0) {
    throw new TypeError(`[pet-poses] ${name}.frames 不能为空（空片段不是"可播放内容"）`);
  }
  if (frameMs.length !== frames.length) {
    throw new RangeError(`[pet-poses] ${name}.frameMs 长度 ${frameMs.length} 与帧数 ${frames.length} 不等长`);
  }
  for (const frameId of frames) {
    const frame = batch.frames[frameId];
    if (frame === undefined) {
      throw new TypeError(`[pet-poses] ${name}.frames 引用了不存在的帧 ${frameId}`);
    }
    // 跨朝向混帧必须硬失败：播放器按 clip 顺序上屏，混入反朝向帧等于让角色原地翻转。
    // 真正要左右各一条时，adapter 会产出**两条同 id 不同 facing 的 clip**（buildClips）。
    if (frame.facing !== facing) {
      throw new TypeError(
        `[pet-poses] ${name}.facing=${facing} 但帧 ${frameId} 的 facing=${frame.facing}（同一片段不许混朝向）`,
      );
    }
  }
  const loop = source.loop === true;
  const onEnd = source.onEnd;
  if (onEnd !== undefined && onEnd !== 'hold-last' && onEnd !== 'return-stand') {
    throw new TypeError(`[pet-poses] ${name}.onEnd 只能是 hold-last / return-stand，实际为 ${String(onEnd)}`);
  }
  const id = requireString(source.id, `${name}.id`);
  const duplicated = batch.clips?.some((clip) => clip.id === id && clip.facing === facing);
  if (duplicated === true) {
    // 同 id 同朝向 = 取用面二义（"两条一模一样的东西哪条算数"），明确报错而不是任选其一。
    // 同 id **不同**朝向是允许的（walk/run 的 cycle 左右各一条），见 `clipsOf` / `clipOf`。
    throw new TypeError(`[pet-poses] ${name} 与前面的片段重复：id=${id} facing=${facing} 已存在`);
  }
  return {
    id,
    facing,
    frames,
    loop,
    frameMs,
    ...(onEnd === undefined ? {} : { onEnd }),
  };
}

/**
 * 归一化一帧。
 *
 * @param raw 原始值
 * @param name 字段路径
 * @returns 帧
 * @throws {TypeError} 朝向非法 / 缺密度文件
 */
function normalizeFrame(raw: unknown, name: string): PoseFrame {
  const source = requireObject(raw, name);
  const facing = requireFacing(source.facing, `${name}.facing`);
  const filesRaw = requireObject(source.files, `${name}.files`);
  const oneX = filesRaw['1x'];
  const twoX = filesRaw['2x'];
  if (oneX === undefined || twoX === undefined) {
    throw new TypeError(`[pet-poses] ${name}.files 必须同时有 '1x' 与 '2x' 两档`);
  }
  const inkRaw = requireObject(source.inkNative, `${name}.inkNative`);
  const ink = {
    left: asNativePx(requireNumber(inkRaw.left, `${name}.inkNative.left`)),
    top: asNativePx(requireNumber(inkRaw.top, `${name}.inkNative.top`)),
    right: asNativePx(requireNumber(inkRaw.right, `${name}.inkNative.right`)),
    bottom: asNativePx(requireNumber(inkRaw.bottom, `${name}.inkNative.bottom`)),
  };
  if (!(ink.right > ink.left) || !(ink.bottom > ink.top)) {
    throw new RangeError(`[pet-poses] ${name}.inkNative 右/下必须大于左/上（right>left 且 bottom>top）`);
  }
  const gapRaw = source.airborneGapNative;
  const supportRaw = source.supportFootX;
  return {
    id: requireString(source.id, `${name}.id`),
    facing,
    files: {
      '1x': normalizeAssetFile(oneX, `${name}.files['1x']`),
      '2x': normalizeAssetFile(twoX, `${name}.files['2x']`),
    },
    anchorNative: normalizeFacingAnchor(source.anchorNative, `${name}.anchorNative`),
    inkNative: ink,
    airborneGapNative: gapRaw === null || gapRaw === undefined ? null : asNativePx(requireNumber(gapRaw, `${name}.airborneGapNative`)),
    supportFootX: supportRaw === null || supportRaw === undefined ? null : asNativePx(requireNumber(supportRaw, `${name}.supportFootX`)),
  };
}

/**
 * 归一化一个批次的溯源信息。
 *
 * @param raw 原始值
 * @param name 字段路径
 * @returns 溯源
 */
function normalizeProvenance(raw: unknown, name: string): PoseProvenance {
  const source = requireObject(raw, name);
  const adapter = requireString(source.adapter, `${name}.adapter`);
  if (!(ADAPTERS as readonly string[]).includes(adapter)) {
    throw new TypeError(`[pet-poses] ${name}.adapter 非法：${adapter}`);
  }
  const manifestSha256 = requireString(source.manifestSha256, `${name}.manifestSha256`).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(manifestSha256)) {
    throw new TypeError(`[pet-poses] ${name}.manifestSha256 必须是 64 位小写十六进制`);
  }
  return {
    adapter: adapter as PoseProvenance['adapter'],
    manifestSha256,
    consumedKeys: requireStringArray(source.consumedKeys, `${name}.consumedKeys`),
    aliasesResolved: requireStringArray(source.aliasesResolved, `${name}.aliasesResolved`),
  };
}

/**
 * 归一化一个批次，并做**域混用**的运行时断言（G-09）。
 *
 * @param raw 原始值
 * @param posture 该批应对应的姿态 id
 * @param name 字段路径
 * @returns 批次
 * @throws {RangeError} 锚点越出 native 画布（把母版值当 native 塞进来的典型症状）
 */
function normalizeBatch(raw: unknown, posture: PostureId, name: string): PoseBatch {
  const source = requireObject(raw, name);
  const declared = requireString(source.posture, `${name}.posture`);
  if (declared !== posture) {
    throw new TypeError(`[pet-poses] ${name}.posture=${declared} 与清单键 ${posture} 不一致`);
  }
  const status = requireString(source.status, `${name}.status`);
  if (!(STATUSES as readonly string[]).includes(status)) {
    throw new TypeError(`[pet-poses] ${name}.status 非法：${status}`);
  }
  const canvasRaw = requireObject(source.canvas, `${name}.canvas`);
  const nativeCanvasRaw = requireObject(source.nativeCanvas, `${name}.nativeCanvas`);
  const canvas = {
    width: asMasterPx(requireNumber(canvasRaw.width, `${name}.canvas.width`)),
    height: asMasterPx(requireNumber(canvasRaw.height, `${name}.canvas.height`)),
  };
  const nativeCanvas = {
    width: asNativePx(requireNumber(nativeCanvasRaw.width, `${name}.nativeCanvas.width`)),
    height: asNativePx(requireNumber(nativeCanvasRaw.height, `${name}.nativeCanvas.height`)),
  };
  const bodyAnchor = normalizeBodyAnchor(source.bodyAnchor, `${name}.bodyAnchor`);

  // 域混用的第一道：母版画布必须正好是 native 画布的 `masterScale` 倍。
  // 把 native 画布填进 `canvas`（母版字段）时倍率会变成 1，当场红。
  const masterScale = requireNumber(source.masterScale, `${name}.masterScale`);
  if (!(masterScale > 0)) {
    throw new RangeError(`[pet-poses] ${name}.masterScale 必须为正，实际为 ${masterScale}`);
  }
  if (Math.abs(masterToNative(canvas.width, masterScale) - nativeCanvas.width) > ANCHOR_TOLERANCE) {
    throw new RangeError(
      `[pet-poses] ${name}.canvas.width=${canvas.width} 不是 nativeCanvas.width=${nativeCanvas.width} 的 ` +
        `${masterScale} 倍（域混用：母版字段里塞了 native 值，或反之）`,
    );
  }
  if (Math.abs(masterToNative(canvas.height, masterScale) - nativeCanvas.height) > ANCHOR_TOLERANCE) {
    throw new RangeError(
      `[pet-poses] ${name}.canvas.height=${canvas.height} 不是 nativeCanvas.height=${nativeCanvas.height} 的 ` +
        `${masterScale} 倍（域混用）`,
    );
  }

  // G-09：锚点必须落在 native 画布内。把母版值（如 sit 的 948）当 native 塞进来时，
  // 948 < 1024 仍然"过"，但它会被下面的比例关系抓住；真正的强判据是"锚点必须在画布内且
  // 不能在 [nativeCanvas.width, masterCanvas.width) 这个只可能来自母版的区间"。
  for (const facing of ['-1', '1'] as const) {
    const anchor = bodyAnchor.byFacing[facing];
    if (!(anchor.x > 0) || anchor.x >= nativeCanvas.width) {
      throw new RangeError(
        `[pet-poses] ${name}.bodyAnchor.byFacing['${facing}'].x=${anchor.x} 越出 native 画布宽 ` +
          `${nativeCanvas.width}（域混用：母版值不能当 native 用）`,
      );
    }
    if (!(anchor.y > 0) || anchor.y > nativeCanvas.height) {
      throw new RangeError(
        `[pet-poses] ${name}.bodyAnchor.byFacing['${facing}'].y=${anchor.y} 越出 native 画布高 ` +
          `${nativeCanvas.height}（域混用：母版值不能当 native 用）`,
      );
    }
  }

  const framesRaw = requireObject(source.frames, `${name}.frames`);
  const frames: Record<string, PoseFrame> = {};
  for (const [frameId, value] of Object.entries(framesRaw)) {
    frames[frameId] = normalizeFrame(value, `${name}.frames.${frameId}`);
  }
  if (Object.keys(frames).length === 0) {
    throw new TypeError(`[pet-poses] ${name}.frames 为空：没有帧的批次不是可播资产`);
  }
  const clipsRaw = source.clips;
  if (!Array.isArray(clipsRaw) || clipsRaw.length === 0) {
    throw new TypeError(`[pet-poses] ${name}.clips 必须是非空数组`);
  }
  const clips: PoseClip[] = [];
  clipsRaw.forEach((item, index) => {
    // 边归一化边累积：`normalizeClip` 借它拦"同 id 同朝向重复"（取用面二义）。
    clips.push(normalizeClip(item, `${name}.clips[${index}]`, { frames, clips }));
  });

  // 域混用的第二道（G-09 的运行时部分）：躯干质心必然落在该帧墨迹的水平范围内。
  // 把母版值（sit 的 474 母版 = 948）当 native 塞进来时，948 会掉到墨迹右缘 918.5 之外，
  // 于是这条当场红——比"必须小于画布宽"（948 < 1024 仍成立）强得多。
  for (const [frameId, frame] of Object.entries(frames)) {
    const anchor = bodyAnchor.byFacing[frame.facing === 1 ? '1' : '-1'];
    if (
      anchor.x < frame.inkNative.left - ANCHOR_TOLERANCE ||
      anchor.x > frame.inkNative.right + ANCHOR_TOLERANCE
    ) {
      throw new RangeError(
        `[pet-poses] ${name}.frames.${frameId} 的朝向锚点 x=${anchor.x} 落在该帧墨迹 ` +
          `[${frame.inkNative.left}, ${frame.inkNative.right}] 之外（域混用：母版值不能当 native 用）`,
      );
    }
  }

  return {
    posture,
    assetId: requireString(source.assetId, `${name}.assetId`),
    status: status as PoseBatch['status'],
    masterScale,
    canvas,
    nativeCanvas,
    bodyAnchor,
    envelopeCss: normalizeEnvelope(source.envelopeCss, `${name}.envelopeCss`),
    clips,
    frames,
    provenance: normalizeProvenance(source.provenance, `${name}.provenance`),
  };
}

/**
 * 归一化整份清单（**入参一律不可信**：它来自构建脚本，而构建脚本读的是美术 manifest）。
 *
 * @param raw 原始 JSON
 * @param geometry 几何真源（默认 `PET_GEOMETRY`）
 * @returns 强类型清单
 * @throws {TypeError|RangeError} schema 不合法
 */
export function normalizePetPoses(raw: unknown, geometry: PetGeometry = PET_GEOMETRY): PetPoses {
  const source = requireObject(raw, 'pet-poses');
  // 未知键闸门（G-16）放在最前：schema 没声明的键一律抛 TypeError，绝不静默丢弃。
  // 位置在"逐字段取值"之前，这样报错说的是"有个键不认识"，而不是"某个字段算出来不对"。
  assertNoUnknownKeys(raw);
  const version = requireNumber(source.version, 'pet-poses.version');
  if (version !== PET_POSES_VERSION) {
    throw new RangeError(`[pet-poses] version=${version} 不是本引擎支持的 ${PET_POSES_VERSION}`);
  }
  const scaleRaw = requireObject(source.scale, 'pet-poses.scale');
  const scale: PoseScale = {
    masterToCss: requireNumber(scaleRaw.masterToCss, 'pet-poses.scale.masterToCss'),
    nativeToCss: requireNumber(scaleRaw.nativeToCss, 'pet-poses.scale.nativeToCss'),
    artWidth: requireNumber(scaleRaw.artWidth, 'pet-poses.scale.artWidth'),
    canvasWidth: requireNumber(scaleRaw.canvasWidth, 'pet-poses.scale.canvasWidth'),
  };
  assertScaleConsistent(scale, geometry);

  const alignRaw = requireObject(source.align, 'pet-poses.align');
  const xSource = requireString(alignRaw.xSource, 'pet-poses.align.xSource');
  if (xSource !== 'measured-blue-skirt-centroid' && xSource !== 'fallback-canvas-center') {
    throw new TypeError(`[pet-poses] align.xSource 非法：${xSource}`);
  }
  const align: AlignContract = {
    xNative: asNativePx(requireNumber(alignRaw.xNative, 'pet-poses.align.xNative')),
    yNative: asNativePx(requireNumber(alignRaw.yNative, 'pet-poses.align.yNative')),
    xSource,
  };
  const standNativeWidth = standNativeCanvasWidth(scale);
  if (!(align.xNative > 0) || align.xNative >= standNativeWidth) {
    throw new RangeError(
      `[pet-poses] align.xNative=${align.xNative} 必须落在站姿原生画布 (0, ${standNativeWidth}) 内`,
    );
  }

  const densities = requireStringArray(source.densities, 'pet-poses.densities');
  if (densities.length === 0 || densities.some((item) => !(DENSITIES as readonly string[]).includes(item))) {
    throw new TypeError(`[pet-poses] densities 只能是 ${DENSITIES.join(' / ')} 的子集，实际为 ${densities.join(',')}`);
  }

  const batchesRaw = requireObject(source.batches, 'pet-poses.batches');
  const batches: Partial<Record<PostureId, PoseBatch>> = {};
  for (const [key, value] of Object.entries(batchesRaw)) {
    if (!POSTURE_IDS.includes(key as PostureId)) {
      throw new TypeError(`[pet-poses] batches 里出现未知姿态键 ${key}`);
    }
    batches[key as PostureId] = normalizeBatch(value, key as PostureId, `pet-poses.batches.${key}`);
  }

  const accepted = requireStringArray(source.accepted, 'pet-poses.accepted');
  for (const id of accepted) {
    if (!POSTURE_IDS.includes(id as PostureId)) {
      throw new TypeError(`[pet-poses] accepted 里出现未知姿态 ${id}`);
    }
    if (batches[id as PostureId] === undefined) {
      throw new TypeError(`[pet-poses] accepted 声明了 ${id} 但 batches 里没有该批（"登记了却没资产"必须硬失败）`);
    }
  }

  const deferredRaw = Array.isArray(source.deferred) ? source.deferred : [];
  const deferred: PoseDeferredBatch[] = deferredRaw.map((item, index) => {
    const entry = requireObject(item, `pet-poses.deferred[${index}]`);
    const posture = requireString(entry.posture, `pet-poses.deferred[${index}].posture`);
    if (posture === 'stand' || !POSTURE_IDS.includes(posture as PostureId)) {
      throw new TypeError(`[pet-poses] deferred[${index}].posture 非法：${posture}`);
    }
    return {
      posture: posture as PosePostureId,
      reason: requireString(entry.reason, `pet-poses.deferred[${index}].reason`),
    };
  });

  const degradationRaw = Array.isArray(source.degradations) ? source.degradations : [];
  const degradations = degradationRaw.map((item, index) => {
    const value = requireString(item, `pet-poses.degradations[${index}]`);
    if (!(DEGRADATIONS as readonly string[]).includes(value)) {
      throw new TypeError(`[pet-poses] degradations[${index}] 非法：${value}`);
    }
    return value as PoseDegradation;
  });

  const totalsRaw = requireObject(source.totals, 'pet-poses.totals');
  const totals = {
    frames: requireNumber(totalsRaw.frames, 'pet-poses.totals.frames'),
    bytes1x: requireNumber(totalsRaw.bytes1x, 'pet-poses.totals.bytes1x'),
    bytes2x: requireNumber(totalsRaw.bytes2x, 'pet-poses.totals.bytes2x'),
  };

  return {
    version: PET_POSES_VERSION,
    generatedBy: requireString(source.generatedBy, 'pet-poses.generatedBy'),
    sourceRoot: requireString(source.sourceRoot, 'pet-poses.sourceRoot'),
    scale,
    align,
    densities: densities as readonly Density[],
    batches,
    accepted: accepted as readonly PostureId[],
    deferred,
    degradations,
    totals,
  };
}

/**
 * 载入运行时清单（单例）。
 *
 * <p>加载即校验：非法数据在这里就抛，绝不带病进画面。</p>
 *
 * @returns 强类型清单
 */
export function loadPetPoses(): PetPoses {
  return normalizePetPoses(posesSource);
}

/** 运行时清单单例（模块加载时校验一次）。 */
export const PET_POSES: PetPoses = loadPetPoses();

/**
 * 取一个批次。
 *
 * <p><b>与设计稿的差异（已记录）：</b>设计稿写 `batchOf(...): PoseBatch`（不可空），
 * 但"缺批 = 该姿态无资产"要求缺席可表达。这里返回 `PoseBatch | null`——渲染路径上抛异常
 * 会把整只桌宠带黑（`boot()` 里一段抛错等于窗口空白），所以缺席用 null + 明确降级更安全。</p>
 *
 * @param poses 清单
 * @param posture 姿态 id
 * @returns 批次；不存在时 null
 */
export function batchOf(poses: PetPoses, posture: PostureId): PoseBatch | null {
  return poses.batches[posture] ?? null;
}

/**
 * 取某个 id 的**全部**片段（可能有多条：`walk`/`run` 的 `cycle` 左右各一条）。
 *
 * <p>这是"同 id 多朝向"的显式出口：调用方自己按 `facing` 挑，
 * 不存在"取第一条"这种隐式行为。</p>
 *
 * @param batch 批次
 * @param clipId 片段 id
 * @returns 片段列表（无匹配时为空数组；顺序即清单顺序）
 */
export function clipsOf(batch: PoseBatch, clipId: string): readonly PoseClip[] {
  return batch.clips.filter((clip) => clip.id === clipId);
}

/**
 * 取一个片段：**`id` + `facing` 双键定位**。
 *
 * <p>`facing` 是必填参数（没有默认值），所以"忘了朝向"在编译期就被拦住，
 * 不会像旧实现那样在多朝向批次里静默拿到左向那条。要"某 id 的所有条"用 {@link clipsOf}。</p>
 *
 * @param batch 批次
 * @param clipId 片段 id
 * @param facing 朝向（`-1` 左 / `1` 右）
 * @returns 片段；不存在时 null
 */
export function clipOf(batch: PoseBatch, clipId: string, facing: Facing): PoseClip | null {
  if (facing !== -1 && facing !== 1) {
    // 运行期兜底：JS 调用方可能绕过类型（例如测试里构造的宽松对象）
    throw new TypeError(`[pet-poses] clipOf 的 facing 只能是 -1 或 1，实际为 ${JSON.stringify(facing)}`);
  }
  return batch.clips.find((clip) => clip.id === clipId && clip.facing === facing) ?? null;
}

/**
 * 取一帧。
 *
 * @param batch 批次
 * @param frameId 帧 id
 * @returns 帧；不存在时 null
 */
export function frameOf(batch: PoseBatch, frameId: string): PoseFrame | null {
  return batch.frames[frameId] ?? null;
}

/**
 * 判断某姿态在运行时**是否可播**（`playable` 的唯一判据）。
 *
 * <p>三个条件缺一不可：①批次存在；②在 `accepted[]` 里（工程侧显式登记）；
 * ③至少有一条片段，其帧全部齐全<b>且</b>每帧所用朝向在 `bodyAnchor.byFacing` 里声明过
 * （`jump` 右向帧在产时就会出现"有帧没锚"，此时该片段判不可播，绝不拿左向帧镜像冒充）。</p>
 *
 * @param poses 清单
 * @param posture 姿态 id
 * @returns 是否可播
 */
export function isPlayable(poses: PetPoses, posture: PostureId): boolean {
  if (posture === 'stand') return true;
  if (!poses.accepted.includes(posture)) return false;
  const batch = batchOf(poses, posture);
  if (!batch) return false;
  return batch.clips.some((clip) => {
    if (clip.frames.length === 0) return false;
    return clip.frames.every((frameId) => {
      const frame = batch.frames[frameId];
      if (!frame) return false;
      const anchor = batch.bodyAnchor.byFacing[frame.facing === 1 ? '1' : '-1'];
      return anchor !== undefined && frame.files['1x'] !== undefined && frame.files['2x'] !== undefined;
    });
  });
}

/**
 * 按 DPR 挑密度档（`>= 1.5` 用 `@2x`，与既有 `plan.density` 口径一致）。
 *
 * <p><b>DPR 只决定挑文件，不参与任何几何换算</b>：窗口尺寸单位是 DIP，CSS px 即 DIP。
 * 判据：DPR 从 1.0 改到 2.0，`left/top` 必须逐位不变。</p>
 *
 * @param dpr 设备像素比（不可信输入，非有限数按 1 处理）
 * @returns 密度档
 */
export function densityFor(dpr: number): Density {
  const value = Number.isFinite(dpr) ? dpr : 1;
  return value >= 1.5 ? '2x' : '1x';
}

/** 站姿原生画布宽（对外的便捷出口，测试与调试面板都用它）。 */
export const STAND_NATIVE_CANVAS_WIDTH: number = standNativeCanvasWidth(PET_POSES.scale);

/** 当前清单的母版倍率（= nativeToCss / masterToCss，正常为 2）。 */
export const PET_POSES_MASTER_SCALE: number = masterScaleOf(PET_POSES.scale);
