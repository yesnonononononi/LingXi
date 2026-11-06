/**
 * M2 切片 2 · T01：walk / run / jump 导出管线与清单结构的守卫。
 *
 * <p><b>本文件守什么：</b>设计 §A.3–§A.7 的批次形态裁决（`clips` 用同 id + `facing` 区分、
 * frameId 沿用美术 `frames[].id`、时序 110/90/130、walk/run 循环、jump `return-stand`、
 * `bodyAnchor.byFacing` 从美术 manifest 读），以及 §A.9 的六条门禁断言（G-P1–G-P6）
 * 与 P13 体积上限、P9a/P9b 导出确定性。</p>
 *
 * <p><b>为什么断言"真数据形态"而不是"读代码"：</b>批次形态是 adapter 的行为，不是源码里的
 * 某个标识符。这里一律 `adaptAll` 真跑一遍再断言产出，因此 adapter 一旦改坏（比如把
 * `clips` 拆成 `cycle-left`/`cycle-right`）本文件必红，不依赖任何人记得。</p>
 *
 * <p><b>为什么同时用合成坏批次守判别力：</b>当前 `ACCEPTED_BATCHES` 仍是 `['sit']`
 * （设计 §E.3：T01 与 T04 必须同批合并，否则 `postureOf` 的既有期望会随 accepted 翻转而红），
 * 所以真实清单里还没有 walk/run/jump。若只对真数据断言，门禁新增的六条断言在翻 accepted 之前
 * 全是"空转的绿"。因此每条断言都要有一个**只改坏一处**的合成批次证明它会红——
 * 这就是"断言有判别力"的唯一证据。</p>
 *
 * <p><b>为什么用动态 `import()` 而不是 `require()`：</b>`check-pet-poses.mjs` 的入口段
 * `process.exit(await main())` 让整个 ESM 图带顶层 await，`require(esm)` 会抛
 * `ERR_REQUIRE_ASYNC_MODULE`。CJS 测试里用一次性缓存的 `import()` 是唯一稳妥写法。</p>
 *
 * @module tests/petPoseSlice2Export
 */

const test = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');

/** frontend 根。 */
const FRONTEND_ROOT = resolve(__dirname, '..');

/** 仓库根（adapter 要按 `docs/assets/desktop-pet/poses/<batch>/manifest.json` 读）。 */
const REPO_ROOT = resolve(FRONTEND_ROOT, '..');

/** 美术源根（相对仓库根）。 */
const SOURCE_ROOT = 'docs/assets/desktop-pet/poses';

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

/**
 * 用指定 accepted 清单跑一遍 adapter，取某一批的草稿。
 *
 * @param {object} adapters `pet-pose-adapters.mjs` 模块
 * @param {string} batch 批次名
 * @returns {Record<string, any>} 批次草稿（clips / frames / bodyAnchor 已归一）
 */
function adaptDraft(adapters, batch) {
  const result = adapters.adaptAll({ repoRoot: REPO_ROOT, accepted: [batch] });
  assert.deepStrictEqual(result.problems, [], `adapter 对 ${batch} 报了问题：${result.problems.join(' | ')}`);
  const draft = result.drafts[batch];
  assert.ok(draft, `${batch} 没有产出草稿（missing=${result.missing.join(',')}）`);
  return draft;
}

/**
 * 深拷贝一个草稿，供"只改坏一处"的合成批次使用。
 *
 * @param {Record<string, any>} value 任意可序列化值
 * @returns {Record<string, any>} 深拷贝
 */
function clone(value) {
  return structuredClone(value);
}

/**
 * 按 id + facing 找一条 clip。
 *
 * @param {Array<Record<string, any>>} clips 剪辑列表
 * @param {string} id 剪辑 id
 * @param {number} facing 朝向
 * @returns {Record<string, any>|undefined} 命中的 clip
 */
function clipOf(clips, id, facing) {
  return clips.find((clip) => clip.id === id && clip.facing === facing);
}

/**
 * 读美术 manifest。
 *
 * @param {string} batch 批次名
 * @returns {Record<string, any>} 解析后的 manifest
 */
function readArtManifest(batch) {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, SOURCE_ROOT, batch, 'manifest.json'), 'utf8'));
}

