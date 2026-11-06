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
 * <p><b>内容寻址去重（M2 T02）：</b>同一张画只写一份 webp。归组键是 `contentId`
 * （母版 PNG `sha256` 的前 16 位），canonical 帧负责落盘，同组其余帧的
 * `files[density].file` 指向同一路径；`totals` 按 **distinct 磁盘文件** 累加并写出
 * `totals.distinctFiles`。`--check` 用**同一套 canonical 规则**解盘上路径——
 * 只改一侧会让 `--check` 报"缺少运行产物"，这是本改动最容易翻车的地方。</p>
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
import { checkUnknownKeys } from './pet-poses-schema.mjs';
import {
  ACCEPTED_BATCHES,
  DEFERRED_REASONS,
  POSE_DEGRADATIONS,
  SOURCE_ROOT,
  adaptAll,
} from './pet-pose-adapters.mjs';
// 体积预算**只有一个真源**（`scripts/pet-budget.mjs`）：这里不再定义自己的副本。
// 曾经的 6 MiB 与发布侧的 8 MiB 并存，属于纯漂移（详见该模块的注释）。
import { FRAME_2X_MAX_BYTES, POSE_TOTAL_MAX_BYTES } from './pet-budget.mjs';

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
/**
 * 内容寻址标识的形状：母版 PNG 的 `sha256` **前 16 位小写十六进制**（设计 §8.3 共享知识第 5 条）。
 *
 * <p><b>为什么用母版而不是转码后的 webp：</b>"这两帧是不是同一张画"这个问题的权威答案在
 * 美术交给我们的源像素上。转码后的 sha256 依赖编码器参数——改一次 `effort`、升一次 sharp
 * 就整批变号，那时"要不要写两份文件"就再也答不上来（它正是内容寻址的唯一依据）。</p>
 */
export const CONTENT_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * 算一个母版的 `contentId`（母版 PNG `sha256` 的前 16 位小写十六进制）。
 *
 * @param {string} absolutePath 母版 PNG 绝对路径
 * @returns {string} 16 位小写十六进制 contentId
 * @throws {RangeError} 文件不可读或摘要形状不合预期
 */
export function contentIdOf(absolutePath) {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
    throw new TypeError('[pet-poses] contentIdOf 需要母版 PNG 的路径');
  }
  const contentId = sha256Of(absolutePath).slice(0, 16);
  if (!CONTENT_ID_PATTERN.test(contentId)) {
    throw new RangeError(`[pet-poses] 从 ${absolutePath} 算出的 contentId=${contentId} 不是 16 位小写十六进制`);
  }
  return contentId;
}

/**
 * 按 `contentId` 归组，给出每个帧的 **canonical 帧 id**（组内按草稿顺序的第一个）。
 *
 * <p><b>这是"同一张画只写一份文件"的唯一实现：</b>canonical 帧负责转码落盘，其余同组帧的
 * `files[density].file` 直接指向它。落盘路径包含 `posture`，所以归组天然是**批内**的。</p>
 *
 * <p><b>为什么 canonical id 必须能在不转码的情况下重算：</b>`--check` 不许写盘、也不许假设
 * 编码器可复现，它只能靠"输入相同 ⇒ canonical 相同"这条性质把盘上路径解出来。所以归组键用
 * `contentId`（母版摘要），而不是转码后的 webp 摘要；两者的一一对应由
 * {@link contentAddressingOf} 的第三条断言在构建期**证明**（同 contentId ⇒ 同字节；
 * 异 contentId ⇒ 异字节），这样"按 contentId 归组"与"按 (density, webp sha256) 归组"
 * 是同一套规则，`--check` 才可能与构建写出同一组路径。</p>
 *
 * @param {string[]} frameIds 帧 id（**必须是草稿顺序**：canonical 取组内第一个，顺序变了路径就抖）
 * @param {Record<string, string>} contentIds `frameId → contentId`
 * @returns {Map<string, string>} `frameId → canonical frameId`
 * @throws {RangeError} 帧缺 contentId 或形状非法（查不到 = 判红，不许静默按帧 id 落盘）
 */
