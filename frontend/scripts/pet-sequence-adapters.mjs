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
 * <p><b>本轮范围（T05/B2）：`cloud_react`（伙伴单层）+ `play_cloud`（主角 / 伙伴 / 手掌三层）。</b></p>
 *
 * <p><b>`sit_blink` 不再是序列：</b>B1 曾把它登记在 deferred 里，但它是 **sit 姿态的
 * 一条片段**（"坐着眨眼"是姿态在动，不是一次编排），落点是 `pet-poses.json` 的 sit 批
 * （见 `scripts/pet-pose-adapters.mjs` 的 `SUPPLEMENTAL_SIT_BLINK`）。所以这里把它从
 * deferred 里**删掉**——"没做"与"放错了域"是两句不同的话，留着 deferred 会让
 * 阅读者以为它还欠一次序列交付。</p>
 *
 * <p><b>主角层为什么是 `sequence-frames` 而不是 `pose-frames`：</b>`play_cloud` 的三张主角帧
 * （`sit_welcome` / `sit_hug` / 坐姿中性）是**演出帧**，它们不属于任何姿态片段；
 * 若把它们塞进 `pet-poses.json` 的 sit 批，就会触发 G-P4 孤儿帧判据（帧存在但没有片段引用
 * ⇒ 白占体积且永远不播），唯一"绕过"办法是编一条永不选中的片段——那是拿数据撒谎。
 * 序列域本来就允许多层各演各的（设计 §7.1），所以主角帧与伙伴帧一样走
 * `public/live2d/pet-sequences/**`，`pose-frames` 这条 kind 仍保留给"序列想借用姿态帧"
 * 的场景（运行时与门禁两条路都支持，`PoseController.showFrame` 就是它的窄接口）。</p>
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

/** 本轮真正产出的场景（**只有它们**；其余见 {@link DEFERRED_SEQUENCES}）。 */
export const SUPPORTED_SCENES = Object.freeze(['cloud_react', 'play_cloud']);

/**
 * 未进入本轮的序列与原因（"没做"与"做坏了"必须是两句不同的话）。
 *
 * <p><b>现在是空表，而且它必须能被解释：</b>美术 `gif-v1` 交付的三条 clip 里，
 * `cloud_react` / `play_cloud` 已落地成序列，`sit_blink` 落成 sit 姿态的一条片段
 * （见模块注释）。所以"当前没有任何未进入运行时的序列"是**事实**，不是"还没填"。
 * 将来美术再交 clip，这里按同一纪律先登记理由。</p>
 */
