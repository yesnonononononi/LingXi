/**
 * 桌宠几何真源与门禁逻辑单测（node:test，不碰 DOM）。
 *
 * <p>覆盖三件事：</p>
 * <ol>
 *   <li><b>推导规则</b>：`inkHeight → artHeight → artWidth → 窗口` 的每一行公式（设计文档 §2.1），
 *       含 §2.2 要求的三条边界值（196→219、208→234、214→240）；</li>
 *   <li><b>仓库现况</b>：`pet-geometry.json` 的派生字段是最新的、与 alpha 报告一致、立绘箱严格 2:3；</li>
 *   <li><b>门禁逻辑本身</b>：资产头解析（PNG/WebP）、裸魔法数扫描、注释剥离。</li>
 * </ol>
 *
 * <p>运行：`npm run test:pet`（本文件用 node 直接跑，不依赖 tsx）。</p>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const {
  ART_ASPECT,
  FRONTEND_ROOT,
  GEOMETRY_PATH,
  checkAlphaReportAgreement,
  deriveArtHeight,
  deriveArtWidth,
  deriveGeometry,
  rebuild,
  roundUpToMultiple,
  requireNumber,
} = require('../scripts/build-pet-geometry.mjs');

const {
  FORBIDDEN_MAGIC_NUMBERS,
  MASTER_ART_PATH,
  RUNTIME_ART,
  checkCssVariables,
  readImageSize,
  readPngSize,
  readWebpSize,
  scanSource,
  stripComments,
} = require('../scripts/check-pet-geometry.mjs');

/** 读几何真源原文。 */
function readGeometry() {
  return JSON.parse(readFileSync(GEOMETRY_PATH, 'utf8'));
}

// ---------------------------------------------------------------- 推导规则

test('deriveArtHeight：设计文档 §2.2 的三条边界值', () => {
  const ratio = 0.894531;
  assert.equal(deriveArtHeight(196, ratio), 219);
  assert.equal(deriveArtHeight(208, ratio), 234);
  assert.equal(deriveArtHeight(214, ratio), 240);
});

test('deriveArtHeight：结果一定是 3 的倍数（保证 artWidth 为整数）', () => {
  const ratio = 0.894531;
  for (let ink = 200; ink <= 210; ink += 1) {
    const artHeight = deriveArtHeight(ink, ratio);
    assert.equal(artHeight % 3, 0, `inkHeight=${ink} 推导出 artHeight=${artHeight} 不是 3 的倍数`);
    // 「先四舍五入、再向上取 3 的倍数」在最坏情况下会低 1.5px（四舍五入的半步），
    // 这是规则本身的性质，不是缺陷：容差写死在这里，避免有人以为公式错了去改实现。
    assert.ok(
      artHeight >= ink / ratio - 1.5,
      `artHeight=${artHeight} 与 ink/ratio=${(ink / ratio).toFixed(2)} 偏差超过 1.5px`,
    );
  }
});

test('deriveArtHeight：非法输入必须报错而不是返回 NaN', () => {
  assert.throws(() => deriveArtHeight(0, 0.9), RangeError);
  assert.throws(() => deriveArtHeight(Number.NaN, 0.9), TypeError);
  assert.throws(() => deriveArtHeight(208, 0), RangeError);
  assert.throws(() => deriveArtHeight(208, 1.5), RangeError);
});

test('deriveArtWidth：精确 2:3 且拒绝非 3 倍数的高度', () => {
  assert.equal(deriveArtWidth(234), 156);
  assert.equal(deriveArtWidth(219), 146);
  assert.equal(deriveArtWidth(240), 160);
  assert.throws(() => deriveArtWidth(233), RangeError);
});

test('roundUpToMultiple：向上取整到步长倍数', () => {
  assert.equal(roundUpToMultiple(233, 3), 234);
  assert.equal(roundUpToMultiple(234, 3), 234);
  assert.equal(roundUpToMultiple(1, 3), 3);
  assert.throws(() => roundUpToMultiple(1, 0), RangeError);
});

test('requireNumber：有限数值与区间校验', () => {
  assert.equal(requireNumber('12', 'x', { min: 0 }), 12);
  assert.throws(() => requireNumber('abc', 'x', { min: 0 }), TypeError);
  assert.throws(() => requireNumber(-1, 'x', { min: 0 }), RangeError);
  assert.throws(() => requireNumber(11, 'x', { min: 0, max: 10 }), RangeError);
});

test('deriveGeometry：窗口 188×338、可见墨迹与命中矩形', () => {
  const geometry = readGeometry();
  const derived = deriveGeometry(geometry);
  assert.equal(derived.artWidth, 156);
  assert.equal(derived.artHeight, 234);
  assert.deepEqual(derived.window, { width: 188, height: 338 });
  // 命中矩形（设计文档 §2.1 末行）：x=18.74 / y=100.19 / w=152.50 / h=209.32
  assert.ok(Math.abs(derived.hitBox.x - 18.74) < 0.02, `hitBox.x=${derived.hitBox.x}`);
  assert.ok(Math.abs(derived.hitBox.y - 100.19) < 0.02, `hitBox.y=${derived.hitBox.y}`);
  assert.ok(Math.abs(derived.hitBox.width - 152.5) < 0.02, `hitBox.width=${derived.hitBox.width}`);
  assert.ok(Math.abs(derived.hitBox.height - 209.32) < 0.02, `hitBox.height=${derived.hitBox.height}`);
  // 墨迹必须比立绘箱小：整箱判命中会让透明区吃掉桌面点击
  assert.ok(derived.hitBox.width < derived.artWidth);
  assert.ok(derived.hitBox.height < derived.artHeight);
});

