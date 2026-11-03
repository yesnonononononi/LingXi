import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, writePng } from './png.mjs';
import { clean, measure, describe } from './pixels.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = path.join(root, 'source/sit_neutral_generated.png');
const source = readPng(sourceFile);
const sourceCleanup = clean(source);
const box = measure(source).bbox;
const scale = 1080 / (box.bottom - box.top + 1);
const native = { width: 1024, height: 1536, data: Buffer.alloc(1024 * 1536 * 4) };
// 先等比缩小新绘坐姿，再放进统一母版；绝不通过挤压站姿构造坐姿。
const centerX = (box.left + box.right) / 2;
const targetBottom = 1454;
for (let y = 0; y < native.height; y++) {
  for (let x = 0; x < native.width; x++) {
    const sx = centerX + (x - 512) / scale;
    const sy = box.bottom + (y - targetBottom) / scale;
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    const fx = sx - x0, fy = sy - y0;
    let alpha = 0;
    const colors = [0, 0, 0];
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const px = x0 + dx, py = y0 + dy;
        if (px < 0 || py < 0 || px >= source.width || py >= source.height) continue;
        const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        const offset = (py * source.width + px) * 4;
        const a = source.data[offset + 3] * weight;
        alpha += a;
        for (let c = 0; c < 3; c++) colors[c] += source.data[offset + c] * a;
      }
    }
    const dest = (y * native.width + x) * 4;
    if (alpha > 0) for (let c = 0; c < 3; c++) native.data[dest + c] = Math.round(colors[c] / alpha);
    native.data[dest + 3] = Math.round(alpha);
  }
}
const nativeCleanup = clean(native);
writePng(path.join(root, 'source/sit_neutral_native.png'), native);
const master = { width: 2048, height: 3072, data: Buffer.alloc(2048 * 3072 * 4) };
for (let y = 0; y < master.height; y++) for (let x = 0; x < master.width; x++) {
  const from = (Math.floor(y / 2) * native.width + Math.floor(x / 2)) * 4;
  native.data.copy(master.data, (y * master.width + x) * 4, from, from + 4);
}
const filename = 'sit_neutral@2x.png';
const target = path.join(root, filename);
writePng(target, master);
const metadata = describe(target, master);
// 两只前伸脚掌最低可见像素由独立范围扫描得到，坐标不靠目测猜测。
function locateContact(left, right) {
  let bottom = -1, xs = [];
  for (let y = 2700; y < master.height; y++) for (let x = left; x <= right; x++) {
    if (!master.data[(y * master.width + x) * 4 + 3]) continue;
    if (y > bottom) { bottom = y; xs = []; }
    if (y === bottom) xs.push(x);
  }
  return [Math.round(xs.reduce((sum, x) => sum + x, 0) / xs.length), bottom];
}
const manifest = {
  version: 1, batch: 'sit', assetId: 'lingxi-pet-m2-sit-static-review-v1',
  status: 'awaiting-static-review', canvas: { width: 2048, height: 3072 },
  anchor: { x: 1024, y: 2908 },
  contactPoints: { foot: [1024, 2908], footImageLeft: locateContact(450, 1000),
    footImageRight: locateContact(1080, 1550), belly: null, palmFront: null },
  mirrorSafe: false, notMirrorableParts: ['bow', 'hairpin', 'tail'],
  orientation: '正面；云朵发夹、发侧蝴蝶结与尾巴在画面右侧',
  nativeSourceCanvas: { width: 1024, height: 1536 },
  masterScale: { factor: 2, kernel: 'nearest', addsDetail: false },
  colorSpace: 'sRGB', alpha: 'straight', bboxConvention: 'right/bottom 为含端点坐标；alpha>0',
  normalization: { generatedCanvas: { width: source.width, height: source.height },
    sourceBboxAfterCleanup: box, uniformScaleToNative: scale, kernel: 'alpha-weighted-bilinear',
    targetNativeFootBaseline: targetBottom, sourceCleanup, nativeCleanup },
  display: { canvasWidth: 156, canvasHeight: 234,
    inkHeight: (metadata.bbox.bottom - metadata.bbox.top + 1) * 234 / 3072 },
  review: { requiredNow: [filename], deferredUntilApproval: ['sit_happy@2x.png（抱云）', 'sit_blink@2x.png', '露肉垫特写参数'],
    fullBatchComplete: false },
  files: [{ file: filename, purpose: '坐姿中性静帧，供首轮风格与几何验收', ...metadata }],
  sources: ['source/sit_neutral_generated.png', 'source/sit_neutral_native.png'].map(file => ({ file, ...describe(path.join(root, file), readPng(path.join(root, file))) })),
  notes: '本轮遵循任务书第8节，先交坐姿中性静帧，不冒充坐姿整批完成。双腿屈膝前伸、脚底肉垫朝向观者，臀部坐地，裙摆铺开。等比缩小新绘图后以2倍最近邻生成母版，没有压扁站姿。脚掌最低像素与锚点偏差不超过2px。待确认风格与几何后再制作抱云、眨眼及其余批次。'
};
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`生成坐姿静帧: file=${filename}, bytes=${metadata.bytes}, bbox=${JSON.stringify(metadata.bbox)}`);
