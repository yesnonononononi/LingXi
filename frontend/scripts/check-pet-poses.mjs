#!/usr/bin/env node
/**
 * pose 运行资产门禁：`npm run gate:pet:poses`。
 *
 * <p><b>它拦两类"看起来没事"的故障：</b></p>
 * <ol>
 *   <li><b>漂移</b>：美术改了 `manifest.json` 但没人重建 `pet-poses.json`，或有人手改了清单。
 *       由 `build-pet-poses.mjs --check` 逐字段比对（含盘上 webp 的字节/sha/编码格式）；</li>
 *   <li><b>结构性越界</b>：包络超出窗口（换姿裁边）、体积超预算、时序不合法
 *       （`frameMs` 填 0 会让 rAF 空转）、清单里偷偷透传了母版 `anchor`
 *       （`anchor.y/2` 与 `bodyAnchor.y` 在 4 个直立批"碰巧"相等，透传就等于留下混用入口）。</li>
 *   <li><b>自证缺口</b>：`totals` 必须等于"按 distinct 磁盘文件重算"的和（G-P9，防手写 totals
 *       与"去重后仍按帧位累加"）；同一 `contentId` 的引用必须 `bytes/sha256/format` 全等，
 *       且磁盘上不许有没人引用的 webp（G-P10，内容寻址一致 + 反向孤儿）。</li>
 * </ol>
 *
 * <p><b>包络判据用非对称式</b>（E-02）：窗口不是以对齐点为中心的，对齐点在窗口内的横坐标是
 * `Px = artOrigin.x + artWidth × alignXRatio`，所以每批的横向量必须满足
 * `rel ∈ [-(Px) + SAFE, (W - Px) - SAFE]`。用 `[-W/2+SAFE, W/2-SAFE]` 会在左侧漏判
 * 2.92 px、右侧误报 6.92 px（W=254、X=49 的实测值）。</p>
 *
 * <p>用法：</p>
 * <pre>
 *   node scripts/check-pet-poses.mjs            # 门禁
 *   node scripts/check-pet-poses.mjs --verbose  # 打印每项判据
 * </pre>
 *
 * @module scripts/check-pet-poses
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEOMETRY_PATH, readJsonFile } from './build-pet-geometry.mjs';
// 内容寻址的形状常量（`CONTENT_ID_PATTERN`）与"清单 `file` → 运行目录相对路径"的口径
// （`runtimeRelativePath`）都**只从构建脚本拿**：门禁自己再写一份正则/再写一次前缀裁剪，
// 就是第二份真源，迟早与生成物漂移。
import { CONTENT_ID_PATTERN, DEFAULT_POSE_OUT_DIR, POSES_JSON_PATH, listPoseFiles, runBuild, runtimeRelativePath } from './build-pet-poses.mjs';
// 体积预算的真源是 `pet-budget.mjs`（**不再**从 build-pet-poses 转手拿：转手就是二道贩子，
// 迟早有人以为"这里改一下也行"）。build-pet-poses 与本脚本读的是同一个常量。
import { FRAME_2X_MAX_BYTES, POSE_TOTAL_MAX_BYTES } from './pet-budget.mjs';
import { checkUnknownKeys } from './pet-poses-schema.mjs';

/** 包络的安全余量（CSS px）：两侧各留 2px 吸收半透明羽化边缘。 */
export const ENVELOPE_SAFE_PX = 2;

/** 帧时长的合法区间（毫秒）：低于 80 会让人眼读成"跳帧"，高于 2400 读成"卡住"。 */
export const FRAME_MS_RANGE = Object.freeze({ min: 80, max: 2400 });

/** 两个密度档（`types.ts` 的 `Density` 联合类型的运行期副本）。 */
export const DENSITIES = Object.freeze(['1x', '2x']);

/**
 * pose 帧**唯一允许的编码格式**（U1 裁定：保持无损）。
 *
 * <p>写成常量而不是散落字面量：将来若有人改口径，改一处即可，且能一眼看到 G-P8 在守什么。</p>
 */
export const LOSSLESS_FORMAT = 'webp-lossless';

/**
 * 从几何真源与对齐点算出**对齐点在窗口内的横坐标** `Px`。
 *
 * <p>`Px = artOrigin.x + artWidth × (alignX / 站姿原生画布宽)`；站姿原生画布宽 = 母版画布宽 / 2。
 * 之所以要它而不直接用 `W/2`：对齐点并不居中（E-02）。</p>
 *
 * @param {Record<string, any>} geometry 几何真源
 * @param {Record<string, any>} align 对齐契约
 * @returns {number} Px（CSS px）
 */
export function alignPointX(geometry, align) {
  const artOriginX = geometry.effectMargin.left;
  const nativeStandWidth = geometry.canvasWidth / 2;
  return artOriginX + geometry.artWidth * (Number(align.xNative) / nativeStandWidth);
}

/**
 * 校验一批的包络是否落在窗口内（非对称判据，E-02）。
 *
 * @param {Record<string, any>} batch 批次
 * @param {Record<string, any>} geometry 几何真源
 * @param {Record<string, any>} align 对齐契约
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function checkEnvelope(batch, geometry, align) {
  const problems = [];
  const width = geometry.artWidth + geometry.effectMargin.left + geometry.effectMargin.right;
  const px = alignPointX(geometry, align);
  const min = -px + ENVELOPE_SAFE_PX;
  const max = width - px - ENVELOPE_SAFE_PX;
  const envelope = batch.envelopeCss ?? {};
  const left = Number(envelope.left);
  const right = Number(envelope.right);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    problems.push(`[${batch.posture}] envelopeCss.left/right 不是有限数值`);
    return problems;
  }
  if (left < min) {
    problems.push(
      `[${batch.posture}] 左侧越界：rel=${left.toFixed(2)} < 下限 ${min.toFixed(2)}` +
        `（Px=${px.toFixed(2)}，窗口宽 ${width}）`,
    );
  }
  if (right > max) {
    problems.push(
      `[${batch.posture}] 右侧越界：rel=${right.toFixed(2)} > 上限 ${max.toFixed(2)}` +
        `（Px=${px.toFixed(2)}，窗口宽 ${width}）`,
    );
  }
  return problems;
}

/**
 * 帧时长的**窄豁免**参数（"动作开始前的静止等待"）。
 *
 * <p><b>为什么需要它：</b>{@link FRAME_MS_RANGE} 的上限 2400 ms 守的是"连续帧不许长到像卡住"，
 * 而美术 `supplemental/gif-v1/manifest.json` 的 `clips.sit_blink` 第一帧是 **2600 ms**
 * ——语义是"坐定之后先静止 2.6 秒，然后眨两下眼"。这不是时序错误，也不是卡住。</p>
 *
 * <p><b>为什么不改上限、不拆帧：</b>把 2400 抬高等于给**所有**片段开后门（任何片段都能塞
 * 5 秒的帧）；把 2600 拆成两帧同图等于**造假帧**——正是 G-P14 要防的"多帧同图假动画"变体。
 * 所以正确做法是：全局上限不动，另开一条**窄到只能用一次的**豁免，条件必须同时成立。</p>
 *
 * <p><b>五条同时成立才放行（缺一条即红）：</b></p>
 * <ol>
 *   <li>每个片段**至多 1 帧**超上限；</li>
 *   <li>超限帧必须是**片段第 0 帧**（语义 = "动作开始前的静止等待"），且 ≤ {@link FRAME_MS_EXEMPTION.maxOverMs}；</li>
 *   <li>该片段至少 {@link FRAME_MS_EXEMPTION.minDistinctContentIds} 个 distinct `contentId`
 *       （G-P14 仍要**独立**成立，豁免只是帧时长的例外，不是"在动"的例外）；</li>
 *   <li>该片段总时长 ≤ {@link FRAME_MS_EXEMPTION.maxClipTotalMs}（长等待不能把一个循环拖到十几秒）；</li>
 *   <li>**单帧片段禁止豁免**（单帧就是静态，静态该用 `hold-last`/静态片段表达，不许用长帧凑时间）。</li>
 * </ol>
 *
 * <p><b>放行时必须点名</b>：门禁 `notes` 里会写清"哪个片段、第几帧、多少 ms、依据哪条"，
 * 否则下次读日志的人会以为 2400 是假的。</p>
 */
export const FRAME_MS_EXEMPTION = Object.freeze({
  /** 超限帧自己的上限（ms）：再长就不像"入静"，像卡死。 */
  maxOverMs: 6000,
  /** 用了豁免的片段总时长上限（ms）。 */
  maxClipTotalMs: 9000,
  /** 只认片段第 0 帧（"动作开始前的静止等待"）。 */
  frameIndex: 0,
  /** 片段必须至少这么多 distinct `contentId`（"真的在动"）。 */
  minDistinctContentIds: 2,
});

