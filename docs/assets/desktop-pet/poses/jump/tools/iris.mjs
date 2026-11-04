// 虹膜（深蓝连通块）探测器 + 头部墨迹质心：check-jump.mjs 与跨批交叉验证脚本共用同一份实现。
//
// 口径与 run/tools/check-run.mjs 的 irisBlob 完全一致（这是 C10 的既有口径，不许放宽）：
//   掩膜 = alpha>=200 且 b>=120 且 b-r>=70 且 g<=165 且 r<=120 的 4-邻接连通块；
//   虹膜 = 面积 >= minArea 且填充率 >= minFill 的最大块（虹膜 fill≈0.41~0.50，蝴蝶结/裙摆描边 fill≈0.10~0.27）。
// 历史 bug：jump 早期版本把掩膜放宽成 b-r>=60 && b>=120，蓝色裙摆/披风被并进虹膜（n=28021），
// 偏移量与面积双双失真，于是 C10 假红。此文件即修正后的唯一实现。

/** C10 虹膜连通块最小面积（native px）。check 的 GATE 与 build 的实测共用此常量。 */
export const IRIS_MIN_AREA = 200;

/** C10 虹膜填充率下限：虹膜≈0.41~0.50，蝴蝶结/裙摆描边≈0.10~0.27。 */
export const IRIS_MIN_FILL = 0.35;

/** C10 虹膜相对头部墨迹质心的水平偏移下限（native px）。walk/run 的既有口径，不许降。 */
export const IRIS_MIN_OFFSET = 60;

/**
 * 头部区域内的深蓝连通块（候选虹膜）。
 *
 * @param {{width:number,height:number,data:Buffer}} img RGBA 图像
 * @param {{left:number,top:number,right:number,bottom:number}} box 墨迹外接框
 * @param {number} bandEnd 扫描下界 y（含）
 * @param {{minArea:number,minFill:number}} limits 面积与填充率下限
 * @returns {{iris:object|null,runnerUp:object|null,count:number,comps:object[]}} 探测结果
 */
export function irisBlob(img, box, bandEnd, limits) {
  const mask = new Uint8Array(img.width * img.height);
  for (let y = box.top; y <= bandEnd; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] < 200) continue;
      const r = img.data[o]; const g = img.data[o + 1]; const b = img.data[o + 2];
      if (b >= 120 && b - r >= 70 && g <= 165 && r <= 120) mask[y * img.width + x] = 1;
    }
  }
  const seen = new Uint8Array(img.width * img.height);
  const comps = [];
  for (let y = box.top; y <= bandEnd; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      const s = y * img.width + x;
      if (!mask[s] || seen[s]) continue;
      const stack = [s];
      seen[s] = 1;
      let n = 0; let sx = 0; let sy = 0; let minX = Infinity; let maxX = -1; let minY = Infinity; let maxY = -1;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % img.width; const cy = (cur - cx) / img.width;
        n += 1; sx += cx; sy += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx; const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
          const k = ny * img.width + nx;
          if (mask[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
        }
      }
      const w = maxX - minX + 1; const h = maxY - minY + 1;
      comps.push({ n, cx: sx / n, cy: sy / n, fill: n / (w * h), w, h });
    }
  }
  comps.sort((p, q) => q.n - p.n);
  const iris = comps.find((c) => c.n >= limits.minArea && c.fill >= limits.minFill) || null;
  const runnerUp = comps.find((c) => c !== iris) || null;
  return { iris, runnerUp, count: comps.length, comps };
}

/**
 * 头部带的墨迹质心（alpha>=200 的所有像素）。
 *
 * @param {{width:number,height:number,data:Buffer}} img RGBA 图像
 * @param {{left:number,top:number,right:number,bottom:number}} box 墨迹外接框
 * @param {number} bandEnd 扫描下界 y（含）
 * @returns {{x:number,y:number,n:number}|null} 质心；无墨迹时返回 null
 */
export function headCentroid(img, box, bandEnd) {
  let sx = 0; let sy = 0; let n = 0;
  for (let y = box.top; y <= bandEnd; y += 1) {
    for (let x = box.left; x <= box.right; x += 1) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] < 200) continue;
      sx += x; sy += y; n += 1;
    }
  }
  return n ? { x: sx / n, y: sy / n, n } : null;
}
