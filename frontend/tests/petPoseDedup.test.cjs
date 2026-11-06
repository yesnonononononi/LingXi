/**
 * M2 T02：内容寻址去重（同 `contentId` 只写一份 webp）+ `totals` 自证（G-P9）+ 内容一致性/反向孤儿（G-P10）。
 *
 * <p><b>为什么本文件不得不用真数据（lie）：</b>去重这件事只在"两份帧位指向同一张画"时才存在，
 * 而当前 accepted 的四批（sit/walk/run/jump）**没有重复像素**（每张母版的 sha256 互不相同），
 * 对它们断言去重等于断言一个恒等式。lie 是真世界里唯一满足条件的批次：7 个帧位只有
 * 3 张不同像素（`down_01=up_03`、`down_02=up_02`、`down_03=neutral=up_01`），
 * 而它当前仍是 deferred（切片 3 才翻 accepted），所以这里通过 `runBuild({ accepted: ['lie'] })`
 * 导到**临时目录**——一个字节都不写进仓库运行目录，`ACCEPTED_BATCHES` 也不动。</p>
 *
 * <p><b>每条断言都要有"变红"的证明：</b>每个门禁判据（G-P9/G-P10）都用"只改坏一处"的
 * 合成清单再跑一遍，并要求它确实报出点名到字段的问题行。只验绿不验红，
 * 等于没有任何守卫（本仓已经为此返工过两次）。</p>
 *
 * <p><b>为什么用动态 `import()` 而不是 `require()`：</b>`check-pet-poses.mjs` 的入口段
 * `process.exit(await main())` 让整个 ESM 图带顶层 await，`require(esm)` 会抛
 * `ERR_REQUIRE_ASYNC_MODULE`。CJS 测试里用一次性缓存的 `import()` 是唯一稳妥写法。</p>
 *
 * @module tests/petPoseDedup
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');

/** frontend 根。 */
const FRONTEND_ROOT = resolve(__dirname, '..');

/** 仓库根（adapter 要按 `docs/assets/desktop-pet/poses/<batch>/manifest.json` 读）。 */
const REPO_ROOT = resolve(FRONTEND_ROOT, '..');

/** 已提交的运行时清单。 */
const POSES_JSON_PATH = resolve(FRONTEND_ROOT, 'pet-poses.json');

/** 运行资产目录（Vite 复制进 `dist/live2d/pet-poses`）。 */
const POSE_RUNTIME_DIR = resolve(FRONTEND_ROOT, 'public', 'live2d', 'pet-poses');

/** lie 去重后的真实字节数（= 未去重 1,185,506 − 重复 677,018）：美术真数据的金丝雀。 */
const LIE_DEDUPED_BYTES = 508488;

/** 四批现状（切片 2 的 `totals`）：去重对它们必须**零影响**。 */
const FOUR_BATCH_TOTALS = Object.freeze({ frames: 31, bytes1x: 1299144, bytes2x: 4096820, distinctFiles: 62 });

/** 四批名单（`D7` 的"零变化"判据只针对它们：lie/sleep 是切片 3 才接进来的）。 */
const FOUR_BATCHES = Object.freeze(['sit', 'walk', 'run', 'jump']);

/** 六批现状（切片 3 翻 accepted 之后的真实 `totals`）：lie 508,488 + sleep 784,308 各按 distinct 文件计。 */
const SIX_BATCH_TOTALS = Object.freeze({ frames: 43, bytes1x: 1610116, bytes2x: 5078644, distinctFiles: 78 });

/** 模块缓存（三份脚本只 import 一次）。 */
let modulesPromise = null;

/**
 * 一次性载入三份脚本模块。
 *
 * @returns {Promise<{adapters: object, build: object, gate: object}>} 模块集合
 */
function loadModules() {
  if (modulesPromise === null) {
    modulesPromise = (async () => ({
      adapters: await import('../scripts/pet-pose-adapters.mjs'),
      build: await import('../scripts/build-pet-poses.mjs'),
      gate: await import('../scripts/check-pet-poses.mjs'),
    }))();
  }
  return modulesPromise;
}

