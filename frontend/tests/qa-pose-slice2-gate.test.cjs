/**
 * QA 对抗测试（切片 2）· 门禁层：G-P7 / G-P8 能不能被绕过。
 *
 * <p>运行方式（`.mjs` 用动态 `import()` 载入，普通 node 也能跑；本仓统一用 tsx 跑同一批）：</p>
 * <pre>npx tsx --test tests/qa-pose-slice2-gate.test.cjs</pre>
 *
 * <p><b>只读纪律：</b>所有变异只写 `.lingxi/tmp/qa-slice2-poses-*.json` 临时拷贝，
 * `runPoseGate({ posesJsonPath })` 指向拷贝；仓库里的 `pet-poses.json` 一个字节都不动
 * （`build --check` 只比对不写盘，见 `build-pet-poses.mjs:619`）。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const FRONTEND = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(FRONTEND, '..');
const TMP = path.join(REPO_ROOT, '.lingxi', 'tmp');
const POSES_PATH = path.join(FRONTEND, 'pet-poses.json');

/** 门禁模块（`check-pet-poses.mjs` 有顶层 await，只能用动态 import）。 */
let gatePromise = null;

/**
 * 载入门禁模块（只载一次）。
 *
 * @returns {Promise<object>} 门禁模块
 */
function gate() {
  if (gatePromise === null) {
    gatePromise = import(pathToFileURL(path.join(FRONTEND, 'scripts/check-pet-poses.mjs')).href);
  }
  return gatePromise;
}

/**
 * 读真清单。
 *
 * @returns {Record<string, any>} 原始清单
 */
function rawPoses() {
  return JSON.parse(fs.readFileSync(POSES_PATH, 'utf8'));
}

/**
 * 造一份变异清单并落盘到 `.lingxi/tmp`（返回路径）。
 *
 * @param {string} label 文件名标签（必须带 `qa-slice2-` 前缀，收尾只删自己的）
 * @param {(draft: Record<string, any>) => void} mutate 改动函数
 * @returns {string} 临时清单路径
 */
function writeVariant(label, mutate) {
  const draft = rawPoses();
  mutate(draft);
  const file = path.join(TMP, `${label}.json`);
  fs.writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  return file;
}

test('G-1 基线自证：真清单在 G-P7 与 G-P8 上都是零问题（否则后面的红说明不了任何事）', async () => {
  const { checkAcceptedAnchorSource, checkFrameEncoding } = await gate();
  const raw = rawPoses();
  assert.deepEqual(checkAcceptedAnchorSource(raw), [], '真清单不许有 G-P7 问题');
  for (const posture of Object.keys(raw.batches)) {
    assert.deepEqual(checkFrameEncoding(raw.batches[posture]), [], `${posture} 不许有 G-P8 问题`);
  }
});

test('G-2 对照：mirror-derived 一旦出现，G-P7 确实会红（判据不是恒空）', async () => {
  const { checkAcceptedAnchorSource } = await gate();
  const raw = rawPoses();
  raw.batches.walk.bodyAnchor.byFacingSource = 'mirror-derived';
  const problems = checkAcceptedAnchorSource(raw);
  assert.equal(problems.length, 1, `应恰好一条，实际 ${JSON.stringify(problems)}`);
  assert.match(problems[0], /walk/);
  assert.match(problems[0], /mirror-derived/);
  assert.match(problems[0], /G-P7/);
});

test('G-3 【缺口 G-3】把镜像值手抄进 byFacing 就洗成 measured-per-facing：G-P7 完全无感', async () => {
  const { checkAcceptedAnchorSource } = await gate();
  // run 的真实锚点本来就是精确镜像（x_右 = 1536 − x_左，y 相同），所以"洗白"后数值与镜像推导**逐位相同**。
  const cleaned = rawPoses();
  const run = cleaned.batches.run;
  const left = run.bodyAnchor.byFacing['-1'];
  const width = run.nativeCanvas.width;
  assert.equal(run.bodyAnchor.byFacingSource, 'measured-per-facing', '前置：run 当前声明为实测');
  const mirroredRight = { x: width - left.x, y: left.y };
  assert.deepEqual(run.bodyAnchor.byFacing['1'], mirroredRight, '前置：真实右向锚点与镜像公式逐值相同（这条本身就是发现）');

  // 模拟"某个偷懒的流程把镜像值手写进 byFacing"：数值不变，只是这条路径不再经过 adapter 的 derived 标记
  run.bodyAnchor.byFacing['1'] = { x: width - left.x, y: left.y };
  assert.deepEqual(checkAcceptedAnchorSource(cleaned), [], 'G-P7 只看自报字符串 ⇒ 洗白后零问题');

  // 数值侧证据：镜像公式残差为 0，说明"实测"与"镜像"在这批数据上不可区分
  const residualX = Math.abs(run.bodyAnchor.byFacing['1'].x - (width - run.bodyAnchor.byFacing['-1'].x));
  const residualY = Math.abs(run.bodyAnchor.byFacing['1'].y - run.bodyAnchor.byFacing['-1'].y);
  assert.equal(residualX, 0);
  assert.equal(residualY, 0);
  // ⇒ 建议（不自己改）：G-P7 之外再加一条"若左右锚点恰为镜像公式（残差 0）却声明 measured-per-facing，
  //   要求带实测证据（spreadNative + 逐帧 anchorNative 的左右差异）"；否则唯一守卫就是那个自报字符串。
});