/**
 * 取一个片段所用帧的"是不是同一张画"证据。
 *
 * <p><b>优先 `contentId`</b>（母版 PNG `sha256` 前 16 位，见 `build-pet-poses.mjs` 的
 * `contentIdOf`）——它是"这两帧是不是同一张画"的权威答案。转码前的 adapter **草稿**
 * 还没有 `files`，此时退到 `sourceFile`（母版路径）：两者等价（`contentId` 本来就是母版的摘要），
 * 但清单里只要有 `contentId` 就以它为准。</p>
 *
 * @param {Record<string, any>} batch 批次
 * @param {{frames?: string[]}} clip 片段
 * @returns {{ids: Set<string>, missing: string[], basis: 'contentId'|'sourceFile'}} 证据
 */
export function clipIdentityOf(batch, clip) {
  const frames = batch && batch.frames && typeof batch.frames === 'object' ? batch.frames : {};
  const frameIds = Array.isArray(clip && clip.frames) ? clip.frames : [];
  const ids = new Set();
  const missing = [];
  const values = [];
  for (const frameId of frameIds) {
    const frame = frames[frameId];
    const file = frame && frame.files ? frame.files['1x'] : undefined;
    const contentId = file ? file.contentId : undefined;
    if (typeof contentId === 'string' && CONTENT_ID_PATTERN.test(contentId)) {
      values.push({ value: contentId, basis: 'contentId' });
      continue;
    }
    const sourceFile = frame ? frame.sourceFile : undefined;
    if (typeof sourceFile === 'string' && sourceFile.length > 0) {
      values.push({ value: `file:${sourceFile}`, basis: 'sourceFile' });
      continue;
    }
    missing.push(frameId);
  }
  const basis = values.some((item) => item.basis === 'sourceFile') ? 'sourceFile' : 'contentId';
  for (const item of values) ids.add(item.value);
  return { ids, missing, basis };
}

/**
 * 校验一个批次的剪片段时序（**含 {@link FRAME_MS_EXEMPTION} 窄豁免**）。
 *
 * <p>返回 `problems` 与 `notes` 两份：`problems` 非空即门禁红；`notes` 只用于**点名豁免**
 * ——放行一条超限帧这件事本身必须留下痕迹，静默放行会让"2400 上限"变成一句空话。</p>
 *
 * @param {Record<string, any>} batch 批次
 * @returns {{problems: string[], notes: string[]}} 校验结果
 */
export function checkTimingReport(batch) {
  const problems = [];
  const notes = [];
  const clips = Array.isArray(batch.clips) ? batch.clips : [];
  if (clips.length === 0) {
    problems.push(`[${batch.posture}] 没有 clips：没有可播片段就不是可播资产`);
    return { problems, notes };
  }
  for (const clip of clips) {
    const frames = Array.isArray(clip.frames) ? clip.frames : [];
    const frameMs = Array.isArray(clip.frameMs) ? clip.frameMs : [];
    const label = `[${batch.posture}#${clip.id}]`;
    if (frames.length !== frameMs.length) {
      problems.push(`${label} frameMs 长度 ${frameMs.length} ≠ 帧数 ${frames.length}`);
      continue;
    }
    const singleHold = frames.length === 1 && frameMs[0] === 0;
    if (singleHold) continue;
    // 低于下限**永不豁免**：太快读成跳帧，和"入静等待"是两回事。
    for (const [index, ms] of frameMs.entries()) {
      if (!Number.isFinite(ms) || ms < FRAME_MS_RANGE.min) {
        problems.push(
          `${label} 第 ${index} 帧时长 ${ms}ms 不在 [${FRAME_MS_RANGE.min}, ${FRAME_MS_RANGE.max}]` +
            '（单帧静止姿态允许 0；其余填 0 会让 rAF 空转）',
        );
      }
    }
    const overIndexes = frameMs
      .map((ms, index) => (Number.isFinite(ms) && ms > FRAME_MS_RANGE.max ? index : -1))
      .filter((index) => index >= 0);
    if (overIndexes.length === 0) continue;
    if (overIndexes.length > 1) {
      problems.push(
        `${label} 有 ${overIndexes.length} 帧超过 ${FRAME_MS_RANGE.max}ms（第 ${overIndexes.join('、')} 帧）：` +
          'FRAME_MS_EXEMPTION 每个片段**至多 1 帧**可豁免，多帧超限说明这不是"一次入静等待"而是时序写错了',
      );
      continue;
    }
    const index = overIndexes[0];
    const ms = frameMs[index];
    const reasons = [];
    if (index !== FRAME_MS_EXEMPTION.frameIndex) {
      reasons.push(
        `超限帧是第 ${index} 帧，豁免只认第 ${FRAME_MS_EXEMPTION.frameIndex} 帧` +
          '（语义是"动作开始前的静止等待"，片段中段的长帧就是卡住）',
      );
    }
    if (!(ms <= FRAME_MS_EXEMPTION.maxOverMs)) {
      reasons.push(`第 ${index} 帧 ${ms}ms 超过豁免上限 ${FRAME_MS_EXEMPTION.maxOverMs}ms`);
    }
    if (frames.length === 1) {
      reasons.push(
        '单帧片段禁止使用豁免（单帧就是静态，静态该用 hold-last/静态片段表达，不许用长帧凑时间）',
      );
    }
    const identity = clipIdentityOf(batch, clip);
    if (identity.missing.length > 0) {
      reasons.push(
        `帧 ${identity.missing.join('、')} 既没有 contentId 也没有 sourceFile：` +
          '无法证明该片段在动（G-P14 不许被豁免吃掉）',
      );
    } else if (identity.ids.size < FRAME_MS_EXEMPTION.minDistinctContentIds) {
      reasons.push(
        `该片段只有 ${identity.ids.size} 个 distinct ${identity.basis}：豁免的前提是片段"真的在动"` +
          `（G-P14 要 ≥ ${FRAME_MS_EXEMPTION.minDistinctContentIds}），长等待 + 单张画 = 一张静止的画`,
      );
    }
    const totalMs = frameMs.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    if (!(totalMs <= FRAME_MS_EXEMPTION.maxClipTotalMs)) {
      reasons.push(`片段总时长 ${totalMs}ms 超过 ${FRAME_MS_EXEMPTION.maxClipTotalMs}ms`);
    }
    if (reasons.length > 0) {
      for (const reason of reasons) {
        problems.push(
          `${label} 第 ${index} 帧时长 ${ms}ms 超过 ${FRAME_MS_RANGE.max}ms 且不满足 FRAME_MS_EXEMPTION：${reason}`,
        );
      }
      continue;
    }
    notes.push(
      `FRAME_MS_EXEMPTION 放行 ${label} 第 ${index} 帧 ${ms}ms（> ${FRAME_MS_RANGE.max}ms）：` +
        `片段共 ${frames.length} 帧 / ${totalMs}ms / ${identity.ids.size} 个 distinct ${identity.basis}；` +
        '依据「至多 1 帧超限、只认第 0 帧、≤ 6000ms、≥ 2 个 distinct contentId、片段总时长 ≤ 9000ms、非单帧片段」',
    );
  }
  return { problems, notes };
}

/**
 * 校验一个批次的剪片段时序（只返回问题，供既有调用方与测试使用）。
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表
 */
export function checkTiming(batch) {
  return checkTimingReport(batch).problems;
}

/**
 * 校验一个批次的域完整性（不许透传母版 `anchor`、锚点必须在 native 画布内、帧锚点与批锚点一致）。
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表
 */
export function checkDomains(batch) {
  const problems = [];
  if ('anchor' in batch) {
    problems.push(`[${batch.posture}] 清单里出现了母版 anchor 字段：运行时只许读 bodyAnchor（G-11）`);
  }
  const nativeWidth = Number(batch.nativeCanvas?.width);
  const nativeHeight = Number(batch.nativeCanvas?.height);
  for (const facing of ['-1', '1']) {
    const anchor = batch.bodyAnchor?.byFacing?.[facing];
    if (!anchor) {
      problems.push(`[${batch.posture}] bodyAnchor.byFacing 缺少朝向 ${facing}`);
      continue;
    }
    if (!(anchor.x > 0) || !(anchor.x < nativeWidth)) {
      problems.push(`[${batch.posture}] 锚点 x=${anchor.x} 越出 native 画布宽 ${nativeWidth}`);
    }
    if (!(anchor.y > 0) || !(anchor.y <= nativeHeight)) {
      problems.push(`[${batch.posture}] 锚点 y=${anchor.y} 越出 native 画布高 ${nativeHeight}`);
    }
  }
  for (const [frameId, frame] of Object.entries(batch.frames ?? {})) {
    const anchor = batch.bodyAnchor?.byFacing?.[frame.facing === 1 ? '1' : '-1'];
    if (!anchor) continue;
    const deviation = Math.max(Math.abs(frame.anchorNative.x - anchor.x), Math.abs(frame.anchorNative.y - anchor.y));
    if (deviation > 2) {
      problems.push(`[${batch.posture}] 帧 ${frameId} 的 anchorNative 与批级 bodyAnchor 差 ${deviation.toFixed(2)} > 2（G-08）`);
    }
  }
  // G-08 的第二条腿：美术逐帧实测的离散度必须 ≤ 2 native，且必须真的被记进清单
  // （`spreadNative` 缺失 ⇒ 当年抽样的人已经没法证明"批内一致"，等于判据真空）
  const spread = Number(batch.bodyAnchor?.spreadNative);
  if (batch.bodyAnchor?.spreadNative === undefined || batch.bodyAnchor?.spreadNative === null) {
    problems.push(`[${batch.posture}] 清单缺少 bodyAnchor.spreadNative：G-08 无实测证据（不许省略）`);
  } else if (!Number.isFinite(spread) || spread < 0 || spread > 2) {
    problems.push(`[${batch.posture}] bodyAnchor.spreadNative=${batch.bodyAnchor?.spreadNative} 不在 [0, 2]（G-08）`);
  }
  return problems;
}