test('T01-1 walk：8 帧 → 2 条同 id 的 cycle clip，frameId 沿用美术 id', async () => {
  const { adapters } = await loadModules();
  const draft = adaptDraft(adapters, 'walk');
  assert.strictEqual(Object.keys(draft.frames).length, 8, 'walk 必须 8 帧');
  assert.deepStrictEqual(
    Object.keys(draft.frames),
    ['l1', 'l2', 'l3', 'l4', 'r1', 'r2', 'r3', 'r4'],
    'frameId 必须直接用美术 frames[].id（不许加姿态前缀、不许用文件名 stem）',
  );
  assert.strictEqual(draft.clips.length, 2, 'walk 必须左右各一条 clip');
  assert.deepStrictEqual(
    draft.clips.map((clip) => clip.id),
    ['cycle', 'cycle'],
    'clips 必须用同一个 id（cycle），朝向后缀会让 clipOf 的 (id,facing) 双键失效（D1）',
  );
  assert.deepStrictEqual(draft.clips.map((clip) => clip.facing), [-1, 1], '两条 clip 必须分别是 -1 与 1');
  assert.deepStrictEqual(clipOf(draft.clips, 'cycle', -1).frames, ['l1', 'l2', 'l3', 'l4']);
  assert.deepStrictEqual(clipOf(draft.clips, 'cycle', 1).frames, ['r1', 'r2', 'r3', 'r4']);
});

test('T01-2 run：12 帧 → 2 条 cycle（6+6），frameMs 全 90，loop 为真', async () => {
  const { adapters } = await loadModules();
  const draft = adaptDraft(adapters, 'run');
  assert.strictEqual(Object.keys(draft.frames).length, 12, 'run 必须 12 帧');
  assert.strictEqual(draft.clips.length, 2);
  for (const clip of draft.clips) {
    assert.strictEqual(clip.id, 'cycle');
    assert.strictEqual(clip.frames.length, 6, `run#${clip.facing} 必须 6 帧`);
    assert.deepStrictEqual(clip.frameMs, [90, 90, 90, 90, 90, 90], 'run 单帧 90ms（§A.5）');
    assert.strictEqual(clip.loop, true, 'run 必须循环');
  }
});

test('T01-3 jump：10 帧 → 2 条 once（5+5），loop:false + onEnd:return-stand，frameMs 全 130', async () => {
  const { adapters } = await loadModules();
  const draft = adaptDraft(adapters, 'jump');
  assert.strictEqual(Object.keys(draft.frames).length, 10, 'jump 必须 10 帧');
  assert.strictEqual(draft.clips.length, 2);
  for (const clip of draft.clips) {
    assert.strictEqual(clip.id, 'once', 'jump 的语义是"一次"，id 必须是 once');
    assert.strictEqual(clip.frames.length, 5);
    assert.deepStrictEqual(clip.frameMs, [130, 130, 130, 130, 130], 'jump 单帧 130ms（§A.5）');
    assert.strictEqual(clip.loop, false, 'jump 不许循环');
    assert.strictEqual(clip.onEnd, 'return-stand', 'jump 播完必须回站姿（§A.6）');
  }
  assert.deepStrictEqual(clipOf(draft.clips, 'once', 1).frames, [
    'r_anticipate',
    'r_ascend',
    'r_apex',
    'r_descend',
    'r_land',
  ]);
});

