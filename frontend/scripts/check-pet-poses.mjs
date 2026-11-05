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
      ...checkVolume(manifest).filter((line) => line.includes(`[${posture}]`)),
    ];
    if (verbose) {
      log(`[gate:pet:poses] ${posture}：${batchProblems.length === 0 ? 'OK' : `${batchProblems.length} 个问题`}`);
    }
    problems.push(...batchProblems);
  }
  problems.push(...checkVolume(manifest).filter((line) => !line.includes(']')));
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
