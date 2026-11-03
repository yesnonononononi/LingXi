// sleep 批次派生工具：呼吸 2 帧 + 惊醒帧。
// 两条硬规矩：
//   1) 一切编辑都在 native(1536²) 上做，再 2× nearest 出母版（否则「母版 = 原生 2× 最近邻」不成立，C7 会红）；
//   2) 每帧只允许改「声明区域」内的像素，区域外必须与基准帧逐字节相同（脚本自己先查一遍，check-sleep 再查一遍）。
//
// 运行：node docs/assets/desktop-pet/poses/sleep/tools/derive-sleep.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPng, encodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const posesRoot = path.resolve(root, '..');

export const CONFIG = {
  native: { width: 1536, height: 1536 },
  masterScale: 2,
  alphaClearBelow: 8,
  alphaSolidAt: 248,
  // 呼吸位移场：只在背部/胸廓这一条带上抬起或压下，腹部（落地侧）位移恒为 0
  breath: {
    x0: 830, x1: 1350,
    inhale: 14,    // 吸气：背部轮廓上抬 14 native px（= 28 母版 px）
    exhale: -10,   // 呼气：背部轮廓下压 10 native px
    featherY: 2,   // 带上下各留 2px 过渡
  },
  base: 'source/sleep_neutral_native.png',
  lieBase: '../lie/source/lie_neutral_native.png',
  mask: 'source/eye_mask_native.png',
  // 汗滴：贴在右侧头发上（该处实测无暗线/无蓝色，见 README），四角避开眼区
  sweatBox: { left: 660, top: 1150, right: 703, bottom: 1207 },
};

const W = CONFIG.native.width;
const H = CONFIG.native.height;

function bboxOf(img) {
  let left = W, top = H, right = -1, bottom = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (!img.data[(y * img.width + x) * 4 + 3]) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return { left, top, right, bottom };
}

// 眼区 = 蒙版里的完全透明连通域（与 build-sleep.mjs 同一口径），bbox 直接当声明区域
export function readEyeBoxes(mask) {
  const MW = mask.width, MH = mask.height;
  const seen = new Uint8Array(MW * MH);
  const boxes = [];
  for (let y = 0; y < MH; y += 1) {
    for (let x = 0; x < MW; x += 1) {
      const start = y * MW + x;
      if (seen[start] || mask.data[start * 4 + 3] !== 0) continue;
      const stack = [start];
      seen[start] = 1;
      let left = x, right = x, top = y, bottom = y, count = 0;
      while (stack.length) {
        const cur = stack.pop();
        count += 1;
        const cx = cur % MW;
        const cy = (cur - cx) / MW;
        if (cx < left) left = cx;
        if (cx > right) right = cx;
        if (cy < top) top = cy;
        if (cy > bottom) bottom = cy;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) continue;
            const next = ny * MW + nx;
            if (seen[next] || mask.data[next * 4 + 3] !== 0) continue;
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
      if (count > 64) boxes.push({ left, top, right, bottom, area: count });
    }
  }
  boxes.sort((a, b) => a.left - b.left);
  return boxes;
}

// 每列的墨迹上下边界（躯干位移场要用它判断"背在哪里、落地线在哪里"）
function columnExtent(img) {
  const top = new Int32Array(img.width).fill(-1);
  const bottom = new Int32Array(img.width).fill(-1);
  for (let x = 0; x < img.width; x += 1) {
    for (let y = 0; y < img.height; y += 1) {
      if (img.data[(y * img.width + x) * 4 + 3]) { top[x] = y; break; }
    }
    for (let y = img.height - 1; y >= 0; y -= 1) {
      if (img.data[(y * img.width + x) * 4 + 3]) { bottom[x] = y; break; }
    }
  }
  return { top, bottom };
}

function smoothstep(t) {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
}