test('T01-4 bodyAnchor.byFacing 必须逐值来自美术 manifest（不许自己估）', async () => {
  const { adapters } = await loadModules();
  for (const [batch, expectedSource] of [
    ['run', 'measured-per-facing'],
    ['jump', 'measured-per-facing'],
  ]) {
    const draft = adaptDraft(adapters, batch);
    const manifest = readArtManifest(batch);
    assert.strictEqual(
      draft.bodyAnchor.byFacingSource,
      expectedSource,
      `${batch} 的 byFacing 必须来自 manifest 的实测（byFacingSource）`,
    );
    for (const facing of ['-1', '1']) {
      assert.deepStrictEqual(
        draft.bodyAnchor.byFacing[facing],
        { x: manifest.bodyAnchor.byFacing[facing].x, y: manifest.bodyAnchor.byFacing[facing].y },
        `${batch} 朝向 ${facing} 的锚点必须逐值等于美术 manifest（锚点差 20.72 CSS 是本质，不是标定误差）`,
      );
    }
  }
  // walk 是 batch-single（实测躯干质心 spreadNative 1.69 ≤ 2，见设计 §A.7）：两朝向同值，且等于 manifest 标量锚
  const walk = adaptDraft(adapters, 'walk');
  const walkManifest = readArtManifest('walk');
  assert.strictEqual(walk.bodyAnchor.byFacingSource, 'batch-single');
  assert.deepStrictEqual(walk.bodyAnchor.byFacing['1'], walk.bodyAnchor.byFacing['-1']);
  assert.strictEqual(walk.bodyAnchor.byFacing['1'].x, walkManifest.bodyAnchor.x);
  assert.strictEqual(walk.bodyAnchor.byFacing['1'].y, walkManifest.bodyAnchor.y);
  assert.ok(
    Number(walk.bodyAnchor.spreadNative) <= adapters.ANCHOR_SPREAD_MAX_NATIVE,
    'walk 的批内离散度必须 ≤ ANCHOR_SPREAD_MAX_NATIVE（否则该批不能走 batch-single）',
  );
});

test('T01-5 三批在门禁的剪辑断言下全绿（真草稿零问题）', async () => {
  const { adapters, gate } = await loadModules();
  for (const batch of ['walk', 'run', 'jump', 'sit']) {
    const draft = adaptDraft(adapters, batch);
    assert.deepStrictEqual(gate.checkClips(draft), [], `${batch} 的剪辑断言不该有问题`);
    assert.deepStrictEqual(gate.checkTiming(draft), [], `${batch} 的时序断言不该有问题`);
    assert.deepStrictEqual(gate.checkDomains(draft), [], `${batch} 的域断言不该有问题`);
  }
});

test('T01-6 G-P1：clips[].facing 只能是 -1/1（0 与字符串"1"都必须红）', async () => {
  const { adapters, gate } = await loadModules();
  const draft = adaptDraft(adapters, 'walk');
  for (const bad of [0, '1', null, undefined]) {
    const mutated = clone(draft);
    mutated.clips[1].facing = bad;
    const problems = gate.checkClipFacingDomain(mutated);
    assert.strictEqual(problems.length, 1, `facing=${JSON.stringify(bad)} 必须被判红`);
    assert.match(problems[0], /G-P1/);
  }
});

test('T01-7 G-P2：删掉右向 clip ⇒ 红（单向缺 clip 会静默降级成站姿）', async () => {
  const { adapters, gate } = await loadModules();
  const draft = adaptDraft(adapters, 'walk');
  const mutated = clone(draft);
  mutated.clips = mutated.clips.filter((clip) => clip.facing !== 1);
  const problems = gate.checkClipFacingCoverage(mutated);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /朝向 1/);
  assert.match(problems[0], /G-P2/);
});

test('T01-8 G-P3：把 r1 塞进 facing:-1 的 clip ⇒ 红（跨朝向串帧不会被任何既有断言抓住）', async () => {
  const { adapters, gate } = await loadModules();
  const draft = adaptDraft(adapters, 'walk');
  const mutated = clone(draft);
  clipOf(mutated.clips, 'cycle', -1).frames = ['l1', 'l2', 'l3', 'r1'];
  clipOf(mutated.clips, 'cycle', -1).frameMs = [110, 110, 110, 110];
  const problems = gate.checkClipFrameFacing(mutated);
  assert.strictEqual(problems.length, 1, '只有串进来的那一帧该红');
  assert.match(problems[0], /r1/);
  assert.match(problems[0], /G-P3/);

  // 悬空引用（clip 指向不存在的帧）同样是这一条守的洞
  const dangling = clone(draft);
  clipOf(dangling.clips, 'cycle', 1).frames = ['r1', 'r2', 'r3', 'r9'];
  const danglingProblems = gate.checkClipFrameFacing(dangling);
  assert.strictEqual(danglingProblems.length, 1);
  assert.match(danglingProblems[0], /不存在的帧/);
});

