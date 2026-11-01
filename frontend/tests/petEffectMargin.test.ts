/**
 * `effectMargin` 等值迁移单测（M3/T04）。
 *
 * <p>本文件存在的唯一理由：**窗口尺寸的推导必须跟着四边边距走**。
 * 这条规则以前是"单值 glowPad × 2"，改起来只有一个数字，改错了肉眼也看得出来；
 * 换成四边之后，一旦有人写回 `glowPad × 2`，只有**非对称边距**才会暴露差异——
 * 而线上真源是对称的 16/16/16/16，测试会全绿。所以这里用非对称 fixture 钉死它。</p>
 *
 * <p>另外锁住两条不变式：① 本轮真源四边都是 16，窗口仍是 188×338（`flag` 前后行为等价）；
 * ② `effectMargin` 缺省时四边回落 `glowPad`（老版本 JSON 不会炸）。</p>
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

test('真源四边都是 16，窗口仍是 188×338（等值迁移的行为锁）', () => {
  assert.deepEqual(PET_GEOMETRY.effectMargin, { top: 16, right: 16, bottom: 16, left: 16 });
  assert.equal(PET_GEOMETRY.glowPad, 16);
  assert.deepEqual(windowSize(PET_GEOMETRY), { width: 188, height: 338 });
  assert.deepEqual(ART_ORIGIN(PET_GEOMETRY), { x: 16, y: 88 });
});

test('windowSize：非对称边距必须四边分别加（写成 glowPad×2 会红）', () => {
  const asymmetric = geometryWith({
    effectMargin: { top: 24, right: 20, bottom: 18, left: 20 },
  });
  // 156 + 20 + 20 = 196；234 + 24 + 18 + 72 = 348
  assert.deepEqual(windowSize(asymmetric), { width: 196, height: 348 });
  // 而用单值 glowPad=16 会算成 188×338 —— 这正是要防的错误
  assert.notDeepEqual(windowSize(asymmetric), windowSize(PET_GEOMETRY));
});

test('ART_ORIGIN：只由 left 与 top+bubbleHeight 决定', () => {
  const asymmetric = geometryWith({ effectMargin: { top: 24, right: 20, bottom: 18, left: 20 } });
  assert.deepEqual(ART_ORIGIN(asymmetric), { x: 20, y: 24 + 72 });
});

test('可见盒相对立绘箱的偏移不随边距变化（命中矩形只是整体平移）', () => {
  const base = geometryWith();
  const asymmetric = geometryWith({ effectMargin: { top: 24, right: 20, bottom: 18, left: 20 } });
  const baseBox = artBox(base);
  const baseVisible = visibleBox(base);
  const shiftedBox = artBox(asymmetric);
  const shiftedVisible = visibleBox(asymmetric);
  assert.equal(shiftedVisible.x - shiftedBox.x, baseVisible.x - baseBox.x);
  assert.equal(shiftedVisible.y - shiftedBox.y, baseVisible.y - baseBox.y);
  // 宽高完全不变：边距只影响原点
  assert.equal(shiftedVisible.width, baseVisible.width);
  assert.equal(shiftedVisible.height, baseVisible.height);
});

test('geometryCssVariables：四边变量齐全且带 px', () => {
  const variables = geometryCssVariables(PET_GEOMETRY);
  assert.equal(variables['--pet-effect-top'], '16px');
  assert.equal(variables['--pet-effect-right'], '16px');
  assert.equal(variables['--pet-effect-bottom'], '16px');
  assert.equal(variables['--pet-effect-left'], '16px');
  // 老变量保留（pet.css 首帧兜底仍引用它）
  assert.equal(variables['--pet-art-glow-pad'], '16px');
});

test('effectMargin 缺省时四边回落 glowPad（老真源向后兼容）', () => {
  const legacy = JSON.parse(JSON.stringify(PET_GEOMETRY)) as Record<string, unknown>;
  delete legacy.effectMargin;
  const normalized = normalizeGeometry(legacy);
  assert.deepEqual(normalized.effectMargin, { top: 16, right: 16, bottom: 16, left: 16 });
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
  const asymmetric = geometryWith({ effectMargin: { top: 24, right: 20, bottom: 18, left: 20 } });
  const derivedAsymmetric = deriveGeometry(asymmetric);
  assert.deepEqual(windowSize(asymmetric), derivedAsymmetric.window);
  assert.deepEqual(derivedAsymmetric.effectMargin, { top: 24, right: 20, bottom: 18, left: 20 });
});
