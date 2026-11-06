/**
 * 桌宠序列运行资产构建：adapter → 无损 WebP 导出 → 回写 `frontend/pet-sequences.json`。
 *
 * <p><b>与 pose 管线同构，且不新写任何编解码/哈希实现</b>：</p>
 * <ul>
 *   <li>sharp 加载 / WebP 选项 / sha256 ← `build-pet-assets.mjs`；</li>
 *   <li>转码内核 ← `build-pet-layers.mjs` 的 `transcodeLayer`（`lossless: true` 分支内部就是
 *       `webp({ lossless: true, effort: 6 })`——**和 pose 完全同一口径**，本脚本不另起一套）；</li>
 *   <li>编码格式判定 ← `build-pet-poses.mjs` 的 `webpFormatOf`（RIFF 头里的 `VP8L`）；</li>
 *   <li>PNG/WebP 尺寸 ← `pet-image-headers.mjs`。</li>
 * </ul>
 *
 * <p><b>运行资产只吃母版 PNG，绝不吃 GIF</b>：GIF 是 256 色 + 1-bit alpha，边缘半透明会被硬切
 * （美术 README 原文）。这里只读 `frames/*.png` 与 `companion/v1/*.png`。</p>
 *
 * <p><b>`--check` 只读不写</b>：重跑 adapter 重建清单元数据，与已提交的 `pet-sequences.json`
 * 逐字段比；并独立核验盘上 webp 的存在性 / 字节数 / sha256 / 编码格式 / 像素尺寸。
 * "没检查"与"检查通过"永远是两句不同的话。</p>
 *
 * <p>用法：</p>
 * <pre>
 *   node scripts/build-pet-sequences.mjs            # 导出 webp 并回写 pet-sequences.json
 *   node scripts/build-pet-sequences.mjs --check    # 只比对（漂移即非 0）
 *   node scripts/build-pet-sequences.mjs --verbose  # 打印每个文件
 * </pre>
 *
 * @module scripts/build-pet-sequences
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEBP_OPTIONS, loadSharp, sha256Of } from './build-pet-assets.mjs';
import { discoverRepoRoot, transcodeLayer } from './build-pet-layers.mjs';
import { webpFormatOf } from './build-pet-poses.mjs';
import { readImageSize } from './pet-image-headers.mjs';
import { adaptSequences } from './pet-sequence-adapters.mjs';
import { FRAME_2X_MAX_BYTES } from './pet-budget.mjs';

/** `frontend/` 根。 */
const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 运行时清单路径（唯一真源）。 */
export const SEQUENCES_JSON_PATH = resolve(FRONTEND_ROOT, 'pet-sequences.json');

/** 序列运行资产输出目录（经 Vite 复制进 `dist/live2d/pet-sequences`）。 */
export const DEFAULT_SEQUENCE_OUT_DIR = resolve(FRONTEND_ROOT, 'public', 'live2d', 'pet-sequences');

/** `lxa://` 的 host（小写：standard scheme 会把 host 转小写）。 */
export const SEQUENCE_URL_HOST = 'pet-sequences';

/** 生成脚本标识（与 `src/pet/sequences/manifest.ts` 的常量同值）。 */
export const GENERATED_BY = 'scripts/build-pet-sequences.mjs';

/** 两档密度（与 pose 同名同序）。 */
export const DENSITIES = Object.freeze(['1x', '2x']);

/**
 * 一个层在当前密度下的目标像素尺寸。
 *
 * <p>`宽 = round(layer.canvas.width × stageToCss × 密度系数)`：`layer.canvas` 是**舞台域**的层盒子
 * （伙伴 400×400），乘 `stageToCss` 落到窗口 CSS，再乘密度档得到实际像素。
 * 验算：`round(400 × 0.15234375 × 2) = 122`，与设计 §7.6 实测的 `122×122` 逐值一致。</p>
 *
 * @param {{canvas: {width: number, height: number}}} layer 层
 * @param {{stageToCss: number}} scale 比例契约
 * @param {'1x'|'2x'} density 密度档
 * @returns {{width: number, height: number}} 像素尺寸
 */
export function targetSizeOf(layer, scale, density) {
  const factor = density === '2x' ? 2 : 1;
  return {
    width: Math.round(layer.canvas.width * scale.stageToCss * factor),
    height: Math.round(layer.canvas.height * scale.stageToCss * factor),
  };
}