// 呼吸：竖直位移场。d(x,y) = A·wx(x)·wy(y)，wx 是余弦窗（两端为 0），wy 在背部为 1、落地线为 0。
// 反向采样（dest(y) = src(y + d)）：A>0 背部抬起，A<0 背部压下；腹部和两端 d=0 ⇒ 一动不动。
export function warpBreath(base, amplitude) {
  const { x0, x1, featherY } = CONFIG.breath;
  const out = Buffer.from(base.data);
  const { top, bottom } = columnExtent(base);
  const changed = [];
  let maxShift = 0;
  for (let x = x0; x <= x1; x += 1) {
    if (top[x] < 0) continue;
    const t = (x - x0) / (x1 - x0);
    const wx = Math.sin(Math.PI * t) ** 2; // 两端 0、中间 1
    if (wx <= 0) continue;
    const yTop = top[x] - featherY;
    const yBottom = bottom[x];
    const span = Math.max(1, yBottom - yTop);
    for (let y = yTop; y <= yBottom; y += 1) {
      const wy = smoothstep((yBottom - y) / span); // 底部 0、顶部 1
      const d = amplitude * wx * wy;
      if (d === 0) continue;
      if (Math.abs(d) > maxShift) maxShift = Math.abs(d);
      // 反向采样（纵向双线性，在预乘空间做：否则不透明像素和透明像素平均会得出「发灰的边」）
      const srcY = y + d;
      const y0 = Math.floor(srcY);
      const frac = srcY - y0;
      const o = (y * W + x) * 4;
      const alphaAt = (yy) => (yy >= 0 && yy < H) ? base.data[(yy * W + x) * 4 + 3] / 255 : 0;
      const a0 = alphaAt(y0);
      const a1 = alphaAt(y0 + 1);
      const w0 = a0 * (1 - frac);
      const w1 = a1 * frac;
      const aSum = w0 + w1;
      if (aSum <= 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0; continue; }
      for (let k = 0; k < 3; k += 1) {
        const c0 = (y0 >= 0 && y0 < H) ? base.data[(y0 * W + x) * 4 + k] : 0;
        const c1 = (y0 + 1 >= 0 && y0 + 1 < H) ? base.data[((y0 + 1) * W + x) * 4 + k] : 0;
        out[o + k] = Math.round((c0 * w0 + c1 * w1) / aSum);
      }
      out[o + 3] = Math.round(aSum * 255);
      changed.push(y * W + x);
    }
  }
  return { image: { width: W, height: H, data: out }, maxShift: +maxShift.toFixed(3), changedPixels: changed.length };
}