/**
 * 校验体积（单帧 @2x 与全量合计）。
 *
 * @param {Record<string, any>} manifest 清单
 * @returns {string[]} 问题列表
 */
export function checkVolume(manifest) {
  const problems = [];
  for (const [posture, batch] of Object.entries(manifest.batches ?? {})) {
    for (const [frameId, frame] of Object.entries(batch.frames ?? {})) {
      const bytes = Number(frame.files?.['2x']?.bytes);
      if (!Number.isFinite(bytes)) {
        problems.push(`[${posture}] ${frameId} 缺少 @2x 文件信息`);
        continue;
      }
      if (bytes > FRAME_2X_MAX_BYTES) {
        problems.push(`[${posture}] ${frameId}@2x ${bytes} 字节 > 单帧上限 ${FRAME_2X_MAX_BYTES}`);
      }
    }
  }
  const totals = manifest.totals ?? {};
  const totalBytes = Number(totals.bytes1x) + Number(totals.bytes2x);
  if (!Number.isFinite(totalBytes)) {
    problems.push('清单 totals 缺失（无法判断体积预算）');
  } else if (totalBytes > POSE_TOTAL_MAX_BYTES) {
    problems.push(`pose 运行资产合计 ${totalBytes} 字节 > 预算 ${POSE_TOTAL_MAX_BYTES}`);
  }
  return problems;
}

/**
 * **G-P9：totals 自证**——用清单里 **distinct 的 `file`** 重新累加字节，必须逐值等于
 * `totals.bytes1x` / `totals.bytes2x`（并且 `totals.frames` 等于帧位总数、
 * `totals.distinctFiles` 等于 distinct 文件数）。
 *
 * <p><b>为什么必须独立重算：</b>`build-pet-poses.mjs --check` 会把**已提交的 totals 直接
 * 覆盖到期望值上**（`--check` 不解码、不复算），所以"committed 的 totals 本来就写错了"这件事
 * `--check` 永远看不见。手改一个数字、或去重后仍按帧位累加（同一份字节算两遍），都能一路绿到底。
 * 这条判据是唯一从清单自身数据出发、独立于构建脚本的自证。</p>
 *
 * @param {Record<string, any>} manifest 清单
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function checkTotalsRecompute(manifest) {
  const problems = [];
  const totals = manifest && typeof manifest === 'object' ? manifest.totals : null;
  if (!totals || typeof totals !== 'object') {
    // 查不到 = 判红：缺 totals 时"算不出来"不许变成"跳过"
    return ['清单缺少 totals：G-P9 无法自证（不许静默跳过）'];
  }
  /** `file` 路径 → `{ bytes, density, posture, frameId }`（同一份文件只记一次）。 */
  const distinct = new Map();
  let frameCount = 0;
  for (const [posture, batch] of Object.entries(manifest.batches ?? {})) {
    for (const [frameId, frame] of Object.entries(batch?.frames ?? {})) {
      frameCount += 1;
      for (const density of DENSITIES) {
        const file = frame?.files?.[density];
        if (!file || typeof file !== 'object') {
          problems.push(`[${posture}] ${frameId}@${density} 缺少文件信息：totals 无法按 distinct 文件重算（G-P9）`);
          continue;
        }
        const path = typeof file.file === 'string' && file.file.length > 0 ? file.file : null;
        if (path === null) {
          problems.push(`[${posture}] ${frameId}@${density} 的 file 不是非空字符串（G-P9 无法定位磁盘文件）`);
          continue;
        }
        const bytes = Number(file.bytes);
        if (!Number.isFinite(bytes)) {
          problems.push(`[${posture}] ${frameId}@${density} 的 bytes=${JSON.stringify(file.bytes)} 不是有限数值（G-P9）`);
          continue;
        }
        const known = distinct.get(path);
        if (known === undefined) {
          distinct.set(path, { bytes, density, posture, frameId });
          continue;
        }
        if (known.bytes !== bytes) {
          problems.push(
            `[${posture}] ${frameId}@${density} 与 [${known.posture}] ${known.frameId} 共用同一份文件 ${path}，` +
              `但记录的字节数不同（${bytes} ≠ ${known.bytes}）：同一份磁盘文件不可能有两个大小（G-P9）`,
          );
        }
      }
    }
  }
  let recomputed1x = 0;
  let recomputed2x = 0;
  for (const info of distinct.values()) {
    if (info.density === '1x') recomputed1x += info.bytes;
    else recomputed2x += info.bytes;
  }
  const claimed1x = Number(totals.bytes1x);
  const claimed2x = Number(totals.bytes2x);
  if (!Number.isFinite(claimed1x) || !Number.isFinite(claimed2x)) {
    problems.push(`totals.bytes1x/bytes2x 不是有限数值（${JSON.stringify(totals.bytes1x)} / ${JSON.stringify(totals.bytes2x)}）：G-P9 无法对账`);
  } else {
    if (claimed1x !== recomputed1x) {
      problems.push(
        `totals.bytes1x=${claimed1x} ≠ 按 distinct 文件重算的 ${recomputed1x}（差 ${claimed1x - recomputed1x}）：` +
          'totals 必须是 distinct 文件的和——手写、或去重后仍按帧位累加（同一份字节算两遍）都会在这里红（G-P9）',
      );
    }
    if (claimed2x !== recomputed2x) {
      problems.push(
        `totals.bytes2x=${claimed2x} ≠ 按 distinct 文件重算的 ${recomputed2x}（差 ${claimed2x - recomputed2x}）：` +
          'totals 必须是 distinct 文件的和——手写、或去重后仍按帧位累加（同一份字节算两遍）都会在这里红（G-P9）',
      );
    }
  }
  if (Number(totals.frames) !== frameCount) {
    problems.push(`totals.frames=${JSON.stringify(totals.frames)} ≠ 实际帧位总数 ${frameCount}（G-P9）`);
  }
  if (totals.distinctFiles === undefined || totals.distinctFiles === null) {
    problems.push('清单缺少 totals.distinctFiles：去重后必须写明 distinct 磁盘文件数，否则"有没有真的去重"无法自证（G-P9）');
  } else if (Number(totals.distinctFiles) !== distinct.size) {
    problems.push(
      `totals.distinctFiles=${JSON.stringify(totals.distinctFiles)} ≠ 实际 distinct 文件数 ${distinct.size}（G-P9）`,
    );
  }
  return problems;
}

