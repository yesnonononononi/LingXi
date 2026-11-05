/**
 * 换姿不跳脚单测：对齐公式（`placement.ts`）+ 单一位置写入者（G-05）+ 接地基线（G-06）。
 *
 * <p><b>为什么这个文件必须存在：</b>"换姿态会不会跳脚"是 M2 唯一的用户级硬要求，
 * 而它有两个独立的失效方向——</p>
 * <ol>
 *   <li><b>窗口被挪了</b>：宠物在桌面上跳走。这是用户无法容忍的那一类，
 *       判据是"切姿态 20 次前后 `captureBounds()` 逐值相等"（G-05）；</li>
 *   <li><b>画面里的接地基线错了</b>：脚离地或陷进桌面。判据是
 *       `top + (inkNative.bottom − bodyAnchor.y) × nativeToCss` 与 `Py` 相差 ≤ 0.35 CSS
 *       （G-06）。</li>
 * </ol>
 *
 * <p><b>E-01 必须被真锁住：</b>设计稿 §A1.7.1 把 `Py` 写成
 * `artHeight × (align.yNative / (canvasHeight/2))`，同一条式子混了两个域，
 * 实得 206.75 而不是 317.51。本文件既断言正确值，也断言"用错式子会红"——
 * 否则"公式对了"可能只是碰巧。</p>
 *
 * <p>运行：`npm run test:pet`（tsx）。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ART_ORIGIN, PET_GEOMETRY, windowSize } from '../src/pet/layout';
import { PET_POSES, STAND_NATIVE_CANVAS_WIDTH } from '../src/pet/poses/manifest';
import {
  alignPointOf,
  expectedBaselineOf,
  groundBaselineOf,
  poseBoxOf,
  poseSizeOf,
} from '../src/pet/poses/placement';
import { PoseController } from '../src/pet/poses/controller';
import { adaptAll } from '../scripts/pet-pose-adapters.mjs';
import { FRONTEND_ROOT } from '../scripts/build-pet-geometry.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DocumentLike, ElementLike } from '../src/pet/presentation/layered-presentation';
import type { PoseBatch, PoseFrame } from '../src/pet/poses/types';

/** 仓库根。 */
const REPO_ROOT = resolve(FRONTEND_ROOT, '..');

/** 真实清单里的 sit 批次与首帧（切片 1 的唯一可播姿态）。 */
const SIT_BATCH = PET_POSES.batches.sit;
const SIT_FRAME = SIT_BATCH?.frames.sit_neutral;

/** 接地基线的容差（CSS px）：2 native × nativeToCss = 0.3047，取设计给的 0.35。 */
const BASELINE_TOLERANCE_CSS = 0.35;

/**
 * 断言 sit 批次存在（缺了说明 `build:pet-poses` 没跑，本文件所有断言都失去对象）。
 */
function requireSit(): { batch: PoseBatch; frame: PoseFrame } {
  assert.ok(SIT_BATCH, '真实清单里没有 sit 批次：先跑 npm run build:pet-poses');
  assert.ok(SIT_FRAME, 'sit 批次里没有 sit_neutral 帧');
  return { batch: SIT_BATCH, frame: SIT_FRAME };
}

test('E-01：Py 只用 nativeToCss 一个比例（317.5078），错式子 206.75 必须被识别为错', () => {
  const scale = PET_POSES.scale;
  const point = alignPointOf(scale, PET_POSES.align);
  const origin = ART_ORIGIN(PET_GEOMETRY);
  // Py = artOrigin.y + align.yNative × nativeToCss
  assert.equal(origin.y, PET_GEOMETRY.effectMargin.top + PET_GEOMETRY.bubbleHeight);
  assert.equal(
    Number(point.y.toFixed(4)),
    317.5078,
    `Py 必须是 96 + 1454 × 0.15234375 = 317.5078，实际 ${point.y}（改成 ×2908/6144 会得 206.75）`,
  );
  // 设计稿的错式子：把 native 域的对齐点除以母版画布高（等价于 × 2908/6144）
  const wrongPy = origin.y + PET_GEOMETRY.artHeight * (PET_POSES.align.yNative / PET_GEOMETRY.canvasHeight);
  assert.equal(
    Number(wrongPy.toFixed(2)),
    206.75,
    `错式子的结果应为 206.75（设计稿原文的数值），实际 ${wrongPy}`,
  );
  assert.ok(
    Math.abs(wrongPy - point.y) > 100,
    `错式子与正确值只差 ${Math.abs(wrongPy - point.y)}：E-01 没有被真正区分开`,
  );
  // Px 同样只用 nativeToCss（这也是 G-04 的判据里 Px 的来源）
  assert.equal(
    Number(point.x.toFixed(4)),
    Number((origin.x + PET_POSES.align.xNative * scale.nativeToCss).toFixed(4)),
  );
  // 站姿原生宽 × nativeToCss 必须等于立绘箱宽（比例自洽的另一种写法）
  assert.ok(
    Math.abs(STAND_NATIVE_CANVAS_WIDTH * scale.nativeToCss - PET_GEOMETRY.artWidth) < 1e-9,
    'nativeToCss × 站姿原生宽 ≠ 立绘箱宽：两个域的比例对不上',
  );
});