/**
 * 一个帧 slot 的运行产物相对路径（`<scene>/<slot>@<density>.webp`）。
 *
 * <p>目录名就是**场景名**：B1 只有单场景，帧的归属没有歧义；将来某帧被多场景共享时，
 * 它仍只落在一个"主场景"目录下（G-S1 用同一套相对路径比对盘，不存在两处登记）.</p>
 *
 * @param {string} sceneId 场景 id
 * @param {string} slot slot id
 * @param {'1x'|'2x'} density 密度档
 * @returns {string} POSIX 风格相对路径
 */
export function frameRelPath(sceneId, slot, density) {
  return `${sceneId}/${slot}@${density}.webp`;
}

/**
 * 一个帧 slot 的 `lxa://` URL。
 *
 * @param {string} sceneId 场景 id
 * @param {string} slot slot id
 * @param {'1x'|'2x'} density 密度档
 * @returns {string} URL
 */
export function frameUrl(sceneId, slot, density) {
  return `lxa://${SEQUENCE_URL_HOST}/${frameRelPath(sceneId, slot, density)}`;
}

/**
 * 递归比对两份清单，返回**路径级**的差异行（比整段 JSON 更能指着改）。
 *
 * @param {unknown} expected 期望值（本次重算）
 * @param {unknown} actual 实际值（写入盘上的）
 * @param {string} [path] 当前路径
 * @returns {string[]} 差异行（空数组 = 全等）
 */
export function diffValues(expected, actual, path = 'manifest') {
  if (expected === actual) return [];
  const bothArrays = Array.isArray(expected) && Array.isArray(actual);
  const bothObjects =
    expected !== null && typeof expected === 'object' && !Array.isArray(expected) &&
    actual !== null && typeof actual === 'object' && !Array.isArray(actual);
  if (bothArrays) {
    const lines = [];
    if (expected.length !== actual.length) {
      lines.push(`${path}.length：期望 ${expected.length}，实际 ${actual.length}`);
    }
    const count = Math.min(expected.length, actual.length);
    for (let index = 0; index < count; index += 1) {
      lines.push(...diffValues(expected[index], actual[index], `${path}[${index}]`));
    }
    return lines;
  }
  if (bothObjects) {
    const expectedRecord = /** @type {Record<string, unknown>} */ (expected);
    const actualRecord = /** @type {Record<string, unknown>} */ (actual);
    const keys = [...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])];
    const lines = [];
    for (const key of keys) {
      if (!(key in actualRecord)) {
        lines.push(`${path}.${key}：盘上清单缺这个字段`);
        continue;
      }
      if (!(key in expectedRecord)) {
        lines.push(`${path}.${key}：盘上清单多出这个字段（生成器已不再产出）`);
        continue;
      }
      lines.push(...diffValues(expectedRecord[key], actualRecord[key], `${path}.${key}`));
    }
    return lines;
  }
  return [`${path}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`];
}

/**
 * 列出输出目录里所有 webp（相对路径，POSIX 分隔符）。
 *
 * @param {string} outDir 输出目录
 * @returns {string[]} 相对路径
 */
function listWebpFiles(outDir) {
  if (!existsSync(outDir)) return [];
  const out = [];
  /** 深度优先。 */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.webp$/i.test(entry.name)) out.push(relative(outDir, full).split('\\').join('/'));
    }
  };
  walk(outDir);
  return out.sort();
}

/**
 * 删掉输出目录里没有被本次清单引用的 webp（**只删 webp**，绝不碰 png 与目录）。
 *
 * @param {string} outDir 输出目录
 * @param {Set<string>} expected 期望保留的相对路径集合
 * @returns {string[]} 被删掉的相对路径
 */
export function pruneExpectedOrphans(outDir, expected) {
  const keep = expected instanceof Set ? expected : new Set();
  if (keep.size === 0) return [];
  const removed = [];
  for (const relPath of listWebpFiles(outDir)) {
    if (keep.has(relPath)) continue;
    rmSync(resolve(outDir, relPath), { force: true });
    removed.push(relPath);
  }
  return removed;
}

/**
 * 读盘上一份 webp 的四项事实（存在性由调用方先判）。
 *
 * @param {string} absolutePath 绝对路径
 * @returns {{bytes: number, sha256: string, format: string|null}} 事实
 */
function diskFactsOf(absolutePath) {
  return {
    bytes: statSync(absolutePath).size,
    sha256: sha256Of(absolutePath),
    format: webpFormatOf(absolutePath),
  };
}

