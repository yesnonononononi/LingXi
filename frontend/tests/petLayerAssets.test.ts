/**
 * 分层资产管线单测（tsx 执行，纯 node，不碰 DOM / 不起 Electron）。
 *
 * <p><b>为什么这个文件必须存在：</b>M6 新增的是一条"美术母版 → 运行时 WebP → 清单回填 → 门禁"
 * 的生成链。这类链路的故障几乎都是**静默**的：文件少回填一档、`layers/` 前缀被拼两次
 * （`…/layers/layers/x.webp`，页面上只表现为 404）、孤儿文件让包体积对不上账、
 * 掩膜缺了却没人发现。所以这里对每个硬约束都留一条会红的断言。</p>
 *
 * <p>覆盖：母版定位与掩膜路径、密度目标与压平帧同尺寸、`diskPathOf` 的口径差、
 * 清单字段缺失/体积/sha256/像素比例/缺档/孤儿/掩膜 七类硬错、以及"源不完整时优雅跳过"。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LAYER_OUT_DIR,
  LAYERS_JSON_PATH,
  LAYERS_TOTAL_BUDGET,
  LAYER_BYTE_BUDGET,
  REQUIRED_FILE_FIELDS,
  SUPPORTED_FORMATS,
  buildLayerAssets,
  defaultLayerSourceDir,
  diskPathOf,
  maskPathsOf,
  parseArgs,
  pruneOrphans,
  resolveDensityTargets,
  scanLayerSource,
  sourcePathOf,
  transcodeLayer,
} from '../scripts/build-pet-layers.mjs';
import {
  runLayerGate,
  validateAgainstDisk,
  validateMasks,
  validateNoOrphans,
  sourceDirPresent,
} from '../scripts/check-pet-layers.mjs';
import { loadSharp, sha256Of } from '../scripts/build-pet-assets.mjs';

/** 仓库里的层清单（真实生成物）。 */
const MANIFEST = JSON.parse(readFileSync(LAYERS_JSON_PATH, 'utf8')) as {
  enabled: boolean;
  assetBase: string;
  canvas: { width: number; height: number };
  densities: string[];
  layers: Array<{
    layerId: string;
    role: string;
    source: string;
    files: Record<string, Record<string, unknown>>;
  }>;
};

/** P1 母版目录（美术入库位置）。 */
const SOURCE_DIR = defaultLayerSourceDir();

/**
 * 深拷贝清单（每个用例都拿自己的副本，避免互相污染）。
 *
 * @returns 清单副本
 */
function cloneManifest() {
  return JSON.parse(JSON.stringify(MANIFEST));
}

test('母版目录与运行时目录指向仓库内的固定位置（不写死楼层数）', () => {
  assert.equal(sourceDirPresent(SOURCE_DIR), true, `P1 母版目录不存在: ${SOURCE_DIR}`);
  assert.ok(SOURCE_DIR.includes('desktop-pet'), `母版目录应位于 docs/assets/desktop-pet/p1，实际 ${SOURCE_DIR}`);
  assert.ok(DEFAULT_LAYER_OUT_DIR.endsWith('pet-p1' + String.fromCharCode(92) + 'layers') || DEFAULT_LAYER_OUT_DIR.endsWith('pet-p1/layers'), DEFAULT_LAYER_OUT_DIR);
  // 运行时目录必须在 public/live2d 下，才会被 Vite 复制进 dist 并被 lxa:// 读到
  const normalized = DEFAULT_LAYER_OUT_DIR.split('\\').join('/');
  assert.ok(normalized.includes('/public/live2d/pet-p1/layers'), normalized);
});

test('sourcePathOf：支持子目录（support/*）与反斜杠写法', () => {
  const support = sourcePathOf(SOURCE_DIR, 'support/underpainting');
  assert.ok(support.endsWith('underpainting.png'), support);
  assert.ok(support.split('\\').join('/').endsWith('p1/support/underpainting.png'), support);
  const part = sourcePathOf(SOURCE_DIR, '01_tail_base');
  assert.ok(part.endsWith('01_tail_base.png'), part);
});

test('maskPathsOf：可见/被遮挡两张掩膜都在 support/masks 下', () => {
  const masks = maskPathsOf(SOURCE_DIR, '03_ear_left');
  assert.ok(masks.visible.split('\\').join('/').endsWith('support/masks/03_ear_left_visible.png'), masks.visible);
  assert.ok(masks.hidden.split('\\').join('/').endsWith('support/masks/03_ear_left_hidden.png'), masks.hidden);
});