test('T01-9 G-P4：加一帧没人引用的 l5 ⇒ 红（孤儿帧白占体积）', async () => {
  const { adapters, gate } = await loadModules();
  const draft = adaptDraft(adapters, 'walk');
  const mutated = clone(draft);
  mutated.frames.l5 = { ...clone(mutated.frames.l1), id: 'l5' };
  const problems = gate.checkOrphanFrames(mutated);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /l5/);
  assert.match(problems[0], /G-P4/);
});

test('T01-10 G-P5：loop:true 的 cycle 第 0 帧填 0 ⇒ 红（永不推进的假动画）', async () => {
  const { adapters, gate } = await loadModules();
  const draft = adaptDraft(adapters, 'walk');
  const mutated = clone(draft);
  clipOf(mutated.clips, 'cycle', -1).frameMs = [0, 110, 110, 110];
  const problems = gate.checkClipSemantics(mutated);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /G-P5/);
});

test('T01-11 G-P6：jump 的 once 只留 land 一帧 + return-stand ⇒ 红', async () => {
  const { adapters, gate } = await loadModules();
  const draft = adaptDraft(adapters, 'jump');
  const mutated = clone(draft);
  const clip = clipOf(mutated.clips, 'once', -1);
  clip.frames = ['land'];
  clip.frameMs = [130];
  const problems = gate.checkClipSemantics(mutated);
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /G-P6/);
});

test('T01-12 P13：totals.bytes1x + totals.bytes2x 必须 ≤ POSE_TOTAL_MAX_BYTES', async () => {
  const { adapters, gate } = await loadModules();
  // 上限的真源：scripts/pet-budget.mjs（**不再**经 build-pet-poses 转手）
  const { POSE_TOTAL_MAX_BYTES } = await import('../scripts/pet-budget.mjs');
  const limit = POSE_TOTAL_MAX_BYTES;
  // 2026-11-05 主理人裁决：pose 运行资产总量上限从 6 MiB 抬到 8 MiB（对齐发布侧 D-02，
  // 因为构建侧 6 MiB 才是漂着的那个，"切片后每片 ≤ 2 MiB"已被切片 2 的 5.15 MiB 实测证伪）。
  // 这行是**随裁决更新**，不是为让断言变绿而放宽：判据形状（=limit 放行 / limit+1 必红）逐字未动。
  assert.strictEqual(limit / 1024 / 1024, 8, '上限是 8 MiB（D-02 对齐后的裁决值，改它必须有新的算账依据）');

  const over = gate.checkVolume({ batches: {}, totals: { bytes1x: limit, bytes2x: 1 } });
  assert.strictEqual(over.length, 1, '超一个字节就必须红');
  assert.match(over[0], /预算/);

  const atLimit = gate.checkVolume({ batches: {}, totals: { bytes1x: limit, bytes2x: 0 } });
  assert.deepStrictEqual(atLimit, [], '等于上限必须放行（判据是 ≤，不是 <）');

  // 真实清单（当前只有 sit）必须在预算内
  const manifest = JSON.parse(readFileSync(resolve(FRONTEND_ROOT, 'pet-poses.json'), 'utf8'));
  const realBytes = Number(manifest.totals.bytes1x) + Number(manifest.totals.bytes2x);
  assert.ok(realBytes <= limit, `已提交清单 ${realBytes} B 必须 ≤ ${limit} B`);

  // 三批真跑一遍后的预算也要在册（用 adapter 真数据 + 不落盘）
  const drafts = adapters.adaptAll({ repoRoot: REPO_ROOT, accepted: ['sit', 'walk', 'run', 'jump'] }).drafts;
  const frames = Object.values(drafts).reduce((sum, draft) => sum + Object.keys(draft.frames).length, 0);
  assert.strictEqual(frames, 31, 'sit 1 + walk 8 + run 12 + jump 10 = 31 帧（§E.4 的 T01 判据）');
});

