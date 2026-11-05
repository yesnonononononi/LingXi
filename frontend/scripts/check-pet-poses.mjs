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
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEOMETRY_PATH, readJsonFile } from './build-pet-geometry.mjs';
import {
  DEFAULT_POSE_OUT_DIR,
  FRAME_2X_MAX_BYTES,
  POSE_TOTAL_MAX_BYTES,
  POSES_JSON_PATH,
  runBuild,
} from './build-pet-poses.mjs';
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
 * 校验一个批次的剪片段时序。
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表
 */
export function checkTiming(batch) {
  const problems = [];
  const clips = Array.isArray(batch.clips) ? batch.clips : [];
  if (clips.length === 0) {
    problems.push(`[${batch.posture}] 没有 clips：没有可播片段就不是可播资产`);
    return problems;
  }
  for (const clip of clips) {
    const frames = Array.isArray(clip.frames) ? clip.frames : [];
    const frameMs = Array.isArray(clip.frameMs) ? clip.frameMs : [];
    if (frames.length !== frameMs.length) {
      problems.push(`[${batch.posture}#${clip.id}] frameMs 长度 ${frameMs.length} ≠ 帧数 ${frames.length}`);
      continue;
    }
    const singleHold = frames.length === 1 && frameMs[0] === 0;
    for (const [index, ms] of frameMs.entries()) {
      if (singleHold) break;
      if (!Number.isFinite(ms) || ms < FRAME_MS_RANGE.min || ms > FRAME_MS_RANGE.max) {
        problems.push(
          `[${batch.posture}#${clip.id}] 第 ${index} 帧时长 ${ms}ms 不在 [${FRAME_MS_RANGE.min}, ${FRAME_MS_RANGE.max}]` +
            '（单帧静止姿态允许 0；其余填 0 会让 rAF 空转）',
        );
      }
    }
  }
  return problems;
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
 * 校验 clip 的播放语义（**G-P5 / G-P6**）。
 *
 * <p><b>G-P5</b>：`loop:true` 的 clip 里 `frameMs` 全项必须 `> 0`。填 0 的循环片段 =
 * 永不推进的假动画（rAF 空转、画面静止），与 D-03 是同类坑。</p>
 *
 * <p><b>G-P6</b>：`onEnd:'return-stand'` 的 clip 帧数必须 `≥ 2`。1 帧 + `return-stand`
 * 的观感是"闪一下就回站姿"（用户侧读成"卡了一下"），而这个形态在单测里完全合法。</p>
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
    if (clip && clip.onEnd === 'return-stand' && ids.length < 2) {
      problems.push(
        `${label} onEnd:return-stand 但只有 ${ids.length} 帧：` +
          '单帧 + 回到站姿的观感是"闪一下就消失"（G-P6）',
      );
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
 * <p>顺序固定（域 → 覆盖 → 帧朝向 → 孤儿 → 语义 → 编码），报错行因此稳定、可 diff。</p>
 *
 * @param {Record<string, any>} batch 批次
 * @returns {string[]} 问题列表
 */
export function checkClips(batch) {
  return [
    ...checkClipFacingDomain(batch),
    ...checkClipFacingCoverage(batch),
    ...checkClipFrameFacing(batch),
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
    const batchProblems = [
      ...checkDomains(batch),
      ...checkTiming(batch),
      ...checkEnvelope(batch, geometry, align),
      ...checkClips(batch),
      ...checkVolume(manifest).filter((line) => line.includes(`[${posture}]`)),
    ];
    if (verbose) {
      log(`[gate:pet:poses] ${posture}：${batchProblems.length === 0 ? 'OK' : `${batchProblems.length} 个问题`}`);
    }
    problems.push(...batchProblems);
  }
  problems.push(...checkVolume(manifest).filter((line) => !line.includes(']')));
  problems.push(...checkAcceptedAnchorSource(manifest));
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
      console.log('✅ gate:pet:poses 通过：清单与美术 manifest 无漂移、包络不越界、体积/时序/域均合法');
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