/**
 * **G-P10：内容寻址一致性 + 磁盘反向孤儿**。
 *
 * <ol>
 *   <li><b>一致性</b>：同一 `(posture, contentId)` 的所有引用，`bytes` / `sha256` / `format`
 *       必须全等。去重后两个帧位指向同一份文件，任何一项不等都意味着"其中一帧看到的内容
 *       与它自称的不是同一张画"——用户侧表现是某一帧突然闪成另一张图。</li>
 *   <li><b>反向孤儿</b>：磁盘上存在于运行目录却**没有被任何帧引用**的 webp 必须判红。
 *       去重之后节点更少、更容易漏删旧文件（改 canonical 帧、改帧 id 都会留下实体文件），
 *       而"多出来的文件"既不会被播放、也不会让任何既有断言变红。G-P4 判的是**清单内**
 *       孤儿帧（帧没被 clip 引用），这里是**磁盘侧**的反向：文件没被帧引用，两者不重叠。</li>
 * </ol>
 *
 * <p>比较范围是**批内**（按 `posture` 分组）：canonical 落盘路径包含 posture，
 * 而目标像素尺寸由各批自己的 `canvas` / `masterScale` 决定，跨批比较字节会误报。</p>
 *
 * @param {Record<string, any>} manifest 清单
 * @param {string} [outDir] 运行资产目录（默认 `public/live2d/pet-poses`）
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function checkContentAddressedFiles(manifest, outDir = DEFAULT_POSE_OUT_DIR) {
  const problems = [];
  /** `${posture}|${density}|${contentId}` → 首个引用。 */
  const firstOf = new Map();
  /** 清单引用到的相对路径（`sit/sit_neutral@1x.webp`）。 */
  const referenced = new Set();
  for (const [posture, batch] of Object.entries(manifest?.batches ?? {})) {
    for (const [frameId, frame] of Object.entries(batch?.frames ?? {})) {
      for (const density of DENSITIES) {
        const file = frame?.files?.[density];
        if (!file || typeof file !== 'object') continue;
        if (typeof file.file === 'string' && file.file.length > 0) {
          referenced.add(runtimeRelativePath(file.file));
        }
        const contentId = file.contentId;
        if (contentId === undefined) {
          problems.push(
            `[${posture}] ${frameId}@${density} 缺少 contentId：去重后"同一份文件被几个帧位共用"这件事` +
              '必须能从清单里读出来（否则一致性判据无处可施，G-P10）',
          );
          continue;
        }
        if (typeof contentId !== 'string' || !CONTENT_ID_PATTERN.test(contentId)) {
          problems.push(
            `[${posture}] ${frameId}@${density} 的 contentId=${JSON.stringify(contentId)} 不是 16 位小写十六进制（G-P10）`,
          );
          continue;
        }
        const key = `${posture}|${density}|${contentId}`;
        const previous = firstOf.get(key);
        if (previous === undefined) {
          firstOf.set(key, { frameId, file });
          continue;
        }
        for (const field of ['bytes', 'sha256', 'format']) {
          if (previous.file[field] !== file[field]) {
            problems.push(
              `[${posture}] ${frameId}@${density} 与 ${previous.frameId}@${density} 共用 contentId ${contentId}，` +
                `但 ${field} 不一致（${JSON.stringify(file[field])} ≠ ${JSON.stringify(previous.file[field])}）：` +
                '同 contentId = 同一张画，只写一份文件时字节必须全等（G-P10）',
            );
          }
        }
      }
    }
  }
  // ② 磁盘侧反向孤儿：存在的 webp 必须至少被一帧引用
  for (const relativePath of listPoseFiles(outDir)) {
    if (referenced.has(relativePath)) continue;
    problems.push(
      `运行目录里的 ${relativePath} 没有被任何帧引用：孤儿文件白占体积（改 canonical 帧 / 改帧 id 后` +
        '残留的旧文件，G-P10）',
    );
  }
  return problems;
}

/**
 * 校验一个批次的 `clips[].facing` 域（**G-P1**）。
 *
 * <p>多朝向批次第一次真的产出 clip，`facing` 从"常量 -1"变成"真数据"。写成 `0`、`"1"`、
 * 或漏掉这个字段，运行时 `clipOf(batch, id, facing)` 会在**播放时**抛 `TypeError`
 * （`manifest.ts:762` 对 `facing` 做 ±1 校验），那时已经是用户眼前黑屏。所以必须在构建期拦。</p>
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表
 */
export function checkClipFacingDomain(batch) {
  const problems = [];
  const clips = Array.isArray(batch.clips) ? batch.clips : [];
  for (const [index, clip] of clips.entries()) {
    const label = `[${batch.posture}#${clip && clip.id ? clip.id : index}]`;
    const facing = clip && clip.facing;
    if (facing !== -1 && facing !== 1) {
      problems.push(
        `${label} clips[${index}].facing=${JSON.stringify(facing)} 不是 -1/1（必须数字：字符串或 0 会让 clipOf 在播放期抛错，G-P1）`,
      );
    }
  }
  return problems;
}

/**
 * 校验"每个出现过的朝向都有自己的 clip"（**G-P2**）。
 *
 * <p>判据按**行为**写：先从 `frames` 求出现过的朝向集合，再求 `clips` 覆盖的朝向集合，
 * 前者必须是后者的子集。这样单向缺 clip 会红，而"只有单朝向的批次"（`sit` 只有 `-1`）
 * 天然通过——不需要维护一张"哪些批次该有两条 clip"的名字表（名字表迟早与真数据漂移）。</p>
 *
 * <p>为什么这条必须有：缺一条 clip 时 `isPlayable(posture, facing)` 才判不可播，
 * 于是运行时**静默**降级成站姿。没有门禁，"少了一条"不会以任何形式被看见。</p>
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表
 */
export function checkClipFacingCoverage(batch) {
  const problems = [];
  const clips = Array.isArray(batch.clips) ? batch.clips : [];
  const frameFacings = new Set();
  for (const frame of Object.values(batch.frames ?? {})) {
    if (frame && (frame.facing === -1 || frame.facing === 1)) frameFacings.add(frame.facing);
  }
  const clipFacings = new Set();
  for (const clip of clips) {
    if (clip && (clip.facing === -1 || clip.facing === 1)) clipFacings.add(clip.facing);
  }
  for (const facing of [...frameFacings].sort((a, b) => a - b)) {
    if (!clipFacings.has(facing)) {
      problems.push(
        `[${batch.posture}] frames 里有朝向 ${facing} 的帧，但 clips 里没有该朝向的片段：` +
          '运行时会静默降级成站姿（G-P2，删掉一条 clip 就会这样）',
      );
    }
  }
  return problems;
}

/**
 * 校验 clip 内每帧的朝向与 clip 自身朝向一致（**G-P3**）。
 *
 * <p><b>为什么必须显式守：</b>跨朝向串帧（把 `r1` 塞进 `facing:-1` 的 clip）**不会让任何既有断言变红** ——
 * 帧存在、文件齐、`frameMs` 长度对、包络是全体帧的 min/max、`isPlayable` 只看"帧存在且有锚"。
 * 症状是走路时突然反向抽搐一下，而且只在真机上看得到。所以这里逐个遍历 `clip.frames` 求集合，
 * 不写成"源码里出现过 facing 字样"的文本断言。</p>
 *
 * <p>同时守一条相邻的洞：clip 引用的帧 id 必须在 `frames` 里存在（悬空引用同样不会让
 * `frameMs` 长度断言变红）。</p>
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表
 */
export function checkClipFrameFacing(batch) {
  const problems = [];
  const clips = Array.isArray(batch.clips) ? batch.clips : [];
  const frames = batch.frames ?? {};
  for (const clip of clips) {
    const ids = Array.isArray(clip && clip.frames) ? clip.frames : [];
    const label = `[${batch.posture}#${clip && clip.id ? clip.id : '?'}]`;
    for (const frameId of ids) {
      const frame = frames[frameId];
      if (!frame) {
        problems.push(`${label} 引用了不存在的帧 ${JSON.stringify(frameId)}（悬空引用，G-P3）`);
        continue;
      }
      if (frame.facing !== clip.facing) {
        // 两侧都用 JSON.stringify：`facing` 写成字符串 `"1"` 时，裸模板串会打出
        // 「facing=1 ≠ clip.facing=1」——两个 1 不相等，读的人第一反应会是"门禁自己坏了"。
        // 带上引号之后 `"1"` 与 `1` 在文字上可区分，诊断信息才自洽（判据本身一个字没放宽）。
        problems.push(
          `${label} 内帧 ${frameId} 的 facing=${JSON.stringify(frame.facing)} ` +
            `≠ clip.facing=${JSON.stringify(clip.facing)}：` +
            '跨朝向串帧会让角色在播放中反向抽搐，且不会让任何既有断言变红（G-P3）',
        );
      }
    }
  }
  return problems;
}

/**
 * 校验批次内没有孤儿帧（**G-P4**）。
 *
 * <p>美术多交一帧、或改了帧 id 却没进 clip，构建会成功、`--check` 会成功、盘上多两个 webp
 * 永远没人读。孤儿帧白占体积（每帧 ≈170 KB），在只剩 14% 体积余量的切片 2 里不是小事。</p>
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表
 */
export function checkOrphanFrames(batch) {
  const problems = [];
  const clips = Array.isArray(batch.clips) ? batch.clips : [];
  const referenced = new Set();
  for (const clip of clips) {
    for (const frameId of Array.isArray(clip && clip.frames) ? clip.frames : []) referenced.add(frameId);
  }
  for (const frameId of Object.keys(batch.frames ?? {})) {
    if (!referenced.has(frameId)) {
      problems.push(
        `[${batch.posture}] 帧 ${frameId} 没有被任何 clip 引用（孤儿帧白占体积、也永远不会被播放，G-P4）`,
      );
    }
  }
  return problems;
}