// 惊醒：眼睛从 lie 原生图原样取回（保留睁眼），再把虹膜按 0.85 收一圈、腾出的眼白补白；
// 另加「小开口嘴」与一滴汗。所有落笔都限制在声明区域内。
export function buildStartle(base, lie, eyeBoxes) {
  const out = Buffer.from(base.data);
  // 1) 恢复睁眼：整块取 lie 的眼区
  for (const box of eyeBoxes) {
    for (let y = box.top; y <= box.bottom; y += 1) {
      for (let x = box.left; x <= box.right; x += 1) {
        const o = (y * W + x) * 4;
        for (let k = 0; k < 4; k += 1) out[o + k] = lie.data[o + k];
      }
    }
  }
  // 2) 虹膜缩小 15%：在虹膜掩膜上做距离变换后腐蚀 15% 半径，腾出的环带补眼白。
  //    不用椭圆拟合 —— 眼白里的冷色阴影会被算进椭圆，白环就糊到眼线上去了。
  const irisReport = [];
  for (const box of eyeBoxes) {
    const bw = box.right - box.left + 1;
    const bh = box.bottom - box.top + 1;
    const idx = (x, y) => (y - box.top) * bw + (x - box.left);
    // 虹膜色掩膜
    const blue = new Uint8Array(bw * bh);
    let n = 0;
    for (let y = box.top; y <= box.bottom; y += 1) {
      for (let x = box.left; x <= box.right; x += 1) {
        const o = (y * W + x) * 4;
        const r = out[o], g = out[o + 1], b = out[o + 2];
        if (b - r >= 40 && b >= 100) { blue[idx(x, y)] = 1; n += 1; }
      }
    }
    if (n < 200) { irisReport.push({ box, irisPixels: n, skipped: true }); continue; }
    // 从框边界泛洪「外部」，没被泛洪到的就是虹膜实心区（瞳孔/高光等内部空洞自动算进去）
    const outside = new Uint8Array(bw * bh);
    const stack = [];
    for (let x = 0; x < bw; x += 1) { stack.push(x, 0, x, bh - 1); }
    for (let y = 0; y < bh; y += 1) { stack.push(0, y, bw - 1, y); }
    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
      const i = y * bw + x;
      if (outside[i] || blue[i]) continue;
      outside[i] = 1;
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
    const solid = new Uint8Array(bw * bh);
    let solidN = 0;
    for (let i = 0; i < solid.length; i += 1) if (blue[i] || !outside[i]) { solid[i] = 1; solidN += 1; }
    // 掩膜边界在抗锯齿带上会抖，先做两遍多数滤波把毛刺磨平，否则白环边缘会出现锯齿碎片
    const smooth = majorityFilter(solid, bw, bh, 2);
    const dIn = distanceTransform(smooth, bw, bh);
    const notSolid = new Uint8Array(smooth.length);
    for (let i = 0; i < smooth.length; i += 1) notSolid[i] = smooth[i] ? 0 : 1;
    const dOut = distanceTransform(notSolid, bw, bh); // 非虹膜像素：到最近虹膜像素的距离
    let R = 0;
    for (let i = 0; i < smooth.length; i += 1) if (smooth[i] && dIn[i] > R) R = dIn[i];
    const shrink = 0.15;   // 半径缩 15%（题目口径）
    const cut = R * shrink; // 腐蚀阈值
    // 眼白：取虹膜外一圈亮近中性像素的均值（不凭空调色值）
    let wr = 0, wg = 0, wb = 0, wn = 0;
    for (let y = box.top; y <= box.bottom; y += 1) {
      for (let x = box.left; x <= box.right; x += 1) {
        const i = idx(x, y);
        if (smooth[i] || dOut[i] > 2) continue;
        const o = (y * W + x) * 4;
        const r = out[o], g = out[o + 1], b = out[o + 2];
        if (Math.max(r, g, b) > 225 && Math.max(r, g, b) - Math.min(r, g, b) < 26) { wr += r; wg += g; wb += b; wn += 1; }
      }
    }
    const white = wn > 20 ? [wr / wn, wg / wn, wb / wn] : [252, 250, 250];
    let ringPx = 0;
    for (let y = box.top; y <= box.bottom; y += 1) {
      for (let x = box.left; x <= box.right; x += 1) {
        const i = idx(x, y);
        const sd = smooth[i] ? dIn[i] : -dOut[i];
        if (sd >= cut) continue; // 离边界够远：保持原虹膜
        // 双侧羽化：内侧 1px 收边；外侧 2px 渐变
        let alpha = Math.min(Math.min(1, Math.max(0, cut - sd)), Math.max(0, 0.5 * (1 + sd)));
        if (alpha <= 0.02 && smooth[i]) continue;
        const o = (y * W + x) * 4;
        if (!smooth[i]) {
          if (dOut[i] > 4) continue;
          // 虹膜外侧只允许覆盖「浅色眼白」或「原虹膜的抗锯齿残边」，睫毛/眼线/皮肤一概不动
          const r = out[o], g = out[o + 1], b = out[o + 2];
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          const pale = mx >= 200 && mx - mn <= 34;  // 眼白
          const irisInk = b - r >= 30;              // 原虹膜的蓝/深蓝描边残边（睫毛是棕黑，b-r≈0，不会被误伤）
          if (!pale && !irisInk) continue;
          // 残边直接盖满：白底上留半透明蓝点会变成一圈噪点，盖成纯白才看不见锯齿
          if (irisInk) alpha = 1;
        }
        if (alpha <= 0.02) continue;
        for (let k = 0; k < 3; k += 1) {
          out[o + k] = Math.round(white[k] * alpha + out[o + k] * (1 - alpha));
        }
        if (alpha > 0.5) ringPx += 1;
      }
    }
    irisReport.push({ box, radiusPx: +R.toFixed(1), cutPx: +cut.toFixed(2), shrink,
      irisPixelsBlue: n, irisPixelsSolid: solidN, ringPixels: ringPx,
      irisPixelsAfter: solidN - ringPx, white: white.map((c) => Math.round(c)) });
  }
  // 3) 小开口嘴：在两眼之间的中线下方找原嘴位置，画一个小开口椭圆
  const mouthBox = findMouth(out, eyeBoxes);
  // 声明区域必须按「真实落笔几何」算，否则椭圆两端会溢出声明框 → 区域外差异不为 0
  const mouthPaintBox = drawOpenMouth(out, mouthBox);
  // 4) 汗滴
  drawSweat(out, CONFIG.sweatBox);
  return { image: { width: W, height: H, data: out }, irisReport,
    mouthBox: mouthPaintBox, mouthDetected: mouthBox.detected };
}

