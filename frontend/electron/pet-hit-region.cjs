/**
 * 桌宠命中区域（纯函数，零 IO、零 electron 依赖、零几何字面量）。
 *
 * <p><b>为什么单独一个模块：</b>"鼠标是否在桌宠身上"以前由渲染层算（`src/pet/hit/*`），
 * 于是主进程只能被动等一条 IPC。现在这条判定归主进程独占，判定本身退化成四个纯函数：
 * 派生命中矩形 → 换成屏幕坐标 → 半开区间判点 → 滞回。纯到可以在 node 里逐值断言。</p>
 *
 * <p><b>几何只有一个来源：</b>全部字段从 `frontend/pet-geometry.json` 现算，本文件里
 * **不出现任何几何数值字面量**（唯一例外是 `0` 这类"无外扩 / 起点"的语义默认值）。
 * 抄第二份常量的后果是"点不到 / 点太宽"，而且症状极难二分定位——`gate:pet` 里的
 * `checkHitDerivation` 与 `tests/petHitRegion.test.cjs` 的 C1 各自守一道。</p>
 *
 * <p><b>坐标口径：</b>`win.getBounds()` 与 `screen.getCursorScreenPoint()` 都是屏幕坐标
 * （DIP，原点在虚拟桌面左上角，可为负）。两者直接相加减即可，**绝不乘 `scaleFactor`、
 * 不除 `devicePixelRatio`**：DPI 只影响渲染层像素，与本判定无关。</p>
 *
 * @module electron/pet-hit-region
 */

/**
 * 把一个值规整成有限数值。
 *
 * @param {unknown} value 任意输入
 * @param {string} label 报错用的字段名
 * @returns {number} 有限数值
 * @throws {TypeError} 输入不是有限数值时抛出（几何真源坏了必须当场炸，不能静默用 0 兜底）
 */
function requireFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`pet-hit-region: ${label} 必须是有限数值，实际为 ${String(value)}`);
  }
  return number;
}

/**
 * 取四边特效边距。
 *
 * <p>老版本真源可能只有 `glowPad`（四边等值），此时按它回退——与 `pet-window.cjs`
 * 的 `EFFECT_MARGIN ?? glowPad` 保持同一口径，绝不引入第二套默认值。</p>
 *
 * @param {object} geometry 几何真源
 * @returns {{top: number, left: number}} 只取派生命中矩形需要的两条边
 */
function resolveMargin(geometry) {
  const margin = geometry.effectMargin;
  if (margin && typeof margin === 'object') {
    return { top: requireFinite(margin.top, 'geometry.effectMargin.top'), left: requireFinite(margin.left, 'geometry.effectMargin.left') };
  }
  const glowPad = requireFinite(geometry.glowPad, 'geometry.glowPad');
  return { top: glowPad, left: glowPad };
}

/**
 * 取可见包围盒（归一化 0..1），并校验区间方向。
 *
 * @param {object} geometry 几何真源
 * @returns {{left: number, top: number, right: number, bottom: number}} 可见包围盒
 */
function resolveVisibleBounds(geometry) {
  const bounds = geometry.visibleBounds;
  if (!bounds || typeof bounds !== 'object') {
    throw new TypeError('pet-hit-region: geometry.visibleBounds 缺失（命中矩形必须由可见墨迹派生）');
  }
  const resolved = {
    left: requireFinite(bounds.left, 'geometry.visibleBounds.left'),
    top: requireFinite(bounds.top, 'geometry.visibleBounds.top'),
    right: requireFinite(bounds.right, 'geometry.visibleBounds.right'),
    bottom: requireFinite(bounds.bottom, 'geometry.visibleBounds.bottom'),
  };
  if (!(resolved.right > resolved.left)) {
    throw new RangeError('pet-hit-region: visibleBounds 必须满足 right > left');
  }
  if (!(resolved.bottom > resolved.top)) {
    throw new RangeError('pet-hit-region: visibleBounds 必须满足 bottom > top');
  }
  return resolved;
}

/**
 * 派生命中矩形（窗口坐标，DIP）。
 *
 * <p>与渲染层 `layout.ts` 的 `visibleBox()` **同一份公式**：
 * `原点 = (margin.left, margin.top + bubbleHeight)`，`命中 = 原点 + 立绘箱 × 归一化包围盒`。
 * 两者逐值相等由 C1 断言；任一侧漂移立刻红。</p>
 *
 * @param {object} geometry `frontend/pet-geometry.json` 的解析对象
 * @returns {{x: number, y: number, width: number, height: number}} 命中矩形（窗口坐标）
 * @throws {TypeError} 几何缺字段或不是对象时抛出
 */