/**
 * `onEnd:'return-stand'` 片段的**总可见时长**下限（毫秒）。
 *
 * <p>300 ms 是"一个能被看见的节拍"：低于它，用户侧读成"卡了一下"而不是"做了一个动作"。
 * 真数据里 `sleep.exit` 正是单帧 `startle` × 300 ms（睡→醒先睁一次眼）。</p>
 */
export const MIN_RETURN_STAND_MS = 300;

/**
 * 校验 clip 的播放语义（**G-P5 / G-P6**）。
 *
 * <p><b>G-P5</b>：`loop:true` 的 clip 里 `frameMs` 全项必须 `> 0`。填 0 的循环片段 =
 * 永不推进的假动画（rAF 空转、画面静止），与 D-03 是同类坑。</p>
 *
 * <p><b>G-P6</b>：`onEnd:'return-stand'` 的片段**总可见时长必须 ≥ {@link MIN_RETURN_STAND_MS}**。</p>
 *
 * <p><b>为什么判据从"帧数 ≥ 2"改成"总时长"（这是一次口径修正，不是放宽）：</b>
 * 真实要防的是"闪一下就回站姿"，而帧数只是它的**代理指标**，两个方向都会判错：</p>
 * <ul>
 *   <li><b>它冤枉合法形态</b>：`sleep.exit` = 单帧 `startle` × 300 ms（睡→醒先睁一次眼）
 *       只有 1 帧但看得清，旧判据直接判红；</li>
 *   <li><b>它放过更糟的形态</b>：`2 帧 × 40 ms`（合计 80 ms，闪得比单帧 300 ms 厉害得多）
 *       旧判据判绿。</li>
 * </ul>
 * <p>换成"总时长"后两个方向都对了：`2 帧 × 40 ms` 从**绿变红**（收紧），
 * 单帧 130 ms（`tests/petPoseSlice2Export.test.cjs` 的 T01-11）仍然红。
 * 帧数不再参与判定——"能不能被看见"本来就是时间问题，不是帧数问题。</p>
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表
 */
export function checkClipSemantics(batch) {
  const problems = [];
  const clips = Array.isArray(batch.clips) ? batch.clips : [];
  for (const clip of clips) {
    const label = `[${batch.posture}#${clip && clip.id ? clip.id : '?'}]`;
    const ids = Array.isArray(clip && clip.frames) ? clip.frames : [];
    const frameMs = Array.isArray(clip && clip.frameMs) ? clip.frameMs : [];
    if (clip && clip.loop === true) {
      const zeroIndex = frameMs.findIndex((ms) => !(Number(ms) > 0));
      if (zeroIndex >= 0) {
        problems.push(
          `${label} loop:true 但第 ${zeroIndex} 帧时长 ${JSON.stringify(frameMs[zeroIndex])} 不是正数：` +
            '循环片段里填 0 等于永不推进的假动画（G-P5）',
        );
      }
    }
    if (clip && clip.onEnd === 'return-stand') {
      const totalMs = frameMs.reduce((sum, ms) => sum + Number(ms), 0);
      if (!Number.isFinite(totalMs) || totalMs < MIN_RETURN_STAND_MS) {
        problems.push(
          `${label} onEnd:return-stand 但总时长 ${JSON.stringify(frameMs)}（${ids.length} 帧，合计 ${totalMs} ms）` +
            `短于 ${MIN_RETURN_STAND_MS} ms：用户侧读成"闪一下就回站姿/卡了一下"，不是"做了一个动作"（G-P6）`,
        );
      }
    }
  }
  return problems;
}

/**
 * 校验每帧的运行文件都是**无损编码**（**G-P8**）。
 *
 * <p><b>为什么必须有这一条：</b>`build-pet-poses.mjs` 调 `transcodeLayer` 时传了
 * `maxBytes: FRAME_2X_MAX_BYTES`（400 KiB），而 `build-pet-layers.mjs` 里有一条**自动降级旁路**：
 * `if (lossless && maxBytes > 0 && bytes > maxBytes) { lossless = false; 重新编码 }`，
 * 返回的 `format` 随之从 `'webp-lossless'` 变成 `'webp'`。</p>
 *
 * <p>后果是双向的坏：①U1 裁定的"保持无损"**没有任何门禁守着**；②降级后字节**更少**，
 * 于是 `checkVolume` 的"单帧 ≤ 400 KiB""合计 ≤ 6 MiB"两条体积断言**照样全绿**
 * —— 体积断言在这里恰好是"有损反而更容易过"。用户侧看到的是换姿/换朝向时的块效应与振铃。</p>
 *
 * <p>判据是行为断言：遍历该批每个帧的 `files['1x']` 与 `files['2x']`，两者的 `format`
 * 都必须 `=== 'webp-lossless'`（`types.ts` 里 `PoseAssetFile.format` 已声明该字段，
 * 产物已带，不需要改 schema）。</p>
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表
 */
export function checkFrameEncoding(batch) {
  const problems = [];
  for (const [frameId, frame] of Object.entries(batch.frames ?? {})) {
    const files = frame && frame.files;
    // adapter 草稿（未转码）没有 `files`：这不是编码问题，"文件齐不齐"由 checkVolume 守。
    // 一旦 `files` 存在（= 已经过转码的运行帧），两个密度档就都必须无损，缺一档也算缺陷。
    if (!files || typeof files !== 'object') continue;
    for (const density of DENSITIES) {
      const file = files[density];
      if (!file || typeof file !== 'object') {
        problems.push(`[${batch.posture}] ${frameId}@${density} 缺少文件信息（无法判断编码格式，G-P8）`);
        continue;
      }
      if (file.format !== LOSSLESS_FORMAT) {
        problems.push(
          `[${batch.posture}] ${frameId}@${density} 的编码格式是 ${JSON.stringify(file.format)}，` +
            `不是 ${JSON.stringify(LOSSLESS_FORMAT)}：该帧被降成了有损编码——字节更少所以体积断言全绿，` +
            '但换姿时会看出块效应（transcodeLayer 的自动降级旁路，G-P8）',
        );
      }
    }
  }
  return problems;
}

/**
 * 主选择器（`PoseController.pickClip`）会依次尝试的片段 id，**顺序即优先级**。
 *
 * <p><b>为什么门禁要持有这份表：</b>G-P11 判的是"同一姿态同一朝向下，有没有片段会被前面的
 * 片段永久遮住"。这个判断等价于"`pickClip` 会先把哪一条还给你"，无法只凭 `clips[]` 里的
 * 字段算出来，必须知道候选序。所以这里持有它，并用 {@link checkPickOrderDrift} 与
 * `src/pet/poses/controller.ts` 的真实现对账——两边一旦漂移，门禁先红，而不是等用户发现
 * "趴下动画永远不播"。</p>
 *
 * <p>`exit` 刻意**不在**表内：它不由 `setPosture` 的主选择器选，而由"离开姿态"的专用路径
 * （`pendingStand` → `clipOf(batch,'exit',facing)`）选中。把 `exit` 混进候选序会让
 * "进姿态时若没有 enter 就顺手播起身"这种荒谬行为发生。</p>
 */
export const PICK_CANDIDATE_IDS = Object.freeze(['hold', 'cycle', 'once', 'enter']);

/**
 * **G-P11 片段可达性**：同一姿态、同一朝向下不许出现两条"主选择器候选"片段。
 *
 * <p><b>为什么这条必须存在：</b>`lie` 一旦同时产出 `hold`（趴着不动）与 `enter`（趴下过程），
 * 因为候选序里 `hold` 在 `enter` 之前，`enter` 会被**永久遮住**：`clips[]` 两条都合法、
 * 包络/时序/朝向全绿、体积也正常，但用户永远看不到趴下动画。这不是"少了一条断言"，
 * 而是"数据合法但一半永不可达"的设计缺陷，只能靠显式判据守。</p>
 *
 * <p><b>判据按行为遍历 `batch.clips`，不写姿态名字表</b>：任何批次、任何将来新增的片段 id
 * （只要它进了候选序）都会被同一套逻辑检查。</p>
 *
 * <p>合法形态有两种，都不触发本判据：单帧静止用"1 帧 + 时长"表达（`sit` 的 `hold`），
 * 或者把"过程 + 停留"合并成一条 `enter` 并以 `hold-last` 收尾（`lie`）。</p>
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function checkClipReachability(batch) {
  const problems = [];
  const label = batch && batch.posture ? batch.posture : '(未知批次)';
  const clips = Array.isArray(batch && batch.clips) ? batch.clips : [];
  /** 朝向 → 该朝向下的片段列表（朝向按 `String()` 归一，`-1` 与 `"-1"` 不混）。 */
  const byFacing = new Map();
  for (const clip of clips) {
    const key = String(clip && clip.facing);
    const list = byFacing.get(key) ?? [];
    list.push(clip);
    byFacing.set(key, list);
  }
  for (const [facing, group] of byFacing) {
    const candidates = group
      .filter((clip) => PICK_CANDIDATE_IDS.includes(clip.id))
      .sort((a, b) => PICK_CANDIDATE_IDS.indexOf(a.id) - PICK_CANDIDATE_IDS.indexOf(b.id));
    if (candidates.length <= 1) continue;
    const names = candidates.map((clip) => `${clip.id}@${facing}`);
    problems.push(
      `[${label}] 朝向 ${facing} 下同时存在 ${names.join(' 与 ')}：主选择器只按固定候选序 ` +
        `（${PICK_CANDIDATE_IDS.join(' → ')}）取第一条 ⇒ ${names.slice(1).join('、')} 永远不可达（G-P11）。` +
        '静态停留请用"单帧 + 时长"或把过程与停留合并成一条 enter（hold-last）表达，' +
        '不要靠再加一条 hold 片段（那会让另一条静默失效而门禁全绿）',
    );
  }
  return problems;
}