/** lie 的一次真实导出（7 帧 / 3 张不同像素），只跑一次给全文件复用。 */
let lieBuildPromise = null;

/**
 * 把 lie 导到临时目录（**不写仓库运行目录**），并在整个文件内复用同一次结果。
 *
 * @returns {Promise<{dir: string, outDir: string, posesJsonPath: string, result: Record<string, any>}>} 导出结果
 */
function buildLieOnce() {
  if (lieBuildPromise === null) {
    lieBuildPromise = (async () => {
      const { build } = await loadModules();
      const dir = mkdtempSync(join(tmpdir(), 'kou-dedup-lie-'));
      const outDir = join(dir, 'out');
      const posesJsonPath = join(dir, 'pet-poses.json');
      const result = await build.runBuild({ accepted: ['lie'], outDir, posesJsonPath });
      return { dir, outDir, posesJsonPath, result };
    })();
  }
  return lieBuildPromise;
}

after(async () => {
  if (lieBuildPromise === null) return;
  const { dir } = await lieBuildPromise;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 深拷贝一个可序列化值（"只改坏一处"的合成清单都从它出发）。
 *
 * @param {any} value 任意可序列化值
 * @returns {any} 深拷贝
 */
function clone(value) {
  return structuredClone(value);
}

/**
 * 读一份 JSON。
 *
 * @param {string} absolutePath 路径
 * @returns {any} 解析结果
 */
function readJson(absolutePath) {
  return JSON.parse(readFileSync(absolutePath, 'utf8'));
}

/**
 * 递归列出目录下所有 webp（相对路径，正斜杠）。
 *
 * @param {string} root 目录
 * @returns {string[]} 相对路径
 */
function listWebp(root) {
  const collected = [];
  /**
   * 深度优先。
   *
   * @param {string} dir 当前目录
   */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.webp$/i.test(entry.name)) continue;
      collected.push(relativePathOf(root, full));
    }
  };
  walk(root);
  return collected;
}

/**
 * 相对路径（正斜杠）。
 *
 * @param {string} root 根目录
 * @param {string} absolutePath 绝对路径
 * @returns {string} 相对路径
 */
function relativePathOf(root, absolutePath) {
  return absolutePath.slice(root.length).replace(/^[\\/]+/, '').split(sep).join('/');
}

/**
 * 给一棵目录树算"相对路径 → sha256"，用于逐文件比对（导出确定性）。
 *
 * @param {string} root 目录
 * @returns {Record<string, string>} 相对路径 → 摘要
 */
function hashTree(root) {
  /** @type {Record<string, string>} */
  const table = {};
  for (const relativePath of listWebp(root)) {
    table[relativePath] = createHash('sha256').update(readFileSync(join(root, relativePath))).digest('hex');
  }
  return table;
}

/**
 * 深度拷贝一棵 webp 目录树（只拷 webp，够门禁用了）。
 *
 * @param {string} source 源目录
 * @param {string} target 目标目录
 */
function copyWebpTree(source, target) {
  for (const relativePath of listWebp(source)) {
    const targetPath = join(target, relativePath);
    mkdirSync(join(targetPath, '..'), { recursive: true });
    writeFileSync(targetPath, readFileSync(join(source, relativePath)));
  }
}

/**
 * 把一段问题列表拼成一行文本（断言用）。
 *
 * @param {string[]} problems 问题列表
 * @returns {string} 拼接文本
 */
function joinProblems(problems) {
  return problems.join('\n');
}