test('G-4 【缺口 G-4】bodyAnchor 整体缺失时 G-P7 静默跳过，但运行期加载会硬失败', async () => {
  const { checkAcceptedAnchorSource } = await gate();
  const raw = rawPoses();
  delete raw.batches.sit.bodyAnchor;
  assert.deepEqual(checkAcceptedAnchorSource(raw), [], 'G-P7 对"没有 bodyAnchor"直接 continue ⇒ 静默');

  // 运行期兜底：加载器连 bodyAnchor 缺失都不接受
  const { normalizePetPoses } = require(path.join(FRONTEND, 'src/pet/poses/manifest.ts'));
  assert.throws(() => normalizePetPoses(raw), /bodyAnchor/);
});

test('G-5 G-P8 四种绕过实测：只有"files 整个缺失"能过（format 大写/缺失/单档 都会被拦）', async () => {
  const { checkFrameEncoding } = await gate();
  const raw = rawPoses();
  const build = () => JSON.parse(JSON.stringify(raw.batches.walk));
  const firstFrame = (batch) => Object.keys(batch.frames)[0];

  const missingFormat = build();
  delete missingFormat.frames[firstFrame(missingFormat)].files['2x'].format;
  assert.equal(checkFrameEncoding(missingFormat).length, 1, 'format 缺失必须红');

  const upper = build();
  upper.frames[firstFrame(upper)].files['1x'].format = 'WEBP-LOSSLESS';
  assert.equal(checkFrameEncoding(upper).length, 1, '大写变体必须红（严格 === 比较）');

  const oneDensity = build();
  delete oneDensity.frames[firstFrame(oneDensity)].files['2x'];
  assert.equal(checkFrameEncoding(oneDensity).length, 1, '只声明一档密度必须红');

  const noFiles = build();
  delete noFiles.frames[firstFrame(noFiles)].files;
  assert.deepEqual(checkFrameEncoding(noFiles), [], '【漏检】files 整个缺失 ⇒ G-P8 直接 continue，一条都不报');

  const arrayFiles = build();
  arrayFiles.frames[firstFrame(arrayFiles)].files = [];
  assert.notEqual(checkFrameEncoding(arrayFiles).length, 0, 'files 是数组（typeof object）也必须被挡');
});

test('G-6 G-P8 的"files 缺失"漏检被 checkVolume 兜住：整门禁不会放过', async () => {
  const { checkVolume, checkFrameEncoding } = await gate();
  const raw = rawPoses();
  const batch = raw.batches.walk;
  delete batch.frames[Object.keys(batch.frames)[0]].files;
  assert.deepEqual(checkFrameEncoding(batch), [], '前置：G-P8 自己确实放行');
  const volume = checkVolume({ batches: { walk: batch }, totals: raw.totals });
  assert.ok(volume.some((line) => /缺少 @2x 文件信息/.test(line)), `checkVolume 必须报缺文件，实际：${JSON.stringify(volume)}`);
});

test('G-7 整门禁（真变异）：walk 改 mirror-derived ⇒ runPoseGate 红且报 G-P7', async () => {
  const { runPoseGate } = await gate();
  const file = writeVariant('qa-slice2-poses-mirror', (draft) => {
    draft.batches.walk.bodyAnchor.byFacingSource = 'mirror-derived';
  });
  const result = await runPoseGate({ posesJsonPath: file });
  assert.equal(result.ok, false, '镜像推导的 accepted 批次必须让门禁红');
  assert.ok(
    result.problems.some((line) => /G-P7/.test(line)),
    `problems 里必须出现 G-P7 那一行：${JSON.stringify(result.problems.slice(0, 5))}`,
  );
});

test('G-11 accepted 名字与批次键不一致（幻影姿态 / 键名拼错）时 G-P7 静默，但加载期硬失败', async () => {
  const { checkAcceptedAnchorSource } = await gate();
  const raw = rawPoses();

  // (a) accepted 里多了一个没有批次的姿态
  const phantom = JSON.parse(JSON.stringify(raw));
  phantom.accepted = [...phantom.accepted, 'lie'];
  assert.deepEqual(checkAcceptedAnchorSource(phantom), [], 'G-P7 对"accepted 有、batches 没有"直接跳过（静默）');

  // (b) 批次键拼错（walk → walk2，但 posture 字段仍是 walk）
  const renamed = JSON.parse(JSON.stringify(raw));
  renamed.batches.walk2 = { ...renamed.batches.walk, bodyAnchor: { ...renamed.batches.walk.bodyAnchor, byFacingSource: 'mirror-derived' } };
  delete renamed.batches.walk;
  const problems = checkAcceptedAnchorSource(renamed);
  assert.equal(problems.length, 1, 'G-P7 遍历的是"accepted ∪ 全部批次"，改键名也在射程内');
  assert.match(problems[0], /walk2/);

  // 两种形态在运行期都被加载器硬拦 ⇒ 不必靠 G-P7
  const { normalizePetPoses } = require(path.join(FRONTEND, 'src/pet/poses/manifest.ts'));
  assert.throws(() => normalizePetPoses(phantom), /accepted/);
  assert.throws(() => normalizePetPoses(renamed), /未知姿态键/);
});