/**
 * **G-P11 的对账项**：门禁持有的候选序必须与 `PoseController.pickClip` 的真实现逐项一致。
 *
 * <p>没有这条，G-P11 会跟着候选序一起漂移：`pickClip` 改成 `['cycle','hold',…]` 之后，
 * "谁遮住谁"的结论就变了，而门禁还在按旧顺序判 ⇒ 判据本身变成谎话。</p>
 *
 * @param {object} [options] 选项
 * @param {string} [options.controllerPath] `controller.ts` 路径（测试可注入）
 * @returns {string[]} 问题列表
 */
export function checkPickOrderDrift(options = {}) {
  const controllerPath =
    options.controllerPath ??
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pet', 'poses', 'controller.ts');
  if (!existsSync(controllerPath)) {
    return [`门禁无法对账候选序：找不到 ${controllerPath}（G-P11 的判据依赖它）`];
  }
  const source = readFileSync(controllerPath, 'utf8');
  const start = source.indexOf('private pickClip(');
  if (start === -1) {
    return ['门禁无法对账候选序：controller.ts 里找不到 `private pickClip(`（方法改名或删除了，G-P11 的判据依赖它）'];
  }
  const end = source.indexOf('private handleFrame(');
  const body = source.slice(start, end === -1 ? start + 8000 : end);
  const match = /for \(const id of \[([^\]]*)\]\)/.exec(body);
  if (match === null) {
    return ['门禁无法对账候选序：`pickClip` 里没有 `for (const id of [...])`（G-P11 的判据依赖它，必须显式列出候选序）'];
  }
  const ids = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
  if (ids.length !== PICK_CANDIDATE_IDS.length || ids.some((id, index) => id !== PICK_CANDIDATE_IDS[index])) {
    return [
      `门禁的候选序 [${PICK_CANDIDATE_IDS.join(', ')}] 与 controller.pickClip 的真实现 ` +
        `[${ids.join(', ')}] 不一致：G-P11 会按错的顺序判"谁遮住谁"（改实现必须同批改 check-pet-poses.mjs）`,
    ];
  }
  return [];
}

/**
 * **单真源对账：帧时长窄豁免在运行时与门禁两侧必须逐条同构。**
 *
 * <p><b>为什么必须有这条（真实事故）：</b>"每帧时长上界 2400ms"曾经有**两份真源**
 * ——门禁的 {@link FRAME_MS_RANGE} 与播放器的 `FRAME_MS_MAX`。给 `sit` 的眨眼接入
 * {@link FRAME_MS_EXEMPTION} 时只在门禁侧加了豁免，运行时仍然抛 `RangeError` ⇒
 * `PoseController.setPosture('sit')` 每次都回 `stand`，而坐姿的画、时序、体积、去重
 * **门禁一条都不红**。用户侧表现就是"坐着不会眨眼"，日志里只有一句"播放失败"。</p>
 *
 * <p><b>为什么用文本对账而不是共享常量：</b>跨语言 import 走不通（门禁是 node ESM，
 * 播放器是被 vite 打包的 TS）。所以沿用本仓库既有先例（{@link checkPickOrderDrift}）：
 * 解析另一侧源码，断言两侧的数值与条件结构一致。任一侧单独改动 ⇒ 这里红。</p>
 *
 * <p><b>断言五件事：</b></p>
 * <ol>
 *   <li>`player.ts` 的 `FRAME_MS_MAX` 数值 === 门禁的 `FRAME_MS_RANGE.max`；</li>
 *   <li>四个豁免门槛逐值相等：`maxOverMs` / `maxClipTotalMs` / `frameIndex` / `minDistinctFrames`
 *       （门禁侧名叫 `minDistinctContentIds`，因为门禁读得到 `contentId`）；</li>
 *   <li>播放器代码**真的引用**了这四个字段（不是写了一份没人读的常量）；</li>
 *   <li>"片段内 distinct frame id 作 contentId 代理 + 真判据由 G-P14 独占"这句话必须写在源码里
 *       （代理关系是本豁免最容易被悄悄放大的地方，注释被删就等于口径被删）；</li>
 *   <li>播放器的豁免只在"超过上限"时生效（低于下界永不豁免），且单帧片段天然被排除
 *       （靠 `frames.length < minDistinctFrames`）。</li>
 * </ol>
 *
 * @param {object} [options] 选项
 * @param {string} [options.playerPath] `player.ts` 路径（测试可注入）
 * @returns {string[]} 问题列表
 */
export function checkPlayerExemptionDrift(options = {}) {
  const playerPath =
    options.playerPath ??
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pet', 'poses', 'player.ts');
  if (!existsSync(playerPath)) {
    return [`豁免对账失败：找不到运行时播放器 ${playerPath}（FRAME_MS 的单真源对账依赖它）`];
  }
  const raw = readFileSync(playerPath, 'utf8');
  const source = stripSourceComments(raw);
  const problems = [];
  /** 从源码里抠一个数值常量（注释已剥离，避免读到注释里的示例数字）。 */
  const numberOf = (pattern, label) => {
    const match = pattern.exec(source);
    if (match === null) {
      problems.push(`豁免对账失败：player.ts 里找不到 ${label}（改名/删除都必须同批改本判据）`);
      return null;
    }
    const value = Number(match[1]);
    if (!Number.isFinite(value)) {
      problems.push(`豁免对账失败：player.ts 的 ${label} 不是数值（实际 ${JSON.stringify(match[1])}）`);
      return null;
    }
    return value;
  };
  const pairs = [
    ['FRAME_MS_MAX', /export const FRAME_MS_MAX = (\d+)/, FRAME_MS_RANGE.max, '每帧时长上界'],
    ['FRAME_MS_EXEMPTION.maxOverMs', /maxOverMs:\s*(\d+)/, FRAME_MS_EXEMPTION.maxOverMs, '超限帧自身上限'],
    ['FRAME_MS_EXEMPTION.maxClipTotalMs', /maxClipTotalMs:\s*(\d+)/, FRAME_MS_EXEMPTION.maxClipTotalMs, '片段总时长上限'],
    ['FRAME_MS_EXEMPTION.frameIndex', /frameIndex:\s*(\d+)/, FRAME_MS_EXEMPTION.frameIndex, '只认的帧序号'],
    ['FRAME_MS_EXEMPTION.minDistinctFrames', /minDistinctFrames:\s*(\d+)/, FRAME_MS_EXEMPTION.minDistinctContentIds, 'distinct 下限'],
  ];
  for (const [label, pattern, expected, human] of pairs) {
    const actual = numberOf(pattern, label);
    if (actual === null) continue;
    if (actual !== expected) {
      problems.push(
        `豁免对账失败：${human}（${label}）在 player.ts 里是 ${actual}，门禁侧是 ${expected}：` +
          '同一判据两份真源 ⇒ 门禁放行的片段运行时会抛 RangeError（或反之放行坏数据），必须同批对齐',
      );
    }
  }
  for (const field of ['frameIndex', 'maxOverMs', 'maxClipTotalMs', 'minDistinctFrames']) {
    if (!source.includes(`FRAME_MS_EXEMPTION.${field}`)) {
      problems.push(
        `豁免对账失败：player.ts 的豁免实现没有引用 FRAME_MS_EXEMPTION.${field}：` +
          '常量写了却没人读，等于口径只存在于注释里（这正是"空门禁"的老毛病）',
      );
    }
  }
  if (!source.includes('new Set(frames)')) {
    problems.push(
      '豁免对账失败：player.ts 的豁免没有用 `new Set(frames)` 判 distinct frame id：' +
        '"长等待 + 同一张画"会被当成合法片段放行（G-P14 的运行时代理缺失）',
    );
  }
  // 代理关系必须写在源码注释里（剥注释后的代码看不出"为什么是 frame id 而不是 contentId"）
  if (!(raw.includes('G-P14') && raw.includes('distinct frame id'))) {
    problems.push(
      '豁免对账失败：player.ts 里缺少"以 distinct frame id 代理 contentId、真判据由 G-P14 独占"的说明：' +
        '代理关系被删掉后，下一个人会以为运行时也验了 contentId（而它拿不到）',
    );
  }
  return problems;
}

