// 墨迹与 alpha 卫生的**单一出处**：build-jump.mjs、check-jump.mjs 与跨批交叉验证脚本共用同一份实现，
// 避免"build 用 alpha>=8、check 用 alpha>=1"这类口径漂移（jump 批次 C4b 假红就是该漂移造成的）。
// 纯函数，无 IO，无外部依赖。

/** 「可见墨迹」阈值：alpha>=8 才算墨迹。与 build 的 alphaClearBelow=8、C2a 的 alpha<8 必须全透明同源。 */
export const INK_ALPHA_MIN = 8;

/** 「任意像素」阈值：alpha>0。用于核对直出图在文件层面的完整范围（与 manifest.bboxConvention 一致）。 */
export const ANY_ALPHA_MIN = 1;

/** 「视为实心」阈值：与 build 的 alphaSolidAt=248 同源；>=248 的 alpha 会被提满到 255。 */
export const SOLID_ALPHA = 248;

/** 中性灰的三通道互差上限（native px）。 */
export const NEUTRAL_GRAY_TOLERANCE = 6;

/** 中性灰脏边的亮度上限（0.299/0.587/0.114 加权）。 */
export const DIRTY_GRAY_MAX_LUMA = 210;

/**
 * 墨迹外接框（含端点坐标）。
 *
 * @param {{width:number,height:number,data:Buffer}} image RGBA 图像
 * @param {number} [minAlpha] 计入墨迹的最小 alpha，默认 INK_ALPHA_MIN
 * @returns {{left:number,top:number,right:number,bottom:number,width:number,height:number}} 外接框
 *   （right/bottom 为含端点坐标；width/height 为含端点跨度；全透明时 right/bottom 为 -1）
 */
export function bboxOf(image, minAlpha = INK_ALPHA_MIN) {
  const { width, height, data } = image;
  let left = width; let top = height; let right = -1; let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < minAlpha) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * 是否中性灰（三通道互差均不超过容差）。
 *
 * @param {number} r 红通道
 * @param {number} g 绿通道
 * @param {number} b 蓝通道
 * @returns {boolean} 中性灰返回 true
 */
export function isNeutralGray(r, g, b) {
  return Math.abs(r - g) <= NEUTRAL_GRAY_TOLERANCE
    && Math.abs(g - b) <= NEUTRAL_GRAY_TOLERANCE
    && Math.abs(r - b) <= NEUTRAL_GRAY_TOLERANCE;
}

/**
 * 是否为「半透明中性灰脏边」像素：C2c 的度量口径与 build 的边缘净化口径共用此函数。
 *
 * @param {number} r 红通道
 * @param {number} g 绿通道
 * @param {number} b 蓝通道
 * @param {number} alpha alpha 通道
 * @returns {boolean} 半透明、中性灰且偏暗时返回 true
 */
export function isDirtyNeutralGray(r, g, b, alpha) {
  if (alpha < INK_ALPHA_MIN || alpha === 255) return false;
  if (!isNeutralGray(r, g, b)) return false;
  return (0.299 * r + 0.587 * g + 0.114 * b) <= DIRTY_GRAY_MAX_LUMA;
}

/**
 * alpha 卫生度量：低 alpha 残留、半透明中性灰脏边比例、<minIslandArea 的孤立块像素数。
 *
 * @param {{width:number,height:number,data:Buffer}} img RGBA 图像
 * @param {number} minIslandArea 孤立块面积下限（px）
 * @returns {{lowAlpha:number,semi:number,gray:number,grayRatio:number,tiny:number}} 度量结果
 */
export function alphaHygiene(img, minIslandArea) {
  const { width: W, height: H, data } = img;
  let lowAlpha = 0; let semi = 0; let gray = 0;
  for (let i = 0; i < W * H; i += 1) {
    const a = data[i * 4 + 3];
    if (a === 0) continue;
    if (a < INK_ALPHA_MIN) { lowAlpha += 1; continue; }
    if (a === 255) continue;
    semi += 1;
    const r = data[i * 4]; const g = data[i * 4 + 1]; const b = data[i * 4 + 2];
    if (isDirtyNeutralGray(r, g, b, a)) gray += 1;
  }
  let tiny = 0;
  const seen = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const s = y * W + x;
      if (seen[s] || data[s * 4 + 3] === 0) continue;
      const stack = [s]; seen[s] = 1; let n = 0;
      while (stack.length) {
        const cur = stack.pop(); n += 1;
        const cx = cur % W; const cy = (cur - cx) / W;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = cx + dx; const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const k = ny * W + nx;
            if (seen[k] || data[k * 4 + 3] === 0) continue;
            seen[k] = 1; stack.push(k);
          }
        }
      }
      if (n < minIslandArea) tiny += n;
    }
  }
  return { lowAlpha, semi, gray, grayRatio: semi ? gray / semi : 0, tiny };
}

/**
 * 把半透明中性灰脏边像素清零（原地修改）。
 *
 * 只动 alpha 在 [INK_ALPHA_MIN, SOLID_ALPHA) 之间、三通道互差 <=6、且加权亮度 <=210 的像素，
 * 其它像素一个字节都不碰；调用方负责验证 bbox 不变。
 *
 * @param {{width:number,height:number,data:Buffer}} img RGBA 图像（原地修改）
 * @param {number} [maxAlpha] 只清理 alpha 小于该值的像素，默认 SOLID_ALPHA
 * @returns {number} 被清零的像素数
 */
export function clearDirtyNeutralGray(img, maxAlpha = SOLID_ALPHA) {
  const { width, height, data } = img;
  let cleared = 0;
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    const alpha = data[o + 3];
    if (alpha < INK_ALPHA_MIN || alpha >= maxAlpha) continue;
    if (!isDirtyNeutralGray(data[o], data[o + 1], data[o + 2], alpha)) continue;
    data.fill(0, o, o + 4);
    cleared += 1;
  }
  return cleared;
}