test('G-9 G-P8 有字节级兜底：build --check 会读盘上 RIFF/VP8L 签名与清单 format 比对', () => {
  const build = fs.readFileSync(path.join(FRONTEND, 'scripts/build-pet-poses.mjs'), 'utf8');
  assert.match(build, /export function webpFormatOf\(/, 'webpFormatOf 是"从字节判编码"的唯一实现');
  assert.match(build, /VP8L/, '必须真读 RIFF 子块标签（VP8L = 无损，VP8 = 有损）');
  assert.match(
    build,
    /format !== file\.format/,
    'build --check 必须把"盘上真实编码"与清单声明的 format 逐帧比对（这条是 G-P8 的字节级兜底）',
  );
  // 装机实验（本报告 §2 记录，未写进用例：它会改盘上 webp 字节）：
  // 把 walk/l1@1x.webp 的 'VP8L' 改成 'VP8 '（长度不变）后 `node scripts/build-pet-poses.mjs --check`
  // ⇒ exit 1，报 "[walk] l1@1x 编码格式 webp ≠ 清单 webp-lossless"；还原后 exit 0、4 批 / 31 帧 / 5269 KiB。
});

test('G-10 G-P7 的判据是"按行为读清单"，不依赖批次名硬编码', () => {
  const gateSource = fs.readFileSync(path.join(FRONTEND, 'scripts/check-pet-poses.mjs'), 'utf8');
  const start = gateSource.indexOf('export function checkAcceptedAnchorSource(');
  assert.notEqual(start, -1);
  const body = gateSource.slice(start, start + 1200);
  for (const posture of ['sit', 'walk', 'run', 'jump', 'lie']) {
    assert.equal(
      new RegExp(`['"]${posture}['"]`).test(body),
      false,
      `G-P7 的判据体里不许出现批次名字面量 ${posture}（名字表迟早与真数据漂移）`,
    );
  }
  assert.match(body, /manifest\.accepted/, '必须读 accepted[]');
  assert.match(body, /byFacingSource/, '必须读 bodyAnchor.byFacingSource');
});

test('G-8 整门禁（洗白）：G-P7 静默之后，兜住它的是漂移比对（而不是 G-P7 自己）', async () => {
  const { runPoseGate, checkAcceptedAnchorSource } = await gate();

  // (a) 数值与原文件等价的"洗白"：把右向锚点写成镜像公式的结果。
  //     真实数据本来就是精确镜像，所以这份"洗白"产物与原文件**逐字节等价** ⇒ 门禁当然绿。
  //     这正是"美术手抄镜像值"会产生的产物形态：没有任何数值漂移可供发现。
  const equivalent = writeVariant('qa-slice2-poses-laundered', (draft) => {
    const run = draft.batches.run;
    run.bodyAnchor.byFacing['1'] = {
      x: run.nativeCanvas.width - run.bodyAnchor.byFacing['-1'].x,
      y: run.bodyAnchor.byFacing['-1'].y,
    };
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(equivalent, 'utf8')).batches.run,
    rawPoses().batches.run,
    '前置：这份"洗白"与原数据逐值相同（说明真实数据本身就对镜像不变）',
  );
  assert.deepEqual(checkAcceptedAnchorSource(JSON.parse(fs.readFileSync(equivalent, 'utf8'))), [], 'G-P7 静默');

  // (b) 洗白 + 数值与真源不同（造一对新的镜像锚点 640/896）⇒ 整门禁红，
  //     但红的原因是**漂移比对**（pet-poses.json 与美术真源不一致），G-P7 那条判据依然沉默。
  const drifted = writeVariant('qa-slice2-poses-laundered-drift', (draft) => {
    const run = draft.batches.run;
    run.bodyAnchor.byFacing['-1'] = { x: 640, y: 1454 };
    run.bodyAnchor.byFacing['1'] = { x: run.nativeCanvas.width - 640, y: 1454 };
  });
  const manifest = JSON.parse(fs.readFileSync(drifted, 'utf8'));
  assert.deepEqual(checkAcceptedAnchorSource(manifest), [], 'G-P7 仍然静默（它只看 byFacingSource 字符串）');

  const result = await runPoseGate({ posesJsonPath: drifted });
  assert.deepEqual(result.problems.filter((line) => /G-P7/.test(line)), [], 'G-P7 一条都不报');
  assert.equal(result.ok, false, `整门禁必须红（靠漂移比对），实际 problems：${JSON.stringify(result.problems.slice(0, 4))}`);
  assert.ok(
    result.problems.some((line) => /漂移|不一致|manifest/.test(line)),
    `红的必须是"与美术真源不一致"这一类，实际：${JSON.stringify(result.problems.slice(0, 4))}`,
  );
});