/**
 * 跑整条 pipeline（供 CLI 与门禁共用）。
 *
 * @param {object} [options] 选项
 * @param {boolean} [options.check] 只比对不写盘
 * @param {boolean} [options.verbose] 打印每个文件
 * @param {string} [options.repoRoot] 仓库根
 * @param {string} [options.outDir] 输出目录
 * @param {string} [options.sequencesJsonPath] 清单路径
 * @param {(message: string) => void} [options.log] 日志出口
 * @returns {Promise<{ok: boolean, check: boolean, problems: string[], notes: string[], manifest: Record<string, any>|null, written: boolean, removed: string[], deferred: ReadonlyArray<{scene: string, reason: string}>, totals: {scenes: number, steps: number, bytes1x: number, bytes2x: number, durationMs: number}}>} 结果
 */
export async function runBuildSequences(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const verbose = options.verbose === true;
  const check = options.check === true;
  const repoRoot = options.repoRoot ?? discoverRepoRoot();
  const outDir = options.outDir ?? DEFAULT_SEQUENCE_OUT_DIR;
  const sequencesJsonPath = options.sequencesJsonPath ?? SEQUENCES_JSON_PATH;
  const problems = [];
  const notes = [];
  const removed = [];
  const emptyTotals = { scenes: 0, steps: 0, bytes1x: 0, bytes2x: 0, durationMs: 0 };

  const adapted = adaptSequences({ repoRoot, log: verbose ? log : () => {} });
  problems.push(...adapted.problems);
  notes.push(...adapted.notes);
  if (adapted.draft === null) {
    return {
      ok: false,
      check,
      problems,
      notes,
      manifest: null,
      written: false,
      removed,
      deferred: adapted.deferred,
      totals: emptyTotals,
    };
  }

  const draft = adapted.draft;
  const layersById = new Map(draft.layers.map((layer) => [layer.id, layer]));
  const sharp = check ? null : await loadSharp();
  const frames = {};
  const expectedFiles = new Set();
  let bytes1x = 0;
  let bytes2x = 0;

  // 帧 key 形如 `<scene>/<slot>`；产物落 `<scene>/<slot>@<density>.webp`
  for (const [frameKey, entry] of Object.entries(draft.frames)) {
    const sceneId = frameKey.split('/')[0];
    const layer = layersById.get(entry.layer);
    if (!layer) {
      problems.push(`${frameKey} 引用了未定义的层 ${entry.layer}`);
      continue;
    }
    const sourcePath = resolve(repoRoot, entry.sourceFile);
    if (!existsSync(sourcePath)) {
      problems.push(`${frameKey} 的母版不存在：${sourcePath}`);
      continue;
    }
    for (const density of DENSITIES) {
      const target = targetSizeOf(layer, draft.scale, density);
      const relPath = frameRelPath(sceneId, entry.slot, density);
      expectedFiles.add(relPath);
      const diskPath = resolve(outDir, sceneId, `${entry.slot}@${density}.webp`);

      if (check) {
        if (!existsSync(diskPath)) {
          problems.push(`${frameKey}@${density} 缺少运行产物 ${relPath}（请先跑 node scripts/build-pet-sequences.mjs）`);
          continue;
        }
        const facts = diskFactsOf(diskPath);
        if (!facts.format) {
          problems.push(`${frameKey}@${density} 不是合法 WebP（${relPath}）`);
          continue;
        }
        const actualSize = readImageSize(diskPath);
        if (actualSize.width !== target.width || actualSize.height !== target.height) {
          problems.push(
            `${frameKey}@${density} 像素尺寸 ${actualSize.width}×${actualSize.height} ≠ 期望 ` +
              `${target.width}×${target.height}（${relPath}）`,
          );
          continue;
        }
        frames[relPath] = {
          layer: entry.layer,
          slot: entry.slot,
          width: target.width,
          height: target.height,
          bytes: facts.bytes,
          sha256: facts.sha256,
          format: facts.format,
          url: frameUrl(sceneId, entry.slot, density),
        };
        if (density === '1x') bytes1x += facts.bytes;
        else bytes2x += facts.bytes;
        continue;
      }

      mkdirSync(dirname(diskPath), { recursive: true });
      const result = await transcodeLayer(
        sharp,
        { path: sourcePath, layerId: entry.slot, density },
        resolve(outDir, sceneId),
        target,
        {
          aspect: { w: layer.canvas.width, h: layer.canvas.height },
          lossless: true,
          quality: WEBP_OPTIONS.quality,
          maxBytes: FRAME_2X_MAX_BYTES,
        },
      );
      if (!result.ok) {
        problems.push(`${frameKey}@${density} 转码失败：${result.reason}`);
        continue;
      }
      if (result.downgraded) {
        // 自动降级旁路：字节更少 ⇒ 体积断言全绿，用户看到的是块效应。必须让人看得见，
        // 并且 G-S1 的"格式必须 webp-lossless"会在门禁里再判一次红。
        const warning =
          `${frameKey}@${density} 超过 ${FRAME_2X_MAX_BYTES} B，已被自动**降为有损 WebP**（${result.bytes} 字节）`;
        notes.push(warning);
        log(`[pet-sequences] ⚠ 有损降级：${warning}`);
      }
      const facts = diskFactsOf(diskPath);
      frames[relPath] = {
        layer: entry.layer,
        slot: entry.slot,
        width: target.width,
        height: target.height,
        bytes: facts.bytes,
        sha256: facts.sha256,
        format: facts.format,
        url: frameUrl(sceneId, entry.slot, density),
      };
      if (density === '1x') bytes1x += facts.bytes;
      else bytes2x += facts.bytes;
      if (verbose) log(`[pet-sequences] 导出 ${relPath} ${target.width}×${target.height} ${facts.bytes}B ${facts.format}`);
    }
  }

  const manifest = {
    ...draft,
    frames,
    totals: { ...draft.totals, bytes1x, bytes2x },
  };

  if (problems.length > 0) {
    return { ok: false, check, problems, notes, manifest, written: false, removed, deferred: adapted.deferred, totals: manifest.totals };
  }

  if (check) {
    if (!existsSync(sequencesJsonPath)) {
      problems.push(`清单不存在：${sequencesJsonPath}（请先跑 node scripts/build-pet-sequences.mjs）`);
    } else {
      let committed = null;
      try {
        committed = JSON.parse(readFileSync(sequencesJsonPath, 'utf8'));
      } catch (err) {
        problems.push(`清单不可解析：${(err && err.message) || err}（${sequencesJsonPath}）`);
      }
      if (committed !== null) {
        problems.push(...diffValues(manifest, committed).map((line) => `清单纯漂移：${line}`));
      }
      // 多文件（孤儿）在 `--check` 下也算漂移：清单是唯一真源，盘上不许留没人引用的 webp
      for (const relPath of listWebpFiles(outDir)) {
        if (!expectedFiles.has(relPath)) problems.push(`盘上多出未被清单引用的 webp：${relPath}`);
      }
    }
    return { ok: problems.length === 0, check, problems, notes, manifest, written: false, removed, deferred: adapted.deferred, totals: manifest.totals };
  }

  removed.push(...pruneExpectedOrphans(outDir, expectedFiles));
  writeFileSync(sequencesJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  log(
    `[pet-sequences] 已写出 ${relative(repoRoot, sequencesJsonPath) || sequencesJsonPath}：` +
      `${manifest.totals.scenes} 场景 / ${manifest.totals.steps} 步 / ` +
      `${manifest.totals.durationMs} ms / ${((manifest.totals.bytes1x + manifest.totals.bytes2x) / 1024).toFixed(1)} KiB`,
  );
  return {
    ok: true,
    check,
    problems,
    notes,
    manifest,
    written: true,
    removed,
    deferred: adapted.deferred,
    totals: manifest.totals,
  };
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
    const result = await runBuildSequences({ check, verbose, log: (message) => console.log(message) });
    for (const note of result.notes) {
      if (note.includes('有损')) console.warn(`[pet-sequences] ⚠ ${note}`);
      else console.log(`[pet-sequences] 注意：${note}`);
    }
    if (!result.ok) {
      console.error(`❌ ${check ? 'build-pet-sequences --check' : 'build-pet-sequences'} 失败：`);
      for (const problem of result.problems) console.error(`   - ${problem}`);
      return 1;
    }
    const total = result.totals.bytes1x + result.totals.bytes2x;
    if (check) {
      console.log(
        `✅ pet-sequences 漂移检查通过：${result.totals.scenes} 场景 / ${result.totals.steps} 步 / ` +
          `${result.totals.durationMs} ms / 合计 ${total} B`,
      );
    } else {
      console.log(
        `✅ 已导出 sequence 运行资产：${result.totals.scenes} 场景 / ${result.totals.steps} 步 / ` +
          `合计 ${total} B` +
          (result.removed.length > 0 ? `，清理孤儿 ${result.removed.length} 个` : ''),
      );
    }
    return 0;
  } catch (err) {
    console.error(`❌ build-pet-sequences 异常：${(err && err.message) || err}`);
    return 1;
  }
}

/** 当前脚本是否为入口（被测试 import 时保持静默）。 */
export const IS_ENTRY = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false;

if (IS_ENTRY) {
  process.exit(await main());
}