test('scanLayerSource：9 层母版齐、12 个掩膜齐、母版 sha256 与美术清单一致', () => {
  const scan = scanLayerSource(MANIFEST, SOURCE_DIR);
  assert.equal(scan.present, true);
  assert.deepEqual(scan.problems, [], `母版问题: ${scan.problems.join('; ')}`);
  assert.equal(scan.entries.length, 9);
  const animatable = scan.entries.filter((entry: { masksRequired: boolean }) => entry.masksRequired === true);
  assert.equal(animatable.length, 6, '6 个可动件必须有掩膜');
  // 支撑层没有掩膜，也不该被要求
  assert.equal(scan.entries.filter((entry: { masksRequired: boolean }) => entry.masksRequired === false).length, 3);
});

test('scanLayerSource：母版目录整块不存在 → present=false 且给出中文原因（优雅跳过）', () => {
  const scan = scanLayerSource(MANIFEST, resolve(tmpdir(), '__definitely_missing_p1__'));
  assert.equal(scan.present, false);
  assert.match(scan.reason, /不存在/);
  assert.deepEqual(scan.problems, []);
});

test('scanLayerSource：母版在但缺图 → 显式报错，不是静默跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-layers-empty-'));
  try {
    const scan = scanLayerSource(MANIFEST, dir);
    assert.equal(scan.present, true);
    assert.equal(scan.entries.length, 0);
    assert.equal(scan.problems.length, MANIFEST.layers.length);
    assert.match(scan.problems[0], /母版文件不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDensityTargets：两档尺寸与压平帧同尺寸且都是 2:3', () => {
  const targets = resolveDensityTargets();
  assert.deepEqual(targets['1x'], { width: 160, height: 240 });
  assert.deepEqual(targets['2x'], { width: 320, height: 480 });
  for (const density of ['1x', '2x']) {
    const target = targets[density];
    assert.ok(Math.abs(target.width / target.height - 2 / 3) < 0.002, `${density} 不是 2:3`);
  }
});

test('diskPathOf：清单里的 layers/ 前缀只吃一次（拼两次就会 404）', () => {
  const outDir = 'D:/repo/frontend/public/live2d/pet-p1/layers';
  assert.equal(diskPathOf(outDir, 'layers/tail-base@2x.webp').split('\\').join('/'), `${outDir}/tail-base@2x.webp`);
  assert.equal(diskPathOf(outDir, 'tail-base@2x.webp').split('\\').join('/'), `${outDir}/tail-base@2x.webp`);
});

test('validateAgainstDisk：真实清单与磁盘逐项对齐（字段/体积/sha256/尺寸/比例）', () => {
  assert.deepEqual(validateAgainstDisk(MANIFEST, { outDir: DEFAULT_LAYER_OUT_DIR }), []);
});

test('validateAgainstDisk：缺字段必须显式报错（不是跳过）', () => {
  for (const field of REQUIRED_FILE_FIELDS) {
    const manifest = cloneManifest();
    delete manifest.layers[0].files['1x'][field];
    const problems = validateAgainstDisk(manifest, { outDir: DEFAULT_LAYER_OUT_DIR });
    assert.equal(problems.length, 1, `${field} 缺失应报 1 条，实际 ${problems.join('; ')}`);
    assert.match(problems[0], new RegExp(field));
  }
});

test('validateAgainstDisk：缺一整档、空 files、体积/sha256 篡改、比例不对 都要红', () => {
  const noDensity = cloneManifest();
  delete noDensity.layers[0].files['2x'];
  assert.match(validateAgainstDisk(noDensity, { outDir: DEFAULT_LAYER_OUT_DIR })[0], /缺少 files\.2x/);

  const emptyFiles = cloneManifest();
  emptyFiles.layers[0].files = {};
  assert.match(validateAgainstDisk(emptyFiles, { outDir: DEFAULT_LAYER_OUT_DIR })[0], /没有任何密度的文件条目/);

  const badBytes = cloneManifest();
  badBytes.layers[0].files['1x'].bytes = 1;
  assert.match(validateAgainstDisk(badBytes, { outDir: DEFAULT_LAYER_OUT_DIR }).join(';'), /体积不一致/);

  const badSha = cloneManifest();
  badSha.layers[0].files['1x'].sha256 = 'f'.repeat(64);
  assert.match(validateAgainstDisk(badSha, { outDir: DEFAULT_LAYER_OUT_DIR }).join(';'), /sha256 不一致/);

  const badClaim = cloneManifest();
  badClaim.layers[0].files['1x'].width = 161;
  assert.match(validateAgainstDisk(badClaim, { outDir: DEFAULT_LAYER_OUT_DIR }).join(';'), /像素尺寸不一致/);
});