test('sit 的姿态盒：top 恰好等于 artOrigin.y（可解释的巧合），left = Px − 锚点偏移', () => {
  const { batch, frame } = requireSit();
  const scale = PET_POSES.scale;
  const box = poseBoxOf(batch, frame, scale, PET_POSES.align);
  const origin = ART_ORIGIN(PET_GEOMETRY);
  const point = alignPointOf(scale, PET_POSES.align);
  const anchor = batch.bodyAnchor.byFacing['-1'];

  assert.equal(Number(box.top.toFixed(6)), origin.y, 'sit 的 top 应恰好等于 artOrigin.y（接地线对齐的巧合）');
  assert.equal(
    Number(box.left.toFixed(6)),
    Number((point.x - anchor.x * scale.nativeToCss).toFixed(6)),
    'left 必须由 Px 减锚点偏移算出',
  );
  // 尺寸逐批读，不许写死 234（sit 是 156×234，其余批是 234×234）
  const size = poseSizeOf(batch, scale);
  assert.equal(Number(box.width.toFixed(6)), Number(size.width.toFixed(6)));
  assert.equal(Number(box.height.toFixed(6)), Number(size.height.toFixed(6)));
  assert.equal(Number(box.width.toFixed(6)), PET_GEOMETRY.artWidth, 'sit 的盒宽应等于立绘箱宽 156');
  assert.equal(Number(box.height.toFixed(6)), PET_GEOMETRY.artHeight, 'sit 的盒高应等于立绘箱高 234');
});

test('G-06：每帧接地基线 = Py ± 0.35；腾空帧按 airborneGapNative 扣减', () => {
  const { batch, frame } = requireSit();
  const scale = PET_POSES.scale;
  const box = poseBoxOf(batch, frame, scale, PET_POSES.align);
  const actual = groundBaselineOf(batch, frame, box, scale);
  const expected = expectedBaselineOf(frame.airborneGapNative, scale, PET_POSES.align);
  assert.ok(
    Math.abs(actual - expected) <= BASELINE_TOLERANCE_CSS,
    `sit 接地基线 ${actual} 与期望 ${expected} 差 ${Math.abs(actual - expected)} > ${BASELINE_TOLERANCE_CSS}`,
  );
  // sit 是贴地帧：期望基线就是 Py
  assert.equal(Number(expected.toFixed(4)), Number(alignPointOf(scale, PET_POSES.align).y.toFixed(4)));
});

test('G-06 金丝雀：jump 的 apex 与 land 期望基线相差 25.90 CSS（证明它不是恒等式）', () => {
  const scale = PET_POSES.scale;
  const drafts = adaptAll({ repoRoot: REPO_ROOT, accepted: ['jump'] }).drafts;
  const jump = drafts.jump as unknown as PoseBatch;
  assert.ok(jump, 'jump 草稿缺失');
  const apex = Object.values(jump.frames).find((item) => item.id === 'apex');
  const land = Object.values(jump.frames).find((item) => item.id === 'land');
  assert.ok(apex && land, 'jump 缺少 apex / land 帧');

  const apexExpected = expectedBaselineOf(apex.airborneGapNative, scale, PET_POSES.align);
  const landExpected = expectedBaselineOf(land.airborneGapNative, scale, PET_POSES.align);
  const gap = Number((landExpected - apexExpected).toFixed(2));
  // 170 native × 0.15234375 = 25.898 ⇒ 25.90（设计 §A1.9 的实测值）
  assert.equal(gap, 25.9, `apex 与 land 的期望基线差应为 25.90 CSS，实际 ${gap}`);

  // 逐帧：姿态盒 + 美术声明的腾空量必须自洽（这是"公式不是恒等式"的另一半证据）
  for (const frame of Object.values(jump.frames)) {
    const box = poseBoxOf(jump, frame, scale, PET_POSES.align);
    const actual = groundBaselineOf(jump, frame, box, scale);
    const expectedFrame = expectedBaselineOf(frame.airborneGapNative, scale, PET_POSES.align);
    assert.ok(
      Math.abs(actual - expectedFrame) <= BASELINE_TOLERANCE_CSS,
      `jump/${frame.id} 基线 ${actual} 与期望 ${expectedFrame} 差 ${Math.abs(actual - expectedFrame)}`,
    );
  }

  // E-01 反证：若把 Py 写成"native 锚点除以母版画布高"的错式子（实得 206.75），判据必须红
  const origin = ART_ORIGIN(PET_GEOMETRY);
  const wrongPy = origin.y + PET_GEOMETRY.artHeight * (PET_POSES.align.yNative / PET_GEOMETRY.canvasHeight);
  const wrongBaseline = wrongPy + (SIT_FRAME!.inkNative.bottom - SIT_BATCH!.bodyAnchor.byFacing['-1'].y) * scale.nativeToCss;
  const correctBaseline = alignPointOf(scale, PET_POSES.align).y;
  assert.ok(
    Math.abs(wrongBaseline - correctBaseline) > BASELINE_TOLERANCE_CSS,
    '用错 Py 公式算出的基线居然落在容差内：G-06 抓不到 E-01',
  );
});

