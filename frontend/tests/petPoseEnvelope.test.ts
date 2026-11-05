/**
 * 视觉守卫 G-01 / G-04 / G-06 / G-07（纯 node，不依赖浏览器）。
 *
 * <p><b>四条守卫各守一个"看起来对但其实错"的失效方向：</b></p>
 * <ul>
 *   <li><b>G-01 单一可见源</b>：姿态层与既有的动作层/层栈必须<b>互斥</b>。失效后的画面
 *       是"两套身体叠在一起"（穿模），而代码层面完全看不出问题——所以判据落在
 *       <b>CSS 文本</b>上：`data-posture !== 'stand'` 必须精确匹配到两条 `display:none`。</li>
 *   <li><b>G-04 不破边</b>：包络必须落在窗口内。判据是<b>非对称</b>的（E-02）：
 *       `rel ∈ [−(Px)+SAFE, (W−Px)−SAFE]`，因为对齐点在窗口里<b>不居中</b>。
 *       用对称的 `±W/2` 会给出错误的乐观结论——这正是设计稿 49px 边距被否决的原因（D-01）。</li>
 *   <li><b>G-06 接地基线</b>：脚既不能离地也不能陷进桌面。判据用"绝对坐标比绝对坐标"，
 *       附录 E-01 的错公式（`Py` 用母版分母）会让偏差从 0.08 CSS 放大到 110 CSS。</li>
 *   <li><b>G-07 比例恒定（两段式）</b>：直立批的墨迹高度必须与站姿一致（没有被缩放），
 *       <b>且</b>非直立姿态必须显著更矮（不是把站姿压扁冒充）。单看前一半会让"坐下"
 *       和"站姿缩放"无法区分。</li>
 * </ul>
 *
 * <p><b>每条守卫都配一枚"必须红"的金丝雀</b>（见各用例名）：守卫能变绿不代表它在看东西，
 * 只有"注入坏数据它也变红"才证明它不是恒等式。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PET_GEOMETRY, windowSize } from '../src/pet/layout';
import { PET_POSES } from '../src/pet/poses/manifest';
import { parseCssRules, poseVisibilityProblems, matchPoseVisibility } from '../src/pet/poses/css-contract';
import {
  alignPointOf,
  expectedBaselineOf,
  groundBaselineOf,
  poseBoxOf,
} from '../src/pet/poses/placement';
import type { PoseBatch, PoseFrame } from '../src/pet/poses/types';
import { adaptAll } from '../scripts/pet-pose-adapters.mjs';
import { computeScale, envelopeOf } from '../scripts/build-pet-poses.mjs';
import { ENVELOPE_SAFE_PX, alignPointX, checkEnvelope } from '../scripts/check-pet-poses.mjs';
import { FRONTEND_ROOT } from '../scripts/build-pet-geometry.mjs';

/** 仓库根。 */
const REPO_ROOT = resolve(FRONTEND_ROOT, '..');

/** `pet.css` 的绝对路径（G-01 直接读产物，不读测试里的副本）。 */
const PET_CSS_PATH = resolve(FRONTEND_ROOT, 'src', 'pet', 'pet.css');

/** 站姿墨迹高度（CSS px；设计 §A1.9 的实测值，是 G-07 ⓵ 的基准）。 */
const STAND_INK_HEIGHT_CSS = 209.65;

/** G-07 ⓵ 的容差（±2%）。 */
const UPRIGHT_TOLERANCE_RATIO = 0.02;

/** G-07 ⓶ 的上界倍率（非直立姿态必须 ≤ 0.85 × 站姿 = 178.2 CSS）。 */
const NON_UPRIGHT_MAX_RATIO = 0.85;

/** G-06 的容差（CSS px）：2 native × nativeToCss ≈ 0.30，取 0.35。 */
const BASELINE_TOLERANCE_CSS = 0.35;

/** 全部登记批次的姿态 id（切片 1 只导出 sit，其余按 adapter 草稿测量）。 */
const ALL_POSTURES = ['sit', 'lie', 'sleep', 'walk', 'run', 'jump'] as const;

/** 一个批次的测量视图。 */
interface BatchUnderTest {
  /** 姿态 id。 */
  readonly posture: string;
  /** 批次（真实清单或 adapter 草稿）。 */
  readonly batch: PoseBatch;
  /** 包络（相对对齐点，CSS px）。 */
  readonly envelopeCss: { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };
}