// ---------------------------------------------------------------- 仓库现况

test('pet-geometry.json：派生字段是最新的（改 inkHeight 必须回写）', () => {
  const result = rebuild({ check: true });
  assert.equal(result.changed.length, 0, `派生字段过期: ${result.changed.join('; ')}`);
});

test('pet-geometry.json：立绘箱严格 2:3 且窗口公式自洽', () => {
  const geometry = readGeometry();
  const aspect = geometry.artWidth / geometry.artHeight;
  assert.ok(Math.abs(aspect - ART_ASPECT) / ART_ASPECT < 0.002, `立绘箱比例 ${aspect} 不是 2:3`);
  assert.equal(Number.isInteger(geometry.artWidth), true);
  assert.equal(geometry.artHeight % 3, 0);
  assert.equal(geometry.artWidth + geometry.glowPad * 2, 188);
  assert.equal(geometry.artHeight + geometry.glowPad * 2 + geometry.bubbleHeight, 338);
});

test('可见比例与 alpha 报告一致（美术重出图后的漂移检测）', () => {
  const geometry = readGeometry();
  const report = JSON.parse(
    readFileSync(resolve(FRONTEND_ROOT, '..', 'docs', 'assets', 'desktop-pet', 'v2', 'alpha-report.json'), 'utf8'),
  );
  assert.deepEqual(checkAlphaReportAgreement(geometry, report), []);
  // 篡改一份副本必须被检出
  const tampered = JSON.parse(JSON.stringify(geometry));
  tampered.visibleBounds.left = 0.5;
  assert.ok(checkAlphaReportAgreement(tampered, report).length > 0);
});

test('pet.css 的变量默认值与几何真源一致', () => {
  const geometry = readGeometry();
  assert.deepEqual(checkCssVariables(resolve(FRONTEND_ROOT, 'src/pet/pet.css'), geometry), []);
});

// ---------------------------------------------------------------- 门禁逻辑

test('母版 PNG 头解析：1024×1536（2:3）', () => {
  const size = readPngSize(MASTER_ART_PATH);
  assert.equal(size.width, 1024);
  assert.equal(size.height, 1536);
  assert.equal(size.format, 'png');
  assert.ok(Math.abs(size.width / size.height - ART_ASPECT) < 0.001);
});

test('运行时 WebP 头解析：@1x/@2x 都是 2:3 且为 2 倍关系', () => {
  const one = readWebpSize(RUNTIME_ART['@1x']);
  const two = readWebpSize(RUNTIME_ART['@2x']);
  for (const size of [one, two]) {
    assert.ok(Math.abs(size.width / size.height - ART_ASPECT) < 0.002, `${size.width}×${size.height} 不是 2:3`);
  }
  assert.equal(two.width, one.width * 2);
  assert.equal(two.height, one.height * 2);
});

test('readImageSize：未知扩展名必须报错', () => {
  assert.throws(() => readImageSize('/tmp/nope.gif'), /不认识的文件类型/);
});

test('stripComments：注释里的数字不参与魔法数扫描', () => {
  const source = ['// 旧值 288 / 316', '/* 窗口 320×420 */', 'const width = 188;'].join('\n');
  const stripped = stripComments(source);
  assert.equal(stripped.includes('288'), false);
  assert.equal(stripped.includes('320'), false);
  assert.equal(stripped.includes('188'), true);
});

test('scanSource：pet-window.cjs / pet.css / layout.ts 都没有旧的裸魔法数', () => {
  for (const relative of ['electron/pet-window.cjs', 'src/pet/pet.css', 'src/pet/layout.ts']) {
    const problems = scanSource(resolve(FRONTEND_ROOT, relative));
    assert.deepEqual(problems, [], `${relative} 命中: ${problems.join(' | ')}`);
  }
});

test('scanSource：检测能力自证（注入旧魔法数必须被抓到）', () => {
  const { writeFileSync, mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const dir = mkdtempSync(resolve(tmpdir(), 'pet-gate-'));
  const file = resolve(dir, 'fake.css');
  writeFileSync(file, '.a { width: 288px; }\n.b { object-fit: cover; }\n.c { transform: rotate(-90deg); }\n', 'utf8');
  const problems = scanSource(file);
  assert.ok(problems.some((item) => item.includes(String(FORBIDDEN_MAGIC_NUMBERS[0]))), '应命中 288');
  assert.ok(problems.some((item) => item.includes('object-fit')), '应命中 cover');
  assert.ok(problems.some((item) => item.includes('rotate')), '应命中 rotate(-90deg)');
});
