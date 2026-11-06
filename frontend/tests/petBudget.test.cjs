/**
 * 体积预算单一真源的守卫（`scripts/pet-budget.mjs`）。
 *
 * <p><b>为什么单独给"预算"写测试：</b>体积预算天生是"数字对不对"，而数字可以被写成两份、
 * 也可以被写成"看起来在算、其实没用上"。本仓踩过三次同类坑：①发布侧 8 MiB 与构建侧 6 MiB
 * 并存（纯漂移，谁红取决于你跑了哪条命令）；②`isPlayable` 的"缺锚即不可播"是恒成立的空门；
 * ③`checkHitDerivation` 曾只做文本匹配，"算完不用"也能过。所以这里的断言分两类：
 * <b>文本层</b>（字面量只许出现一次）与<b>行为层</b>（把 limit 与 limit+1 真的喂进两个消费方，
 * 看它们是否按同一个上限放行/报错）。文本层只能防抄数字，行为层才是真守卫。</p>
 *
 * <p>运行：`node --test tests/petBudget.test.cjs`（`pet-budget.mjs` 是 ESM，CJS 里用
 * `await import()`；不 require TS 模块，所以本文件进 `test:pet` 的 CJS 段）。</p>
 *
 * @module tests/petBudget
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** `frontend/` 根。 */
const FRONTEND = path.resolve(__dirname, '..');

/** 预算模块（ESM 真源）。 */
const BUDGET_PATH = path.join(FRONTEND, 'scripts', 'pet-budget.mjs');

/** 真源之外**禁止**出现「8 MiB」这个字面量（乘法写法也算）的脚本目录。 */
const SCRIPTS_DIR = path.join(FRONTEND, 'scripts');

/**
 * 逐行扫描某个目录下所有 `.mjs`，找出匹配 `pattern` 的行。
 *
 * @param {string} dir 目录
 * @param {RegExp} pattern 单行正则（不带 g，避免 lastIndex 干扰）
 * @returns {Array<{file: string, line: number, text: string}>} 命中行
 */
function scanScripts(dir, pattern) {
  const hits = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const absolute = path.join(dir, name);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) continue;
    const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
    lines.forEach((text, index) => {
      if (pattern.test(text)) hits.push({ file: name, line: index + 1, text: text.trim() });
    });
  }
  return hits;
}