/**
 * 取 6 批的测量视图：`sit` 用**入库清单**里的真值，其余用 adapter 草稿 + 同一套 `envelopeOf`。
 *
 * <p>为什么其余 5 批不读 `pet-poses.json`：切片 1 只导出 `sit`（`ACCEPTED_BATCHES`），
 * 那 5 批在清单里是 `deferred`。但 G-04/G-06/G-07 必须在<b>资产到齐之前</b>就能验，
 * 否则"D-01 到底够不够宽"只能等切片 2 才知道。包络用与构建脚本<b>同一个</b>
 * `envelopeOf` 计算，避免测试里出现第二套口径。</p>
 *
 * @returns 6 批的测量视图
 */
function batchesUnderTest(): BatchUnderTest[] {
  const geometry = JSON.parse(readFileSync(resolve(FRONTEND_ROOT, 'pet-geometry.json'), 'utf8')) as Record<string, unknown>;
  const scale = computeScale(geometry);
  const adapted = adaptAll({ repoRoot: REPO_ROOT, accepted: [...ALL_POSTURES] });
  assert.deepEqual(adapted.problems, [], `adapter 无法归一美术资产：\n${adapted.problems.join('\n')}`);
  const result: BatchUnderTest[] = [];
  for (const posture of ALL_POSTURES) {
    if (posture === 'sit') {
      const batch = PET_POSES.batches.sit;
      assert.ok(batch, '入库清单缺 sit 批次：先跑 npm run build:pet-poses');
      result.push({ posture, batch, envelopeCss: batch.envelopeCss });
      continue;
    }
    const draft = adapted.drafts[posture] as unknown as PoseBatch | undefined;
    assert.ok(draft, `adapter 草稿缺 ${posture}`);
    result.push({ posture, batch: draft, envelopeCss: envelopeOf(draft.frames, scale) });
  }
  return result;
}

/**
 * 造一份"注入不同窗口边距"的几何（只改特效边距，其余真值不动）。
 *
 * @param left 左边距（CSS px）
 * @param right 右边距（CSS px）
 * @returns 几何对象
 */
function geometryWithMargin(left: number, right: number): typeof PET_GEOMETRY {
  return { ...PET_GEOMETRY, effectMargin: { ...PET_GEOMETRY.effectMargin, left, right } };
}

/**
 * 取某批某帧（草稿与清单都支持的写法）。
 *
 * @param batch 批次
 * @param frameId 帧 id
 * @returns 帧
 */
function frameOf(batch: PoseBatch, frameId: string): PoseFrame {
  const frame = batch.frames[frameId];
  assert.ok(frame, `批次 ${batch.posture} 缺帧 ${frameId}`);
  return frame;
}

/**
 * 一帧的墨迹高度（CSS px）。
 *
 * @param frame 帧
 * @param nativeToCss native → CSS 比例
 * @returns 墨迹高度（CSS px）
 */
function inkHeightCss(frame: PoseFrame, nativeToCss: number): number {
  return (frame.inkNative.bottom - frame.inkNative.top) * nativeToCss;
}

test('G-01：pet.css 的互斥规则精确匹配（非站姿藏 .pet-action/.pet-layers，站姿藏 .pet-pose）', () => {
  const css = readFileSync(PET_CSS_PATH, 'utf8');
  const matched = matchPoseVisibility(css);

  assert.deepEqual(poseVisibilityProblems(css), [], 'pet.css 不满足姿态可见性契约');
  assert.deepEqual(matched.nonStandHides, ['pet-action', 'pet-layers'], '非站姿必须藏掉动作层与层栈');
  assert.deepEqual(matched.standHides, ['pet-pose'], '站姿必须藏掉姿态层');
  // 防空集通过：CSS 一旦改选择器前缀，上面两条会变成"比空数组与空数组"而误绿
  assert.ok(matched.rootPrefixedRules >= 1, '没有匹配到任何 #pet-root 前缀规则：G-01 在看空气');
  // 用 opacity 藏层是错误形态：既不可测也不可靠（层还在命中测试里）
  assert.deepEqual(matched.opacityHides, [], '姿态互斥必须用 display:none，不能用 opacity');
});