// 找原嘴：两眼之间中线下方那一小团暗红像素
function findMouth(data, eyeBoxes) {
  const leftBox = eyeBoxes[0];
  const rightBox = eyeBoxes[eyeBoxes.length - 1];
  // 嘴的实测位置：native (469..508, 1265..1274)（鼻子高光在 485,1237 下方），搜索窗只包住它周围
  const x0 = 450;
  const x1 = 526;
  const y0 = 1240;
  const y1 = 1300;
  let minX = W, maxX = -1, minY = H, maxY = -1, n = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const o = (y * W + x) * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      if (r > g + 40 && r > 150 && g < 170 && b < 175) {
        n += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (n < 20) {
    const cx = Math.round((leftBox.right + rightBox.left) / 2);
    const cy = Math.round((Math.min(leftBox.bottom, rightBox.bottom)) - 6);
    return { left: cx - 16, top: cy - 12, right: cx + 16, bottom: cy + 14, detected: false, pixels: n };
  }
  return { left: minX - 3, top: minY - 3, right: maxX + 3, bottom: maxY + 3, detected: true, pixels: n };
}

// 小开口嘴：深棕描边 + 暗红内腔 + 一点点舌头色，尺寸克制（这是「小开口」，不是打哈欠）
function drawOpenMouth(data, box) {
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  // 小开口：固定尺寸（≈26×20 native px），不跟着检测框的宽度膨胀成「打哈欠」
  const rx = 13;
  const ry = 10;
  const edgePx = Math.min(rx, ry);
  for (let y = Math.floor(cy - ry) - 1; y <= Math.ceil(cy + ry) + 1; y += 1) {
    for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx) + 1; x += 1) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const q = Math.sqrt(dx * dx + dy * dy);
      if (q >= 1) continue;
      const o = (y * W + x) * 4;
      if (data[o + 3] === 0) continue;
      const cover = Math.min(1, Math.max(0, (1 - q) * edgePx + 0.5)); // 边缘抗锯齿
      let color;
      if (q > 0.62) color = [98, 56, 50];        // 描边：深棕
      else if (dy > 0.22) color = [166, 88, 92]; // 下唇内侧：一点点舌头色
      else color = [74, 40, 44];                 // 口腔：暗
      for (let k = 0; k < 3; k += 1) {
        data[o + k] = Math.round(color[k] * cover + data[o + k] * (1 - cover));
      }
    }
  }
  // 返回真实落笔几何（椭圆外接框 + 1px 抗锯齿余量），供声明区域使用
  return {
    left: Math.floor(cx - rx) - 1,
    top: Math.floor(cy - ry) - 1,
    right: Math.ceil(cx + rx) + 1,
    bottom: Math.ceil(cy + ry) + 1,
    cx: +cx.toFixed(1),
    cy: +cy.toFixed(1),
    rx: +rx.toFixed(1),
    ry: +ry.toFixed(1),
    detected: box.detected,
    detectedPixels: box.pixels,
  };
}