test('T01-13 P9a：buildPosesManifest 同输入跑两次 ⇒ 清单逐字节相等（无时间戳）', async () => {
  const { adapters, build } = await loadModules();
  const drafts = adapters.adaptAll({ repoRoot: REPO_ROOT, accepted: ['sit'] }).drafts;
  const geometry = JSON.parse(readFileSync(resolve(FRONTEND_ROOT, 'pet-geometry.json'), 'utf8'));
  const assets = {};
  for (const [posture, draft] of Object.entries(drafts)) {
    assets[posture] = {};
    for (const frameId of Object.keys(draft.frames)) {
      assets[posture][frameId] = {
        '1x': { bytes: 1, sha256: 'a'.repeat(64), format: 'webp-lossless' },
        '2x': { bytes: 2, sha256: 'b'.repeat(64), format: 'webp-lossless' },
      };
    }
  }
  const first = JSON.stringify(build.buildPosesManifest({ drafts, assets, geometry }));
  const second = JSON.stringify(build.buildPosesManifest({ drafts, assets, geometry }));
  assert.strictEqual(first, second, '清单两次构建必须逐字节一致（任何 Date.now()/随机键序都会在这里红）');
  assert.ok(!/generatedAt|timestamp|time/.test(first), '清单里不许出现时间戳字段');
});

test('T02-1 G-P7：真清单的 accepted 批次（sit/walk/run/jump）没有镜像推导锚点', async () => {
  const { gate } = await loadModules();
  const manifest = JSON.parse(readFileSync(resolve(FRONTEND_ROOT, 'pet-poses.json'), 'utf8'));
  // 金丝雀：这条断言不许空转（accepted 必须真的包含四批）
  assert.deepStrictEqual(manifest.accepted, ['sit', 'walk', 'run', 'jump']);
  assert.deepStrictEqual(gate.checkAcceptedAnchorSource(manifest), [], '真清单不该有 mirror-derived 批次');
  // 逐批核对来源（这就是主理人要求的"walk/run/jump 到底有没有 mirror-derived"的答案）
  const sources = Object.fromEntries(
    Object.entries(manifest.batches).map(([posture, batch]) => [posture, batch.bodyAnchor.byFacingSource]),
  );
  assert.deepStrictEqual(sources, {
    sit: 'batch-single',
    walk: 'batch-single',
    run: 'measured-per-facing',
    jump: 'measured-per-facing',
  });
});

test('T02-2 G-P7 变异：accepted 批次出现 mirror-derived ⇒ 必红且点明"镜像推导必须由美术补齐"', async () => {
  const { gate } = await loadModules();
  const manifest = JSON.parse(readFileSync(resolve(FRONTEND_ROOT, 'pet-poses.json'), 'utf8'));
  for (const posture of ['sit', 'walk', 'run', 'jump']) {
    const mutated = JSON.parse(JSON.stringify(manifest));
    mutated.batches[posture].bodyAnchor.byFacingSource = 'mirror-derived';
    const problems = gate.checkAcceptedAnchorSource(mutated);
    assert.strictEqual(problems.length, 1, `${posture} 改成 mirror-derived 必须恰好红一条`);
    assert.match(problems[0], new RegExp(`\\[${posture}\\]`), '报错行必须点名批次');
    assert.match(problems[0], /镜像推导/, '报错行必须说清"锚点是镜像推导"');
    assert.match(problems[0], /G-P7/);
  }
  // 反向：只改一个非 accepted 的批次不该红（判据挂在 accepted / 实际导出批次上，不是"任何批次"）
  const deferredOnly = JSON.parse(JSON.stringify(manifest));
  deferredOnly.batches = {};
  deferredOnly.accepted = [];
  assert.deepStrictEqual(gate.checkAcceptedAnchorSource(deferredOnly), []);
});

test('T02-3 G-P8：真清单每帧的 1x/2x 都是 webp-lossless（U1 裁定的"保持无损"有门禁守着）', async () => {
  const { gate } = await loadModules();
  assert.strictEqual(gate.LOSSLESS_FORMAT, 'webp-lossless');
  const manifest = JSON.parse(readFileSync(resolve(FRONTEND_ROOT, 'pet-poses.json'), 'utf8'));
  for (const [posture, batch] of Object.entries(manifest.batches)) {
    assert.deepStrictEqual(gate.checkFrameEncoding(batch), [], `${posture} 出现了非无损编码`);
  }
  // 金丝雀：确实有帧被判过（否则"全绿"可能只是因为一个帧都没遍历到）
  let frameCount = 0;
  for (const batch of Object.values(manifest.batches)) {
    for (const [frameId, frame] of Object.entries(batch.frames)) {
      frameCount += 1;
      // 运行帧必须两个密度档的文件信息都在（这保证 G-P8 的循环不会因为缺 files 被跳过）
      for (const density of ['1x', '2x']) {
        assert.ok(frame.files && frame.files[density], `${frameId}@${density} 缺文件信息：G-P8 会空转`);
        assert.strictEqual(frame.files[density].format, gate.LOSSLESS_FORMAT);
      }
    }
  }
  assert.strictEqual(frameCount, 31);
});

