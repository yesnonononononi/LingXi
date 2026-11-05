/**
 * `effectMargin` 等值迁移单测（M3/T04）。
 *
 * <p>本文件存在的唯一理由：**窗口尺寸的推导必须跟着四边边距走**。
 * 这条规则以前是"单值 glowPad × 2"，改起来只有一个数字，改错了肉眼也看得出来；
 * 换成四边之后，一旦有人写回 `glowPad × 2`，只有**非对称边距**才会暴露差异——
 * 而线上真源是对称的 16/16/16/16，测试会全绿。所以这里用非对称 fixture 钉死它。</p>
 *
 * <p>另外锁住两条不变式：① 真源的窗口尺寸 = 立绘箱 + 四边边距 + 顶部气泡（D-01 2026-11-05 起为 268×348，
 * 断言里不写死数字，改边距只改 JSON）；② `effectMargin` 缺省时四边回落 `glowPad`（老版本 JSON 不会炸）。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  ART_ORIGIN,
  PET_GEOMETRY,
  artBox,
  geometryCssVariables,
  normalizeGeometry,
  resolveEffectMargin,
  visibleBox,
  windowSize,
} from '../src/pet/layout';
import type { PetGeometry } from '../src/pet/layout';

const require = createRequire(import.meta.url);
const { deriveGeometry } = require('../scripts/build-pet-geometry.mjs') as {
  deriveGeometry: (geometry: unknown) => { window: { width: number; height: number }; effectMargin: Record<string, number> };
};

/** 造一份几何（默认就是仓库真源，可覆盖任意字段）。 */
function geometryWith(overrides: Partial<PetGeometry> = {}): PetGeometry {
  return { ...PET_GEOMETRY, ...overrides };
}

/** 非对称夹具（**故意与真源不同**：真源是 24/56/18/56，用它会让"四边分别加"的断言失去区分度）。 */
const ASYMMETRIC: PetGeometry['effectMargin'] = { top: 30, right: 8, bottom: 12, left: 4 };

test('真源窗口 = 立绘箱 + 四边边距 + 气泡（D-01 2026-11-05：268×348，断言不写死派生式）', () => {
  const margin = PET_GEOMETRY.effectMargin;
  assert.deepEqual(margin, { top: 24, right: 56, bottom: 18, left: 56 });
  assert.equal(PET_GEOMETRY.artWidth, 156);
  assert.equal(PET_GEOMETRY.artHeight, 234);
  assert.deepEqual(windowSize(PET_GEOMETRY), {
    width: PET_GEOMETRY.artWidth + margin.left + margin.right,
    height: PET_GEOMETRY.artHeight + margin.top + margin.bottom + PET_GEOMETRY.bubbleHeight,
  });
  assert.deepEqual(windowSize(PET_GEOMETRY), { width: 268, height: 348 });
  assert.deepEqual(ART_ORIGIN(PET_GEOMETRY), { x: margin.left, y: margin.top + PET_GEOMETRY.bubbleHeight });
});

test('windowSize：非对称边距必须四边分别加（写成 glowPad×2 会红）', () => {
  const asymmetric = geometryWith({ effectMargin: ASYMMETRIC });
  // 156 + 4 + 8 = 168；234 + 30 + 12 + 72 = 348
  assert.deepEqual(windowSize(asymmetric), { width: 168, height: 348 });
  // 而用单值 glowPad=16 会算成 188×338 —— 这正是要防的错误
  assert.notDeepEqual(windowSize(asymmetric), windowSize(PET_GEOMETRY));
});

test('ART_ORIGIN：只由 left 与 top+bubbleHeight 决定', () => {
  const asymmetric = geometryWith({ effectMargin: ASYMMETRIC });
  assert.deepEqual(ART_ORIGIN(asymmetric), { x: ASYMMETRIC.left, y: ASYMMETRIC.top + 72 });
});