/**
 * 渲染层里**禁止出现**的镜像变换（G-P12）。
 *
 * <p>静态姿态（`sit`/`lie`/`sleep`）只有左向画稿。缺右向时的正确做法是**用左向原样播**
 * （设计 §4.3 方案 Ⅲ），而不是 `scaleX(-1)` 把画面翻过来：镜像会同时镜像**锚点**，
 * 让落点对、内容错（而且用户看到的是一只被翻面的猫——它身上的文字/装饰全反了）。
 * 这里覆盖 CSS 与内联样式两种写法，`scale()` / `scale3d()` 的负值同样算。</p>
 */
const MIRROR_PATTERNS = Object.freeze([
  Object.freeze({ name: 'scaleX(负数)', pattern: /scaleX\(\s*-\s*[\d.]+\s*\)/ }),
  Object.freeze({ name: 'scaleY(负数)', pattern: /scaleY\(\s*-\s*[\d.]+\s*\)/ }),
  Object.freeze({ name: 'scale(负数,…)', pattern: /(^|[^\w-])scale\(\s*-\s*[\d.]+\s*[,)]/ }),
  Object.freeze({ name: 'scale3d(负数,…)', pattern: /scale3d\(\s*-\s*[\d.]+\s*,/ }),
]);

/** 扫描的渲染层文件后缀（TS/Vue/CSS/HTML 都可能承载 transform）。 */
const RENDER_SOURCE_EXTENSIONS = Object.freeze(['.ts', '.mts', '.js', '.mjs', '.css', '.scss', '.vue', '.html']);

/**
 * 去掉注释（**只去掉真注释**），避免"文档里提到 `scaleX(-1)`"被当成违规。
 *
 * <p>`//` 的判定要求前面不是 `:`，这样 `lxa://pet-poses/...`、`https://...` 里的双斜杠
 * 不会被误当成注释起点（否则整行后半段会被吞掉，反而可能漏掉真正的 transform）。</p>
 *
 * @param {string} text 源码文本
 * @returns {string} 去注释后的文本（行号保持可用：块注释替换成等量换行）
 */
export function stripSourceComments(text) {
  const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''));
  return withoutBlock
    .split('\n')
    .map((line) => line.replace(/(^|\s)(?<!:)\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * 递归收集渲染层源文件（`src/pet/**`，可选多个根）。
 *
 * @param {string[]} roots 根目录（缺省 = `src/pet`）
 * @returns {Array<{path: string, text: string}>} 文件内容列表
 */
function collectRenderSourceFiles(roots) {
  const collected = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!RENDER_SOURCE_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(ext))) continue;
      try {
        collected.push({ path: full, text: readFileSync(full, 'utf8') });
      } catch {
        // 读不到就跳过：这不是"检查通过"，是"这个文件不参与静态扫描"（不会让任何判据变绿）
      }
    }
  };
  const list = Array.isArray(roots) && roots.length > 0
    ? roots
    : [resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pet')];
  for (const root of list) walk(root);
  return collected;
}

/**
 * **G-P12 禁镜像**：静态扫描渲染层，出现 `scaleX(-1)`（或等价的负向 `scale`/`scale3d`）即判红。
 *
 * <p>为什么必须是静态扫描而不是运行时断言：镜像渲染是**一行 CSS**，它不会让任何数据判据
 * 变红（帧、锚点、体积全都还是对的），只有肉眼看画面才会发现"猫被翻过来了"。
 * 代码里出现这个变换本身就足以证明有人打算用镜像凑合，所以在这一层拦。</p>
 *
 * @param {object} [options] 选项
 * @param {Array<{path: string, text: string}>} [options.files] 直接给文件内容（测试注入）
 * @param {string[]} [options.roots] 扫描根目录（缺省 = `src/pet`）
 * @returns {string[]} 问题列表
 */
export function checkNoMirrorRender(options = {}) {
  const problems = [];
  const files = Array.isArray(options.files) ? options.files : collectRenderSourceFiles(options.roots);
  for (const file of files) {
    const text = typeof file.text === 'string' ? stripSourceComments(file.text) : '';
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const { name, pattern } of MIRROR_PATTERNS) {
        if (!pattern.test(line)) continue;
        problems.push(
          `${file.path}:${index + 1} 出现镜像变换 ${name}：${line.trim()} —— ` +
            '静态姿态缺右向时**用左向原样播**，不许用镜像凑合。镜像会同时镜像锚点，' +
            '让落点对、内容错（G-P12）',
        );
      }
    }
  }
  return problems;
}

/**
 * **G-P14「在动」判据**：多帧片段的"在动"按 **distinct `contentId` ≥ 2** 判，**不是按帧数**。
 *
 * <p><b>为什么不能用帧数：</b>两帧同图会被误判成动画——`clips[].frames` 有两项、
 * `frameMs` 有两项、时序判据全绿，但播放起来是**一张静止的画**（rAF 空转、用户看到卡住）。
 * `contentId` 是母版摘要（"这两帧是不是同一张画"的权威答案），所以判据落在这里。</p>
 *
 * <p><b>单帧片段显式豁免</b>：`sit` 的 `hold` 只有 1 帧且 `frameMs:[0]`，它本来就该是静止的
 * ——"停留"由片段类型（`hold`）表达，不由帧数表达。豁免写在代码里并给出理由，
 * **不用"帧数 > 1 才检查"那种隐式豁免蒙过去**（那会让判据的形状随数据摇摆）。</p>
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function checkClipMotion(batch) {
  const problems = [];
  const label = batch && batch.posture ? batch.posture : '(未知批次)';
  const clips = Array.isArray(batch && batch.clips) ? batch.clips : [];
  const frames = batch && batch.frames && typeof batch.frames === 'object' ? batch.frames : {};
  for (const clip of clips) {
    const ids = Array.isArray(clip && clip.frames) ? clip.frames : [];
    if (ids.length === 0) continue;
    const contentIds = new Set();
    const missing = [];
    for (const frameId of ids) {
      const file = frames[frameId] && frames[frameId].files ? frames[frameId].files['1x'] : undefined;
      const contentId = file ? file.contentId : undefined;
      if (typeof contentId !== 'string' || !CONTENT_ID_PATTERN.test(contentId)) {
        missing.push(frameId);
        continue;
      }
      contentIds.add(contentId);
    }
    if (missing.length > 0) {
      problems.push(
        `[${label}] ${clip.id}@${clip.facing} 的帧 ${missing.join('、')} 缺少合法的 contentId：` +
          '无法判断这个片段是否真的在动（G-P14）',
      );
      continue;
    }
    // 单帧片段：显式豁免（静止姿态，停留由片段类型表达，不由帧数表达）
    if (ids.length === 1) continue;
    if (contentIds.size < 2) {
      problems.push(
        `[${label}] ${clip.id}@${clip.facing} 有 ${ids.length} 帧但只有 ${contentIds.size} 个 distinct contentId：` +
          '这是"假动画"（多帧同图 = 播起来是静止的，rAF 空转、用户看到卡住）。' +
          '要停留请用单帧 + 时长，不要靠复制同一张画凑帧数（G-P14）',
      );
    }
  }
  return problems;
}

/**
 * 校验**已 accepted 的批次**没有用镜像推导的锚点（**G-P7**）。
 *
 * <p><b>为什么这条必须存在：</b>`isPlayable` 的注释与设计 §B.1 都写"缺锚 ⇒ 该朝向不可播"，
 * 但 `pet-pose-adapters.mjs` 的 `normalizeBodyAnchor` 在缺某个朝向时会**自动补
 * `nativeCanvas.width − x` 的镜像推导锚**，把 `byFacing` 补成永远两键齐全。
 * 也就是说"缺锚即不可播"在实现上曾经是一道**永远成立的空门**。</p>
 *
 * <p>镜像同时镜像锚点：落点对（帧确实是镜像画的），**内容错**（这一朝向的实测躯干质心
 * 从来没人量过，尾巴把 bbox 拉偏时镜像值会偏 20+ native）。所以口径是：
 * `accepted` 批次一旦 `byFacingSource === 'mirror-derived'` ⇒ 门禁直接红，
 * 让美术补齐该朝向的实测锚点；运行期 `isPlayable` 同口径整批判不可播（降级 stand）。</p>
 *
 * <p><b>判据按行为写</b>：读清单里的 `accepted[]` 与 `batches[*].bodyAnchor.byFacingSource`
 * 逐批求值，不看源码里出现过什么标识符；也不按批次名硬编码（将来 `lie` 若走 mirror-derived
 * 同样会被这里拦住）。`batch-single` 合法（v1/v2 正面与卧姿不区分朝向），`sit` 正是这种。</p>
 *
 * @param {Record<string, any>} manifest 清单
 * @returns {string[]} 问题列表
 */
