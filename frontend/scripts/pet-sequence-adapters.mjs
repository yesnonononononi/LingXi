/**
 * 美术 `gif-v1` manifest → `pet-sequences.json` 的**构建期适配器**。
 *
 * <p><b>它只干一件事：把"美术的交付形态"翻成"运行时的编排形态"</b>，且一个字段的来源
 * 都能指回美术原文件。像素转码、体积核算、写盘都不归它管（那是
 * `build-pet-sequences.mjs` 的事），它只产出**草稿**：哪几层、每一步多少毫秒、
 * 每一步引用哪个 slot、每个 slot 的母版 PNG 在哪。</p>
 *
 * <p><b>为什么"未登记键即硬失败"：</b>pose 侧三种 manifest 写法并存，所以有显式 adapter；
 * 序列侧只有一种写法，但风险不是"写法多"而是"字段悄悄多出来"——美术新加一个 `dy2`
 * 或把 `ms` 改名成 `duration`，适配器如果只是因为"读不到就当 0"而继续跑，运行时会按
 * **错误的时序**演一遍，而门禁全绿。所以这里用**正向白名单**：源 manifest 的顶层键必须是
 * {@link KNOWN_SOURCE_KEYS} 里登记过的，多一个就抛 {@link TypeError}。</p>
 *
 * <p><b>本轮范围（T05/B1）：只做 `cloud_react`。</b>`play_cloud`（双角色 + 握持 + 手掌层）
 * 与 `sit_blink`（主角帧序列）显式登记在 {@link DEFERRED_SEQUENCES} 里——
 * "没做"必须是一句能贴进验收记录的实话，不是"忘了"。</p>
 *
 * @module scripts/pet-sequence-adapters
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Of } from './build-pet-assets.mjs';
import { readJsonFile } from './build-pet-geometry.mjs';
import { readImageSize } from './pet-image-headers.mjs';

/** `frontend/` 根（本模块与 `scripts/` 同级）。 */
const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 美术源根（**只读**：美术域，前端任何人不得修改）。 */
export const SOURCE_ROOT = 'docs/assets/desktop-pet/supplemental/gif-v1';

/** 美术源 manifest 文件名。 */
export const SOURCE_MANIFEST_FILE = 'manifest.json';

/** pose 运行时清单路径：`stageToCss` 从它读（同一舞台坐标系，比例只许一个真源）。 */
export const POSES_RUNTIME_JSON_PATH = resolve(FRONTEND_ROOT, 'pet-poses.json');

/** 运行时代码/清单里用的适配器标识（写进 `provenance.adapter`）。 */
export const SEQUENCE_ADAPTER_ID = 'gif-v1-steps';

/** 本轮真正产出的场景（**只有它**；其余见 {@link DEFERRED_SEQUENCES}）。 */
export const SUPPORTED_SCENES = Object.freeze(['cloud_react']);

/**
 * 未进入本轮的序列与原因（"没做"与"做坏了"必须是两句不同的话）。
 *
 * <p>理由都指向具体缺口，不写"后续再说"这类空话。</p>
 */
export const DEFERRED_SEQUENCES = Object.freeze([
  Object.freeze({
    scene: 'play_cloud',
    reason: '双角色编排（主角三帧 + 伙伴 + 手掌层 + 握持点 G-S2 + 叠放序）属 B2；B1 只验"序列资产能跑通"',
  }),
  Object.freeze({
    scene: 'sit_blink',
    reason: '主角帧序列（帧只存 id、经 PoseController.showFrame 上屏）属 B2；pose 域本轮禁改',
  }),
]);

/** sequence 层的合法 id（美术 `placement.order` 用 `sit_hug_hands` 表示手掌层）。 */
export const SEQUENCE_LAYER_IDS = Object.freeze(['protagonist', 'companion', 'hands']);

/**
 * 美术 `placement.order` 里的层名 → 运行时层 id。
 *
 * <p>写成显式别名表而不是"字符串裁剪"：美术的 `sit_hug_hands` 与运行时的 `hands` 不是
 * 拼写差异，是命名域不同；裁剪式转换会在美术改名时静默错位。</p>
 */
export const LAYER_ALIASES = Object.freeze({
  protagonist: 'protagonist',
  companion: 'companion',
  sit_hug_hands: 'hands',
});