export const DEFERRED_SEQUENCES = Object.freeze([]);

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
  /**
   * 主角中性坐姿（`play_cloud` 第 0 步与末步）。
   *
   * <p>母版取 `poses/sit/source/sit_neutral_native.png`（1024×1536 native）：它就是
   * 坐姿姿态帧的**同一份画稿**，让"一开始坐着"与"坐着不动"逐像素一致；摘要由美术
   * `baseReferences` 声明，构建期比对。</p>
   */
  sit_neutral: Object.freeze({
    slot: 'sit_neutral',
    layer: 'protagonist',
    file: 'docs/assets/desktop-pet/poses/sit/source/sit_neutral_native.png',
    reference: 'baseReferences',
  }),
  /** 主角"伸手迎接"（靠近段与放回段）。母版 2048×3072（`@2x`）。 */
  sit_welcome: Object.freeze({
    slot: 'sit_welcome',
    layer: 'protagonist',
    file: 'docs/assets/desktop-pet/supplemental/gif-v1/frames/sit_welcome@2x.png',
    reference: 'files',
  }),
  /** 主角"抱住"（接触段与回应段）。母版 2048×3072（`@2x`）。 */
  sit_hug: Object.freeze({
    slot: 'sit_hug',
    layer: 'protagonist',
    file: 'docs/assets/desktop-pet/supplemental/gif-v1/frames/sit_hug@2x.png',
    reference: 'files',
  }),
  /**
   * 前景手掌层（**独立层**，`placement.order` 的第 3 项 `sit_hug_hands`）。
   *
   * <p>它必须是独立层而不是并进 `sit_hug`：手要压在云上面、身体要压在云下面，
   * 一条"主角帧叠伙伴帧"的二元关系表达不了这个三明治（美术 README 的分层约定）。
   * 母版 1024×1536 native，与主角层同画布同锚点 ⇒ 两层的 CSS 盒子逐像素相同。</p>
   */
  sit_hug_hands: Object.freeze({
    slot: 'hug',
    layer: 'hands',
    file: 'docs/assets/desktop-pet/supplemental/gif-v1/frames/sit_hug_hands_native.png',
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
 * 握持判据的容差（**CSS px**，不是舞台单位）。
 *
 * <p>为什么不用"≤2 舞台单位"：2 舞台单位 = 0.3 CSS px，比一个亚像素还小，等于把
 * "响应段里云朵弹一下（美术给了 `footY 1147 → 1141`，6 舞台单位 = 0.92 CSS px）"
 * 这种**用户看不见**的细节判成红；而真正的"没抱住"是几十 CSS px（例如把 `footY`
 * 写成放回段的 1260 ⇒ 偏 13 CSS px）。判据按用户可见量表达才守得住真问题。</p>
 */
export const GRIP_TOLERANCE_CSS_PX = 1;

/**
 * 伙伴层在某一组舞台坐标下的**握持点**（舞台域）。
 *
 * <p>公式（与 `companionBoxOf` 同一套换算）：`k = canvas.width / sourceCanvas.width`；
 * `gripStageX = centerX + (grip.x − anchor.x) × k`；
 * `gripStageY = footY − (anchor.y − grip.y) × k`。</p>
 *
 * <p>验算（美术数据自身）：`k = 400/512 = 0.78125`、`anchor.y − grip.y = 470−333 = 137`，
 * 抱起步 `footY = 1147` ⇒ `1147 − 137 × 0.78125 = 1039.97`，与 `hugGripStage.y = 1040`
 * 相差 0.03 舞台单位 —— 这就是"美术的握持点与运行时落点公式是同一件事"的证据。</p>
 *
 * @param {Record<string, any>} layer 伙伴层
 * @param {Record<string, any>} step 本步
 * @returns {{x: number, y: number}|null} 握持点；缺几何时 null
 */
export function companionGripStageOf(layer, step) {
  const canvas = layer?.canvas;
  const source = layer?.sourceCanvas;
  const anchor = layer?.anchor;
  const grip = layer?.grip;
  if (!canvas || !source || !anchor || !grip) return null;
  if (!(source.width > 0)) return null;
  const centerX = Number(step?.companionCenterX);
  const footY = Number(step?.companionFootY);
  if (!Number.isFinite(centerX) || !Number.isFinite(footY)) return null;
  const k = canvas.width / source.width;
  return {
    x: centerX + (Number(grip.x) - Number(anchor.x)) * k,
    y: footY - (Number(anchor.y) - Number(grip.y)) * k,
  };
}

/**
 * 美术声明的"抱起时云朵该被握在哪"（舞台域，`placement.hugGripStage`）。
 *
 * @param {Record<string, any>} manifest 美术 manifest
 * @returns {{x: number, y: number}} 握持点
 */
export function hugGripStageOf(manifest) {
  const placement = requireObject(manifest.placement, 'manifest.placement');
  const [x, y] = requirePair(placement.hugGripStage, 'manifest.placement.hugGripStage');
  return { x, y };
}

/**
 * 主角层（`sequence-frames`）：画布 = 美术 `placement.protagonistCanvas`（1024×1536 舞台域），
 * 源画布 = `nativeCanvas.protagonist`（同值 ⇒ `k = canvas/sourceCanvas = 1`），
 * 锚点 = `anchors.protagonistBody`（474,1454，坐下时的躯干质心与接地线）。
 *
 * <p>三个字段都必须来自美术 manifest：主角层与手掌层要**逐像素重合**在坐姿画布上，
 * 任何一处"工程侧猜一个 1024"都会让手掌偏离手掌位置几像素。</p>
 *
 * @param {Record<string, any>} manifest 美术 manifest
 * @returns {Record<string, any>} protagonist 层
 */
export function protagonistLayerOf(manifest) {
  const nativeCanvas = requireObject(manifest.nativeCanvas, 'manifest.nativeCanvas');
  const anchors = requireObject(manifest.anchors, 'manifest.anchors');
  const placement = requireObject(manifest.placement, 'manifest.placement');
  const [canvasWidth, canvasHeight] = requirePair(placement.protagonistCanvas, 'manifest.placement.protagonistCanvas');
  const [sourceWidth, sourceHeight] = requirePair(nativeCanvas.protagonist, 'manifest.nativeCanvas.protagonist');
  const [anchorX, anchorY] = requirePair(anchors.protagonistBody, 'manifest.anchors.protagonistBody');
  if (canvasWidth !== sourceWidth || canvasHeight !== sourceHeight) {
    throw new RangeError(
      `[pet-sequences] 主角层 canvas ${canvasWidth}×${canvasHeight} 与 sourceCanvas ${sourceWidth}×${sourceHeight} 不等：` +
        '两者不等就意味着"舞台域 ≠ 母版域"，锚点会按错的域换算（四倍偏差那个坑）',
    );
  }
  if (anchorX > sourceWidth || anchorY > sourceHeight) {
    throw new RangeError(
      `[pet-sequences] 主角层锚点 (${anchorX}, ${anchorY}) 越出源画布 ${sourceWidth}×${sourceHeight}：锚点与画布不同域`,
    );
  }
  return {
    id: 'protagonist',
    kind: 'sequence-frames',
    canvas: { width: canvasWidth, height: canvasHeight },
    sourceCanvas: { width: sourceWidth, height: sourceHeight },
    anchor: { x: anchorX, y: anchorY },
  };
}

/**
 * 前景手掌层：与主角层**同一画布、同一锚点**（美术 `sit_hug_hands_native.png` 就是坐姿母版
 * 同尺寸的一张透明前景），所以它的 CSS 盒子与主角层逐像素相同——手才会长在手腕上。
 *
 * @param {Record<string, any>} manifest 美术 manifest
 * @returns {Record<string, any>} hands 层
 */
export function handsLayerOf(manifest) {
  const protagonist = protagonistLayerOf(manifest);
  return {
    id: 'hands',
    kind: 'sequence-frames',
    canvas: { ...protagonist.canvas },
    sourceCanvas: { ...protagonist.sourceCanvas },
    anchor: { ...protagonist.anchor },
  };
}

/**
 * G-S2 的握持判据：显示手掌层的每一步，云朵都真的被握在 `hugGripStage` 上。
 *
 * <p>判据读的是**每一步自己的坐标**（不是场景级常量），所以"手举着、云飘走了"必然红。</p>
 *
 * <p>容差为什么按 CSS px 而不是舞台单位：2 舞台单位 = 0.3 CSS px，比一个亚像素还小，
 * 等于把"响应段里云朵弹一下"（美术给了 `footY 1147 → 1141`，6 舞台单位 = 0.92 CSS px）
 * 这种**用户看不见**的细节判成红；而真正的"没抱住"是几十 CSS px（把 `footY` 写成
 * 放回段的 1260 ⇒ 偏 13 CSS px）。判据按用户可见量表达才守得住真问题。</p>
 *
 * @param {Array<Record<string, any>>} steps 运行时 step
 * @param {Record<string, any>} companion 伙伴层
 * @param {{x: number, y: number}} hugGripStage 美术声明的握持点
 * @param {number} stageToCss 舞台→CSS 比例
 * @param {string} [sceneId] 场景名（报错定位）
 * @returns {string[]} 问题列表
 */
export function checkHandGrip(steps, companion, hugGripStage, stageToCss, sceneId = 'play_cloud') {
  const problems = [];
  for (const [index, step] of steps.entries()) {
    const showsHands = step?.frames?.hands !== undefined && step.frames.hands !== null;
    if (!showsHands) continue;
    const grip = companionGripStageOf(companion, step);
    if (grip === null) {
      problems.push(`${sceneId} 第 ${index} 步显示手掌层，但伙伴层几何不完整，算不出握持点（握持判据失效 = 允许穿模）`);
      continue;
    }
    const distance = Math.hypot((grip.x - hugGripStage.x) * stageToCss, (grip.y - hugGripStage.y) * stageToCss);
    if (!(distance <= GRIP_TOLERANCE_CSS_PX)) {
      problems.push(
        `${sceneId} 第 ${index} 步显示手掌层（抱住），但云朵握持点 (${grip.x.toFixed(2)}, ${grip.y.toFixed(2)}) ` +
          `离美术 placement.hugGripStage (${hugGripStage.x}, ${hugGripStage.y}) 有 ${distance.toFixed(2)} CSS px` +
          `（容差 ${GRIP_TOLERANCE_CSS_PX} CSS px）——"手举着、云飘走了"正是这条判据守的形态`,
      );
    }
  }
  return problems;
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
 * 把 `play_cloud` 的 step 列表翻成运行时 step（纯函数）。
 *
 * <p>与 `cloud_react` 的差别只有三处，但三处都必须显式表达：</p>
 * <ol>
 *   <li><b>三层各演各的</b>：主角帧来自 `steps[].protagonist`、伙伴帧来自 `steps[].companion`、
 *       手掌层来自"主角是否在抱"（`sit_hug` ⇒ 显示，其余 ⇒ 不写这个键）；</li>
 *   <li><b>伙伴坐标逐步给出</b>：`companionCenterX` / `companionFootY` 是美术逐帧的舞台坐标
 *       （不是"基准 + 偏移"），所以这一步不写 `companionDy`（每一帧都是绝对值，累加会飘）；</li>
 *   <li><b>`phase` 进清单</b>：靠近 / 接触 / 回应 / 放回四段是**编排语义**，门禁与排障要读它，
 *       丢掉就只能靠肉眼猜"第几步才算抱住"。</li>
 * </ol>
 *
 * @param {Record<string, any>} clip 美术 clip
 * @param {string} [sceneId] 场景名
 * @returns {Array<Record<string, any>>} 运行时 step
 * @throws {TypeError} step 形态非法 / 引用了未登记的帧
 */
export function adaptPlayCloudSteps(clip, sceneId = 'play_cloud') {
  const steps = clip.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new TypeError(`[pet-sequences] ${sceneId} 没有任何 step（空序列不是可播放内容）`);
  }
  const adapted = [];
  for (const [index, raw] of steps.entries()) {
    const step = requireObject(raw, `manifest.clips.${sceneId}.steps[${index}]`);
    const ms = requirePositive(step.ms, `manifest.clips.${sceneId}.steps[${index}].ms`);
    /** @type {Record<string, string>} */
    const frames = {};
    const protagonist = sourceOfLayer('protagonist', step.protagonist, `${sceneId} 第 ${index} 步 protagonist`);
    frames.protagonist = protagonist.slot;
    const companion = sourceOfLayer('companion', step.companion, `${sceneId} 第 ${index} 步 companion`);
    frames.companion = companion.slot;
    // 手掌层跟着"抱住"走：只有抱住的主角帧才有手掌，凭空给别的帧配手掌 = 手上什么都没有
    const hugSource = Object.values(FRAME_SOURCES).filter((item) => item.layer === 'hands');
    const hugFrame = FRAME_SOURCES.sit_hug;
    if (frames.protagonist === hugFrame.slot) {
      if (hugSource.length !== 1) {
        throw new TypeError(`[pet-sequences] ${sceneId} 第 ${index} 步需要手掌层，但 FRAME_SOURCES 里登记了 ${hugSource.length} 个 hands 帧`);
      }
      frames.hands = hugSource[0].slot;
    }
    /** @type {Record<string, any>} */
    const entry = {
      ms,
      frames,
      companionCenterX: requirePositive(step.companionCenterX, `manifest.clips.${sceneId}.steps[${index}].companionCenterX`),
      companionFootY: requirePositive(step.companionFootY, `manifest.clips.${sceneId}.steps[${index}].companionFootY`),
    };
    if (typeof step.phase === 'string' && step.phase.length > 0) entry.phase = step.phase;
    adapted.push(entry);
  }
  return adapted;
}

/**
 * 按 (层, 美术帧名) 查一个已登记的帧来源。
 *
 * @param {string} layer 层 id
 * @param {unknown} name 美术帧名
 * @param {string} where 报错定位
 * @returns {{slot: string, layer: string, file: string, reference: string}} 帧来源
 * @throws {TypeError} 未登记 / 层不匹配
 */
function sourceOfLayer(layer, name, where) {
  const source = typeof name === 'string' ? FRAME_SOURCES[name] : undefined;
  if (!source) {
    throw new TypeError(
      `[pet-sequences] ${where} 引用了未登记的帧 ${JSON.stringify(name)}（已登记：${Object.keys(FRAME_SOURCES).join(' / ')}）`,
    );
  }
  if (source.layer !== layer) {
    throw new TypeError(`[pet-sequences] ${where} 的帧 ${String(name)} 属于 ${source.layer} 层，与期望的 ${layer} 层不符`);
  }
  return source;
}

/**
 * 场景 id → step 适配器（显式登记；新场景必须在这里多一行，不许靠"名字像就套用"）。
 */
export const STEP_ADAPTERS = Object.freeze({
  cloud_react: adaptCloudReactSteps,
  play_cloud: adaptPlayCloudSteps,
});

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
  const protagonist = protagonistLayerOf(manifest);
  const hands = handsLayerOf(manifest);
  // 叠放序 = 数组下标（0 最底）：主角 → 伙伴 → 手掌。最后一项必须是最上，
  // 否则"手在云后面"——美术 `placement.order` 就是它的真源。
  const layers = [protagonist, companion, hands];
  problems.push(...checkLayerOrder(manifest, layers.map((layer) => layer.id)));

  const clips = requireObject(manifest.clips, 'manifest.clips');
  const scenes = {};
  /** @type {Record<string, Record<string, any>>} */
  const frames = {};
  const frameOrder = [];
  let stepTotal = 0;
  let durationMs = 0;

  // stageToCss 的唯一真源是 pose 运行时清单（同一舞台坐标系），不在这里写第二份比例字面量。
  // 它要在**逐场景适配之前**就绪：握持判据（G-S2）按 CSS px 表达容差，没有比例就算不出距离。
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

  for (const sceneId of SUPPORTED_SCENES) {
    const clip = clips[sceneId];
    if (clip === undefined) {
      problems.push(`美术 manifest 里没有 ${sceneId}（已支持的场景缺源 ⇒ 不许凭空造清单）`);
      continue;
    }
    const adaptSteps = STEP_ADAPTERS[sceneId];
    if (typeof adaptSteps !== 'function') {
      problems.push(`场景 ${sceneId} 没有登记 step 适配器（STEP_ADAPTERS 里缺项）`);
      continue;
    }
    let steps;
    try {
      steps = adaptSteps(clip, sceneId);
    } catch (err) {
      problems.push((err && err.message) || String(err));
      continue;
    }
    // 登记本场景用到的帧（首见序，稳定可 diff）：**所有层都登记**，
    // 只登记伙伴层会让主角帧/手掌帧在清单里凭空缺席（运行时取不到帧 = 黑场）
    for (const step of steps) {
      for (const [layerId, slot] of Object.entries(step.frames)) {
        if (typeof slot !== 'string') continue;
        const frameKey = `${sceneId}/${slot}`;
        if (frames[frameKey] !== undefined) continue;
        const sourceName = Object.keys(FRAME_SOURCES).find(
          (name) => FRAME_SOURCES[name].layer === layerId && FRAME_SOURCES[name].slot === slot,
        );
        if (sourceName === undefined) {
          problems.push(`${sceneId} 的 ${layerId}/${slot} 在 FRAME_SOURCES 里查不到母版（不许凭空造帧）`);
          continue;
        }
        const sourceFrame = FRAME_SOURCES[sourceName];
        frames[frameKey] = {
          layer: layerId,
          slot,
          /** 美术侧的帧名（排障用；运行时只认 slot）。 */
          sourceFrame: sourceName,
          sourceFile: sourceFrame.file,
          reference: sourceFrame.reference,
        };
        frameOrder.push(frameKey);
      }
    }
    // G-S2 握持判据：显示手掌层的每一步，云朵握持点必须贴在美术 hugGripStage 上
    problems.push(...checkHandGrip(steps, companion, hugGripStageOf(manifest), stageToCss, sceneId));
    scenes[sceneId] = {
      loop: clip.loop === true,
      onEnd: null,
      steps,
    };
    stepTotal += steps.length;
    // 本场景自己的时长（**不能**用累计值：`play_cloud：15 步 / 8040 ms` 这种日志会让人
    // 以为单场景 8 秒，于是"真值 4860"的判据看起来像错的——日志也要可核对）
    const sceneDurationMs = steps.reduce((sum, step) => sum + step.ms, 0);
    durationMs += sceneDurationMs;
    log(`[pet-sequences] ${sceneId}：${steps.length} 步 / ${sceneDurationMs} ms`);
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
    const owner = layers.find((layer) => layer.id === entry.layer);
    if (owner === undefined) {
      problems.push(`${key} 的母版 ${entry.sourceFile} 找不到所属层 ${entry.layer}`);
      continue;
    }
    if (size.width / size.height !== owner.canvas.width / owner.canvas.height) {
      problems.push(
        `${key} 的母版 ${size.width}×${size.height} 与层 ${owner.id} 的画布 ` +
          `${owner.canvas.width}×${owner.canvas.height} 比例不一致（等比 contain 会留白或裁切）`,
      );
    }
    entry.sourceSize = { width: size.width, height: size.height };
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
      layers,
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
