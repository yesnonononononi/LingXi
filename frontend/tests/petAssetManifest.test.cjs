/**
 * 资产管线与运行时清单单测（node:test，不碰 DOM）。
 *
 * <p><b>关于"美术源不在本机时"的处理（重要）：</b></p>
 * <ul>
 *   <li><b>硬断言只针对入库物</b>：`frontend/pet-assets.json`（生成物，入库）与
 *       `frontend/public/live2d/pet-v3/**`（接入产物，入库）。这两者一定在仓库里，
 *       所以校验它们不会因环境差异而红。</li>
 *   <li><b>美术源目录（`docs/assets/desktop-pet/v3` 或暂存区）只做"在场则校验、不在场则跳过"</b>：
 *       它可能被主理人迁移、也可能在 CI 上不存在。跳过时用例里会打印原因，不会静默假通过。</li>
 *   <li><b>`psd/pet_p0.psd` 永不读取、永不校验哈希</b>：它是 Git LFS 对象，工作区文件的
 *       sha256 与清单里的 oid 不是一回事，校验必然误报（主理人明确提醒）。</li>
 * </ul>
 *
 * <p>运行：`npm run test:pet`。</p>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { resolve } = require('node:path');

const {
  ART_EXPRESSION_IDS,
  ASSETS_JSON_PATH,
  DENSITIES,
  DEFAULT_OUT_DIR,
  EXPRESSION_FILE_ALIASES,
  buildAssetsJson,
  detectMode,
  detectSourceDir,
  discoverSourceCandidates,
  loadSharp,
  parseArgs,
  readRuntimeManifest,
  renderManifestTs,
  run,
  sha256Of,
  verifyManifestAgainstDisk,
} = require('../scripts/build-pet-assets.mjs');

const { ART_ASPECT, FRONTEND_ROOT } = require('../scripts/build-pet-geometry.mjs');
const { readImageSize } = require('../scripts/check-pet-geometry.mjs');

/**
 * 从 TS 源码里解析眨眼三态映射。
 *
 * <p>本文件是 `.cjs`（node 直接跑，不经 tsx），不能 `require` TS 模块；但"美术清单的 blink 字段"
 * 与"渲染层 `BLINK_EXPRESSION_MAP`"必须一致，所以这里读源码文本做正则提取。
 * 提取失败即视为契约被改（宁可让测试红，也不要静默放过）。</p>
 *
 * <p><b>为什么键值正则要允许大写字母：</b>`blinkHalf` 是驼峰（M1 起半闭帧不再是 `sleepy`），
 * 只允许 `[a-z]+` 会把 `'blinkHalf'` 整条漏掉、返回空串——那种"提取不到"会伪装成
 * "双方不一致"，把真正的契约问题埋掉。</p>
 *
 * @returns {{ open: string, closed: string, half: string, wink: string }} 渲染层声明
 */
function readBlinkMapFromSource() {
  const source = readFileSync(resolve(FRONTEND_ROOT, 'src/pet/presentation/blink-driver.ts'), 'utf8');
  /**
   * 取某个键的字面量值。
   *
   * @param {string} key 键名
   * @returns {string} 值（提不到时为空串）
   */
  const pick = (key) => {
    const matched = new RegExp(`${key}\\s*:\\s*'([A-Za-z]+)'`).exec(source);
    return matched ? matched[1] : '';
  };
  return { open: pick('open'), closed: pick('closed'), half: pick('half'), wink: pick('wink') };
}

/**
 * v4 母版清单的眨眼字段（`supersedes: v3`，M1 起它是眼部语义的真源）。
 *
 * <p><b>为什么不能继续拿 `pet-assets.json` 对账 `half`：</b>那份清单是由 v3 母版清单生成的，
 * v3 的 `blink.half = 'sleepy'` 正是 M1 要废掉的写法（困倦嘴型不得随眨眼跳动，§5.1）。
 * v4 清单已经把 `half` 显式置空并把 `wink` 落成 `'wink'`，所以 `half` / `wink` 与 v4 对账，
 * `open` / `closed` 仍与 `pet-assets.json` 对账（这档资产没变）。</p>
 *
 * @returns {{ open: string, closed: string, half: string|null, wink: string, present: boolean }} v4 声明
 */
function readV4Blink() {
  const file = resolve(FRONTEND_ROOT, '..', 'docs/assets/desktop-pet/v4/manifest.json');
  if (!existsSync(file)) return { open: '', closed: '', half: null, wink: '', present: false };
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const blink = manifest && typeof manifest.blink === 'object' && manifest.blink ? manifest.blink : {};
  return {
    open: typeof blink.open === 'string' ? blink.open : '',
    closed: typeof blink.closed === 'string' ? blink.closed : '',
    half: typeof blink.half === 'string' ? blink.half : null,
    wink: typeof blink.wink === 'string' ? blink.wink : '',
    present: true,
  };
}

