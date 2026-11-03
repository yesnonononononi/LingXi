const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
let sharp;
for (const location of [root, path.resolve(root, '../../work/desktop-pet-visual/frontend')]) {
  try { sharp = require(require.resolve('sharp', { paths: [location] })); break; }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
}
if (!sharp) throw new Error('缺少 sharp，请在本目录执行 npm install');
sharp.concurrency(2);
const W = 1024, H = 1536;
const parts = [
  { id: '01_tail_base', source: 'tail_base', label: '尾根段', pivot: [660, 1180], roi: [590, 1020, 1023, 1360],
    fill: '尾根向长袍和后发下补绘至少 20px；中段保留 12px 重叠带。', transform: [1.475, 1.288, -484.5, -346.16] },
  { id: '02_tail_tip', source: 'tail_tip', label: '尾尖段', pivot: [920, 1080], roi: [700, 780, 1023, 1095],
    fill: '尾尖内侧补齐后发遮挡的毛面；中段与尾根段使用同一份原像素形成 12px 重叠带。', transform: [1.234, 1.357, -239, -392.7] },
  { id: '03_ear_left', source: 'ear_left', label: '左耳', pivot: [242, 354], roi: [120, 140, 440, 485],
    fill: '屏幕左耳的完整内外耳保留，耳根向刘海下补绘 22px。', transform: [1.45, 1.66, -65, -100.6] },
  { id: '04_ear_right', source: 'ear_right', label: '右耳', pivot: [704, 350], roi: [520, 140, 830, 475],
    fill: '屏幕右耳单独生成，向刘海与发夹下补绘 22px，未镜像左耳。', transform: [1.79, 2.04, -559.5, -178.6] },
  { id: '05_ahoge', source: 'ahoge', label: '呆毛', pivot: [486, 257], roi: [325, 55, 600, 305],
    fill: '卷曲末端完整保留，根部向头顶内部延伸 22px，使用前景发根盖片压住隐藏边。', transform: [2.09, 2.0, -462, -30] },
  { id: '06_bow', source: 'bow', label: '头饰蝴蝶结', pivot: [794, 472], roi: [690, 390, 915, 660],
    fill: '双翼和两条飘带完整保留，补齐云朵发夹下的左翼和结背连接；另附移除蝴蝶结后的头发底图。', transform: [2.69, 2.30, -1401, -572.2] },
];
function image(data, width = W, height = H) { return sharp(data, { raw: { width, height, channels: 4 } }); }
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'); }
function writeJson(file, data) { fs.writeFileSync(path.join(root, file), JSON.stringify(data, null, 2) + '\n'); }
async function readRaw(file) { return sharp(path.join(root, file)).ensureAlpha().raw().toBuffer(); }
function scalePixels(data, channels = 4) {
  const result = Buffer.alloc(W * H * channels * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const offset = (y * W + x) * channels;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      result.set(data.subarray(offset, offset + channels), ((y * 2 + dy) * W * 2 + x * 2 + dx) * channels);
    }
  }
  return result;
}
async function writeMaster(file, data) {
  await image(scalePixels(data), W * 2, H * 2).withIccProfile('srgb')
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }).toFile(path.join(root, file));
}
function over(destination, source) {
  for (let i = 0; i < destination.length; i += 4) {
    const a = source[i + 3];
    if (!a) continue;
    if (a === 255 || destination[i + 3] === 0) { source.copy(destination, i, i, i + 4); continue; }
    const sa = a / 255, da = destination[i + 3] / 255;
    const combined = sa + da * (1 - sa);
    for (let c = 0; c < 3; c++) destination[i + c] = Math.round((source[i + c] * sa + destination[i + c] * da * (1 - sa)) / combined);
    destination[i + 3] = Math.round(combined * 255);
  }
  return destination;
}
module.exports = { fs, path, root, sharp, W, H, parts, image, hash, writeJson, readRaw, scalePixels, writeMaster, over };