test('T02-4 G-P8 变异：把某帧 format 改成 "webp" ⇒ 必红（体积断言拦不住这条旁路）', async () => {
  const { gate } = await loadModules();
  const manifest = JSON.parse(readFileSync(resolve(FRONTEND_ROOT, 'pet-poses.json'), 'utf8'));
  // 只改 @2x：1x 仍然无损 ⇒ 证明两个密度档分别守
  const mutated = JSON.parse(JSON.stringify(manifest));
  mutated.batches.walk.frames.l1.files['2x'].format = 'webp';
  const problems = gate.checkFrameEncoding(mutated.batches.walk);
  assert.strictEqual(problems.length, 1, '只有被改的那一档该红');
  assert.match(problems[0], /l1@2x/);
  assert.match(problems[0], /有损/);
  assert.match(problems[0], /G-P8/);
  // 而且体积断言照样全绿 —— 这正是这条断言存在的理由
  const volume = gate.checkVolume(mutated).filter((line) => line.includes('字节') && line.includes('[walk]'));
  assert.deepStrictEqual(volume, [], '有损帧的字节更少 ⇒ 体积断言拦不住它（所以必须有 G-P8）');
});

test('T02-5 G-P3 诊断：facing 写成字符串 "1" 时，报错两侧必须能看出类型差异', async () => {
  const { adapters, gate } = await loadModules();
  const draft = adaptDraft(adapters, 'walk');
  const mutated = clone(draft);
  clipOf(mutated.clips, 'cycle', -1).facing = '-1';
  const problems = gate.checkClipFrameFacing(mutated);
  assert.ok(problems.length > 0, '字符串 facing 必须红');
  // 关键：`"1"` 与 `1` 在文字上必须可区分（旧文案会打出 facing=1 ≠ clip.facing=1）
  assert.match(problems[0], /clip\.facing="-1"/, `报错两侧必须带引号，实际：${problems[0]}`);
  assert.doesNotMatch(problems[0], /facing=1 ≠/, '裸数字文案会让读的人以为门禁自己坏了');
});

test('T01-14 P9b：同一母版连续导两次 ⇒ pet-poses.json 与每个 webp 逐字节相同', async () => {
  const { build } = await loadModules();
  const dirs = [];
  /**
   * 跑一次导出并返回"相对路径 → sha256"表与清单文本。
   *
   * @returns {Promise<{files: Record<string, string>, manifest: string}>} 快照
   */
  const exportOnce = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kou-pose-determinism-'));
    dirs.push(dir);
    const outDir = join(dir, 'out');
    const posesJsonPath = join(dir, 'pet-poses.json');
    const result = await build.runBuild({ accepted: ['sit'], outDir, posesJsonPath });
    assert.strictEqual(result.ok, true, `导出失败：${result.problems.join(' | ')}`);
    const files = {};
    for (const postureDir of readdirSync(outDir, { withFileTypes: true })) {
      if (!postureDir.isDirectory()) continue;
      const posturePath = join(outDir, postureDir.name);
      for (const entry of readdirSync(posturePath)) {
        const full = join(posturePath, entry);
        files[`${postureDir.name}/${entry}`] = createHash('sha256').update(readFileSync(full)).digest('hex');
        assert.ok(statSync(full).size > 0);
      }
    }
    return { files, manifest: readFileSync(posesJsonPath, 'utf8') };
  };
  try {
    const first = await exportOnce();
    const second = await exportOnce();
    assert.ok(Object.keys(first.files).length > 0, '至少要有产物（否则这条断言是空转）');
    assert.deepStrictEqual(second.files, first.files, '两次导出的 webp 必须逐字节相同');
    assert.strictEqual(second.manifest, first.manifest, '两次导出的清单必须逐字节相同');
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});