/** 渲染层声明的眨眼三态。 */
const BLINK_EXPRESSION_MAP = readBlinkMapFromSource();

/** 运行时清单（入库物；缺失说明没跑过管线）。 */
const ASSETS_READY = existsSync(ASSETS_JSON_PATH);
/** 读清单文本（缺省返回空对象，让相关用例能给出可读的跳过原因）。 */
function readAssets() {
  return ASSETS_READY ? JSON.parse(readFileSync(ASSETS_JSON_PATH, 'utf8')) : {};
}
const SKIP_NO_ASSETS = ASSETS_READY ? false : '运行时清单未生成（先跑 npm run build:pet-assets）';

// ---------------------------------------------------------------- 管线行为

test('parseArgs：源目录可配置（--source / --source= / 环境变量），默认自动探测', () => {
  const auto = parseArgs([]);
  assert.equal(auto.sourceExplicit, false);
  assert.equal(auto.source, detectSourceDir());
  assert.equal(parseArgs(['--source', 'D:/tmp/art']).source, resolve(process.cwd(), 'D:/tmp/art'));
  assert.equal(parseArgs(['--source=D:/tmp/art']).source, resolve(process.cwd(), 'D:/tmp/art'));
  assert.equal(parseArgs(['--check']).check, true);

  const previous = process.env.PET_ASSET_SOURCE;
  process.env.PET_ASSET_SOURCE = 'D:/tmp/env-art';
  assert.equal(parseArgs([]).source, resolve(process.cwd(), 'D:/tmp/env-art'));
  if (previous === undefined) delete process.env.PET_ASSET_SOURCE;
  else process.env.PET_ASSET_SOURCE = previous;
});

test('discoverSourceCandidates：向上多层探测且 v3 优先于暂存区与 v2', () => {
  const candidates = discoverSourceCandidates();
  assert.ok(candidates.length >= 3);
  const v3Index = candidates.findIndex((item) => item.includes('desktop-pet') && item.endsWith('v3'));
  const stagingIndex = candidates.findIndex((item) => item.includes('.lingxi') && item.endsWith('pet'));
  const v2Index = candidates.findIndex((item) => item.endsWith('v2'));
  assert.ok(v3Index >= 0 && stagingIndex >= 0 && v2Index >= 0);
  assert.ok(v3Index < stagingIndex, 'v3（入库归宿）应排在暂存区之前');
  assert.ok(stagingIndex < v2Index, '暂存区应排在历史 v2 之前');
});

test('源目录不存在：优雅退出（退出码 1，不抛未捕获异常）', async () => {
  const code = await run({
    source: resolve(FRONTEND_ROOT, 'no-such-dir-for-test'),
    out: DEFAULT_OUT_DIR,
    check: true,
    verbose: false,
  });
  assert.equal(code, 1);
});

test('源目录缺少母版与 runtime 清单：优雅退出（退出码 1）', async () => {
  const code = await run({
    source: resolve(FRONTEND_ROOT, 'scripts'),
    out: DEFAULT_OUT_DIR,
    check: true,
    verbose: false,
  });
  assert.equal(code, 1);
});

test('detectMode：没有清单也没有母版时返回 none（不猜模式）', () => {
  assert.equal(detectMode(resolve(FRONTEND_ROOT, 'scripts'), null), 'none');
});

test('detectMode：有 composites 走 composite，只有 expressions 走 overlay', () => {
  const compositeManifest = { files: [{ file: 'composites/neutral@2x.webp' }] };
  assert.equal(detectMode(DEFAULT_OUT_DIR, compositeManifest), 'composite');
  const overlayManifest = { files: [{ file: 'expressions/neutral@2x.webp' }] };
  assert.equal(detectMode(DEFAULT_OUT_DIR, overlayManifest), 'overlay');
});

test('loadSharp：可选依赖，不可用时返回 null 而不是抛异常', async () => {
  const sharp = await loadSharp();
  assert.ok(sharp === null || typeof sharp === 'function' || typeof sharp === 'object');
});

test('EXPRESSION_FILE_ALIASES：8 档表情都能对到美术 E1–E8 编号', () => {
  for (const id of ART_EXPRESSION_IDS) {
    const aliases = EXPRESSION_FILE_ALIASES[id];
    assert.ok(Array.isArray(aliases) && aliases.length > 0, `缺少 ${id} 的文件别名`);
    assert.ok(aliases.includes(id), `${id} 的别名里应包含自身`);
  }
  assert.equal(Object.keys(EXPRESSION_FILE_ALIASES).length, 8);
});

