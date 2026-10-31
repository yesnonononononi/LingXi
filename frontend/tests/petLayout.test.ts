/**
 * `src/pet/layout.ts` 纯函数单测（tsx 执行，不碰 DOM）。
 *
 * <p>这些函数是**尺寸真源的唯一消费方**：窗口尺寸、立绘箱、命中矩形、归一化坐标。
 * 设计文档 §9.2 要求"改错一个系数就必须变红"，所以每条断言都钉具体数值（而不是自比自）。</p>
 *
 * <p>运行：`npm run test:pet`。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ART_ASPECT,
  ART_ORIGIN,
  PET_GEOMETRY,
  artBox,
  geometryCssVariables,
  normalizeGeometry,
  toNormalized,
  toView,
  visibleBox,
  windowSize,
} from '../src/pet/layout';

/** 允许的浮点误差（CSS px）。 */
const EPSILON = 0.01;

/**
 * 判断两个数是否足够接近。
 *
 * @param actual 实际值
 * @param expected 期望值
 * @param message 断言失败时的说明
 */
function near(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < EPSILON, `${message}: actual=${actual}, expected=${expected}`);
}

test('windowSize：188×338（立绘箱 + 四周留白 + 顶部气泡）', () => {
  assert.deepEqual(windowSize(PET_GEOMETRY), { width: 188, height: 338 });
});

test('ART_ORIGIN：原点 = (glowPad, glowPad + bubbleHeight)', () => {
  assert.deepEqual(ART_ORIGIN(PET_GEOMETRY), { x: 16, y: 88 });
});

test('artBox / visibleBox：立绘箱是 156×234，可见盒是墨迹包围盒', () => {
  const box = artBox(PET_GEOMETRY);
  assert.deepEqual(box, { x: 16, y: 88, width: 156, height: 234 });

  const visible = visibleBox(PET_GEOMETRY);
  near(visible.x, 18.74, 'visibleBox.x');
  near(visible.y, 100.19, 'visibleBox.y');
  near(visible.width, 152.5, 'visibleBox.width');
  near(visible.height, 209.32, 'visibleBox.height');
  // 可见盒必须严格内缩于立绘箱，否则等于用整箱判命中
  assert.ok(visible.x > box.x && visible.y > box.y);
  assert.ok(visible.x + visible.width < box.x + box.width);
  assert.ok(visible.y + visible.height < box.y + box.height);
});

test('toNormalized / toView：互为逆运算，原点在画布左上角', () => {
  const origin = ART_ORIGIN(PET_GEOMETRY);
  const center = toNormalized(PET_GEOMETRY, origin.x + PET_GEOMETRY.artWidth / 2, origin.y + PET_GEOMETRY.artHeight / 2);
  near(center.u, 0.5, 'center.u');
  near(center.v, 0.5, 'center.v');

  const back = toView(PET_GEOMETRY, center.u, center.v);
  near(back.x, origin.x + PET_GEOMETRY.artWidth / 2, 'round-trip x');
  near(back.y, origin.y + PET_GEOMETRY.artHeight / 2, 'round-trip y');
});

test('toNormalized：越界点不钳制（调用方自己决定丢弃还是夹紧）', () => {
  const point = toNormalized(PET_GEOMETRY, 0, 0);
  assert.ok(point.u < 0, `u=${point.u} 应小于 0`);
  assert.ok(point.v < 0, `v=${point.v} 应小于 0`);
});

test('geometryCssVariables：四个几何变量都带 px 单位', () => {
  const variables = geometryCssVariables(PET_GEOMETRY);
  assert.equal(variables['--pet-art-w'], '156px');
  assert.equal(variables['--pet-art-h'], '234px');
  assert.equal(variables['--pet-art-glow-pad'], '16px');
  assert.equal(variables['--pet-art-bubble-h'], '72px');
  assert.equal(variables['--pet-ink-h'], '208px');
});

test('PET_GEOMETRY：立绘箱严格 2:3 且与真源一致', () => {
  near(PET_GEOMETRY.artWidth / PET_GEOMETRY.artHeight, ART_ASPECT, '立绘箱比例');
  assert.equal(PET_GEOMETRY.inkHeight, 208);
  assert.equal(PET_GEOMETRY.canvasWidth, 1024);
  assert.equal(PET_GEOMETRY.canvasHeight, 1536);
});

test('normalizeGeometry：非法真源必须抛错而不是带 NaN 跑下去', () => {
  assert.throws(() => normalizeGeometry(null), TypeError);
  assert.throws(() => normalizeGeometry({}), TypeError);
  const base = JSON.parse(JSON.stringify(PET_GEOMETRY));
  const badAspect = { ...base, artWidth: 200 };
  assert.throws(() => normalizeGeometry(badAspect), RangeError);
  const badBounds = { ...base, visibleBounds: { ...base.visibleBounds, right: 0.01 } };
  assert.throws(() => normalizeGeometry(badBounds), RangeError);
  const badNumber = { ...base, inkHeight: Number.NaN };
  assert.throws(() => normalizeGeometry(badNumber), TypeError);
});