/**
 * 美术 manifest 顶层允许出现的键（**正向白名单**，未登记即硬失败）。
 *
 * <p>列全 20 个是故意的：这张表本身就是"美术交付契约"的一行摘要，
 * 将来美术加键，这里必须留一行解释它是什么、有没有被消费。</p>
 */
export const KNOWN_SOURCE_KEYS = Object.freeze([
  'version',
  'assetId',
  'status',
  'scope',
  'generator',
  'dependencies',
  'nativeCanvas',
  'masterScale',
  'colorSpace',
  'alpha',
  'anchors',
  'placement',
  'masks',
  'sourceMode',
  'baseReferences',
  'clips',
  'gif',
  'files',
  'sources',
  'review',
  'deferred',
]);

/** 适配器**真正消费**的键（写进 `provenance.consumedKeys`，字段漂移检测的锚）。 */
export const CONSUMED_SOURCE_KEYS = Object.freeze([
  'nativeCanvas',
  'anchors',
  'placement',
  'baseReferences',
  'clips',
  'files',
]);

/** clip 级别允许出现的键。 */
export const KNOWN_CLIP_KEYS = Object.freeze(['file', 'canvas', 'loop', 'frames', 'frameMs', 'steps', 'stageScale']);

/** step 级别允许出现的键（`protagonist` / `companion*` 是 B2 的形态，先登记）。 */
export const KNOWN_STEP_KEYS = Object.freeze([
  'phase',
  'frame',
  'dy',
  'ms',
  'protagonist',
  'companion',
  'companionCenterX',
  'companionFootY',
]);

/**
 * 序列帧 slot 的真源：美术 `steps[].frame` 的取值 → 运行时 slot + 母版 PNG。
 *
 * <p><b>为什么母版路径写死在这里：</b>它是"美术交付物在哪"的事实，不是可推导的计算。
 * 写死 + 构建期 sha256 校验（`baseReferences` / `files` 里美术已给出摘要），
 * 一旦有人替换母版，构建立刻红——这比"按文件名猜"可靠得多。</p>
 *
 * <p>`cloud_neutral` 只有 512² 一份（`companion/v1` 的 native 交付，没有 `@2x`）；
 * `cloud_happy` 取 `frames/cloud_happy@2x.png`（1024² 母版）。两档密度都由母版降采样，
 * 所以"源是 512 还是 1024"不影响目标尺寸，只影响锐度余量。</p>
 */
export const FRAME_SOURCES = Object.freeze({
  cloud_neutral: Object.freeze({
    slot: 'neutral',
    layer: 'companion',
    file: 'docs/assets/desktop-pet/companion/v1/cloudling_neutral.png',
    /** 摘要来自美术 manifest 的哪个表（构建期按该表校验）。 */
    reference: 'baseReferences',
  }),
  cloud_happy: Object.freeze({
    slot: 'happy',
    layer: 'companion',
    file: 'docs/assets/desktop-pet/supplemental/gif-v1/frames/cloud_happy@2x.png',
    reference: 'files',
  }),
});

/**
 * 断言对象是普通对象。
 *
 * @param {unknown} value 待检查值
 * @param {string} name 字段路径（报错用）
 * @returns {Record<string, any>} 对象
 * @throws {TypeError} 不是对象
 */
function requireObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`[pet-sequences] ${name} 必须是对象，实际为 ${JSON.stringify(value)}`);
  }
  return /** @type {Record<string, any>} */ (value);
}

/**
 * 断言是正有限数值。
 *
 * @param {unknown} value 待检查值
 * @param {string} name 字段路径
 * @returns {number} 数值
 * @throws {TypeError} 不是正有限数值
 */
function requirePositive(value, name) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new TypeError(`[pet-sequences] ${name} 必须是正的有限数值，实际为 ${JSON.stringify(value)}`);
  }
  return num;
}

/**
 * 断言是 `[x, y]` 形态的二元数组。
 *
 * @param {unknown} value 待检查值
 * @param {string} name 字段路径
 * @returns {[number, number]} 二元数组
 * @throws {TypeError} 形态非法
 */
function requirePair(value, name) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(`[pet-sequences] ${name} 必须是长度 2 的数组，实际为 ${JSON.stringify(value)}`);
  }
  return [requirePositive(value[0], `${name}[0]`), requirePositive(value[1], `${name}[1]`)];
}