test('buildAssetsJson：汇总 totals 并对空表给出 0', () => {
  const empty = buildAssetsJson({
    assetId: 'x',
    sourceDir: 'y',
    mode: 'composite',
    canvas: { width: 2048, height: 3072 },
    nativeCanvas: { width: 1024, height: 1536 },
    colorSpace: 'sRGB',
    alpha: 'straight',
    masterScale: { factor: 2, kernel: 'nearest', addsDetail: false },
    anchorNormalized: { x: 0.5, y: 0.95 },
    headEndByScale: { '1x': 116, '2x': 233 },
    blink: { open: 'neutral', closed: 'blink', half: 'sleepy', eyeRegionNative: { left: 1, top: 2, width: 3, height: 4 } },
    frames: {},
    patches: {},
    body: null,
  });
  assert.deepEqual(empty.totals, { fileCount: 0, bytes: 0 });
  assert.equal(empty.version, 1);
  assert.equal(empty.generatedBy, 'scripts/build-pet-assets.mjs');
});

test('renderManifestTs：生成的是类型化薄包装（数据仍只在 JSON 里）', () => {
  const text = renderManifestTs();
  assert.ok(text.includes("import assetsSource from '../../../pet-assets.json'"));
  assert.ok(text.includes('export const PET_ASSETS: PetAssets'));
  assert.ok(text.includes('export function expressionFrameUrl'));
  assert.ok(text.includes('export function expressionFrameUrls'));
  assert.ok(text.includes('export function petArtUrl'));
  assert.ok(text.includes('export const PET_BLINK_MAPPING'));
  // 不重复数据：生成物里不该出现像素数字
  assert.equal(/width: \d{3}/.test(text), false, 'manifest.ts 不应内嵌资产数据（避免两份真源）');
  // 不许宣称"2× 高清母版"（母版是最近邻放大）
  assert.ok(text.includes('不含额外细节') || text.includes('addsDetail'));
});

// ---------------------------------------------------------------- 入库清单

test('pet-assets.json：v3 接入、composite 模式、8 档表情 × 2 档密度', { skip: SKIP_NO_ASSETS }, () => {
  const assets = readAssets();
  assert.equal(assets.mode, 'composite', '当前美术产物应走 composite（完整帧）模式');
  // assetId 取母版清单（v3 母版是权威），runtime 清单的 id 带 -runtime 后缀
  assert.equal(assets.assetId, 'lingxi-pet-p0-v3');
  assert.ok(assets.sourceDir.endsWith('desktop-pet/v3'), `源目录应指向 v3，实际 ${assets.sourceDir}`);
  assert.equal(assets.colorSpace, 'sRGB');
  assert.equal(assets.alpha, 'straight');
  assert.equal(assets.masterScale.addsDetail, false, '母版是最近邻 2× 放大，不含额外细节');
  for (const id of ART_EXPRESSION_IDS) {
    const byDensity = assets.frames[id];
    assert.ok(byDensity, `缺少表情 ${id} 的帧`);
    for (const density of DENSITIES) {
      assert.ok(byDensity[density.id], `缺少 ${id} 的 ${density.id} 档`);
    }
  }
  assert.equal(assets.totals.fileCount, ART_EXPRESSION_IDS.length * DENSITIES.length);
});