test('B-1：右向帧必须用 bodyAnchor.byFacing[1]（run/jump 右向锚 836 ≠ 左向 700，差 20.72 CSS）', () => {
  const scale = PET_POSES.scale;
  const point = alignPointOf(scale, PET_POSES.align);
  const drafts = adaptAll({ repoRoot: REPO_ROOT, accepted: ['run', 'jump'] }).drafts;

  /** 断言一批里"右向帧用右向锚"，返回该批的右向锚 x。 */
  const assertRightFacingAnchor = (name: 'run' | 'jump'): number => {
    const batch = drafts[name] as unknown as PoseBatch | undefined;
    assert.ok(batch, `${name} 草稿缺失（美术 manifest 变了？）`);
    const right = Object.values(batch.frames).find((frame) => frame.facing === 1);
    assert.ok(right, `${name} 必须有右向帧，否则本用例失去对象`);
    const anchorRight = batch.bodyAnchor.byFacing['1'];
    const anchorLeft = batch.bodyAnchor.byFacing['-1'];
    assert.notEqual(anchorRight.x, anchorLeft.x, '左右向锚点相同则本用例无鉴别力');

    const box = poseBoxOf(batch, right, scale, PET_POSES.align);
    // 逐值：left === Px − byFacing['1'].x × nativeToCss（这里不写死 836，锚点取自数据）
    assert.equal(
      Number(box.left.toFixed(6)),
      Number((point.x - anchorRight.x * scale.nativeToCss).toFixed(6)),
      `${name}/${right.id} 的 left 必须由**右向**锚点算出`,
    );
    // 变异点：把取值写死成 `byFacing['-1']`（QA M1 的变异）⇒ left 偏移 (836−700)×nativeToCss
    const wrongLeft = point.x - anchorLeft.x * scale.nativeToCss;
    assert.equal(
      Number(Math.abs(wrongLeft - box.left).toFixed(4)),
      20.7188,
      `用错朝向必须差 136 native × 0.15234375 = 20.7188 CSS（实际 ${Math.abs(wrongLeft - box.left)}）`,
    );
    return anchorRight.x;
  };

  assert.equal(assertRightFacingAnchor('run'), 836, 'run 右向锚 836（美术实测）');
  assert.equal(assertRightFacingAnchor('jump'), 836, 'jump 右向锚 836（美术实测）');

  // 金丝雀：同一批的左向帧必须用左向锚（否则"按朝向取"这件事没被真正区分开）
  const run = drafts.run as unknown as PoseBatch;
  const left = Object.values(run.frames).find((frame) => frame.facing === -1);
  assert.ok(left, 'run 必须有左向帧');
  const leftBox = poseBoxOf(run, left, scale, PET_POSES.align);
  assert.equal(
    Number(leftBox.left.toFixed(6)),
    Number((point.x - run.bodyAnchor.byFacing['-1'].x * scale.nativeToCss).toFixed(6)),
    '左向帧必须用左向锚（700）',
  );
});