function deriveHitRect(geometry) {
  if (!geometry || typeof geometry !== 'object') {
    throw new TypeError('pet-hit-region: deriveHitRect 需要 pet-geometry.json 的解析对象');
  }
  const artWidth = requireFinite(geometry.artWidth, 'geometry.artWidth');
  const artHeight = requireFinite(geometry.artHeight, 'geometry.artHeight');
  const bubbleHeight = requireFinite(geometry.bubbleHeight, 'geometry.bubbleHeight');
  const margin = resolveMargin(geometry);
  const bounds = resolveVisibleBounds(geometry);
  const originX = margin.left;
  const originY = margin.top + bubbleHeight;
  return {
    x: originX + artWidth * bounds.left,
    y: originY + artHeight * bounds.top,
    width: artWidth * (bounds.right - bounds.left),
    height: artHeight * (bounds.bottom - bounds.top),
  };
}

/**
 * 规整一个矩形（缺字段按"零尺寸、原点零"处理，不抛）。
 *
 * @param {{x: number, y: number, width: number, height: number}} rect 待规整矩形
 * @returns {{x: number, y: number, width: number, height: number}} 规整后的矩形
 */
function normalizeRect(rect) {
  const source = rect && typeof rect === 'object' ? rect : {};
  const x = Number(source.x);
  const y = Number(source.y);
  const width = Number(source.width);
  const height = Number(source.height);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    width: Number.isFinite(width) ? Math.max(0, width) : 0,
    height: Number.isFinite(height) ? Math.max(0, height) : 0,
  };
}

/**
 * 矩形外扩 / 内缩（滞回用）。
 *
 * @param {{x: number, y: number, width: number, height: number}} rect 原矩形
 * @param {number} pad 正数外扩、负数内缩（非有限值按 0 处理）
 * @returns {{x: number, y: number, width: number, height: number}} 新矩形（不改入参）
 */
function expandRect(rect, pad) {
  const base = normalizeRect(rect);
  const parsed = Number(pad);
  const amount = Number.isFinite(parsed) ? parsed : 0;
  return {
    x: base.x - amount,
    y: base.y - amount,
    width: base.width + amount * 2,
    height: base.height + amount * 2,
  };
}

/**
 * 点是否落在矩形内。
 *
 * <p><b>半开区间 `[x, x+width) × [y, y+height)`：</b>边界只归属一侧，相邻矩形不会双命中。
 * 这与渲染层 `RectHitTester`（闭区间，服务于"点在边缘算不算点到"的事件级筛选）刻意不同：
 * 那边是用户手指的容差，这边是状态机判定，必须唯一。</p>
 *
 * @param {{x: number, y: number, width: number, height: number}} rect 矩形
 * @param {number} x 点 x（屏幕坐标 DIP）
 * @param {number} y 点 y（屏幕坐标 DIP）
 * @returns {boolean} 是否落在矩形内（非有限输入一律 false）
 */
function containsPoint(rect, x, y) {
  const box = normalizeRect(rect);
  const pointX = Number(x);
  const pointY = Number(y);
  if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) return false;
  return pointX >= box.x && pointX < box.x + box.width && pointY >= box.y && pointY < box.y + box.height;
}

/**
 * 窗口坐标矩形 → 屏幕坐标矩形。
 *
 * <p>两个坐标系同为 DIP、同原点，所以只是平移。**不做任何缩放换算**。</p>
 *
 * @param {{x: number, y: number, width: number, height: number}} bounds `win.getBounds()` 的结果
 * @param {{x: number, y: number, width: number, height: number}} rect 窗口坐标矩形
 * @returns {{x: number, y: number, width: number, height: number}} 屏幕坐标矩形
 */
function toScreenRect(bounds, rect) {
  const origin = normalizeRect(bounds);
  const box = normalizeRect(rect);
  return { x: origin.x + box.x, y: origin.y + box.y, width: box.width, height: box.height };
}

/**
 * 滞回判定：已在内侧时用"外扩矩形"判离开，否则用原矩形判进入。
 *
 * <p>方向是刻意的：进入要准（贴着可见墨迹就算命中），离开要钝（抖动 1~2px 不许翻转）。
 * 把两方向都外扩会让可点区比墨迹大 6px（点空气也算命中），把两方向都不扩则边界抖动即闪。</p>
 *
 * @param {boolean} prevInside 上一拍是否在内侧
 * @param {{x: number, y: number, width: number, height: number}} screenRect 屏幕坐标命中矩形
 * @param {{x: number, y: number}} point 光标屏幕坐标（DIP）
 * @param {number} hysteresisPx 离开方向的外扩量（像素）
 * @returns {boolean} 本拍是否命中
 */
function resolveInside(prevInside, screenRect, point, hysteresisPx) {
  const box = prevInside === true ? expandRect(screenRect, hysteresisPx) : normalizeRect(screenRect);
  const source = point && typeof point === 'object' ? point : {};
  return containsPoint(box, source.x, source.y);
}

module.exports = {
  deriveHitRect,
  expandRect,
  containsPoint,
  toScreenRect,
  resolveInside,
};