test('pet-assets.json：画布 2:3、锚点归一化、眨眼映射与渲染层一致', { skip: SKIP_NO_ASSETS }, () => {
  const assets = readAssets();
  assert.equal(assets.canvas.width / assets.canvas.height, ART_ASPECT);
  assert.ok(assets.anchorNormalized.x >= 0 && assets.anchorNormalized.x <= 1);
  assert.ok(assets.anchorNormalized.y >= 0 && assets.anchorNormalized.y <= 1);
  assert.equal(assets.blink.open, BLINK_EXPRESSION_MAP.open, '睁眼档必须与渲染层同源');
  assert.equal(assets.blink.closed, BLINK_EXPRESSION_MAP.closed, '闭眼档必须与渲染层同源');
  assert.ok(assets.blink.eyeRegionNative.width > 0);
  assert.ok(assets.blink.eyeRegionNative.height > 0);

  // ---- M1：半闭帧与 wink 的真源是 v4 母版清单（`supersedes: v3`），不是 v3 生成的 pet-assets.json。
  // v3 的 `blink.half = 'sleepy'` 是 §5.1 认定的缺陷本身（每眨一次嘴型抖一下），
  // 所以这里既要求渲染层不再指向 sleepy，也要求 v4 把它显式置空。
  assert.equal(BLINK_EXPRESSION_MAP.half, 'blinkHalf', '半闭帧必须是独立档（不许回落 sleepy）');
  assert.notEqual(BLINK_EXPRESSION_MAP.half, 'sleepy', '半闭帧借用困倦整脸 = E08 缺陷复发');

  const v4 = readV4Blink();
  if (v4.present) {
    assert.equal(v4.open, BLINK_EXPRESSION_MAP.open, 'v4 清单的睁眼档必须与渲染层一致');
    assert.equal(v4.closed, BLINK_EXPRESSION_MAP.closed, 'v4 清单的闭眼档必须与渲染层一致');
    assert.equal(v4.half, null, 'v4 必须把 blink.half 显式置空（未交付 = 两态降级，不借别人的脸）');
    assert.equal(v4.wink, BLINK_EXPRESSION_MAP.wink, 'v4 清单的 wink 档必须与渲染层一致');
  }
});

test('pet-assets.json：每个文件都能追溯到美术 runtime/，且 URL 走 lxa://pet-v3', { skip: SKIP_NO_ASSETS }, () => {
  const assets = readAssets();
  for (const [id, byDensity] of Object.entries(assets.frames)) {
    for (const [density, asset] of Object.entries(byDensity)) {
      assert.ok(asset.file.startsWith('composites/'), `${id}@${density} 应来自美术 composites/`);
      assert.ok(asset.file.endsWith(`@${density}.webp`));
      assert.equal(asset.url, `lxa://pet-v3/${asset.file}`);
      assert.equal(asset.sha256.length, 64);
    }
  }
});

test('运行时产物与清单完全一致（存在/尺寸/体积/sha256/2:3）', { skip: SKIP_NO_ASSETS }, () => {
  const problems = verifyManifestAgainstDisk({ out: DEFAULT_OUT_DIR, assetsJsonPath: ASSETS_JSON_PATH });
  assert.deepEqual(problems, [], problems.join(' | '));
});

test('运行时产物比例与像素尺寸：全部 2:3，且 @2x 是 @1x 的 2 倍', { skip: SKIP_NO_ASSETS }, () => {
  const assets = readAssets();
  for (const [id, byDensity] of Object.entries(assets.frames)) {
    const one = byDensity['1x'];
    const two = byDensity['2x'];
    assert.equal(two.width, one.width * 2, `${id} 两档宽度不是 2 倍`);
    assert.equal(two.height, one.height * 2, `${id} 两档高度不是 2 倍`);
    for (const asset of [one, two]) {
      const file = resolve(DEFAULT_OUT_DIR, asset.file);
      const size = readImageSize(file);
      assert.equal(size.width, asset.width);
      assert.ok(Math.abs(size.width / size.height - ART_ASPECT) < 0.002, `${asset.file} 不是 2:3`);
      assert.equal(statSync(file).size, asset.bytes);
      assert.equal(sha256Of(file), asset.sha256);
    }
  }
});

test('体积预算：运行时资产总量 ≤2.5MB（16 张美术产物，工程侧不重编码）', { skip: SKIP_NO_ASSETS }, () => {
  const assets = readAssets();
  const total = Number(assets.totals.bytes);
  assert.ok(total > 0);
  assert.ok(total <= 2.5 * 1024 * 1024, `当前 ${(total / 1024 / 1024).toFixed(2)}MB 超过 2.5MB 预算`);
  // 预算是我们自己定的上限；美术自检口径的 modelBytes（23.4MB）是全量母版，两者不冲突，
  // 这里只断言"运行时产物"的量级，避免有人拿母版体积来比对
});

test('运行时目录无孤儿产物（清单没引用的文件 = 第二套资产来源）', { skip: SKIP_NO_ASSETS }, () => {
  const { findOrphanAssets } = require('../scripts/check-pet-geometry.mjs');
  const orphans = findOrphanAssets(DEFAULT_OUT_DIR, readAssets());
  assert.deepEqual(orphans, [], `存在未引用的文件: ${orphans.join(', ')}`);
});

