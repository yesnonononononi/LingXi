import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPng, writePng } from './png.mjs';
import { blank, resize, enlarge, overlay, patch, cut, encodeGif } from './raster.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsRoot = path.resolve(root, '../..');
const baseSit = readPng(path.join(assetsRoot, 'poses/sit/source/sit_neutral_native.png'));
const baseCloud = readPng(path.join(assetsRoot, 'companion/v1/cloudling_neutral.png'));
const readSource = name => readPng(path.join(root, 'source', `${name}_generated.png`));
export const MASKS = {
  sit_blink: [[326, 748, 446, 845, 7], [508, 748, 620, 845, 7]],
  sit_welcome: [[270, 953, 690, 1260, 12], [446, 832, 510, 883, 6]],
  sit_hug: [[270, 953, 690, 1260, 12], [326, 748, 446, 845, 7], [508, 748, 620, 845, 7], [446, 832, 510, 883, 6]],
  cloud_happy: [[208, 340, 309, 383, 4]],
};
const images = {
  sit_neutral: baseSit,
  cloud_neutral: baseCloud,
  ...Object.fromEntries(Object.entries(MASKS).map(([name, rects]) => [name, patch(name.startsWith('sit') ? baseSit : baseCloud, readSource(name), rects)])),
};
images.sit_hug_hands = cut(images.sit_hug, [[354, 979, 434, 1088, 3], [520, 979, 598, 1090, 3]]);
const fileEntries = [];
const describe = relative => {
  const bytes = fs.readFileSync(path.join(root, relative));
  return { file: relative, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
};
for (const name of Object.keys(MASKS)) {
  const image = images[name];
  writePng(path.join(root, 'frames', `${name}_native.png`), image);
  writePng(path.join(root, 'frames', `${name}@2x.png`), enlarge(image));
  for (const suffix of ['_native.png', '@2x.png']) fileEntries.push(describe(`frames/${name}${suffix}`));
}
writePng(path.join(root, 'frames/sit_hug_hands_native.png'), images.sit_hug_hands);
fileEntries.push(describe('frames/sit_hug_hands_native.png'));

const blinkIds = ['sit_neutral', 'sit_blink', 'sit_neutral', 'sit_blink', 'sit_neutral', 'sit_blink', 'sit_neutral'];
const blinkDelays = [2600, 110, 1800, 90, 100, 110, 1800];
encodeGif(path.join(root, 'gifs/sit_blink.gif'), blinkIds.map(id => resize(images[id], 256, 384)), blinkDelays);

const cloudSteps = [
  ['cloud_neutral', 0, 1000], ['cloud_neutral', -4, 80], ['cloud_neutral', -9, 80],
  ['cloud_happy', -14, 160], ['cloud_happy', -9, 80], ['cloud_happy', -4, 80],
  ['cloud_happy', 0, 700], ['cloud_neutral', 0, 1000],
];
const cloudPreviews = cloudSteps.map(([id, dy]) => {
  const frame = blank(512, 512); overlay(frame, images[id], 0, dy); return resize(frame, 256, 256);
});
encodeGif(path.join(root, 'gifs/cloud_react.gif'), cloudPreviews, cloudSteps.map(step => step[2]));

// 两个角色保持分层；接触后把手掌放回最前，云朵不会盖住握持动作。
const playSteps = [
  ['approach', 'sit_neutral', 'cloud_neutral', 1080, 1454, 700],
  ['approach', 'sit_welcome', 'cloud_neutral', 1010, 1444, 160],
  ['approach', 'sit_welcome', 'cloud_neutral', 930, 1418, 120],
  ['approach', 'sit_welcome', 'cloud_neutral', 850, 1454, 120],
  ['approach', 'sit_welcome', 'cloud_neutral', 770, 1420, 120],
  ['contact', 'sit_welcome', 'cloud_neutral', 690, 1370, 140],
  ['contact', 'sit_welcome', 'cloud_neutral', 600, 1260, 140],
  ['contact', 'sit_hug', 'cloud_neutral', 475, 1147, 420],
  ['response', 'sit_hug', 'cloud_happy', 475, 1147, 650],
  ['response', 'sit_hug', 'cloud_happy', 475, 1141, 160],
  ['response', 'sit_hug', 'cloud_happy', 475, 1147, 650],
  ['end', 'sit_welcome', 'cloud_happy', 600, 1260, 160],
  ['end', 'sit_welcome', 'cloud_neutral', 770, 1400, 160],
  ['end', 'sit_welcome', 'cloud_neutral', 930, 1454, 160],
  ['end', 'sit_neutral', 'cloud_neutral', 1080, 1454, 1000],
];
const playFrames = playSteps.map(([, protagonist, companion, x, footY]) => {
  const frame = blank(1280, 1536);
  overlay(frame, images[protagonist]);
  overlay(frame, resize(images[companion], 400, 400), x - 200, footY - 470 * 400 / 512);
  if (protagonist === 'sit_hug') overlay(frame, images.sit_hug_hands);
  return resize(frame, 320, 384);
});
encodeGif(path.join(root, 'gifs/play_cloud.gif'), playFrames, playSteps.map(step => step[5]));

const sheet = blank(1280, 768);
for (let i = 0; i < 8; i++) {
  const tile = i < 4 ? [resize(baseSit, 256, 384), resize(images.sit_blink, 256, 384), playFrames[7], playFrames[8]][i]
    : [resize(baseSit, 256, 384), resize(images.sit_blink, 256, 384), playFrames[7], playFrames[8]][i - 4];
  const left = (i % 4) * 320, top = i < 4 ? 0 : 384;
  const color = i < 4 ? [245, 242, 235, 255] : [36, 42, 53, 255];
  for (let y = top; y < top + 384; y++) for (let x = left; x < left + 320; x++) sheet.data.set(color, (y * sheet.width + x) * 4);
  overlay(sheet, tile, left + (320 - tile.width) / 2, top);
}
writePng(path.join(root, 'qa/review.png'), sheet);

const contactSheet = blank(800, 576);
playFrames.forEach((frame, index) => {
  const left = (index % 5) * 160, top = Math.floor(index / 5) * 192;
  for (let y = top; y < top + 192; y++) for (let x = left; x < left + 160; x++) contactSheet.data.set([238, 240, 244, 255], (y * contactSheet.width + x) * 4);
  overlay(contactSheet, resize(frame, 160, 192), left, top);
});
writePng(path.join(root, 'qa/play_frames.png'), contactSheet);

for (const file of ['gifs/sit_blink.gif', 'gifs/cloud_react.gif', 'gifs/play_cloud.gif', 'qa/review.png', 'qa/play_frames.png']) fileEntries.push(describe(file));
const sourceEntries = fs.readdirSync(path.join(root, 'source')).sort().map(name => describe(`source/${name}`));
const manifest = {
  version: 1, assetId: 'lingxi-pet-gif-supplement-v1', status: 'awaiting-visual-review',
  scope: ['A01 坐姿眨眼', 'A01 坐姿抱云关键帧', 'A07 靠近—接触抱起—回应—结束', '伙伴开心弹跳反馈'],
  generator: 'tools/build.mjs', dependencies: '纯 Node；PNG 编解码复用 sit 批次工具，无新增依赖',
  nativeCanvas: { protagonist: [1024, 1536], companion: [512, 512], playStage: [1280, 1536] },
  masterScale: { factor: 2, kernel: 'nearest', addsDetail: false }, colorSpace: 'sRGB', alpha: 'straight',
  anchors: { protagonistBody: [474, 1454], protagonistGround: [512, 1454], companionFoot: [256, 470], companionGrip: [256, 333] },
  placement: { companionCanvas: [400, 400], protagonistCanvas: [1024, 1536], hugGripStage: [475, 1040], order: ['protagonist', 'companion', 'sit_hug_hands'] },
  masks: MASKS, sourceMode: 'built-in image_gen；仅采纳声明区域，原图轮廓、alpha、脚底与区域外像素保持不变',
  baseReferences: [
    { file: '../../poses/sit/source/sit_neutral_native.png', sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(assetsRoot, 'poses/sit/source/sit_neutral_native.png'))).digest('hex') },
    { file: '../../companion/v1/cloudling_neutral.png', sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(assetsRoot, 'companion/v1/cloudling_neutral.png'))).digest('hex') },
  ],
  clips: {
    sit_blink: { file: 'gifs/sit_blink.gif', canvas: [256, 384], loop: true, frames: blinkIds, frameMs: blinkDelays },
    cloud_react: { file: 'gifs/cloud_react.gif', canvas: [256, 256], loop: true, steps: cloudSteps.map(([frame, dy, ms]) => ({ frame, dy, ms })) },
    play_cloud: { file: 'gifs/play_cloud.gif', canvas: [320, 384], loop: true, stageScale: 0.25,
      steps: playSteps.map(([phase, protagonist, companion, x, footY, ms]) => ({ phase, protagonist, companion, companionCenterX: x, companionFootY: footY, ms })) },
  },
  gif: { palette: 256, transparentIndex: 0, alphaThreshold: 128, disposal: 2, note: 'GIF 仅支持二值透明；运行接入优先使用 PNG 分层与时序，不将 GIF 反解为母版' },
  files: fileEntries, sources: sourceEntries,
  review: { approvedBy: null, fullBatchComplete: false },
  deferred: ['尚未接入 frontend 运行时', '坐姿持续呼吸与耳尾分层动作', '其他玩耍变体与朝向', 'side / edge / mini 独立资产'],
};
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`生成动画补充资产: png=${Object.keys(MASKS).length * 2 + 1}, gif=3, playFrames=${playSteps.length}`);
