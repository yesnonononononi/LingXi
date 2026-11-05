/**
 * 命中区域纯函数用例（C1–C6）：`electron/pet-hit-region.cjs`。
 *
 * <p><b>守的是什么：</b>命中所有权归主进程之后，"鼠标是否在宠物身上"完全由这四个纯函数决定，
 * 而它们的输入只有一份几何真源（`frontend/pet-geometry.json`）。本文件钉住四件事：</p>
 *
 * <ol>
 *   <li><b>C1 派生等值</b>：`deriveHitRect` 必须与渲染层 `layout.ts` 的 `visibleBox()` 逐值相等
 *       （同一份公式，两边各算一遍，漂移即红）；</li>
 *   <li><b>C2 透明带不命中</b>：窗口 268×348 内、命中矩形外的六个点必须 false —— 这是
 *       "整窗吃鼠标"缺陷的唯一守卫；</li>
 *   <li><b>C3 滞回</b>：边界 ±1px 抖动 200 次，翻转数必须 0；同时用"无滞回"配置自证用例有判别力；</li>
 *   <li><b>C4/C5/C6</b>：半开区间、负坐标（副屏在左）、DPI 无关（同为 DIP，不许换算）。</li>
 * </ol>
 *
 * <p>运行：`npm run test:pet`（node 直接跑，不需要 tsx / Electron）。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');

const region = require(path.join(__dirname, '..', 'electron', 'pet-hit-region.cjs'));
const GEOMETRY = require(path.join(__dirname, '..', 'pet-geometry.json'));

const { deriveHitRect, expandRect, containsPoint, toScreenRect, resolveInside } = region;

/** 窗口尺寸由几何派生（与 `pet-window.cjs` 的 PET_WIDTH/PET_HEIGHT 同公式）。 */
const WINDOW_WIDTH = GEOMETRY.artWidth + GEOMETRY.effectMargin.left + GEOMETRY.effectMargin.right;
const WINDOW_HEIGHT =
  GEOMETRY.artHeight + GEOMETRY.effectMargin.top + GEOMETRY.effectMargin.bottom + GEOMETRY.bubbleHeight;

/** 滞回量（与主进程常量同值；只在本文件里作为"输入"出现，不参与派生）。 */
const HYSTERESIS = 6;

/**
 * 独立复算 `layout.ts` 的 `visibleBox()`（**刻意与 CJS 实现分开写**：两边算出来相等才有意义）。
 *
 * @param {object} geometry 几何
 * @returns {{x: number, y: number, width: number, height: number}} 命中矩形（窗口坐标）
 */
function visibleBoxFromLayoutFormula(geometry) {
  const originX = geometry.effectMargin.left;
  const originY = geometry.effectMargin.top + geometry.bubbleHeight;
  const bounds = geometry.visibleBounds;
  return {
    x: originX + geometry.artWidth * bounds.left,
    y: originY + geometry.artHeight * bounds.top,
    width: geometry.artWidth * (bounds.right - bounds.left),
    height: geometry.artHeight * (bounds.bottom - bounds.top),
  };
}

/**
 * 按两位小数取整（断言用：浮点尾数不该进断言文案）。
 *
 * @param {number} value 数值
 * @returns {number} 两位小数
 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/** 窗口原点（屏幕位置）：任意非零点，用来证明换算只做平移。 */
const SCREEN_ORIGIN = { x: 1628, y: 660, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };

test('C1 派生等值：deriveHitRect 与 layout.ts 的 visibleBox 公式逐值相等（268×348 窗口）', () => {
  const rect = deriveHitRect(GEOMETRY);
  const expected = visibleBoxFromLayoutFormula(GEOMETRY);

  // 逐字段（两位小数）——设计复算值：58.74 / 108.19 / 152.65 / 209.47
  assert.deepEqual(
    { x: round2(rect.x), y: round2(rect.y), width: round2(rect.width), height: round2(rect.height) },
    { x: 58.74, y: 108.19, width: 152.65, height: 209.47 },
    '命中矩形必须与设计复算值逐值一致',
  );
  // 全精度逐值相等（两条独立实现必须给出同一个数）
  assert.deepEqual(rect, expected, 'pet-hit-region 与 layout.ts 必须由同一份几何派生出同一个矩形');

  // 不是烘焙常量：改 artWidth，命中矩形必须跟着变
  const wider = deriveHitRect({ ...GEOMETRY, artWidth: 200 });
  assert.notDeepEqual(wider, rect, '改了 artWidth 命中矩形却不变 ⇒ 说明有烘焙数字');
  assert.equal(
    round2(wider.width),
    round2(200 * (GEOMETRY.visibleBounds.right - GEOMETRY.visibleBounds.left)),
    '宽度必须随 artWidth 等比变化',
  );

  // 几何坏掉必须当场炸，不能静默兜底（静默兜底 = 命中区悄悄变成 0 或者整窗）
  assert.throws(() => deriveHitRect(null), TypeError);
  assert.throws(() => deriveHitRect({ ...GEOMETRY, visibleBounds: undefined }), TypeError);
  assert.throws(() => deriveHitRect({ ...GEOMETRY, artWidth: Number.NaN }), TypeError);
});

test('C2 透明带不得命中：六个留白点必须 false，墨迹中心必须 true（整窗退化的唯一守卫）', () => {
  const rect = deriveHitRect(GEOMETRY);
  const screenRect = toScreenRect(SCREEN_ORIGIN, rect);
  /** 窗口坐标 → 是否命中（走完整链路：窗口坐标 → 屏幕坐标 → 半开区间判定）。 */
  const inside = (x, y) => resolveInside(false, screenRect, { x: SCREEN_ORIGIN.x + x, y: SCREEN_ORIGIN.y + y }, HYSTERESIS);

  // 六个判据点（窗口坐标）：左上边距 / 底部边距+气泡 / 左右各 56px 边距 / 上边界之上 / 下边界之下
  const outsidePoints = [
    [10, 10],
    [60, 340],
    [5, 200],
    [262, 200],
    [135, 100],
    [135, 330],
  ];
  for (const [x, y] of outsidePoints) {
    assert.equal(inside(x, y), false, `(${x},${y}) 在透明留白里，不得命中（命中矩形退化成整窗会立刻红）`);
  }
  // 墨迹中心必须命中
  assert.equal(inside(135, 200), true, '(135,200) 压在立绘上，必须命中');
  // 窗口尺寸确实是 268×348（判据点都落在这个窗口里，防止用例拿错坐标系）
  assert.deepEqual({ width: WINDOW_WIDTH, height: WINDOW_HEIGHT }, { width: 268, height: 348 });
  assert.equal(inside(WINDOW_WIDTH, 200), false, '窗口右边缘之外（半开区间）不得命中');
});

test('C3 边界 ±1px 抖动 200 次翻转数必须 0；无滞回时必须 >100（自证判别力）', () => {
  const rect = deriveHitRect(GEOMETRY);
  const rightEdge = rect.x + rect.width;
  const centerY = rect.y + rect.height / 2;

  /**
   * 喂一段 ±1px 正弦抖动，返回状态翻转次数（起点设为"已在内侧"，即设计说的"首次进入后"）。
   *
   * @param {number} hysteresis 滞回量（0 = 无滞回）
   * @returns {number} 翻转次数
   */
  const countFlips = (hysteresis) => {
    let inside = true;
    let flips = 0;
    let previous = true;
    for (let step = 0; step < 200; step += 1) {
      // 最坏情况抖动：每拍在边界两侧各 1px 反复横跳（相邻两拍必然跨边界）
      const offset = step % 2 === 0 ? 1 : -1;
      const next = resolveInside(inside, rect, { x: rightEdge + offset, y: centerY }, hysteresis);
      inside = next;
      if (next !== previous) flips += 1;
      previous = next;
    }
    return flips;
  };

  // 有滞回：+1px 抖到 217.39 才算离开（父矩形外扩 6px），200 次一次都不许翻
  assert.equal(countFlips(HYSTERESIS), 0, '滞回 6px 下边界 ±1px 抖动必须一次都不翻转');
  // 无滞回：单帧 1px 就跨越边界 ⇒ 大量翻转（证明本用例真的能判别"删掉滞回"）
  assert.ok(countFlips(0) > 100, '无滞回配置下必须出现大量翻转，否则本用例没有判别力');
});