/**
 * 校验一个对象只出现白名单里的键（未登记键即抛错）。
 *
 * @param {Record<string, any>} record 对象
 * @param {readonly string[]} allowed 允许的键
 * @param {string} name 字段路径
 * @throws {TypeError} 出现未登记的键
 */
function assertKnownKeys(record, allowed, name) {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  throw new TypeError(
    `[pet-sequences] ${name} 出现未登记的键：${unknown.join(' / ')}` +
      `（只允许：${allowed.join(' / ')}）—— 静默忽略一个字段，代价是运行时按错的时序演一遍`,
  );
}

/**
 * 校验美术 manifest 里所有会被消费的层都没出现未登记的键。
 *
 * @param {Record<string, any>} manifest 美术 manifest
 * @throws {TypeError} 出现未登记的键
 */
export function assertSourceSchema(manifest) {
  assertKnownKeys(requireObject(manifest, 'manifest'), KNOWN_SOURCE_KEYS, 'manifest');
  const clips = requireObject(manifest.clips, 'manifest.clips');
  for (const [clipId, clip] of Object.entries(clips)) {
    const record = requireObject(clip, `manifest.clips.${clipId}`);
    assertKnownKeys(record, KNOWN_CLIP_KEYS, `manifest.clips.${clipId}`);
    const steps = record.steps;
    if (steps === undefined) continue;
    if (!Array.isArray(steps)) {
      throw new TypeError(`[pet-sequences] manifest.clips.${clipId}.steps 必须是数组`);
    }
    steps.forEach((step, index) => {
      const entry = requireObject(step, `manifest.clips.${clipId}.steps[${index}]`);
      assertKnownKeys(entry, KNOWN_STEP_KEYS, `manifest.clips.${clipId}.steps[${index}]`);
    });
  }
}

/**
 * 读美术源（manifest 原文 + 它的 sha256）。
 *
 * @param {object} [options] 选项
 * @param {string} [options.repoRoot] 仓库根（缺省自动发现）
 * @returns {{manifest: Record<string, any>, sourceSha256: string, sourcePath: string}} 源
 * @throws {Error} 源不存在或不可解析
 */
export function readSequenceSource(options = {}) {
  const repoRoot = options.repoRoot ?? discoverRepoRootSafe();
  const sourcePath = resolve(repoRoot, SOURCE_ROOT, SOURCE_MANIFEST_FILE);
  if (!existsSync(sourcePath)) {
    throw new Error(`[pet-sequences] 美术源 manifest 不存在：${sourcePath}（不许凭空造清单）`);
  }
  const manifest = readJsonFile(sourcePath);
  return { manifest, sourceSha256: sha256Of(sourcePath), sourcePath };
}

/**
 * 延迟取"仓库根"（避免与 build 脚本形成导入环：`discoverRepoRoot` 住在 layers 管线里）。
 *
 * @returns {string} 仓库根（`frontend/` 的上一级）
 */
function discoverRepoRootSafe() {
  return resolve(FRONTEND_ROOT, '..');
}

/**
 * 从美术 manifest 里取一层的几何（画布 / 源画布 / 锚点 / 握持点）。
 *
 * <p><b>三个尺寸域必须分清：</b>`canvas` 是**舞台域**的层盒子（400×400，设计 §7.5 的公式用它），
 * `sourceCanvas` 是**母版域**（伙伴 512²，锚点/握持点都在这个域里），两者之比就是
 * `gripStageY` 里的 `k`。少写 `sourceCanvas` 的话，B2 只能靠"猜 512"来算握持点。</p>
 *
 * @param {Record<string, any>} manifest 美术 manifest
 * @returns {Record<string, any>} companion 层
 */
