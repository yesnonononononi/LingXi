import { readPng } from './png.mjs';
const V3 = new URL('../../v3/expr/', import.meta.url);
const e1 = readPng(new URL('E1_default.png', V3));
const e2 = readPng(new URL('E2_blink.png', V3));
const W = e1.width;
function bbox(x0, x1) {
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
  for (let y = 0; y < e1.height; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * W + x) * 4;
    const d = Math.max(Math.abs(e1.data[i]-e2.data[i]), Math.abs(e1.data[i+1]-e2.data[i+1]), Math.abs(e1.data[i+2]-e2.data[i+2]), Math.abs(e1.data[i+3]-e2.data[i+3]));
    if (d > 7) { n++; if (x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
  }
  return { n, minX, minY, maxX, maxY };
}
console.log('[左眼 x<=900]', JSON.stringify(bbox(0, 900)));
console.log('[右眼 x>=1000]', JSON.stringify(bbox(1000, 2047)));
