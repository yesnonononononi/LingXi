import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';
import { measure, describe } from './pixels.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const errors = [];
function requireValue(condition, message) { if (!condition) errors.push(message); }

function inspect(image, entry, contract, actual) {
  const found = [];
  const stats = measure(image);
  const { bbox } = stats;
  if (image.width !== contract.canvas.width || image.height !== contract.canvas.height ||
    image.width !== entry.width || image.height !== entry.height ||
    image.bitDepth !== 8 || image.colorType !== 6 || image.interlace !== 0) found.push('C1');
  if (stats.lowAlpha || stats.islands.length) found.push('C2');
  if (entry.bytes !== actual.bytes || entry.sha256 !== actual.sha256 ||
    JSON.stringify(entry.bbox) !== JSON.stringify(bbox)) found.push('C3');
  if (bbox.left < 8 || bbox.top < 8 || image.width - 1 - bbox.right < 8 || image.height - 1 - bbox.bottom < 8 ||
    Math.abs(bbox.bottom - contract.anchor.y) > 2) found.push('C4');
  for (const name of ['footImageLeft', 'footImageRight']) {
    const [x, y] = contract.contactPoints[name];
    if (x < 0 || y < 0 || x >= image.width || y >= image.height ||
      Math.abs(y - contract.anchor.y) > 2 || !image.data[(y * image.width + x) * 4 + 3]) found.push('C4');
  }
  return [...new Set(found)];
}

requireValue(manifest.batch === 'sit' && manifest.canvas.width === 2048 && manifest.canvas.height === 3072, 'C1 坐姿画布契约不符');
requireValue(manifest.anchor.x === 1024 && manifest.anchor.y === 2908, 'C4 锚点契约不符');
requireValue(JSON.stringify(manifest.contactPoints.foot) === '[1024,2908]', 'C4 站位中心不符');
requireValue(manifest.alpha === 'straight' && manifest.colorSpace === 'sRGB', 'C1 导出约定不符');
requireValue(manifest.mirrorSafe === false && ['bow', 'hairpin'].every(name => manifest.notMirrorableParts.includes(name)), 'C5 缺少不可镜像部件约束');
requireValue(manifest.files.length === 1 && manifest.files[0].file === 'sit_neutral@2x.png', 'C6 首轮必须恰好交付坐姿中性静帧');
let official;
for (const entry of manifest.files) {
  const filename = path.join(root, entry.file);
  const image = readPng(filename);
  official = image;
  const actual = describe(filename, image);
  const failed = inspect(image, entry, manifest, actual);
  requireValue(!failed.length, `${failed.join('/')} 资产检查失败: file=${entry.file}`);
  requireValue(fs.readFileSync(filename).includes(Buffer.from('sRGB')), 'C1 缺少 sRGB 色彩声明');
  console.log(`核对母版: file=${entry.file}, bytes=${actual.bytes}, sha256=${actual.sha256}, bbox=${JSON.stringify(actual.bbox)}`);
}
for (const entry of manifest.sources) {
  const filename = path.join(root, entry.file);
  requireValue(JSON.stringify(describe(filename, readPng(filename))) === JSON.stringify({ width: entry.width, height: entry.height, bytes: entry.bytes, sha256: entry.sha256, bbox: entry.bbox }), `C3 来源对账失败: file=${entry.file}`);
}
const native = readPng(path.join(root, 'source/sit_neutral_native.png'));
let different = 0;
for (let y = 0; y < official.height; y++) for (let x = 0; x < official.width; x++) {
  const a = (y * official.width + x) * 4;
  const b = (Math.floor(y / 2) * native.width + Math.floor(x / 2)) * 4;
  for (let channel = 0; channel < 4; channel++) if (official.data[a + channel] !== native.data[b + channel]) different++;
}
requireValue(!different, 'C1 母版不是原生画布的2倍最近邻导出');
const measuredBox = measure(official).bbox;
const measuredHeight = (measuredBox.bottom - measuredBox.top + 1) * 234 / 3072;
requireValue(measuredHeight >= 150 && measuredHeight <= 170 && measuredHeight === manifest.display.inkHeight, 'C4 坐姿显示高度与实测不符或超出建议范围');

if (process.argv.includes('--self-test')) {
  const entry = manifest.files[0];
  const actual = { bytes: entry.bytes, sha256: entry.sha256 };
  const clone = () => ({ ...official, data: Buffer.from(official.data) });
  const canaries = [];
  function detects(name, image, changedEntry, changedContract, changedActual, expected) {
    const found = inspect(image, changedEntry, changedContract, changedActual);
    requireValue(found.includes(expected), `金丝雀漏报: case=${name}, expected=${expected}`);
    canaries.push(`${name}:${found.includes(expected) ? '拒绝' : '漏报'}`);
  }
  detects('错误画布', { ...official, width: official.width - 1 }, entry, manifest, actual, 'C1');
  detects('错误位深', { ...official, bitDepth: 16 }, entry, manifest, actual, 'C1');
  const low = clone(); low.data[(10 * low.width + 10) * 4 + 3] = 1;
  detects('低alpha', low, entry, manifest, actual, 'C2');
  const island = clone(); island.data[(10 * island.width + 10) * 4 + 3] = 255;
  detects('单像素孤岛', island, entry, manifest, actual, 'C2');
  detects('错误哈希', official, { ...entry, sha256: '0'.repeat(64) }, manifest, actual, 'C3');
  detects('错误字节数', official, { ...entry, bytes: entry.bytes + 1 }, manifest, actual, 'C3');
  detects('错误包围盒', official, { ...entry, bbox: { ...entry.bbox, bottom: entry.bbox.bottom - 1 } }, manifest, actual, 'C3');
  detects('错误脚底锚点', official, entry, { ...manifest, anchor: { x: 1024, y: 2800 } }, actual, 'C4');
  const margin = clone();
  for (const y of [10, 11]) for (const x of [0, 1]) margin.data[(y * margin.width + x) * 4 + 3] = 255;
  detects('边缘无留白', margin, entry, manifest, actual, 'C4');
  console.log(`金丝雀正对照: ${canaries.join(', ')}`);
}

if (process.argv.includes('--complete')) {
  const required = ['sit_neutral@2x.png', 'sit_happy@2x.png', 'sit_blink@2x.png'];
  for (const name of required) requireValue(manifest.files.some(entry => entry.file === name), `C6 完整批次缺帧: file=${name}`);
  requireValue(manifest.review.fullBatchComplete && manifest.pawPadCloseup, 'C6 完整批次尚缺肉垫特写参数与验收状态');
}
for (const error of errors) console.error(`校验失败: ${error}`);
if (errors.length) process.exitCode = 1;
else console.log('静帧门禁通过: C1-C5=通过, C6=首轮静帧齐全, C7=非mini不适用, C8=纯Node零依赖');
console.log('完整批次状态: 未完成，等待中性静帧风格与几何确认；抱云、眨眼与肉垫特写参数尚未交付');