test('B-1 单一真源：8 MiB 的乘法字面量只允许出现在 scripts/pet-budget.mjs 一处', () => {
  // 负向后顾：不许匹配 `128 MiB`（dev-mutation 的 maxBuffer）、`1.6 MiB` 之类别的预算
  // 之类别的预算，只匹配**独立的数字 8**。
  const pattern = /(?<![\d.])\b8\s*\*\s*1024\s*\*\s*1024\b/;
  const hits = scanScripts(SCRIPTS_DIR, pattern);
  const outside = hits.filter((hit) => hit.file !== 'pet-budget.mjs');
  assert.deepEqual(
    outside.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`),
    [],
    '出现第二处 8 MiB 的乘法字面量：预算又有两份定义了 —— 请改成从 scripts/pet-budget.mjs import',
  );
  const inBudget = hits.filter((hit) => hit.file === 'pet-budget.mjs');
  assert.equal(inBudget.length, 1, `pet-budget.mjs 里必须**恰好**一处 8 MiB 定义，实际 ${inBudget.length} 处`);
  assert.match(
    inBudget[0].text,
    /POSE_TOTAL_MAX_BYTES/,
    'pet-budget.mjs 里唯一的 8 MiB 必须就是 POSE_TOTAL_MAX_BYTES 的取值',
  );

  // 单帧上限同理：`400 * 1024` 也只许一处
  const frameHits = scanScripts(SCRIPTS_DIR, /(?<![\d.])\b400\s*\*\s*1024\b/);
  assert.deepEqual(
    frameHits.filter((hit) => hit.file !== 'pet-budget.mjs').map((hit) => `${hit.file}:${hit.line}`),
    [],
    '出现第二处 `400 * 1024`：单帧上限也有两份定义了',
  );
});

test('B-2 三处口径一致（行为断言）：两个消费方必须按同一个 limit 放行 / 报错', async () => {
  const budget = await import('../scripts/pet-budget.mjs');
  const build = await import('../scripts/build-pet-poses.mjs');
  const notShipped = await import('../scripts/check-pet-not-shipped.mjs');
  const limit = budget.POSE_TOTAL_MAX_BYTES;
  assert.equal(limit / 1024 / 1024, 8, '前置：真源值必须是 D-02 的 8 MiB');

  // ── 消费方 1：构建/pose 门禁侧的纯函数（不接收 limit 形参，只能读真源） ──
  assert.deepEqual(build.poseVolumeProblems({ bytes1x: limit, bytes2x: 0 }), [], '= limit 必须放行');
  const buildOver = build.poseVolumeProblems({ bytes1x: limit, bytes2x: 1 });
  assert.equal(buildOver.length, 1, 'limit + 1 必须报错（判据是 ≤，不是 <）');
  assert.match(buildOver[0], /超过预算/);

  // ── 消费方 2：发布侧门禁（真跑 runNotShippedChecks，喂一个临时 dist） ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kou-pet-budget-'));
  const distPoseDir = path.join(tmp, ...notShipped.POSE_RUNTIME_DIR_SEGMENTS);
  fs.mkdirSync(distPoseDir, { recursive: true });
  const probe = path.join(distPoseDir, 'probe@2x.webp');
  try {
    // = limit ⇒ 两侧的 pose-budget 判据都必须绿
    fs.writeFileSync(probe, Buffer.alloc(limit));
    const atLimit = notShipped.runNotShippedChecks({ distDir: tmp });
    const atLimitEntries = atLimit.checks.filter((item) => item.id === 'pose-budget');
    assert.equal(atLimitEntries.length, 2, 'public 侧 + dist 侧各一条 pose-budget 判据');
    assert.deepEqual(
      atLimitEntries.filter((item) => !item.ok).map((item) => item.detail),
      [],
      `= limit 时不许有 pose-budget 报错：\n${atLimit.problems.join('\n')}`,
    );
    // ── 口径变化（M2 线A任务 2，前提变了不是放宽）──
    // 本用例原来的收尾断言是 `atLimit.ok === true`（整轮全绿）。前提已经变了：生产构建现在
    // 要求 dist 里**根本不许有**桌宠静态资产（`dist-pet-static-*`），而本用例为了测 pose 体积
    // 恰恰手工造了一个"dist 里有 pet-poses"的世界 —— 那个世界如今按设计就是红的。
    // 所以改成逐族点账：pose-budget 族必须全绿（B-2 的主题没变），并且**必须**恰好只有
    // dist-pet-static-* 族红（否则说明有其他判据被连坐，或新判据根本没生效）。
    assert.deepEqual(
      atLimit.problems.filter((problem) => !/产物里出现桌宠/.test(problem)),
      [],
      `= limit 时除了"dist 不许含桌宠静态资产"这一族，不应有别的红：\n${atLimit.problems.join('\n')}`,
    );
    const staticFamily = atLimit.checks.filter((item) => item.id.startsWith('dist-pet-static-'));
    assert.equal(staticFamily.length, 3, 'dist-pet-static-dirs / -paths / -media 三条子判据必须都在');
    assert.deepEqual(
      staticFamily.filter((item) => item.ok).map((item) => item.id),
      [],
      '手工造的 dist 里就摆着 pet-poses ⇒ 三条静态资产判据必须全红（新判据真的接上了，不是空转）',
    );

    // limit + 1 ⇒ dist 侧必须红
    fs.writeFileSync(probe, Buffer.alloc(limit + 1));
    const over = notShipped.runNotShippedChecks({ distDir: tmp });
    const overEntries = over.checks.filter((item) => item.id === 'pose-budget');
    const distOver = overEntries.filter((item) => item.detail.includes('dist 侧'));
    assert.equal(distOver.length, 1, 'dist 侧必须有一条 pose-budget 判据');
    assert.equal(distOver[0].ok, false, 'limit + 1 必须报错');
    assert.match(distOver[0].detail, /预算/, '报错要点名"预算"');
    assert.equal(over.ok, false, '整轮守卫必须红');
    // 另一侧（真实 public 目录）不许被连坐
    const publicOver = overEntries.filter((item) => item.detail.includes('public 侧'));
    assert.equal(publicOver.length, 1);
    assert.equal(publicOver[0].ok, true, 'public 侧体积没变，不许连坐打红');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('B-3 值等于裁决值：POSE_TOTAL_MAX_BYTES === 8 MiB（8388608 B）', async () => {
  const budget = await import('../scripts/pet-budget.mjs');
  assert.equal(
    budget.POSE_TOTAL_MAX_BYTES,
    8 * 1024 * 1024,
    '这是 D-02 对齐后的裁决值（发布侧一直是 8 MiB、构建侧的 6 MiB 是漂移的那一个）；' +
      '改它必须有新的算账依据并重新裁决，不许"因为现在超了"就抬',
  );
  assert.equal(budget.FRAME_2X_MAX_BYTES, 400 * 1024, '单帧 @2x 上限 400 KiB（172 KiB 的 2.3 倍留白）');
});

test('B-4 余量守卫：已提交清单的合计必须 ≤ 上限，且余量 > 0', async () => {
  const budget = await import('../scripts/pet-budget.mjs');
  const manifest = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'pet-poses.json'), 'utf8'));
  const total = Number(manifest.totals.bytes1x) + Number(manifest.totals.bytes2x);
  assert.ok(Number.isFinite(total) && total > 0, `pet-poses.json 的 totals 读不出来：${JSON.stringify(manifest.totals)}`);
  assert.ok(total <= budget.POSE_TOTAL_MAX_BYTES, `已提交清单 ${total} B 超过上限 ${budget.POSE_TOTAL_MAX_BYTES} B`);
  const margin = budget.POSE_TOTAL_MAX_BYTES - total;
  assert.ok(
    margin > 0,
    '余量必须 > 0：把上限设成比现状还小，会让**现有**姿态一键全红（等于烧掉已交付资产），' +
      `现状 ${total} B / 上限 ${budget.POSE_TOTAL_MAX_BYTES} B`,
  );
});

test('B-5 依据留痕：pet-budget.mjs 的注释必须同时出现 D-02 与 证伪', async () => {
  const source = fs.readFileSync(BUDGET_PATH, 'utf8');
  assert.match(source, /D-02/, '注释里必须写明 8 MiB 的来源是裁决 D-02（否则将来会被"清理"成一句空话）');
  assert.match(
    source,
    /证伪/,
    '注释里必须留下"切片后每片 ≤ 2 MiB 已被切片 2 的 5.15 MiB 实测证伪"这条事实——' +
      '它是 8 MiB 站得住的唯一理由',
  );
});