// 距离变换（两遍 chamfer）：flag=1 的像素返回到最近 flag=0 像素的距离，flag=0 处为 0
function distanceTransform(flag, bw, bh) {
  const INF = 1e6;
  const d = new Float32Array(bw * bh);
  for (let i = 0; i < d.length; i += 1) d[i] = flag[i] ? INF : 0;
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const i = y * bw + x;
      if (!d[i]) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + 1);
      if (y > 0) {
        m = Math.min(m, d[i - bw] + 1);
        if (x > 0) m = Math.min(m, d[i - bw - 1] + 1.4142);
        if (x < bw - 1) m = Math.min(m, d[i - bw + 1] + 1.4142);
      }
      d[i] = m;
    }
  }
  for (let y = bh - 1; y >= 0; y -= 1) {
    for (let x = bw - 1; x >= 0; x -= 1) {
      const i = y * bw + x;
      if (!d[i]) continue;
      let m = d[i];
      if (x < bw - 1) m = Math.min(m, d[i + 1] + 1);
      if (y < bh - 1) {
        m = Math.min(m, d[i + bw] + 1);
        if (x < bw - 1) m = Math.min(m, d[i + bw + 1] + 1.4142);
        if (x > 0) m = Math.min(m, d[i + bw - 1] + 1.4142);
      }
      d[i] = m;
    }
  }
  return d;
}

// 3×3 多数滤波：磨掉掩膜边界上的单像素毛刺，免得虹膜收缩后留锯齿碎片
function majorityFilter(flag, bw, bh, passes) {
  let cur = Uint8Array.from(flag);
  for (let p = 0; p < passes; p += 1) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < bh; y += 1) {
      for (let x = 0; x < bw; x += 1) {
        let on = 0;
        let total = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
            total += 1;
            if (cur[ny * bw + nx]) on += 1;
          }
        }
        next[y * bw + x] = on * 2 > total ? 1 : 0;
      }
    }
    cur = next;
  }
  return cur;
}

// 汗滴：上尖下圆的泪滴（不是三角形/锥形），深蓝灰描边 + 淡蓝填充 + 高光，边缘 1px 抗锯齿
function drawSweat(data, box) {
  const cx = (box.left + box.right) / 2;
  const W2 = box.right - box.left;
  const H2 = box.bottom - box.top;
  const r = Math.min(H2 * 0.26, W2 * 0.34);       // 底部圆半径
  const tipY = box.top + 3;
  const bottomY = box.bottom - 3;
  const circY = bottomY - r;
  const OUTLINE = [92, 128, 168];
  const FILL_TOP = [206, 232, 250];
  const FILL_BOT = [163, 201, 238];
  for (let y = tipY - 1; y <= bottomY + 1; y += 1) {
    for (let x = Math.floor(cx - r) - 1; x <= Math.ceil(cx + r) + 1; x += 1) {
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      let half;
      if (y < circY) {
        const v = (y - tipY) / (circY - tipY);
        half = v <= 0 ? 0 : r * Math.pow(v, 1.55); // 上部向上收成尖
      } else {
        const dy = y - circY;
        half = r * r - dy * dy <= 0 ? 0 : Math.sqrt(r * r - dy * dy);
      }
      const dx = Math.abs(x - cx);
      if (half <= 0) continue;
      const cover = Math.min(1, Math.max(0, half - dx + 0.5)); // 横向覆盖率 ⇒ 侧边抗锯齿
      if (cover <= 0) continue;
      const o = (y * W + x) * 4;
      if (data[o + 3] === 0) continue;
      const onEdge = half - dx < 1.6 || y <= tipY + 1 || y >= bottomY - 1;
      let color;
      if (onEdge) color = OUTLINE;
      else {
        const vFill = (y - tipY) / (bottomY - tipY);
        const hi = Math.hypot(x - (cx - r * 0.34), y - (circY - r * 0.42)) < r * 0.30;
        color = hi ? [244, 251, 255]
          : [0, 1, 2].map((k) => FILL_TOP[k] * (1 - vFill) + FILL_BOT[k] * vFill);
      }
      for (let k = 0; k < 3; k += 1) {
        data[o + k] = Math.round(color[k] * cover + data[o + k] * (1 - cover));
      }
    }
  }
}

function cleanupAlpha(image) {
  let clearedLowAlpha = 0;
  let solidified = 0;
  for (let i = 0; i < image.width * image.height; i += 1) {
    const o = i * 4 + 3;
    const a = image.data[o];
    if (a !== 0 && a < CONFIG.alphaClearBelow) {
      image.data.fill(0, i * 4, i * 4 + 4);
      clearedLowAlpha += 1;
    } else if (a >= CONFIG.alphaSolidAt && a < 255) {
      image.data[o] = 255;
      solidified += 1;
    }
  }
  return { clearedLowAlpha, solidified };
}

