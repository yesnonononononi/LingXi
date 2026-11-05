import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';
import { rectWeight } from './raster.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function inspectGif(bytes) {
  if (bytes.toString('ascii', 0, 6) !== 'GIF89a') throw new Error('GIF 文件头不正确');
  const result = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), frames: [], loop: null };
  let offset = 13 + ((bytes[10] & 128) ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), control = null;
  const readBlocks = () => {
    const blocks = [];
    while (bytes[offset]) { const size = bytes[offset++]; blocks.push(bytes.subarray(offset, offset + size)); offset += size; }
    offset++;
    return Buffer.concat(blocks);
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return result;
    if (marker === 0x21) {
      const type = bytes[offset++], data = readBlocks();
      if (type === 0xf9) control = { delay: data.readUInt16LE(1) * 10, disposal: (data[0] >> 2) & 7, transparent: !!(data[0] & 1) };
      if (type === 0xff && data.toString('ascii', 0, 11) === 'NETSCAPE2.0') result.loop = data.readUInt16LE(12);
    } else if (marker === 0x2c) {
      const width = bytes.readUInt16LE(offset + 4), height = bytes.readUInt16LE(offset + 6), packed = bytes[offset + 8];
      offset += 9;
      if (packed & 128) offset += 3 * 2 ** ((packed & 7) + 1);
      offset++; readBlocks();
      result.frames.push({ ...control, width, height }); control = null;
    } else throw new Error(`GIF 存在未知块: marker=${marker}, offset=${offset - 1}`);
  }
  throw new Error('GIF 缺少结束标记');
}

export function check({ imageOverrides = {}, gifOverrides = {}, manifestOverride = null } = {}) {
  const manifest = manifestOverride ?? JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const problems = [], evidence = [];
  const loadImage = file => imageOverrides[file] ?? readPng(path.join(root, file));
  const requireValid = (condition, message) => { if (!condition) problems.push(message); };
  for (const entry of [...manifest.files, ...manifest.sources, ...manifest.baseReferences]) {
    const file = path.resolve(root, entry.file);
    requireValid(fs.existsSync(file), `交付文件缺失: file=${entry.file}`);
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file), sha = crypto.createHash('sha256').update(bytes).digest('hex');
    requireValid(sha === entry.sha256, `文件摘要不一致: file=${entry.file}`);
    if (entry.bytes !== undefined) requireValid(bytes.length === entry.bytes, `文件字节数不一致: file=${entry.file}`);
  }
  const baseSit = readPng(path.resolve(root, manifest.baseReferences[0].file));
  const baseCloud = readPng(path.resolve(root, manifest.baseReferences[1].file));
  for (const [name, rects] of Object.entries(manifest.masks)) {
    const image = loadImage(`frames/${name}_native.png`), base = name.startsWith('sit') ? baseSit : baseCloud;
    requireValid(image.width === base.width && image.height === base.height, `画布发生变化: frame=${name}`);
    let outside = 0, alpha = 0, changed = 0, masterMismatch = 0;
    const master = loadImage(`frames/${name}@2x.png`);
    requireValid(master.width === image.width * 2 && master.height === image.height * 2, `母版不是两倍画布: frame=${name}`);
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const different = image.data.subarray(i, i + 4).compare(base.data.subarray(i, i + 4)) !== 0;
      if (different) changed++;
      if (different && !rects.some(rect => rectWeight(x, y, rect) > 0)) outside++;
      if (image.data[i + 3] !== base.data[i + 3]) alpha++;
      for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
        const m = ((y * 2 + yy) * master.width + x * 2 + xx) * 4;
        if (image.data.subarray(i, i + 4).compare(master.data.subarray(m, m + 4)) !== 0) masterMismatch++;
      }
    }
    requireValid(outside === 0, `指定区域外像素改变: frame=${name}, pixels=${outside}`);
    requireValid(alpha === 0, `轮廓或透明度改变: frame=${name}, pixels=${alpha}`);
    requireValid(changed > 100, `缺少真实状态变化: frame=${name}, pixels=${changed}`);
    requireValid(masterMismatch === 0, `母版不满足最近邻两倍关系: frame=${name}, blocks=${masterMismatch}`);
    evidence.push(`${name}: changed=${changed}, outside=${outside}, alpha=${alpha}, masterMismatch=${masterMismatch}`);
  }
  const blink = loadImage('frames/sit_blink_native.png');
  const countBlue = image => {
    let total = 0;
    for (const [left, top, right, bottom] of manifest.masks.sit_blink) for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i + 2] > image.data[i] + 25 && image.data[i + 2] > image.data[i + 1] + 10) total++;
    }
    return total;
  };
  const openBlue = countBlue(baseSit), blinkBlue = countBlue(blink);
  requireValid(openBlue > 500 && blinkBlue < openBlue * 0.08, `闭眼帧仍有明显虹膜: openBlue=${openBlue}, blinkBlue=${blinkBlue}`);
  for (const [name, clip] of Object.entries(manifest.clips)) {
    const bytes = gifOverrides[name] ?? fs.readFileSync(path.join(root, clip.file));
    const gif = inspectGif(bytes), delays = clip.frameMs ?? clip.steps.map(step => step.ms);
    requireValid(gif.width === clip.canvas[0] && gif.height === clip.canvas[1], `GIF 画布不一致: clip=${name}`);
    requireValid(gif.frames.length === delays.length, `GIF 帧数不一致: clip=${name}`);
    requireValid(gif.loop === 0, `GIF 未设置循环: clip=${name}`);
    gif.frames.forEach((frame, index) => {
      requireValid(frame.disposal === 2 && frame.transparent, `GIF 清帧或透明配置错误: clip=${name}, index=${index}`);
      requireValid(frame.delay === delays[index], `GIF 时序不一致: clip=${name}, index=${index}`);
      requireValid(frame.width === gif.width && frame.height === gif.height, `GIF 帧画布不一致: clip=${name}, index=${index}`);
    });
    evidence.push(`${name}: frames=${gif.frames.length}, durationMs=${delays.reduce((n, ms) => n + ms, 0)}, loop=${gif.loop}`);
  }
  const play = manifest.clips.play_cloud.steps;
  requireValid(['approach', 'contact', 'response', 'end'].every(phase => play.some(step => step.phase === phase)), '玩耍缺少四段闭环');
  const first = play[0], last = play.at(-1);
  requireValid(['protagonist', 'companion', 'companionCenterX', 'companionFootY'].every(key => first[key] === last[key]), '玩耍首尾姿态或位置不一致');
  requireValid(manifest.placement.order.join(',') === 'protagonist,companion,sit_hug_hands', '握持时手掌层次错误');
  return { problems, evidence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = check();
  for (const line of result.evidence) console.log(line);
  for (const line of result.problems) console.error(line);
  console.log(`动画资产校验: problems=${result.problems.length}`);
  process.exitCode = result.problems.length ? 1 : 0;
}