test('C4 半开区间与 expandRect：边界归属唯一，外扩四边各 6px', () => {
  const rect = { x: 10, y: 20, width: 30, height: 40 };
  assert.equal(containsPoint(rect, rect.x, rect.y), true, '左上角属于矩形（含起点）');
  assert.equal(containsPoint(rect, rect.x + rect.width, rect.y + 1), false, '右边界不属于矩形（半开区间）');
  assert.equal(containsPoint(rect, rect.x + 1, rect.y + rect.height), false, '下边界不属于矩形（半开区间）');
  assert.equal(containsPoint(rect, rect.x + rect.width - 0.001, rect.y), true, '右边界内侧 0.001 仍命中');
  assert.equal(containsPoint(rect, Number.NaN, 20), false, '脏坐标一律不命中');

  const expanded = expandRect(rect, 6);
  assert.deepEqual(expanded, { x: 4, y: 14, width: 42, height: 52 }, '四边各外扩 6px，宽高各 +12');
  assert.deepEqual(rect, { x: 10, y: 20, width: 30, height: 40 }, 'expandRect 不许改入参');
  assert.deepEqual(expandRect(rect, -6), { x: 16, y: 26, width: 18, height: 28 }, '负数内缩同样成立');
});

test('C5 负坐标 / 副屏在左：bounds.x = −1920 时命中判定仍然正确', () => {
  const rect = deriveHitRect(GEOMETRY);
  const bounds = { x: -1920, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
  const screenRect = toScreenRect(bounds, rect);

  assert.equal(resolveInside(false, screenRect, { x: -1920 + 135, y: 200 }, HYSTERESIS), true, '副屏上的点必须命中');
  assert.equal(resolveInside(false, screenRect, { x: -1930, y: 200 }, HYSTERESIS), false, '副屏左侧之外不得命中');
  assert.equal(resolveInside(false, screenRect, { x: 135, y: 200 }, HYSTERESIS), false, '主屏原点的同名局部坐标不得命中');
  // 屏幕矩形就是"窗口原点 + 局部矩形"，只有平移
  assert.equal(screenRect.x, -1920 + rect.x);
  assert.equal(screenRect.width, rect.width);
});

test('C6 DIP 口径：结果与设备缩放无关，且源文件不出现任何缩放换算', () => {
  const rect = deriveHitRect(GEOMETRY);
  const baseline = toScreenRect(SCREEN_ORIGIN, rect);

  // getBounds 与 getCursorScreenPoint 同为 DIP ⇒ 无论 display.scaleFactor 是多少，输入输出都一样
  for (const scaleFactor of [1, 1.5, 2]) {
    const display = { scaleFactor, workArea: { x: 0, y: 0, width: 3840 / scaleFactor, height: 2160 / scaleFactor } };
    assert.deepEqual(
      toScreenRect(SCREEN_ORIGIN, deriveHitRect(GEOMETRY)),
      baseline,
      `scaleFactor=${scaleFactor} 下命中矩形必须完全相同（签名里根本没有 DPI 参数）`,
    );
    assert.equal(display.scaleFactor > 0, true, '构造的显示器对象本身合法（仅用于说明口径无关）');
  }

  // 源文件判据：两个模块里不许出现任何缩放换算字样
  for (const file of ['pet-hit-region.cjs', 'pet-hit-poller.cjs']) {
    const source = readFileSync(path.join(__dirname, '..', 'electron', file), 'utf8');
    for (const forbidden of ['scaleFactor', 'devicePixelRatio', 'zoomFactor']) {
      // 注释里可以解释"为什么不换算"，所以只看代码行（去掉整行注释与块注释残留）
      const codeLines = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'));
      assert.equal(
        codeLines.some((line) => line.includes(forbidden)),
        false,
        `${file} 的代码里不许出现 ${forbidden}（DIP 之间不换算）`,
      );
    }
  }
});