export function checkAcceptedAnchorSource(manifest) {
  const problems = [];
  const batches = manifest && manifest.batches ? manifest.batches : {};
  const accepted = Array.isArray(manifest && manifest.accepted) ? manifest.accepted : [];
  /** 待求值的批次：accepted 名单优先，再补上清单里实际导出的批次（导出即 accepted）。 */
  const targets = [];
  const seen = new Set();
  for (const posture of accepted) {
    if (seen.has(posture)) continue;
    seen.add(posture);
    targets.push([posture, batches[posture]]);
  }
  for (const [posture, batch] of Object.entries(batches)) {
    if (seen.has(posture)) continue;
    seen.add(posture);
    targets.push([posture, batch]);
  }
  for (const [posture, batch] of targets) {
    if (!batch || typeof batch !== 'object') continue;
    const source = batch.bodyAnchor ? batch.bodyAnchor.byFacingSource : undefined;
    if (source === 'mirror-derived') {
      problems.push(
        `[${posture}] 该批次的某个朝向锚点是画布镜像推导，不是实测（byFacingSource=mirror-derived）：` +
          '镜像同时镜像锚点会让落点对、内容错（尾巴把 bbox 拉偏，镜像值可偏 20+ native），' +
          '必须让美术补齐该朝向实测锚点（G-P7）',
      );
    }
  }
  return problems;
}

/**
 * 把剪辑相关的断言汇总成一组（`runPoseGate` 每批调用一次）。
 *
 * <p>顺序固定（域 → 覆盖 → 帧朝向 → 可达性 → 孤儿 → 语义 → 编码），报错行因此稳定、可 diff。</p>
 *
 * <p><b>可达性（G-P11）放在这里而不是"清单级"</b>：它只读 `batch.clips` 的 `id`/`facing`，
 * 不需要 `contentId`（那是转码之后才有的），所以 adapter 草稿也能被同一套判据检查
 * ——`petPoseSlice2Export.test.cjs` 正是拿草稿调用 `checkClips` 的。</p>
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表
 */
export function checkClips(batch) {
  return [
    ...checkClipFacingDomain(batch),
    ...checkClipFacingCoverage(batch),
    ...checkClipFrameFacing(batch),
    ...checkClipReachability(batch),
    ...checkOrphanFrames(batch),
    ...checkClipSemantics(batch),
    ...checkFrameEncoding(batch),
  ];
}

/**
 * 校验输出目录里没有 PNG（母版绝不许被顺手拷进 `public/`）。
 *
 * @param {string} outDir 输出目录
 * @returns {string[]} 问题列表
 */
export function checkNoPng(outDir) {
  const problems = [];
  if (!existsSync(outDir)) return problems;
  /** 深度优先。 */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.png$/i.test(entry.name)) problems.push(`pose 运行目录里出现 PNG：${full}（母版只许留在 docs/）`);
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
 * @param {string} [options.posesJsonPath] 清单路径（测试用）
 * @param {string} [options.outDir] 运行目录（测试用）
 * @param {string} [options.geometryPath] 几何真源路径（测试用）
 * @param {(message: string) => void} [options.log] 日志出口
 * @returns {Promise<{ok: boolean, problems: string[], notes: string[], deferred: Array<{posture:string, reason:string}>}>}
 *   门禁结果
 */
export async function runPoseGate(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const verbose = options.verbose === true;
  const posesJsonPath = options.posesJsonPath ?? POSES_JSON_PATH;
  const outDir = options.outDir ?? DEFAULT_POSE_OUT_DIR;
  const geometryPath = options.geometryPath ?? GEOMETRY_PATH;
  const problems = [];
  const notes = [];

  if (!existsSync(posesJsonPath)) {
    return { ok: false, problems: [`清单不存在：${posesJsonPath}`], notes, deferred: [] };
  }
  let manifest = null;
  try {
    manifest = readJsonFile(posesJsonPath);
  } catch (err) {
    return { ok: false, problems: [`清单不可解析：${(err && err.message) || err}`], notes, deferred: [] };
  }
  const geometry = readJsonFile(geometryPath);
  const align = manifest.align ?? {};

  // 未知键闸门（G-16）：只拦"schema 没声明的键"。手改了清单却没重建、或上游 adapter
  // 新写了一个字段而这里没登记，都会在这一行红掉——不许静默丢弃。
  problems.push(...checkUnknownKeys(manifest));

  for (const [posture, batch] of Object.entries(manifest.batches ?? {})) {
    // 时序判据要分两路取：`problems` 让门禁红，`notes` 只用于**点名豁免**
    // （FRAME_MS_EXEMPTION 放行的超限帧必须留下痕迹，静默放行等于 2400 上限不作数）。
    const timing = checkTimingReport(batch);
    const batchProblems = [
      ...checkDomains(batch),
      ...timing.problems,
      ...checkEnvelope(batch, geometry, align),
      ...checkClips(batch),
      // G-P14 需要 `contentId`（母版摘要，转码之后才有），所以它只能跑在**清单级**，
      // 不放进 `checkClips`（那里还要能吃 adapter 草稿）。
      ...checkClipMotion(batch),
      ...checkVolume(manifest).filter((line) => line.includes(`[${posture}]`)),
    ];
    if (verbose) {
      log(`[gate:pet:poses] ${posture}：${batchProblems.length === 0 ? 'OK' : `${batchProblems.length} 个问题`}`);
    }
    problems.push(...batchProblems);
    notes.push(...timing.notes);
  }
  problems.push(...checkVolume(manifest).filter((line) => !line.includes(']')));
  // G-P9 / G-P10 是**清单级**判据（不属于某个批次），所以不参与上面的按批分流。
  // 顺序有意先 P9 后 P10：totals 对不上时先说 totals，免得一屏都是"contentId 不一致"
  // 这种下游症状（两者的根因常常是同一个：去重没落地或清单被手改）。
  problems.push(...checkTotalsRecompute(manifest));
  problems.push(...checkContentAddressedFiles(manifest, outDir));
  problems.push(...checkAcceptedAnchorSource(manifest));
  // G-P11 的对账项：门禁持有的候选序必须与 controller.pickClip 的真实现一致，
  // 否则"谁遮住谁"的结论会跟着实现漂移而判据不自知。
  problems.push(...checkPickOrderDrift());
  // 单真源对账：帧时长窄豁免在运行时（player.ts）与门禁两侧必须逐条同构。
  // 没有这条，"门禁放行、运行时抛 RangeError"那种事故会以"功能静默消失"的形式复活。
  problems.push(...checkPlayerExemptionDrift());
  // G-P12：静态扫描渲染层，禁止用 scaleX(-1) 之类的镜像凑出"右向"。
  problems.push(...checkNoMirrorRender());
  problems.push(...checkNoPng(outDir));

  // 漂移 + 盘上资产完整性（这一条会重新跑 adapter，所以美术 manifest 一改就红）
  const built = await runBuild({
    check: true,
    verbose,
    posesJsonPath,
    outDir,
    geometryPath,
    log: verbose ? log : () => {},
  });
  problems.push(...built.problems);
  notes.push(...built.notes);
  if (built.deferred.length > 0) {
    notes.push(
      `未导出批次（deferred）：${built.deferred.map((item) => `${item.posture}（${item.reason}）`).join('、')}`,
    );
  }
  const unique = [...new Set(problems)];
  return { ok: unique.length === 0, problems: unique, notes, deferred: built.deferred };
}

/**
 * CLI 入口。
 *
 * @returns {Promise<number>} 进程退出码
 */
export async function main() {
  const verbose = process.argv.slice(2).includes('--verbose');
  try {
    const result = await runPoseGate({ verbose, log: (message) => console.log(message) });
    for (const note of result.notes) console.log(`[gate:pet:poses] 注意：${note}`);
    if (result.ok) {
      console.log(
        '✅ gate:pet:poses 通过：清单与美术 manifest 无漂移、包络不越界、体积/时序/域均合法、' +
          'totals 按 distinct 文件自证（G-P9）、内容寻址一致且无孤儿文件（G-P10）',
      );
      return 0;
    }
    console.error('❌ gate:pet:poses 失败：');
    for (const problem of result.problems) console.error(`   - ${problem}`);
    return 1;
  } catch (err) {
    console.error(`❌ gate:pet:poses 异常：${(err && err.message) || err}`);
    return 1;
  }
}

/** 当前脚本是否为入口（被测试 import 时保持静默）。 */
export const IS_ENTRY = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false;

if (IS_ENTRY) {
  process.exit(await main());
}