test('validateAgainstDisk：真实文件不是 2:3 时点名比例（临时生成一张 160×230）', async () => {
  const sharp = await loadSharp();
  if (!sharp) {
    assert.ok(true, '未安装 sharp，跳过（sharp 是 devDependency，正常环境会有）');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'pet-layers-aspect-'));
  try {
    const file = join(dir, 'tail-base@1x.webp');
    await sharp({ create: { width: 160, height: 230, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .webp()
      .toFile(file);
    const manifest = cloneManifest();
    manifest.layers[1].files['1x'] = {
      file: 'layers/tail-base@1x.webp',
      url: `${MANIFEST.assetBase.replace(/\/?$/, '/')}layers/tail-base@1x.webp`,
      width: 160,
      height: 230,
      bytes: readFileSync(file).length,
      sha256: sha256Of(file),
      format: 'webp',
    };
    const problems = validateAgainstDisk(manifest, { outDir: dir });
    // 临时目录里只有这一张图，其余层必然报"文件不存在"；这里只关心比例检查是否点名
    const aspectProblems = problems.filter((item: string) => item.includes('不是画布比例'));
    assert.equal(aspectProblems.length, 1, problems.join('; '));
    assert.match(aspectProblems[0], /tail-base@1x 像素比例 160×230/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateNoOrphans：多出来的 webp 必须被点名', () => {
  assert.deepEqual(validateNoOrphans(MANIFEST, { outDir: DEFAULT_LAYER_OUT_DIR }), []);
  const dir = mkdtempSync(join(tmpdir(), 'pet-layers-orphan-'));
  try {
    mkdirSync(dir, { recursive: true });
    const stray = join(dir, 'ghost-layer@2x.webp');
    writeFileSync(stray, Buffer.from([0x52, 0x49, 0x46, 0x46]));
    const problems = validateNoOrphans(MANIFEST, { outDir: dir });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /孤儿文件 ghost-layer@2x\.webp/);
    // 构建脚本的清理器必须真的能删掉它
    assert.deepEqual(pruneOrphans(dir, new Set(['tail-base@2x.webp'])), ['ghost-layer@2x.webp']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateMasks：可动层缺掩膜要红，支撑层不要求掩膜', () => {
  assert.deepEqual(validateMasks(MANIFEST, { sourceDir: SOURCE_DIR }), []);
  const missing = cloneManifest();
  missing.layers[1].source = '99_not_exist';
  const problems = validateMasks(missing, { sourceDir: SOURCE_DIR });
  assert.equal(problems.length, 2, problems.join('; '));
  assert.match(problems.join(';'), /缺少 visible 掩膜/);
  // 把支撑层的 source 改坏：它本来就不要求掩膜，这里只验证"不误报"
  const supportOnly = cloneManifest();
  supportOnly.layers[0].source = '99_not_exist';
  assert.deepEqual(validateMasks(supportOnly, { sourceDir: SOURCE_DIR }), []);
});

test('runLayerGate：真实仓库一次过（含落盘/孤儿/掩膜三类新校验）', () => {
  const result = runLayerGate({});
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.p1Present, true);
  assert.equal(result.missingAssetState, false);
  assert.equal(result.manifest.enabled, false, '总闸必须仍然关闭（开闸要单独批准）');
});

test('buildLayerAssets --check：入库状态即最新（改了资产却没回填就会红）', async () => {
  const result = await buildLayerAssets({ check: true });
  assert.equal(result.skipped, false);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.missing, []);
});

test('体积预算常量与设计附录 C.1 对齐（45KiB / 120KiB / 1.6MiB）', () => {
  // 数字写死在这里是有意的：预算来自设计文档，改动必须是一次"设计变更"而不是随手调参
  assert.equal(LAYER_BYTE_BUDGET['1x'], 45 * 1024);
  assert.equal(LAYER_BYTE_BUDGET['2x'], 120 * 1024);
  assert.equal(LAYERS_TOTAL_BUDGET, 1677722);
});

test('parseArgs：默认 lossless；--lossy / --quality 走有损', () => {
  assert.equal(parseArgs([]).lossless, true, '默认必须 lossless（与压平帧同口径）');
  assert.equal(parseArgs(['--lossy']).lossless, false);
  assert.equal(parseArgs(['--quality', '82']).lossless, false, '显式给质量即视为有损');
  assert.equal(parseArgs(['--quality', '82']).quality, 82);
  assert.equal(parseArgs(['--lossless']).lossless, true);
});

test('validateAgainstDisk：format 只允许 webp / webp-lossless（其它值必须点名）', () => {
  const manifest = cloneManifest();
  manifest.layers[0].files['1x'].format = 'png';
  const problems = validateAgainstDisk(manifest, { outDir: DEFAULT_LAYER_OUT_DIR }).join(';');
  assert.match(problems, /format 只允许 webp \/ webp-lossless/);
  assert.deepEqual([...SUPPORTED_FORMATS], ['webp', 'webp-lossless']);
});

test('validateAgainstDisk：单层超预算与合计超预算都要点名（不是静默放过）', () => {
  const overLayer = cloneManifest();
  overLayer.layers[0].files['1x'].bytes = LAYER_BYTE_BUDGET['1x'] + 1;
  const layerProblems = validateAgainstDisk(overLayer, { outDir: DEFAULT_LAYER_OUT_DIR }).join(';');
  assert.match(layerProblems, /超出单层预算/);

  const overTotal = cloneManifest();
  // 每层都塞到远高于单层预算的体积：单层问题会连带出现，但这里只关心合计那条断言存在
  for (const layer of overTotal.layers) {
    layer.files['2x'].bytes = 200000;
  }
  const totalProblems = validateAgainstDisk(overTotal, { outDir: DEFAULT_LAYER_OUT_DIR }).join(';');
  assert.match(totalProblems, /超出层增量预算/);
});

test('transcodeLayer：lossless 超预算自动降有损，且 format/字节如实回传', async () => {
  const sharp = await loadSharp();
  if (!sharp) {
    assert.ok(true, '未安装 sharp，跳过（sharp 是 devDependency，正常环境会有）');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'pet-layers-transcode-'));
  try {
    // 造一张 64×96（2:3）的伪随机噪声图：噪声最吃体积，才能稳定触发降级
    const width = 64;
    const height = 96;
    const raw = Buffer.alloc(width * height * 4);
    let seed = 0x9e3779b9;
    for (let index = 0; index < raw.length; index += 4) {
      // 固定种子的 LCG：结果可复现，但分布足够散，压缩率高不了
      seed = (seed * 1664525 + 1013904223) >>> 0;
      raw[index] = seed & 0xff;
      raw[index + 1] = (seed >>> 8) & 0xff;
      raw[index + 2] = (seed >>> 16) & 0xff;
      raw[index + 3] = 255;
    }
    const sourcePath = join(dir, 'noise.png');
    await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(sourcePath);

    const job = { path: sourcePath, layerId: 'noise', density: '1x' };
    const target = { width: 160, height: 240 };

    const kept = await transcodeLayer(sharp, job, dir, target, { lossless: true, maxBytes: LAYERS_TOTAL_BUDGET });
    assert.equal(kept.ok, true);
    assert.equal(kept.format, 'webp-lossless');
    assert.equal(kept.downgraded, false);

    const downgraded = await transcodeLayer(sharp, job, dir, target, {
      lossless: true,
      quality: 40,
      maxBytes: 2000,
    });
    assert.equal(downgraded.ok, true);
    assert.equal(downgraded.downgraded, true, 'lossless 超预算必须降级');
    assert.equal(downgraded.format, 'webp');
    assert.ok(downgraded.bytes > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcodeLayer：非 2:3 母版直接拒绝（不偷偷裁切）', async () => {
  const sharp = await loadSharp();
  if (!sharp) {
    assert.ok(true, '未安装 sharp，跳过');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'pet-layers-bad-aspect-'));
  try {
    const sourcePath = join(dir, 'square.png');
    await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toFile(sourcePath);
    const outcome = await transcodeLayer(sharp, { path: sourcePath, layerId: 'bad', density: '1x' }, dir, { width: 160, height: 240 }, {});
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /不是 2:3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