export function canonicalFrameIds(frameIds, contentIds) {
  if (!Array.isArray(frameIds)) throw new TypeError('[pet-poses] canonicalFrameIds 需要帧 id 数组');
  const source = contentIds && typeof contentIds === 'object' ? contentIds : {};
  /** contentId → 组内第一个帧 id。 */
  const firstOf = new Map();
  /** frameId → canonical frameId。 */
  const result = new Map();
  for (const frameId of frameIds) {
    const contentId = source[frameId];
    if (typeof contentId !== 'string' || !CONTENT_ID_PATTERN.test(contentId)) {
      throw new RangeError(
        `[pet-poses] 帧 ${frameId} 缺少合法 contentId（实际 ${JSON.stringify(contentId)}）：` +
          '内容寻址不许退化回"每个帧位各写一份"',
      );
    }
    if (!firstOf.has(contentId)) firstOf.set(contentId, frameId);
    result.set(frameId, firstOf.get(contentId));
  }
  return result;
}

/**
 * 把清单里的 `file`（`poses/<posture>/<name>@<density>.webp`）解成**相对运行目录**的路径。
 *
 * <p>口径差与 `pet-p1` 那套同源：`file` 是相对 `lxa://pet-poses/` 的（所以带 `poses/` 一级），
 * 而输出目录本身就是 `…/live2d/pet-poses`。直接 `resolve(outDir, file)` 会拼出
 * `…/pet-poses/poses/sit/…`，那个 bug 只在门禁里看得见，页面上只表现为 404。</p>
 *
 * @param {unknown} file 清单里的相对路径
 * @returns {string} 相对运行目录的路径（正斜杠）
 */
export function runtimeRelativePath(file) {
  const normalized = String(file ?? '').replace(/\\/g, '/');
  return normalized.startsWith('poses/') ? normalized.slice('poses/'.length) : normalized;
}

/**
 * 校验 `assets` 的内容寻址结构，返回 `frameId → contentId`。
 *
 * <p>三条断言（全部是**行为**断言，不是文本匹配）：</p>
 * <ol>
 *   <li><b>全有或全无</b>：一批帧里"部分帧有 contentId、部分没有"直接报错——半有半无会让
 *       "同 contentId 全等"这条判据静默失效（没 contentId 的帧永远不被比对）。</li>
 *   <li><b>同 contentId ⇒ 同一张画</b>：`bytes / sha256 / format` 三个字段逐值全等，
 *       否则构建失败。因为 canonical 归组只写一份文件，两帧字节不同就意味着其中一帧
 *       会看到别的内容（用户侧表现是"某一帧突然变成另一张画"）。</li>
 *   <li><b>异 contentId ⇒ 不许共用字节</b>：不同母版编出同一份 webp 时直接报错。
 *       否则按 contentId 归组会多写一份一模一样的文件（去重漏了），而按字节归组又不能被
 *       `--check` 复现。修复方向是让美术用 `aliases` 声明"这两张源文件是同一张画"
 *       （adapter 已有校验），而不是让构建期去猜。</li>
 * </ol>
 *
 * @param {string} posture 批次名（只用于报错文案）
 * @param {string[]} frameIds 帧 id（草稿顺序）
 * @param {Record<string, Record<string, any>>} assets `assets[posture][frameId]`
 * @returns {Record<string, string>} `frameId → contentId`（整批没有内容寻址时是空对象）
 * @throws {RangeError} contentId 形状非法 / 半有半无 / 同 contentId 字节不一致 / 异 contentId 共用字节
 */