test('D1 同 contentId 只写一份文件：lie 的 7 个帧位落到 3 张画 / 6 个 webp 上', async () => {
  const { result, outDir } = await buildLieOnce();
  assert.strictEqual(result.ok, true, `lie 导出失败：${joinProblems(result.problems)}`);
  const lie = result.manifest.batches.lie;
  assert.strictEqual(Object.keys(lie.frames).length, 7, 'lie 必须还是 7 个帧位（去重不许减帧）');

  // ① 两档各只有 3 个不同路径（= 3 张不同像素）
  for (const density of ['1x', '2x']) {
    const distinct = new Set(Object.values(lie.frames).map((frame) => frame.files[density].file));
    assert.strictEqual(distinct.size, 3, `lie@${density} 的 distinct 路径必须是 3，实际 ${[...distinct].join(' / ')}`);
  }
  // ② 逐条对照美术声明的等价关系（7 帧 = 3 张画，这才是"真的用上了 aliases"）
  const pathOf = (frameId, density = '2x') => lie.frames[frameId].files[density].file;
  assert.strictEqual(pathOf('lie_up_03_neutral'), pathOf('lie_down_01_neutral'), 'up_03 与 down_01 是同一张画');
  assert.strictEqual(pathOf('lie_up_02_neutral'), pathOf('lie_down_02_neutral'), 'up_02 与 down_02 是同一张画');
  assert.strictEqual(pathOf('lie_up_01_neutral'), pathOf('lie_down_03_neutral'), 'up_01 与 down_03 是同一张画');
  assert.strictEqual(pathOf('lie_neutral'), pathOf('lie_down_03_neutral'), 'neutral 与 down_03 是同一张画');
  // ③ contentId 同组全等，异组不等（同 contentId 才有资格共用文件）
  const contentIdOf = (frameId) => lie.frames[frameId].files['2x'].contentId;
  for (const frameId of Object.keys(lie.frames)) {
    assert.match(contentIdOf(frameId), /^[0-9a-f]{16}$/, `${frameId} 的 contentId 必须是 16 位小写十六进制`);
    assert.strictEqual(
      lie.frames[frameId].files['1x'].contentId,
      contentIdOf(frameId),
      `${frameId} 的两档密度必须共用同一个 contentId（同一张画）`,
    );
  }
  assert.strictEqual(contentIdOf('lie_up_03_neutral'), contentIdOf('lie_down_01_neutral'));
  assert.notStrictEqual(contentIdOf('lie_down_02_neutral'), contentIdOf('lie_down_01_neutral'), '不同画必须有不同 contentId');
  // ④ canonical 帧自己保留原名（组内草稿顺序的第一个），共享帧指向它
  assert.match(pathOf('lie_down_01_neutral'), /\/lie_down_01_neutral@2x\.webp$/);
  assert.match(pathOf('lie_down_03_neutral'), /\/lie_down_03_neutral@2x\.webp$/);

  // ⑤ 盘上确实只有 6 个 webp，且清单引用的路径集合与磁盘一一对应
  const onDisk = listWebp(outDir).sort();
  assert.strictEqual(onDisk.length, 6, `lie 去重后盘上必须只有 6 个 webp，实际 ${onDisk.length}：${onDisk.join(' / ')}`);
  const referenced = new Set();
  for (const frame of Object.values(lie.frames)) {
    for (const density of ['1x', '2x']) referenced.add(frame.files[density].file.replace(/^poses\//, ''));
  }
  assert.deepStrictEqual([...referenced].sort(), onDisk, '清单引用的路径集合必须与盘上文件逐项一致（多一个=孤儿，少一个=404）');

  // ⑥ totals 按 distinct 文件累加：等于盘上字节之和，且等于美术实测的去重值
  const diskBytes = onDisk.reduce((sum, relativePath) => sum + statSync(join(outDir, relativePath)).size, 0);
  assert.strictEqual(result.manifest.totals.distinctFiles, 6, 'lie 去重后 distinctFiles 必须是 6（3 张画 × 2 档）');
  assert.strictEqual(
    result.manifest.totals.bytes1x + result.manifest.totals.bytes2x,
    diskBytes,
    'totals 必须是 distinct 文件字节之和（按帧位累加会多算 677,018 B）',
  );
  assert.strictEqual(diskBytes, LIE_DEDUPED_BYTES, 'lie 去重后必须正好 508,488 B = 1,185,506 − 677,018');
  assert.ok(
    diskBytes < 1185506,
    '若与未去重的 1,185,506 B 相等，说明去重根本没落地（7 个帧位各写了一份）',
  );
});

test('D2 同 contentId 但内容不同 ⇒ 构建必须抛错（三种字段各打一次）', async () => {
  const { adapters, build } = await loadModules();
  const drafts = adapters.adaptAll({ repoRoot: REPO_ROOT, accepted: ['lie'] }).drafts;
  const geometry = readJson(resolve(FRONTEND_ROOT, 'pet-geometry.json'));

  /**
   * 造一份 assets：**整批同一个 contentId**（这样"异 contentId 共用字节"那条不会先响），
   * 两档字节/摘要/格式都一致。
   *
   * @returns {Record<string, Record<string, any>>} assets
   */
  const baseAssets = () => {
    /** @type {Record<string, Record<string, any>>} */
    const assets = {};
    for (const [posture, draft] of Object.entries(drafts)) {
      assets[posture] = {};
      for (const frameId of Object.keys(draft.frames)) {
        assets[posture][frameId] = {
          contentId: '0123456789abcdef',
          canonicalId: frameId,
          '1x': { bytes: 100, sha256: 'a'.repeat(64), format: 'webp-lossless' },
          '2x': { bytes: 200, sha256: 'b'.repeat(64), format: 'webp-lossless' },
        };
      }
    }
    return assets;
  };

  // 金丝雀：这份输入本身是合法的（否则下面的"必红"可能只是因为别的地方坏了）
  assert.doesNotThrow(() => build.buildPosesManifest({ drafts, assets: baseAssets(), geometry }));

  const cases = [
    ['bytes', (assets) => { assets.lie.lie_up_03_neutral['2x'].bytes = 201; }, /bytes 不一致/],
    ['sha256', (assets) => { assets.lie.lie_up_03_neutral['1x'].sha256 = 'c'.repeat(64); }, /sha256 不一致/],
    ['format', (assets) => { assets.lie.lie_up_03_neutral['2x'].format = 'webp'; }, /format 不一致/],
  ];
  for (const [field, mutate, pattern] of cases) {
    const assets = baseAssets();
    mutate(assets);
    assert.throws(
      () => build.buildPosesManifest({ drafts, assets, geometry }),
      pattern,
      `同 contentId 但 ${field} 不同必须构建失败（否则"只写一份文件"会让其中一帧看到别的内容）`,
    );
  }

  // 半有半无：没 contentId 的帧永远不会被比对，等于判据静默失效 ⇒ 必须直接抛
  const partial = baseAssets();
  delete partial.lie.lie_up_03_neutral.contentId;
  assert.throws(
    () => build.buildPosesManifest({ drafts, assets: partial, geometry }),
    /全有或全无|只覆盖了/,
    'contentId 半有半无必须抛错',
  );

  // 异 contentId 却编出同一份字节：说明美术该用 aliases 声明"同一张画"，构建期必须点名
  const collision = baseAssets();
  for (const frameId of Object.keys(collision.lie)) collision.lie[frameId].contentId = 'fedcba9876543210';
  collision.lie.lie_up_03_neutral.contentId = '0011223344556677';
  assert.throws(
    () => build.buildPosesManifest({ drafts, assets: collision, geometry }),
    /同一份 2x 字节|aliases/,
    '不同 contentId 共用同一份字节必须抛错（否则 canonical 归组与字节归组不再一一对应，--check 无法复现路径）',
  );
});

test('D3 G-P9 totals 自证：手改大/改小/按帧位重复计数都必须红', async () => {
  const { gate } = await loadModules();
  const manifest = readJson(POSES_JSON_PATH);

  // 金丝雀：已提交清单必须自证通过（否则下面"必红"的判别力就说不清）
  assert.deepStrictEqual(gate.checkTotalsRecompute(manifest), [], '真清单的 totals 必须能按 distinct 文件重算');

  for (const delta of [1, -1, 677018]) {
    const mutated = clone(manifest);
    mutated.totals.bytes1x += delta;
    const problems = gate.checkTotalsRecompute(mutated);
    assert.strictEqual(problems.length, 1, `改 bytes1x ${delta} 必须只红一条，实际：${joinProblems(problems)}`);
    assert.match(problems[0], /G-P9/);
    assert.match(problems[0], /bytes1x/);
  }
  for (const delta of [1, -1]) {
    const mutated = clone(manifest);
    mutated.totals.bytes2x += delta;
    const problems = gate.checkTotalsRecompute(mutated);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /bytes2x/);
    assert.match(problems[0], /G-P9/);
  }

  // "去重后仍按帧位累加"（设计 §6.1 的第二个变异点）：用真去重过的 lie 清单制造重复计数
  const lie = await buildLieOnce();
  assert.strictEqual(lie.result.ok, true, `lie 导出失败：${joinProblems(lie.result.problems)}`);
  const doubleCounted = clone(lie.result.manifest);
  let perFrame1x = 0;
  let perFrame2x = 0;
  for (const frame of Object.values(doubleCounted.batches.lie.frames)) {
    perFrame1x += frame.files['1x'].bytes;
    perFrame2x += frame.files['2x'].bytes;
  }
  assert.ok(perFrame2x > doubleCounted.totals.bytes2x, '前提：lie 按帧位累加一定大于按 distinct 文件累加');
  doubleCounted.totals.bytes1x = perFrame1x;
  doubleCounted.totals.bytes2x = perFrame2x;
  const repeated = gate.checkTotalsRecompute(doubleCounted);
  assert.strictEqual(repeated.length, 2, `按帧位重复计数必须两档各红一条，实际：${joinProblems(repeated)}`);
  assert.match(joinProblems(repeated), /G-P9/);

  // frames / distinctFiles / 缺字段：查不到 = 判红，不许跳过
  const wrongFrames = clone(manifest);
  wrongFrames.totals.frames -= 1;
  assert.match(joinProblems(gate.checkTotalsRecompute(wrongFrames)), /totals\.frames.*G-P9/);

  const wrongDistinct = clone(manifest);
  wrongDistinct.totals.distinctFiles = 99;
  assert.match(joinProblems(gate.checkTotalsRecompute(wrongDistinct)), /distinctFiles.*G-P9/);

  const missingDistinct = clone(manifest);
  delete missingDistinct.totals.distinctFiles;
  assert.match(joinProblems(gate.checkTotalsRecompute(missingDistinct)), /缺少 totals\.distinctFiles/);

  const missingTotals = clone(manifest);
  delete missingTotals.totals;
  assert.deepStrictEqual(gate.checkTotalsRecompute(missingTotals), ['清单缺少 totals：G-P9 无法自证（不许静默跳过）']);

  // 同一份文件被两帧引用却记了两个字节数：同一份磁盘文件不可能有两个大小
  const twoSizes = clone(lie.result.manifest);
  twoSizes.batches.lie.frames.lie_up_03_neutral.files['2x'].bytes += 1;
  assert.match(joinProblems(gate.checkTotalsRecompute(twoSizes)), /同一份磁盘文件不可能有两个大小/);
});

test('D4 G-P10 ① 同 contentId 的 bytes/sha256/format 必须全等（改一位就红）', async () => {
  const { gate } = await loadModules();
  const lie = await buildLieOnce();
  assert.strictEqual(lie.result.ok, true, `lie 导出失败：${joinProblems(lie.result.problems)}`);
  const manifest = lie.result.manifest;

  // 金丝雀：真产物必须干净（含磁盘反向孤儿，见 D5）
  assert.deepStrictEqual(
    gate.checkContentAddressedFiles(manifest, lie.outDir),
    [],
    '真产物不该有任何 G-P10 问题',
  );

  const cases = [
    ['sha256', (value) => { value.batches.lie.frames.lie_up_03_neutral.files['2x'].sha256 = 'f'.repeat(64); }, /sha256 不一致/],
    ['bytes', (value) => { value.batches.lie.frames.lie_neutral.files['1x'].bytes += 1; }, /bytes 不一致/],
    ['format', (value) => { value.batches.lie.frames.lie_up_01_neutral.files['2x'].format = 'webp'; }, /format 不一致/],
  ];
  for (const [field, mutate, pattern] of cases) {
    const mutated = clone(manifest);
    mutate(mutated);
    const problems = gate.checkContentAddressedFiles(mutated, lie.outDir);
    assert.strictEqual(problems.length, 1, `改 ${field} 必须只红一条，实际：${joinProblems(problems)}`);
    assert.match(problems[0], pattern);
    assert.match(problems[0], /G-P10/);
  }

  // 缺 contentId：去重后"哪些帧位共用同一份文件"必须能从清单读出来
  const missing = clone(manifest);
  delete missing.batches.lie.frames.lie_up_02_neutral.files['2x'].contentId;
  const missingProblems = gate.checkContentAddressedFiles(missing, lie.outDir);
  assert.strictEqual(missingProblems.length, 1);
  assert.match(missingProblems[0], /缺少 contentId/);
  assert.match(missingProblems[0], /G-P10/);

  // 形状非法同样红
  const malformed = clone(manifest);
  malformed.batches.lie.frames.lie_up_02_neutral.files['2x'].contentId = 'NOT-A-CONTENT-ID';
  assert.match(joinProblems(gate.checkContentAddressedFiles(malformed, lie.outDir)), /不是 16 位小写十六进制/);
});

test('D5 G-P10 ② 磁盘反向孤儿：没人引用的 webp 必须红（清单内孤儿帧 G-P4 管不到这里）', async () => {
  const { gate } = await loadModules();
  const lie = await buildLieOnce();
  assert.strictEqual(lie.result.ok, true, `lie 导出失败：${joinProblems(lie.result.problems)}`);
  const dir = mkdtempSync(join(tmpdir(), 'kou-dedup-orphan-'));
  try {
    const copyDir = join(dir, 'out');
    copyWebpTree(lie.outDir, copyDir);
    assert.strictEqual(listWebp(copyDir).length, 6, '前提：拷贝了 6 个 webp');
    // 金丝雀：原样拷贝必须干净（否则"塞一个就红"可能只是因为它本来就在红）
    assert.deepStrictEqual(gate.checkContentAddressedFiles(lie.result.manifest, copyDir), []);

    const ghost = join(copyDir, 'lie', 'ghost@1x.webp');
    writeFileSync(ghost, Buffer.from('RIFF0000WEBPVP8L0000', 'latin1'));
    const problems = gate.checkContentAddressedFiles(lie.result.manifest, copyDir);
    assert.strictEqual(problems.length, 1, `塞一个没人引用的 webp 必须只红一条，实际：${joinProblems(problems)}`);
    assert.match(problems[0], /ghost@1x\.webp/);
    assert.match(problems[0], /没有被任何帧引用/);
    assert.match(problems[0], /G-P10/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D6 canonical 幂等：同一输入连导两次 ⇒ 清单与每个 webp 逐字节相同', async () => {
  const { build } = await loadModules();
  const first = await buildLieOnce();
  assert.strictEqual(first.result.ok, true, `首次导出失败：${joinProblems(first.result.problems)}`);
  const dir = mkdtempSync(join(tmpdir(), 'kou-dedup-idem-'));
  try {
    const outDir = join(dir, 'out');
    const posesJsonPath = join(dir, 'pet-poses.json');
    const second = await build.runBuild({ accepted: ['lie'], outDir, posesJsonPath });
    assert.strictEqual(second.ok, true, `第二次导出失败：${joinProblems(second.problems)}`);
    assert.strictEqual(
      readFileSync(posesJsonPath, 'utf8'),
      readFileSync(first.posesJsonPath, 'utf8'),
      '两次导出的清单必须逐字节相同（canonical 归组依赖草稿顺序：顺序一旦不稳定，路径就会抖）',
    );
    const firstTree = hashTree(first.outDir);
    const secondTree = hashTree(outDir);
    assert.deepStrictEqual(Object.keys(secondTree).sort(), Object.keys(firstTree).sort(), '文件集合必须一致');
    assert.deepStrictEqual(secondTree, firstTree, '每个 webp 必须逐字节相同');
    assert.strictEqual(Object.keys(secondTree).length, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D7 四批零变化：去重对 sit/walk/run/jump 必须毫无影响（62 个 webp / 5,395,964 B），六批合计 6,688,760 B', async () => {
  const { build, gate } = await loadModules();
  const manifest = readJson(POSES_JSON_PATH);

  // 切片 3 起六批全部 accepted（lie/sleep 已翻），这里断的是**新真值**：
  assert.deepStrictEqual(
    manifest.accepted,
    ['sit', 'walk', 'run', 'jump', 'lie', 'sleep'],
    'accepted 是工程接受的唯一开关，改它必须同批改本用例',
  );
  assert.deepStrictEqual(manifest.deferred, [], '六批全部 accepted ⇒ deferred 必须是空表（不许留幽灵理由）');
  assert.deepStrictEqual(manifest.totals, SIX_BATCH_TOTALS, '六批的 totals 必须等于"按 distinct 文件重算"的结果');

  // **四批零变化**这条判据原样保留（去重不该动它们的路径、字节与 contentId），只是循环范围
  // 从"所有批次"收窄成"四批"，因为现在清单里多了 lie/sleep（它们的路径形态本就不同：去重后
  // 多帧共享同一路径，`poses/<posture>/<frameId>@<density>.webp` 那条正则对它们不成立）。
  let frameCount = 0;
  const contentIds = new Set();
  const paths = new Set();
  for (const posture of FOUR_BATCHES) {
    const batch = manifest.batches[posture];
    assert.ok(batch, `运行清单里必须有 ${posture}`);
    for (const [frameId, frame] of Object.entries(batch.frames)) {
      frameCount += 1;
      for (const density of ['1x', '2x']) {
        const file = frame.files[density];
        assert.match(file.contentId ?? '', /^[0-9a-f]{16}$/, `${posture}/${frameId}@${density} 必须有合法 contentId`);
        assert.match(file.file, new RegExp(`^poses/${posture}/${frameId}@${density}\\.webp$`),
          `${posture}/${frameId}@${density} 的去重不该改路径（四批没有重复像素）`);
        paths.add(file.file);
        contentIds.add(file.contentId);
      }
      assert.strictEqual(frame.files['1x'].contentId, frame.files['2x'].contentId, '同一帧两档必须同一个 contentId');
    }
  }
  assert.strictEqual(frameCount, 31, '四批必须还是 31 帧');
  assert.strictEqual(paths.size, 62, '四批必须还是 62 个不同路径（没有可去重的重复像素）');
  assert.strictEqual(contentIds.size, 31, '四批 31 帧必须是 31 张不同的画（有重复就说明这批不该共用文件）');

  // 四批的字节小计也必须逐值不变（金丝雀：去重对它们零影响）
  const sitFrame = manifest.batches.sit.frames.sit_neutral;
  assert.strictEqual(sitFrame.files['1x'].bytes, 31846, 'sit@1x 字节数不该变');
  assert.strictEqual(sitFrame.files['2x'].bytes, 100182, 'sit@2x 字节数不该变');

  // 盘上 78 个 webp、总字节 6,688,760（逐字节与 totals 吻合；去重不许多写也不许少写文件）
  const onDisk = listWebp(POSE_RUNTIME_DIR);
  assert.strictEqual(onDisk.length, SIX_BATCH_TOTALS.distinctFiles, `盘上应有 ${SIX_BATCH_TOTALS.distinctFiles} 个 webp，实际 ${onDisk.length}`);
  const diskBytes = onDisk.reduce((sum, relativePath) => sum + statSync(join(POSE_RUNTIME_DIR, relativePath)).size, 0);
  assert.strictEqual(diskBytes, SIX_BATCH_TOTALS.bytes1x + SIX_BATCH_TOTALS.bytes2x, '盘上字节必须等于 totals');

  // contentId 的来源可复算：母版 PNG 的 sha256 前 16 位（不是转码后的 webp 摘要）
  const sitSource = resolve(REPO_ROOT, 'docs/assets/desktop-pet/poses/sit/sit_neutral@2x.png');
  assert.strictEqual(
    build.contentIdOf(sitSource),
    manifest.batches.sit.frames.sit_neutral.files['1x'].contentId,
    'contentId 必须是母版 PNG sha256 的前 16 位（换个编码器也不该变号）',
  );

  // 两条新门禁对真清单必须干净
  assert.deepStrictEqual(gate.checkTotalsRecompute(manifest), []);
  assert.deepStrictEqual(gate.checkContentAddressedFiles(manifest, POSE_RUNTIME_DIR), []);
});