test('G-01 变异：删掉任一条互斥规则必红（三枚金丝雀）', () => {
  const css = readFileSync(PET_CSS_PATH, 'utf8');
  const rules = parseCssRules(css);
  assert.ok(rules.length > 0, 'pet.css 解析出 0 条规则');

  /**
   * 去掉满足条件的规则后重建 CSS。
   *
   * @param predicate 丢弃判据
   * @returns 重建后的 CSS
   */
  const rebuildWithout = (predicate: (selector: string, declarations: string) => boolean): string =>
    rules
      .filter((rule) => !predicate(rule.selector, rule.declarations))
      .map((rule) => `${rule.selector} { ${rule.declarations} }`)
      .join('\n');

  const dropAction = rebuildWithout(
    (selector, declarations) =>
      /:not\(\[data-posture\s*=\s*'stand'\]\)/.test(selector) && /\.pet-action\b/.test(selector) && /display\s*:\s*none/i.test(declarations),
  );
  assert.ok(dropAction.length < css.length, '变异没删掉任何规则：金丝雀失效');
  assert.ok(poseVisibilityProblems(dropAction).length > 0, '删掉「非站姿藏 .pet-action」后必须红');

  const dropLayers = rebuildWithout(
    (selector, declarations) =>
      /:not\(\[data-posture\s*=\s*'stand'\]\)/.test(selector) && /\.pet-layers\b/.test(selector) && /display\s*:\s*none/i.test(declarations),
  );
  assert.ok(poseVisibilityProblems(dropLayers).length > 0, '删掉「非站姿藏 .pet-layers」后必须红');

  const dropPose = rebuildWithout(
    (selector, declarations) =>
      /\[data-posture\s*=\s*'stand'\]/.test(selector) &&
      !/:not\(/.test(selector) &&
      /\.pet-pose\b/.test(selector) &&
      /display\s*:\s*none/i.test(declarations),
  );
  assert.ok(poseVisibilityProblems(dropPose).length > 0, '删掉「站姿藏 .pet-pose」后必须红');
});

test('G-04：sit 在 268×348 下不破边（E-02 非对称判据，逐值断言上下限）', () => {
  const size = windowSize(PET_GEOMETRY);
  assert.deepEqual(size, { width: 268, height: 348 }, 'D-01：窗口必须是 268×348');

  const px = alignPointX(PET_GEOMETRY, PET_POSES.align);
  const min = -px + ENVELOPE_SAFE_PX;
  const max = size.width - px - ENVELOPE_SAFE_PX;
  assert.equal(Number(px.toFixed(4)), 129.0793, `Px 必须是 56 + 156×(479.7/1024) = 129.0793，实际 ${px}`);
  assert.equal(Number(min.toFixed(4)), -127.0793);
  assert.equal(Number(max.toFixed(4)), 136.9207);

  const sit = PET_POSES.batches.sit;
  assert.ok(sit);
  assert.deepEqual(checkEnvelope(sit, PET_GEOMETRY, PET_POSES.align), [], 'sit 的包络越界了');
  assert.equal(Number(sit.envelopeCss.left.toFixed(2)), -56.21);
  assert.equal(Number(sit.envelopeCss.right.toFixed(2)), 67.72);
});

test('G-04：6 批全部落在 [−(Px)+SAFE, (W−Px)−SAFE]（向左的余量比向右紧）', () => {
  const size = windowSize(PET_GEOMETRY);
  const px = alignPointX(PET_GEOMETRY, PET_POSES.align);
  const rows: string[] = [];
  for (const item of batchesUnderTest()) {
    const problems = checkEnvelope({ posture: item.posture, envelopeCss: item.envelopeCss }, PET_GEOMETRY, PET_POSES.align);
    assert.deepEqual(problems, [], problems.join('\n'));
    rows.push(
      `${item.posture}: [${item.envelopeCss.left.toFixed(2)}, ${item.envelopeCss.right.toFixed(2)}]` +
        ` 余量 left=${(item.envelopeCss.left + px - ENVELOPE_SAFE_PX).toFixed(2)}` +
        ` right=${(size.width - px - ENVELOPE_SAFE_PX - item.envelopeCss.right).toFixed(2)}`,
    );
  }
  // 金丝雀：6 批都算出了包络（空集会让上面的循环恒过）
  assert.equal(rows.length, 6, rows.join(' | '));
});

test('G-04 金丝雀 ①：注入 196 窗宽（D-01 之前的配置）⇒ 除 sit 外 5 批全部必红', () => {
  const narrow = geometryWithMargin(20, 20);
  assert.equal(windowSize(narrow).width, 196, '注入的几何应还原成 196 宽');
  const results = new Map<string, number>();
  for (const item of batchesUnderTest()) {
    const problems = checkEnvelope({ posture: item.posture, envelopeCss: item.envelopeCss }, narrow, PET_POSES.align);
    results.set(item.posture, problems.length);
  }
  assert.equal(results.get('sit'), 0, '196 下 sit 仍然装得下（这就是切片 1 只发 sit 的原因）');
  for (const posture of ['walk', 'run', 'jump', 'lie', 'sleep']) {
    assert.ok((results.get(posture) ?? 0) > 0, `196 窗宽下 ${posture} 必须越界，判据却放它过了`);
  }
});

test('G-04 金丝雀 ②：注入设计稿的 49/254 ⇒ run 必红（D-01 改成 56/268 的直接证据）', () => {
  const design = geometryWithMargin(49, 49);
  assert.equal(windowSize(design).width, 254, '设计稿口径是 254 宽');
  const run = batchesUnderTest().find((item) => item.posture === 'run');
  assert.ok(run, '缺 run 批次');
  const problems = checkEnvelope({ posture: 'run', envelopeCss: run.envelopeCss }, design, PET_POSES.align);
  assert.ok(
    problems.length > 0,
    '按设计稿 49px 边距 run 居然装得下：说明 E-02 的余量算错了（实测左余量只剩 0.05 CSS px）',
  );
  // 而 56/268 刚好放它过去 ⇒ 不是"随便加宽"，是补足那 0.05px 的擦边
  assert.deepEqual(checkEnvelope({ posture: 'run', envelopeCss: run.envelopeCss }, geometryWithMargin(56, 56), PET_POSES.align), []);
});

test('G-04 金丝雀 ③：把 align.xNative 从 479.70 改成 400 ⇒ run 必红（Px 真的进了判据）', () => {
  const run = batchesUnderTest().find((item) => item.posture === 'run');
  assert.ok(run, '缺 run 批次');
  const shifted = { ...PET_POSES.align, xNative: 400 as typeof PET_POSES.align.xNative };
  const problems = checkEnvelope({ posture: 'run', envelopeCss: run.envelopeCss }, PET_GEOMETRY, shifted);
  assert.ok(problems.length > 0, '对齐点被挪了 12 CSS px，包络判据却毫无反应：Px 没进判据');
  assert.ok(
    problems.some((problem) => problem.includes('左侧越界')),
    `预期是左侧越界，实际：${problems.join(' | ')}`,
  );
});

test('G-06：驻留帧的接地基线 = Py ± 0.35（6 批逐帧）', () => {
  const scale = PET_POSES.scale;
  let checked = 0;
  for (const item of batchesUnderTest()) {
    for (const frame of Object.values(item.batch.frames)) {
      // lie 的 enter/exit 是"趴下/起身"过程帧，见下一条用例的例外留痕
      if (item.posture === 'lie' && frame.id !== 'lie_neutral') continue;
      const box = poseBoxOf(item.batch, frame, scale, PET_POSES.align);
      const actual = groundBaselineOf(item.batch, frame, box, scale);
      const expected = expectedBaselineOf(frame.airborneGapNative, scale, PET_POSES.align);
      assert.ok(
        Math.abs(actual - expected) <= BASELINE_TOLERANCE_CSS,
        `${item.posture}/${frame.id} 接地基线 ${actual.toFixed(3)} 与期望 ${expected.toFixed(3)} 差 ` +
          `${Math.abs(actual - expected).toFixed(3)} > ${BASELINE_TOLERANCE_CSS}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `只检查了 ${checked} 帧，样本太少（守卫会变成抽样碰运气）`);
});

test('G-06 例外留痕：lie 的趴下/起身过程帧偏差逐值记录（不做无声放行）', () => {
  const scale = PET_POSES.scale;
  const lie = batchesUnderTest().find((item) => item.posture === 'lie')?.batch;
  assert.ok(lie, '缺 lie 批次');
  /** 过程帧的实测偏差（CSS px）：美术未给这几帧声明 airborneGap，故偏差非 0。 */
  const expectedDeviations: Record<string, number> = {
    lie_down_01_neutral: -1.904,
    lie_down_02_neutral: 2.514,
    lie_up_02_neutral: 2.514,
    lie_up_03_neutral: -1.904,
  };
  for (const [frameId, want] of Object.entries(expectedDeviations)) {
    const frame = frameOf(lie, frameId);
    const box = poseBoxOf(lie, frame, scale, PET_POSES.align);
    const actual = groundBaselineOf(lie, frame, box, scale);
    const baseline = expectedBaselineOf(frame.airborneGapNative, scale, PET_POSES.align);
    const deviation = Number((actual - baseline).toFixed(3));
    assert.equal(deviation, want, `${frameId} 的过程帧偏差变了（美术改动？）请重新取证并更新本表`);
    // 有界：过程帧的偏差不许无限大（真接错域会是 ~200 CSS 量级）
    assert.ok(Math.abs(deviation) <= 3, `${frameId} 偏差 ${deviation} 超出过程帧的合理量级`);
  }
});

test('G-07 ⓵：直立步态批的支撑帧墨迹高度 = 209.65 ± 2%（没有被缩放）', () => {
  const nativeToCss = PET_POSES.scale.nativeToCss;
  const low = STAND_INK_HEIGHT_CSS * (1 - UPRIGHT_TOLERANCE_RATIO);
  const high = STAND_INK_HEIGHT_CSS * (1 + UPRIGHT_TOLERANCE_RATIO);
  assert.equal(Number(low.toFixed(3)), 205.457);
  assert.equal(Number(high.toFixed(3)), 213.843);

  const batches = batchesUnderTest();
  const samples: Array<{ label: string; height: number }> = [];
  const walk = batches.find((item) => item.posture === 'walk')?.batch;
  const run = batches.find((item) => item.posture === 'run')?.batch;
  const jump = batches.find((item) => item.posture === 'jump')?.batch;
  assert.ok(walk && run && jump, '缺 walk / run / jump 批次');

  // walk：8 帧全部是支撑帧
  for (const frame of Object.values(walk.frames)) {
    samples.push({ label: `walk/${frame.id}`, height: inkHeightCss(frame, nativeToCss) });
  }
  // run：只有 gap === 0 的帧是支撑帧（l4/r4 是腾空相，见 G-14）
  for (const frame of Object.values(run.frames)) {
    if ((frame.airborneGapNative ?? 0) !== 0) continue;
    samples.push({ label: `run/${frame.id}`, height: inkHeightCss(frame, nativeToCss) });
  }
  // jump：设计 §A1.9 点名的左向 anticipate / land
  for (const frameId of ['anticipate', 'land']) {
    const frame = frameOf(jump, frameId);
    samples.push({ label: `jump/${frame.id}`, height: inkHeightCss(frame, nativeToCss) });
  }

  assert.ok(samples.length >= 10, `样本只有 ${samples.length} 个`);
  for (const sample of samples) {
    assert.ok(
      sample.height >= low && sample.height <= high,
      `${sample.label} 墨迹高度 ${sample.height.toFixed(2)} 不在 [${low.toFixed(2)}, ${high.toFixed(2)}]：` +
        '比例变了（有人把 pose 缩放过）或被换成了别的姿态',
    );
  }
});

test('G-07 ⓵ 金丝雀：jump/apex（gap=170）属于腾空例外，不被 ⓵ 误判', () => {
  const nativeToCss = PET_POSES.scale.nativeToCss;
  const jump = batchesUnderTest().find((item) => item.posture === 'jump')?.batch;
  assert.ok(jump, '缺 jump 批次');
  const apex = frameOf(jump, 'apex');
  const height = inkHeightCss(apex, nativeToCss);
  assert.equal(Number(height.toFixed(2)), 192.41, 'apex 的墨迹高度变了（美术改动？）');
  // apex 一定在 ⓵ 的带外（192.41 < 205.46），所以它必须靠"腾空例外"被排除而不是靠阈值放宽
  assert.ok(height < STAND_INK_HEIGHT_CSS * (1 - UPRIGHT_TOLERANCE_RATIO), 'apex 居然落在 ⓵ 的带内');
  assert.ok((apex.airborneGapNative ?? 0) > 0, 'apex 必须有腾空量，否则 ⓵ 无法区分"腾空"与"被缩小"');
});

test('G-07 ⓵ 右向留痕：jump 右向落帧 201.86（冲击压扁）不在 2% 带内，逐值记录', () => {
  const nativeToCss = PET_POSES.scale.nativeToCss;
  const jump = batchesUnderTest().find((item) => item.posture === 'jump')?.batch;
  assert.ok(jump, '缺 jump 批次');
  const expected: Record<string, number> = {
    r_anticipate: 206.58,
    r_ascend: 193.63,
    r_apex: 185.55,
    r_descend: 207.64,
    r_land: 201.86,
  };
  for (const [frameId, want] of Object.entries(expected)) {
    const frame = frameOf(jump, frameId);
    assert.equal(frame.facing, 1, `${frameId} 的朝向应为右`);
    assert.equal(Number(inkHeightCss(frame, nativeToCss).toFixed(2)), want, `${frameId} 的墨迹高度变了（美术改动？）`);
  }
  // 右向落帧比左向矮 8.23 CSS：这不是缩放，是落地的冲击压扁（左 210.08 / 右 201.86）
  const leftLand = inkHeightCss(frameOf(jump, 'land'), nativeToCss);
  const rightLand = inkHeightCss(frameOf(jump, 'r_land'), nativeToCss);
  assert.equal(Number((leftLand - rightLand).toFixed(2)), 8.23);
});

test('G-07 ⓶：非直立姿态必须显著更矮（≤ 0.85 × 站姿 = 178.2），不是站姿压扁冒充', () => {
  const nativeToCss = PET_POSES.scale.nativeToCss;
  const limit = STAND_INK_HEIGHT_CSS * NON_UPRIGHT_MAX_RATIO;
  assert.equal(Number(limit.toFixed(1)), 178.2);

  const batches = batchesUnderTest();
  const samples: Array<{ label: string; height: number }> = [];
  const sit = batches.find((item) => item.posture === 'sit')?.batch;
  const lie = batches.find((item) => item.posture === 'lie')?.batch;
  const sleep = batches.find((item) => item.posture === 'sleep')?.batch;
  assert.ok(sit && lie && sleep, '缺 sit / lie / sleep 批次');
  samples.push({ label: 'sit/hold', height: inkHeightCss(frameOf(sit, 'sit_neutral'), nativeToCss) });
  samples.push({ label: 'lie/hold', height: inkHeightCss(frameOf(lie, 'lie_neutral'), nativeToCss) });
  samples.push({ label: 'sleep/neutral', height: inkHeightCss(frameOf(sleep, 'neutral'), nativeToCss) });

  // 逐值记录（设计 §A1.9 的实测值），任何美术改动都会在这里显形
  assert.equal(Number(samples[0].height.toFixed(2)), 164.46);
  assert.equal(Number(samples[1].height.toFixed(2)), 125.3);
  assert.equal(Number(samples[2].height.toFixed(2)), 125.23);
  for (const sample of samples) {
    assert.ok(sample.height <= limit, `${sample.label} 高 ${sample.height.toFixed(2)} > ${limit.toFixed(1)}：可能是站姿缩放冒充姿态`);
  }
  // 两段式：非直立样本必须落在 ⓵ 的带外，否则两段判据会互相抵消
  const uprightLow = STAND_INK_HEIGHT_CSS * (1 - UPRIGHT_TOLERANCE_RATIO);
  for (const sample of samples) {
    assert.ok(sample.height < uprightLow, `${sample.label} 落在直立带内：两段判据互相抵消了`);
  }
});

test('G-07 变异：把 masterToCss 改成 234/2048 ⇒ ⓵ 必红（阈值不是随便能过的）', () => {
  const jump = batchesUnderTest().find((item) => item.posture === 'jump')?.batch;
  assert.ok(jump, '缺 jump 批次');
  const frame = frameOf(jump, 'anticipate');
  const correct = inkHeightCss(frame, PET_POSES.scale.nativeToCss);
  assert.ok(Math.abs(correct - STAND_INK_HEIGHT_CSS) / STAND_INK_HEIGHT_CSS <= UPRIGHT_TOLERANCE_RATIO);

  // 变异：比例被换成"压平成 234×234"的口径（nativeToCss 从 0.15234375 变 0.11425781…）
  const wrongNativeToCss = (PET_GEOMETRY.artHeight / PET_GEOMETRY.canvasWidth) * 2;
  const wrong = inkHeightCss(frame, wrongNativeToCss);
  assert.ok(
    Math.abs(wrong - STAND_INK_HEIGHT_CSS) / STAND_INK_HEIGHT_CSS > UPRIGHT_TOLERANCE_RATIO,
    '比例跳变后 ⓵ 仍然通过：G-07 抓不住缩放',
  );
});