export function companionLayerOf(manifest) {
  const nativeCanvas = requireObject(manifest.nativeCanvas, 'manifest.nativeCanvas');
  const anchors = requireObject(manifest.anchors, 'manifest.anchors');
  const placement = requireObject(manifest.placement, 'manifest.placement');
  const [canvasWidth, canvasHeight] = requirePair(placement.companionCanvas, 'manifest.placement.companionCanvas');
  const [sourceWidth, sourceHeight] = requirePair(nativeCanvas.companion, 'manifest.nativeCanvas.companion');
  const [footX, footY] = requirePair(anchors.companionFoot, 'manifest.anchors.companionFoot');
  const [gripX, gripY] = requirePair(anchors.companionGrip, 'manifest.anchors.companionGrip');
  if (gripY > footY) {
    throw new RangeError(
      `[pet-sequences] 握持点 y (${gripY}) 不许低于脚底 y (${footY})：` +
        '握持点在画布上方，写反会让 gripStage 算到脚底下（B2 的"不脱手"判据直接失效）',
    );
  }
  return {
    id: 'companion',
    kind: 'sequence-frames',
    canvas: { width: canvasWidth, height: canvasHeight },
    sourceCanvas: { width: sourceWidth, height: sourceHeight },
    anchor: { x: footX, y: footY },
    grip: { x: gripX, y: gripY },
  };
}

/**
 * 校验美术声明的叠放序（`placement.order`）与本轮交付的层序一致。
 *
 * <p>叠放序**固定**、不许运行时算（设计 §7.4）：数组下标即 z 序。B1 只交付 companion 一层，
 * 所以只要求"已交付层在美术序里的相对先后"正确。</p>
 *
 * @param {Record<string, any>} manifest 美术 manifest
 * @param {readonly string[]} deliveredLayerIds 已交付的层 id（按 z 序）
 * @returns {string[]} 问题列表
 */
export function checkLayerOrder(manifest, deliveredLayerIds) {
  const problems = [];
  const placement = requireObject(manifest.placement, 'manifest.placement');
  const order = placement.order;
  if (!Array.isArray(order) || order.length === 0) {
    problems.push('manifest.placement.order 缺失或为空：叠放序没有真源（B2 的"云在手上"判据要读它）');
    return problems;
  }
  const mapped = order.map((name) => LAYER_ALIASES[name] ?? null);
  const unknown = order.filter((name, index) => mapped[index] === null);
  if (unknown.length > 0) {
    problems.push(`manifest.placement.order 出现未登记的层名：${unknown.join(' / ')}（先登记 LAYER_ALIASES）`);
  }
  const known = mapped.filter((id) => id !== null);
  for (const id of deliveredLayerIds) {
    if (!known.includes(id)) problems.push(`已交付层 ${id} 不在美术叠放序 [${known.join(', ')}] 里`);
  }
  const positions = deliveredLayerIds.map((id) => known.indexOf(id)).filter((index) => index >= 0);
  const sorted = [...positions].sort((left, right) => left - right);
  if (positions.join(',') !== sorted.join(',')) {
    problems.push(`已交付层的 z 序 [${deliveredLayerIds.join(', ')}] 与美术叠放序不一致（下标即 z 序，不许运行时重排）`);
  }
  return problems;
}

/**
 * 把 `cloud_react` 的 step 列表翻成运行时 step（纯函数）。
 *
 * @param {Record<string, any>} clip 美术 clip
 * @param {string} [sceneId] 场景名（只用于报错定位，缺省 `cloud_react`）
 * @returns {Array<Record<string, any>>} 运行时 step
 * @throws {TypeError} step 形态非法 / 引用了未登记的帧
 */
export function adaptCloudReactSteps(clip, sceneId = 'cloud_react') {
  const steps = clip.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new TypeError(`[pet-sequences] ${sceneId} 没有任何 step（空序列不是可播放内容）`);
  }
  const adapted = [];
  for (const [index, raw] of steps.entries()) {
    const step = requireObject(raw, `manifest.clips.${sceneId}.steps[${index}]`);
    const ms = requirePositive(step.ms, `manifest.clips.${sceneId}.steps[${index}].ms`);
    const frameName = step.frame;
    const source = typeof frameName === 'string' ? FRAME_SOURCES[frameName] : undefined;
    if (!source) {
      throw new TypeError(
        `[pet-sequences] ${sceneId} 第 ${index} 步引用了未登记的帧 ${JSON.stringify(frameName)}` +
          `（已登记：${Object.keys(FRAME_SOURCES).join(' / ')}）`,
      );
    }
    if (source.layer !== 'companion') {
      throw new TypeError(`[pet-sequences] ${sceneId} 第 ${index} 步的帧属于 ${source.layer} 层，B1 只交付 companion 层`);
    }
    const dy = step.dy === undefined ? 0 : Number(step.dy);
    if (!Number.isFinite(dy)) {
      throw new TypeError(`[pet-sequences] ${sceneId} 第 ${index} 步的 dy 不是有限数值：${JSON.stringify(step.dy)}`);
    }
    /** @type {Record<string, any>} */
    const entry = { ms, frames: { companion: source.slot }, companionDy: dy };
    if (typeof step.phase === 'string' && step.phase.length > 0) entry.phase = step.phase;
    adapted.push(entry);
  }
  return adapted;
}