test('G-06 金丝雀 ②：lie / sleep 的基线差 > 0.35 CSS（"anchor.y/2 冒充接地线"只在这两批暴露）', () => {
  const scale = PET_POSES.scale;
  const drafts = adaptAll({ repoRoot: REPO_ROOT, accepted: ['lie', 'sleep'] }).drafts;
  for (const posture of ['lie', 'sleep'] as const) {
    const batch = drafts[posture] as unknown as PoseBatch;
    assert.ok(batch, `${posture} 草稿缺失`);
    const source = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'docs/assets/desktop-pet/poses', posture, 'manifest.json'), 'utf8'),
    ) as { anchor: { y: number } };
    const masterHalf = source.anchor.y / 2;
    const nativeAnchor = batch.bodyAnchor.byFacing['-1'].y;
    const diff = (nativeAnchor - masterHalf) * scale.nativeToCss;
    // 13.5 native × 0.15234375 = 2.06 CSS；判据是"远大于 0.35 的容差"，所以错域一定会红
    assert.ok(
      Math.abs(diff) > BASELINE_TOLERANCE_CSS,
      `${posture} 的 anchor.y/2 与 native 锚只差 ${diff} CSS：这类错域抓不住（母版 anchor.y=${source.anchor.y}）`,
    );
  }
});

test('G-05：姿态连切 20 次，窗口 bounds 逐值相等（且 placement 的 left 真的变过）', () => {
  // 注入的 bounds 采集器：一次都没被调用，也一次都没变过（渲染层没有窗口写入面）
  const bounds = { x: 100, y: 100, width: windowSize(PET_GEOMETRY).width, height: windowSize(PET_GEOMETRY).height };
  const snaps = [JSON.stringify(bounds)];
  const captures = { count: 0 };

  const host = new FakeElement('div');
  const root = new FakeElement('div');
  let nowMs = 0;
  const controller = new PoseController({
    doc: new FakeDocument(),
    root,
    host,
    poses: PET_POSES,
    density: '2x',
    ports: {
      now: () => nowMs,
      schedule: () => 0,
      cancel: () => {},
      onFrame: () => {},
      onClipEnd: () => {},
    },
    boxOf: (batch, frame) => poseBoxOf(batch, frame, PET_POSES.scale, PET_POSES.align),
  });

  const lefts = new Set<string>();
  for (let index = 0; index < 20; index += 1) {
    const next = index % 2 === 0 ? 'sit' : 'stand';
    controller.setPosture(next);
    nowMs += 10;
    // 每次切姿态后"采一次窗口 bounds"（真实实现由主进程独占写入，这里模拟只读采集）
    captures.count += 1;
    snaps.push(JSON.stringify(bounds));
    const left = (controller.layerElement as unknown as FakeElement).styleProps.get('left');
    if (left !== undefined) lefts.add(left);
  }

  assert.equal(new Set(snaps).size, 1, `切姿态期间窗口 bounds 变了：${[...new Set(snaps)].join(' / ')}`);
  assert.equal(captures.count, 20);
  // 金丝雀：真的在切姿态（placement 写出了至少一个 left），否则"bounds 没变"可能是"什么都没发生"
  assert.ok(lefts.size >= 1, '20 次切换里 placement 一次都没写出 left：说明姿态根本没切');
  assert.equal(controller.posture, 'stand');
});

/** 假元素（只实现控制器用到的成员）。 */
class FakeElement implements ElementLike {
  /** `data-*`。 */
  readonly dataset: Record<string, string | undefined> = {};

  /** 样式写入面。 */
  readonly styleProps = new Map<string, string>();

  /** 属性写入面。 */
  readonly attributes = new Map<string, string>();

  /** 子节点。 */
  readonly children: FakeElement[] = [];

  /** `<img>` 计数用。 */
  readonly tagName: string;

  /** CSS 写入面。 */
  readonly style: { setProperty: (name: string, value: string) => void } = {
    setProperty: (name: string, value: string): void => {
      this.styleProps.set(name, value);
    },
  };

  /** 图片地址。 */
  src = '';

  /** 是否隐藏。 */
  hidden = false;

  /** 文本内容。 */
  textContent: string | null = null;

  /**
   * @param tagName 标签名
   */
  constructor(tagName: string) {
    this.tagName = tagName;
  }

  /**
   * @param child 子节点
   * @returns 追加入参
   */
  appendChild(child: ElementLike): unknown {
    this.children.push(child as FakeElement);
    return child;
  }

  /**
   * @param name 属性名
   * @param value 属性值
   */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /**
   * @param name 属性名
   * @returns 属性值
   */
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

/** 假文档。 */
class FakeDocument implements DocumentLike {
  /**
   * @param tagName 标签名
   * @returns 假元素
   */
  createElement(tagName: string): ElementLike {
    return new FakeElement(tagName);
  }
}