function upscaleNearest(image, factor) {
  const out = { width: image.width * factor, height: image.height * factor,
    data: Buffer.alloc(image.width * factor * image.height * factor * 4) };
  for (let y = 0; y < out.height; y += 1) {
    for (let x = 0; x < out.width; x += 1) {
      const s = (Math.floor(y / factor) * image.width + Math.floor(x / factor)) * 4;
      const t = (y * out.width + x) * 4;
      out.data[t] = image.data[s];
      out.data[t + 1] = image.data[s + 1];
      out.data[t + 2] = image.data[s + 2];
      out.data[t + 3] = image.data[s + 3];
    }
  }
  return out;
}

// 区域外一致性：与基准帧逐像素比（这是「只改了声明区域」的证据）
function diffOutside(reference, image, regions) {
  let outside = 0, outsideMax = 0, inside = 0, insideMax = 0;
  const inAny = (x, y) => regions.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const o = (y * image.width + x) * 4;
      let d = 0;
      for (let k = 0; k < 4; k += 1) d = Math.max(d, Math.abs(image.data[o + k] - reference.data[o + k]));
      if (d === 0) continue;
      if (inAny(x, y)) { inside += 1; if (d > insideMax) insideMax = d; }
      else { outside += 1; if (d > outsideMax) outsideMax = d; }
    }
  }
  return { insidePixels: inside, insideMaxDelta: insideMax, outsidePixels: outside, outsideMaxDelta: outsideMax };
}

function writeFrame(name, nativeImage, baseImage, regions) {
  const cleaned = cleanupAlpha(nativeImage);
  const master = upscaleNearest(nativeImage, CONFIG.masterScale);
  const nativeBytes = encodePng(nativeImage);
  const masterBytes = encodePng(master);
  fs.writeFileSync(path.join(root, 'source', name + '_native.png'), nativeBytes);
  fs.writeFileSync(path.join(root, name + '_neutral@2x.png'), masterBytes);
  return {
    file: name + '_neutral@2x.png',
    nativeFile: 'source/' + name + '_native.png',
    bbox: bboxOf(master),
    bytes: masterBytes.length,
    sha256: crypto.createHash('sha256').update(masterBytes).digest('hex'),
    native: { bytes: nativeBytes.length, sha256: crypto.createHash('sha256').update(nativeBytes).digest('hex'), bbox: bboxOf(nativeImage) },
    alphaCleanup: cleaned,
    diff: diffOutside(baseImage, nativeImage, regions),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const base = readPng(path.join(root, CONFIG.base));
  const lie = readPng(path.join(root, CONFIG.lieBase));
  const mask = readPng(path.join(root, CONFIG.mask));
  const eyeBoxes = readEyeBoxes(mask);
  const baseBox = bboxOf(base);

  const breathRegion = { left: CONFIG.breath.x0, top: baseBox.top, right: CONFIG.breath.x1, bottom: baseBox.bottom };
  const inhale = warpBreath(base, CONFIG.breath.inhale);
  const exhale = warpBreath(base, CONFIG.breath.exhale);
  const inhaleFrame = writeFrame('sleep_breath_in', inhale.image, base, [breathRegion]);
  const exhaleFrame = writeFrame('sleep_breath_out', exhale.image, base, [breathRegion]);

  const startle = buildStartle(base, lie, eyeBoxes);
  const startleRegions = [...eyeBoxes, startle.mouthBox, CONFIG.sweatBox];
  const startleFrame = writeFrame('sleep_startle', startle.image, base, startleRegions);

  console.log(JSON.stringify({
    eyeBoxes,
    mouthBox: startle.mouthBox,
    sweatBox: CONFIG.sweatBox,
    breath: { region: breathRegion, inhaleMaxShift: inhale.maxShift, exhaleMaxShift: exhale.maxShift,
      inhaleChanged: inhale.changedPixels, exhaleChanged: exhale.changedPixels },
    iris: startle.irisReport,
    frames: [inhaleFrame, exhaleFrame, startleFrame],
    baseBbox: baseBox,
  }, null, 2));
}