test('可见盒相对立绘箱的偏移不随边距变化（命中矩形只是整体平移）', () => {
  const base = geometryWith();
  const asymmetric = geometryWith({ effectMargin: ASYMMETRIC });
  const baseBox = artBox(base);
  const baseVisible = visibleBox(base);
  const shiftedBox = artBox(asymmetric);
  const shiftedVisible = visibleBox(asymmetric);
  // 偏移只由归一化包围盒决定，与边距无关（浮点误差按 1e-9 比）
  assert.ok(Math.abs(shiftedVisible.x - shiftedBox.x - (baseVisible.x - baseBox.x)) < 1e-9, '水平偏移随边距变了');
  assert.ok(Math.abs(shiftedVisible.y - shiftedBox.y - (baseVisible.y - baseBox.y)) < 1e-9, '垂直偏移随边距变了');
  // 宽高完全不变：边距只影响原点
  assert.equal(shiftedVisible.width, baseVisible.width);
  assert.equal(shiftedVisible.height, baseVisible.height);
});

test('geometryCssVariables：四边变量齐全且带 px', () => {
  const variables = geometryCssVariables(PET_GEOMETRY);
  const margin = PET_GEOMETRY.effectMargin;
  assert.equal(variables['--pet-effect-top'], `${margin.top}px`);
  assert.equal(variables['--pet-effect-right'], `${margin.right}px`);
  assert.equal(variables['--pet-effect-bottom'], `${margin.bottom}px`);
  assert.equal(variables['--pet-effect-left'], `${margin.left}px`);
  // 老变量保留（pet.css 首帧兜底仍引用它）
  assert.equal(variables['--pet-art-glow-pad'], `${PET_GEOMETRY.glowPad}px`);
});

test('effectMargin 缺省时四边回落 glowPad（老真源向后兼容）', () => {
  const legacy = JSON.parse(JSON.stringify(PET_GEOMETRY)) as Record<string, unknown>;
  delete legacy.effectMargin;
  const normalized = normalizeGeometry(legacy);
  assert.deepEqual(normalized.effectMargin, { top: 16, right: 16, bottom: 16, left: 16 });
  // 老真源没有四边边距 → 四边都取 glowPad → 窗口回到 M3 之前的 188×338（这正是回退分支的意义）
  assert.deepEqual(windowSize(normalized), {
    width: normalized.artWidth + normalized.glowPad * 2,
    height: normalized.artHeight + normalized.glowPad * 2 + normalized.bubbleHeight,
  });
  assert.deepEqual(windowSize(normalized), { width: 188, height: 338 });
});

test('resolveEffectMargin：缺省/非法输入的处理', () => {
  assert.deepEqual(resolveEffectMargin(undefined, 16), { top: 16, right: 16, bottom: 16, left: 16 });
  assert.deepEqual(resolveEffectMargin({ top: 1, right: 2, bottom: 3, left: 4 }, 16), {
    top: 1,
    right: 2,
    bottom: 3,
    left: 4,
  });
  assert.throws(() => resolveEffectMargin('16', 16), TypeError);
  assert.throws(() => resolveEffectMargin({ top: -1, right: 0, bottom: 0, left: 0 }, 16), RangeError);
  assert.throws(() => resolveEffectMargin({ top: 1, right: 0, bottom: 0 }, 16), TypeError);
});

test('脚本侧 deriveGeometry 与渲染层 windowSize 对同一份真源算出一致的窗口', () => {
  const derived = deriveGeometry(PET_GEOMETRY);
  assert.deepEqual(windowSize(PET_GEOMETRY), derived.window);
  const asymmetric = geometryWith({ effectMargin: ASYMMETRIC });
  const derivedAsymmetric = deriveGeometry(asymmetric);
  assert.deepEqual(windowSize(asymmetric), derivedAsymmetric.window);
  assert.deepEqual(derivedAsymmetric.effectMargin, ASYMMETRIC);
});