/**
 * 整条适配：读源 → 校验 → 出草稿。
 *
 * @param {object} [options] 选项
 * @param {string} [options.repoRoot] 仓库根
 * @param {(message: string) => void} [options.log] 日志出口
 * @returns {{draft: Record<string, any>|null, problems: string[], notes: string[], deferred: ReadonlyArray<{scene: string, reason: string}>}} 结果
 */
export function adaptSequences(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const problems = [];
  const notes = [];
  let source;
  try {
    source = readSequenceSource({ repoRoot: options.repoRoot });
  } catch (err) {
    // 美术目录缺失是**合法中间态**，但必须说出来（同 pose 口径："没检查"≠"检查通过"）
    problems.push((err && err.message) || String(err));
    return { draft: null, problems, notes, deferred: DEFERRED_SEQUENCES };
  }
  const { manifest, sourceSha256 } = source;
  try {
    assertSourceSchema(manifest);
  } catch (err) {
    problems.push((err && err.message) || String(err));
    return { draft: null, problems, notes, deferred: DEFERRED_SEQUENCES };
  }

  const nativeCanvas = requireObject(manifest.nativeCanvas, 'manifest.nativeCanvas');
  const [stageWidth, stageHeight] = requirePair(nativeCanvas.playStage, 'manifest.nativeCanvas.playStage');
  const companion = companionLayerOf(manifest);
  problems.push(...checkLayerOrder(manifest, [companion.id]));

  const clips = requireObject(manifest.clips, 'manifest.clips');
  const scenes = {};
  /** @type {Record<string, Record<string, any>>} */
  const frames = {};
  const frameOrder = [];
  let stepTotal = 0;
  let durationMs = 0;

  for (const sceneId of SUPPORTED_SCENES) {
    const clip = clips[sceneId];
    if (clip === undefined) {
      problems.push(`美术 manifest 里没有 ${sceneId}（已支持的场景缺源 ⇒ 不许凭空造清单）`);
      continue;
    }
    const steps = adaptCloudReactSteps(clip, sceneId);
    // 登记本场景用到的 slot（首见序，稳定可 diff）
    for (const step of steps) {
      const slot = step.frames.companion;
      const frameKey = `${sceneId}/${slot}`;
      if (frames[frameKey] !== undefined) continue;
      const sourceName = Object.keys(FRAME_SOURCES).find((name) => FRAME_SOURCES[name].slot === slot);
      const sourceFrame = FRAME_SOURCES[sourceName];
      frames[frameKey] = {
        layer: companion.id,
        slot,
        /** 美术侧的帧名（排障用；运行时只认 slot）。 */
        sourceFrame: sourceName ?? slot,
        sourceFile: sourceFrame.file,
        reference: sourceFrame.reference,
      };
      frameOrder.push(frameKey);
    }
    scenes[sceneId] = {
      loop: clip.loop === true,
      onEnd: null,
      steps,
    };
    stepTotal += steps.length;
    durationMs += steps.reduce((sum, step) => sum + step.ms, 0);
    log(`[pet-sequences] ${sceneId}：${steps.length} 步 / ${durationMs} ms`);
  }

  // slot → 母版摘要校验：美术 manifest 自己给了 sha256，构建期比对（母版被换过就红）
  for (const key of frameOrder) {
    const entry = frames[key];
    const expected = expectedShaOf(manifest, entry);
    if (expected === null) {
      problems.push(`${key} 的母版 ${entry.sourceFile} 在美术 manifest 的 ${entry.reference} 里查不到 sha256（查不到 = 判红，不许跳过）`);
      continue;
    }
    const absolute = resolve(discoverRepoRootSafe(), entry.sourceFile);
    if (!existsSync(absolute)) {
      problems.push(`${key} 的母版不存在：${absolute}`);
      continue;
    }
    const actual = sha256Of(absolute);
    if (actual !== expected) {
      problems.push(`${key} 的母版 sha256 与美术 manifest 不一致：盘上 ${actual.slice(0, 12)}… ≠ 声明 ${expected.slice(0, 12)}…`);
      continue;
    }
    const size = readImageSize(absolute);
    if (size.width / size.height !== companion.canvas.width / companion.canvas.height) {
      problems.push(
        `${key} 的母版 ${size.width}×${size.height} 与层画布 ${companion.canvas.width}×${companion.canvas.height} 比例不一致` +
          '（等比 contain 会留白或裁切）',
      );
    }
    entry.sourceSize = { width: size.width, height: size.height };
  }

  // stageToCss 的唯一真源是 pose 运行时清单（同一舞台坐标系），不在这里写第二份比例字面量
  let stageToCss = 0;
  try {
    const poses = readJsonFile(POSES_RUNTIME_JSON_PATH);
    stageToCss = Number(poses?.scale?.nativeToCss);
    if (!Number.isFinite(stageToCss) || stageToCss <= 0) {
      throw new RangeError(`pet-poses.json 的 scale.nativeToCss 不是正数：${JSON.stringify(poses?.scale)}`);
    }
  } catch (err) {
    problems.push(`读不到 stageToCss（${(err && err.message) || err}）：序列与 pose 必须共用同一舞台比例`);
  }

  notes.push(
    `已支持场景：${SUPPORTED_SCENES.join('、')}（deferred：${DEFERRED_SEQUENCES.map((item) => item.scene).join('、')}）`,
  );
  if (problems.length > 0) {
    return { draft: null, problems, notes, deferred: DEFERRED_SEQUENCES };
  }

  return {
    draft: {
      version: 1,
      generatedBy: 'scripts/build-pet-sequences.mjs',
      sourceRoot: SOURCE_ROOT,
      scale: { stageToCss },
      stage: { width: stageWidth, height: stageHeight },
      layers: [companion],
      scenes,
      frames: Object.fromEntries(frameOrder.map((key) => [key, frames[key]])),
      totals: { scenes: Object.keys(scenes).length, steps: stepTotal, bytes1x: 0, bytes2x: 0, durationMs },
      provenance: {
        adapter: SEQUENCE_ADAPTER_ID,
        manifestSha256: sourceSha256,
        consumedKeys: [...CONSUMED_SOURCE_KEYS],
      },
      deferred: DEFERRED_SEQUENCES.map((item) => ({ scene: item.scene, reason: item.reason })),
    },
    problems,
    notes,
    deferred: DEFERRED_SEQUENCES,
  };
}