export function contentAddressingOf(posture, frameIds, assets) {
  const batchAssets = assets?.[posture] ?? {};
  /** @type {Record<string, string>} */
  const contentIds = {};
  let known = 0;
  for (const frameId of frameIds) {
    const entry = batchAssets[frameId];
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry.contentId;
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || !CONTENT_ID_PATTERN.test(raw)) {
      throw new RangeError(
        `[pet-poses] ${posture}/${frameId} 的 contentId=${JSON.stringify(raw)} 不是 16 位小写十六进制` +
          '（母版 PNG sha256 前 16 位）',
      );
    }
    contentIds[frameId] = raw;
    known += 1;
  }
  if (known === 0) return contentIds;
  if (known !== frameIds.length) {
    throw new RangeError(
      `[pet-poses] ${posture} 的 contentId 只覆盖了 ${known}/${frameIds.length} 帧：` +
        '"同 contentId 字节全等"这条判据在半有半无时会静默失效，所以全有或全无',
    );
  }
  /** contentId → 组内第一个帧（用于报错时点名"跟谁撞了"）。 */
  const firstOf = new Map();
  /** `${density}|${sha256}` → 已占用它的 { frameId, contentId }。 */
  const shaOwner = new Map();
  for (const frameId of frameIds) {
    const contentId = contentIds[frameId];
    const entry = batchAssets[frameId];
    const previous = firstOf.get(contentId);
    if (previous === undefined) {
      firstOf.set(contentId, { frameId, entry });
    } else {
      for (const density of ['1x', '2x']) {
        const left = previous.entry?.[density];
        const right = entry?.[density];
        for (const field of ['bytes', 'sha256', 'format']) {
          if (left?.[field] !== right?.[field]) {
            throw new RangeError(
              `[pet-poses] ${posture} 的 ${previous.frameId} 与 ${frameId} 共用 contentId ${contentId}，` +
                `但 ${density}.${field} 不一致（${JSON.stringify(left?.[field])} ≠ ${JSON.stringify(right?.[field])}）：` +
                '同 contentId = 同一张画，字节必须全等——否则"只写一份文件"会让其中一帧看到别的内容',
            );
          }
        }
      }
    }
    for (const density of ['1x', '2x']) {
      const sha = entry?.[density]?.sha256;
      if (typeof sha !== 'string') continue;
      const key = `${density}|${sha}`;
      const owner = shaOwner.get(key);
      if (owner !== undefined && owner.contentId !== contentId) {
        throw new RangeError(
          `[pet-poses] ${posture} 的 ${owner.frameId} 与 ${frameId} 编出了同一份 ${density} 字节（sha256 ${sha}），` +
            `但 contentId 不同（${owner.contentId} ≠ ${contentId}）：如果这两张源文件本来就是同一张画，` +
            '请在美术 manifest 的 aliases 里声明（adapter 会校验）；否则它们不该字节全等',
        );
      }
      if (owner === undefined) shaOwner.set(key, { frameId, contentId });
    }
  }
  return contentIds;
}


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
 * @param {Record<string, Record<string, Record<string, any>>>} options.assets
 *   帧文件信息：`assets[batch][frameId] = { contentId?, canonicalId?, '1x': { bytes, sha256, format }, '2x': {...} }`
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
  /**
   * 已经计入 `totals` 的磁盘文件（`file` 路径 → 字节数）。
   *
   * <p><b>为什么不能按帧位求和：</b>去重后两个帧位指向同一个文件，按帧位累加会把同一份字节
   * 数算两遍——`totals` 变成"比盘上多 677 KB 的数字"，而体积断言会因此假红/假绿。
   * 这里按 **distinct 文件** 累加，正是设计 §6.1 G-P9 要自证的口径。</p>
   */
  const countedFiles = new Map();
  let distinctFiles = 0;
  for (const [posture, draft] of Object.entries(drafts)) {
    const frames = {};
    const frameIds = Object.keys(draft.frames);
    const contentIds = contentAddressingOf(posture, frameIds, assets);
    // 整批都有 contentId 才能做内容寻址归组；整批都没有（历史上的最小单测输入）保持
    // "一个帧位一份文件"的旧行为。半有半无已被 contentAddressingOf 判红。
    const fullyAddressed = frameIds.every((frameId) => contentIds[frameId] !== undefined);
    const canonicalOf = fullyAddressed
      ? canonicalFrameIds(frameIds, contentIds)
      : new Map(frameIds.map((frameId) => [frameId, frameId]));
    for (const frameId of frameIds) {
      const frame = draft.frames[frameId];
      const entry = assets[posture]?.[frameId];
      if (!entry) {
        throw new RangeError(`[pet-poses] ${posture}/${frameId} 缺少导出信息（assets 里没有该帧）`);
      }
      const layerId = canonicalOf.get(frameId) ?? frameId;
      const contentId = contentIds[frameId];
      const oneX = assetFileOf(posture, layerId, '1x', entry['1x'], scale, draft, contentId);
      const twoX = assetFileOf(posture, layerId, '2x', entry['2x'], scale, draft, contentId);
      frames[frameId] = {
        id: frame.id,
        facing: frame.facing,
        files: { '1x': oneX, '2x': twoX },
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
      for (const [density, file] of [['1x', oneX], ['2x', twoX]]) {
        const knownBytes = countedFiles.get(file.file);
        if (knownBytes === undefined) {
          countedFiles.set(file.file, file.bytes);
          distinctFiles += 1;
          if (density === '1x') bytes1x += file.bytes;
          else bytes2x += file.bytes;
          continue;
        }
        if (knownBytes !== file.bytes) {
          throw new RangeError(
            `[pet-poses] ${posture} 的 ${file.file} 被多个帧引用却有两个字节数（${knownBytes} / ${file.bytes}）：` +
              '同一份磁盘文件不可能有两个大小',
          );
        }
      }
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
    totals: { frames: framesTotal, bytes1x, bytes2x, distinctFiles },
  };
}

/**
 * 造一条 `PoseAssetFile`。
 *
 * <p>`layerId` 是 **canonical 帧 id**（同 contentId 组内第一个帧）：两个帧位共用同一张画时，
 * 它们在这里拿到同一个 `file` / `url`，于是磁盘上只有一份 webp。</p>
 *
 * @param {string} posture 批次
 * @param {string} layerId canonical 帧 id（落盘文件名）
 * @param {'1x'|'2x'} density 密度档
 * @param {{bytes:number, sha256:string, format:string}} info 文件信息
 * @param {{masterToCss: number}} scale 比例契约
 * @param {Record<string, unknown>} batch 批次草稿
 * @param {string} [contentId] 内容寻址标识（缺省表示这份输入没有内容寻址信息，不写该键）
 * @returns {Record<string, unknown>} 文件条目
 */
function assetFileOf(posture, layerId, density, info, scale, batch, contentId) {
  const target = targetSizeOf(batch, scale, density);
  return {
    file: `poses/${posture}/${layerId}@${density}.webp`,
    url: `lxa://${POSE_URL_HOST}/${posture}/${layerId}@${density}.webp`,
    width: target.width,
    height: target.height,
    bytes: info.bytes,
    sha256: info.sha256,
    format: info.format,
    // 追加在末尾：既有键的顺序逐字节不变，`git diff` 里只会多一行 contentId
    ...(contentId === undefined ? {} : { contentId }),
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
 * 判一份 `totals` 是否超 pose 运行资产总量预算（**不接收上限参数**）。
 *
 * <p>为什么故意不给 `limit` 形参：给了就等于允许调用方塞第二个数，漂移会从后门回来。
 * 这个函数只认 `scripts/pet-budget.mjs` 的 `POSE_TOTAL_MAX_BYTES`，
 * 发布侧 `check-pet-not-shipped.mjs` 读的是**同一个常量**——所以"构建侧说超了、发布侧说没超"
 * 这种自相矛盾在结构上不可能出现。</p>
 *
 * @param {{bytes1x?: number, bytes2x?: number}} totals 清单里的体积合计（缺字段按 0 处理）
 * @returns {string[]} 问题列表（空数组 = 未超限）
 */
export function poseVolumeProblems(totals) {
  const source = totals && typeof totals === 'object' ? totals : {};
  const bytes1x = Number.isFinite(source.bytes1x) ? source.bytes1x : 0;
  const bytes2x = Number.isFinite(source.bytes2x) ? source.bytes2x : 0;
  const totalBytes = bytes1x + bytes2x;
  if (totalBytes > POSE_TOTAL_MAX_BYTES) {
    return [
      `pose 运行资产合计 ${totalBytes} 字节超过预算 ${POSE_TOTAL_MAX_BYTES} 字节（${(totalBytes / 1024 / 1024).toFixed(2)} MiB）`,
    ];
  }
  return [];
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
 * @param {string[]} [options.accepted] 本次导出哪些批次（缺省 = {@link ACCEPTED_BATCHES}）
 * @param {(message: string) => void} [options.log] 日志出口
 * @returns {Promise<{ok: boolean, check: boolean, problems: string[], notes: string[], manifest: Record<string, unknown>|null, written: boolean, removed: string[], deferred: Array<{posture:string, reason:string, status:string|null}>, totals: {frames:number, bytes1x:number, bytes2x:number, distinctFiles:number} }>}
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
  // 显式覆盖"导出哪几批"（缺省仍是 ACCEPTED_BATCHES ⇒ 生产路径逐字节不变）。
  // 用途：切片 2 的 T01 要在**不翻 ACCEPTED_BATCHES**（那会立刻让运行时与 state-machine
  // 测试变红，设计 §E.3 的合并约束）的前提下，让 walk/run/jump 走一遍真实导出管线来
  // 体积实测 / 结构自证 / 导出确定性比对。写成"可注入的输入"而不是"多一个开关常量"，
  // 是为了让测试与 CLI 用的是同一条代码路径。
  const acceptedOverride = Array.isArray(options.accepted) ? options.accepted : null;
  const problems = [];
  const notes = [];

  const geometry = readJsonFile(geometryPath);
  const scale = computeScale(geometry);
  const adapted = adaptAll({
    repoRoot,
    ...(acceptedOverride ? { accepted: acceptedOverride } : {}),
    log: verbose ? log : () => {},
  });
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
    const frameIds = Object.keys(draft.frames);
    /** frameId → 源母版绝对路径。 */
    const sourcePaths = {};
    /** frameId → contentId（母版 PNG sha256 前 16 位）。 */
    const contentIds = {};
    for (const frameId of frameIds) {
      const frame = draft.frames[frameId];
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
      sourcePaths[frameId] = sourcePath;
      contentIds[frameId] = contentIdOf(sourcePath);
    }
    // canonical 归组：同 contentId 的帧里，草稿顺序的第一个负责落盘。
    // 有帧没解析出来时只报错不归组（问题已经记下，构建会在下面早退）。
    const fullyResolved = frameIds.every((frameId) => sourcePaths[frameId] !== undefined);
    const canonicalOf = fullyResolved
      ? canonicalFrameIds(frameIds, contentIds)
      : new Map(frameIds.map((frameId) => [frameId, frameId]));
    for (const frameId of frameIds) {
      const sourcePath = sourcePaths[frameId];
      if (sourcePath === undefined) continue;
      const layerId = canonicalOf.get(frameId) ?? frameId;
      const contentId = contentIds[frameId];
      assets[posture][frameId] = { contentId, canonicalId: layerId };
      const shared = layerId === frameId ? '' : `（与 ${layerId} 共用同一份文件：contentId ${contentId}）`;
      for (const density of ['1x', '2x']) {
        const target = targetSizeOf(draft, scale, density);
        const expectedName = `${posture}/${layerId}@${density}.webp`;
        const diskPath = resolve(outDir, posture, `${layerId}@${density}.webp`);
        if (check) {
          if (!existsSync(diskPath)) {
            problems.push(`[${posture}] 缺少运行产物 ${expectedName}${shared}（请先跑 npm run build:pet-poses）`);
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
        // 重复帧**仍然重转一次**：这样 `contentAddressingOf` 的"同 contentId 字节全等"
        // 是拿两次真实编码的结果比的（实测），而不是靠"复用了同一个变量"（假设）。
        // 代价是一次多余编码，收益是这条判据在构建期真的有牙。
        const result = await transcodeLayer(
          sharp,
          { path: sourcePath, layerId, density },
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
          problems.push(`[${posture}] ${expectedName} 转码失败：${result.reason}`);
          continue;
        }
        if (result.downgraded) {
          // 自动降级旁路（`build-pet-layers.mjs` 的 `lossless && bytes > maxBytes`）：字节更少 ⇒
          // 体积断言全绿，用户看到的却是块效应与振铃。所以这里**显式打警告**，
          // 并且 G-P8 会在门禁里判红（两道：日志让人看见，门禁让人改）。
          const warning =
            `[${posture}] ${expectedName} 超过 400 KiB，已被自动**降为有损 WebP**` +
            `（${result.bytes} 字节）：字节更少所以体积断言不会红，但换姿/换朝向时会看出块效应` +
            '（transcodeLayer 的自动降级旁路；G-P8 会判红）';
          if (!notes.includes(warning)) notes.push(warning);
          log(`[pet-poses] ⚠ 有损降级：${warning}`);
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
      totals: { frames: 0, bytes1x: 0, bytes2x: 0, distinctFiles: 0 },
    };
  }

  const manifest = buildPosesManifest({
    drafts,
    assets,
    geometry,
    deferred: adapted.deferred.map((item) => ({ posture: item.posture, reason: item.reason })),
    ...(acceptedOverride ? { accepted: acceptedOverride } : {}),
  });

  // 体积守卫（与 `check-pet-not-shipped` 的进包总量是两道独立闸门：
  // 这里拦"生成时就超预算"，那里拦"进包后总量超上限"；但两处**读同一个上限**）
  problems.push(...poseVolumeProblems(manifest.totals));
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
      // 未知键闸门（G-16）：先拦"有人往清单里塞了 schema 没声明的键"。
      // 放在比对之前——否则 diff 只会说"多了个键"，看起来像漂移而不像缺陷。
      problems.push(...checkUnknownKeys(committed));
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
      // totals 的字节两档沿用已提交值：`--check` 自己看不见"totals 本来就写错了"这件事
      // （那是 G-P9 的活，它用 distinct 文件独立重算）。但 `distinctFiles` **不沿用**——
      // 它是按 canonical 路径数出来的独立计数，能在这里被抓住就没必要交给别人。
      expected.totals.bytes1x = committed.totals?.bytes1x ?? expected.totals.bytes1x;
      expected.totals.bytes2x = committed.totals?.bytes2x ?? expected.totals.bytes2x;
      const diffs = [];
      diffJson(committed, expected, 'pet-poses', diffs);
      if (diffs.length > 0) {
        problems.push(`清单与美术 manifest 漂移（${diffs.length} 处）`);
        for (const line of diffs) problems.push(`   ${line}`);
      }
      // 独立核验：盘上文件与清单记录必须逐值相等（防"清单说 4096 字节、盘上是别的"）。
      // 路径一律**从清单里的 `file` 解**（而不是按 frameId 拼）：去重后两个帧位指向同一个
      // 文件，按 frameId 拼出来的名字在盘上根本不存在，那样这条核验会对着自己造的空路径报错。
      for (const [posture, batch] of Object.entries(committed.batches ?? {})) {
        for (const [frameId, frame] of Object.entries(batch.frames ?? {})) {
          for (const density of ['1x', '2x']) {
            const file = frame.files?.[density];
            if (!file) continue;
            const diskPath = resolve(outDir, runtimeRelativePath(file.file));
            if (!existsSync(diskPath)) {
              problems.push(`[${posture}] 清单登记了 ${frameId}@${density}（${file.file}）但盘上没有 ${diskPath}`);
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
    // 也不能按 `frameId` 拼：去重后只有 canonical 帧有实体文件，按帧 id 拼出来的名字
    // 是盘上不存在的路径，等于把"该保留的文件"漏在期望集合外（`pruneExpectedOrphans`
    // 只删存在的文件，所以不会误删，但会漏删真正该清的旧文件）。
    const expected = new Set();
    for (const batch of Object.values(manifest.batches)) {
      for (const frame of Object.values(batch.frames)) {
        for (const density of ['1x', '2x']) {
          expected.add(runtimeRelativePath(frame.files[density].file));
        }
      }
    }
    const removedList = pruneExpectedOrphans(outDir, expected);
    removed.push(...removedList);
    writeFileSync(posesJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    written = true;
    log(
      `[pet-poses] 已写出 ${relative(repoRoot, posesJsonPath) || posesJsonPath}：` +
        `${Object.keys(manifest.batches).length} 批 / ${manifest.totals.frames} 帧 / ` +
        `${manifest.totals.distinctFiles} 个文件 / ` +
        `${((manifest.totals.bytes1x + manifest.totals.bytes2x) / 1024).toFixed(0)} KiB`,
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
    for (const note of result.notes) {
      // "有损降级"必须走 stderr：它和普通提示（deferred 原因等）不是一个等级，
      // 混在 stdout 的"注意："里等于没人看得见。
      if (note.includes('有损')) console.warn(`[pet-poses] ⚠ ${note}`);
      else console.log(`[pet-poses] 注意：${note}`);
    }
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
          `${result.totals.frames} 帧 / ${result.totals.distinctFiles} 个文件 / ` +
          `合计 ${((result.totals.bytes1x + result.totals.bytes2x) / 1024).toFixed(0)} KiB`,
      );
    } else {
      console.log(
        `✅ 已导出 pose 运行资产：${result.totals.frames} 帧 / ${result.totals.distinctFiles} 个文件 / 合计 ` +
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