test('findOrphanAssets：检测能力自证（注入孤儿文件必须被抓到）', () => {
  const { findOrphanAssets } = require('../scripts/check-pet-geometry.mjs');
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(resolve(tmpdir(), 'pet-orphan-'));
  // try/finally：断言失败也必须把临时目录删掉。旧写法漏了清理，本地已积了 133 个
  // %TEMP%\pet-orphan-XXXXXX 空壳目录（CI 是临时机器不受影响，但本地会一直涨）。
  try {
    mkdirSync(resolve(dir, 'composites'), { recursive: true });
    writeFileSync(resolve(dir, 'composites/neutral@2x.webp'), 'x');
    writeFileSync(resolve(dir, 'front-standing@2x.webp'), 'y');
    const assets = { frames: { neutral: { '2x': { file: 'composites/neutral@2x.webp' } } }, patches: {}, body: null };
    const orphans = findOrphanAssets(dir, assets);
    assert.deepEqual(orphans, ['front-standing@2x.webp']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check 模式：清单与磁盘一致时退出码 0', { skip: SKIP_NO_ASSETS }, async () => {
  const code = await run({ source: detectSourceDir(), out: DEFAULT_OUT_DIR, check: true, verbose: false });
  assert.equal(code, 0);
});

// ---------------------------------------------------------------- 美术源（在场才校验）

test('美术源：runtime 清单与母版清单的 8 档表情、眨眼映射与我们一致', (t) => {
  const sourceDir = detectSourceDir();
  const runtimeManifest = readRuntimeManifest(sourceDir);
  const masterManifest = existsSync(resolve(sourceDir, 'manifest.json'))
    ? JSON.parse(readFileSync(resolve(sourceDir, 'manifest.json'), 'utf8'))
    : null;
  if (!runtimeManifest) {
    // node:test 原生跳过：输出里记 skipped、不计 PASS（旧写法 assert.ok(true) 是假绿）
    t.skip(`美术源不在本机（${sourceDir}）：本用例做的是母版清单对账，无源可对，跳过`);
    return;
  }
  // 8 档表情 id 在母版清单里；运行时清单逐文件带 expressionId，两者应一致
  const ids = Array.isArray(masterManifest?.expressionIds) ? masterManifest.expressionIds : [];
  for (const id of ART_EXPRESSION_IDS) {
    assert.ok(ids.includes(id), `美术母版清单缺少表情 ${id}`);
  }
  const runtimeIds = new Set(
    (Array.isArray(runtimeManifest.files) ? runtimeManifest.files : []).map((item) => item.expressionId).filter(Boolean),
  );
  for (const id of ART_EXPRESSION_IDS) {
    assert.ok(runtimeIds.has(id), `美术 runtime 清单缺少表情 ${id} 的产物`);
  }
  // 眨眼三态是母版清单的契约。`open` / `closed` 两档资产没变，仍与 v3 母版清单对账：
  assert.equal(masterManifest?.blink?.open, BLINK_EXPRESSION_MAP.open, '睁眼档必须与美术母版清单一致');
  assert.equal(masterManifest?.blink?.closed, BLINK_EXPRESSION_MAP.closed, '闭眼档必须与美术母版清单一致');
  // `half` 在 M1 起**不再由 v3 决定**：v3 的 `blink.half = 'sleepy'` 就是 §5.1 认定的缺陷
  // （每逢眨眼换一次困倦整脸 → 嘴型抖一下）。v3 历史交付文件不得修改，v4 清单
  // （`supersedes: v3`）已把 half 显式置空，所以这里只钉"渲染层不再沿用 v3 的换脸写法"，
  // half / wink 的正向对账放在上一条用例里对着 v4 清单做。
  assert.notEqual(
    BLINK_EXPRESSION_MAP.half,
    masterManifest?.blink?.half,
    '渲染层不许沿用 v3 的半闭帧（那是 sleepy 整脸，会抖动嘴型）',
  );
});

test('美术源：composites 的 neutral 与 front-standing 是同一张（美术声明的等价关系）', (t) => {
  const sourceDir = detectSourceDir();
  const runtimeManifest = readRuntimeManifest(sourceDir);
  if (!runtimeManifest) {
    // node:test 原生跳过：输出里记 skipped、不计 PASS（旧写法 assert.ok(true) 是假绿）
    t.skip('美术源不在本机：本用例比对美术声明的等价关系，无源可比，跳过');
    return;
  }
  const files = Array.isArray(runtimeManifest.files) ? runtimeManifest.files : [];
  const neutral = files.find((item) => item.file === 'composites/neutral@2x.webp');
  const standing = files.find((item) => item.file === 'front-standing@2x.webp');
  assert.ok(neutral && standing, '美术清单应同时声明 composites/neutral@2x 与 front-standing@2x');
  assert.equal(neutral.sha256, standing.sha256, '两者应是同一张图（我们只接 composites，不重复接入）');
});