/**
 * 在美术 manifest 里查一个 slot 母版声明的 sha256。
 *
 * @param {Record<string, any>} manifest 美术 manifest
 * @param {Record<string, any>} entry 帧条目（含 `sourceFile` / `reference`）
 * @returns {string|null} 摘要；查不到返回 null（调用方判红）
 */
export function expectedShaOf(manifest, entry) {
  const tables = [manifest.baseReferences, manifest.files, manifest.sources];
  const wanted = entry.sourceFile;
  for (const table of tables) {
    if (!Array.isArray(table)) continue;
    for (const item of table) {
      if (item === null || typeof item !== 'object') continue;
      const file = typeof item.file === 'string' ? item.file : '';
      if (file.length === 0) continue;
      // 美术表里的路径是**相对 gif-v1 目录**的（如 `../../companion/v1/cloudling_neutral.png`），
      // 盘上路径是**相对仓库根**的；只比较归一化后的尾部，避免为了对齐写两套路径表
      if (!normalizeTail(entry.sourceFile).endsWith(normalizeTail(file))) continue;
      const sha = typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : '';
      if (/^[0-9a-f]{64}$/.test(sha)) return sha;
    }
  }
  return null;
}

/**
 * 把路径归一化成"无 `.` / `..` 的尾部片段序列"（只用于跨写法比较，不做真实路径解析）。
 *
 * <p>美术表里的路径是**相对 gif-v1 目录**的（`../../companion/v1/cloudling_neutral.png`），
 * 盘上路径是**相对仓库根**的（`docs/assets/desktop-pet/companion/v1/cloudling_neutral.png`）。
 * 丢掉前导 `..` 之后两者尾部相同，于是不必维护第二张路径表。</p>
 *
 * @param {string} file 相对路径
 * @returns {string} 归一化后的 POSIX 路径
 */
function normalizeTail(file) {
  return String(file)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/');
}
