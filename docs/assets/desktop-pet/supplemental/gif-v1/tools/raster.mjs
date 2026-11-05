import { writeFileSync } from 'node:fs';

export function blank(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

export function resize(image, width, height) {
  const out = blank(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.max(0, Math.min(image.width - 1, (x + 0.5) * image.width / width - 0.5));
    const sy = Math.max(0, Math.min(image.height - 1, (y + 0.5) * image.height / height - 0.5));
    const ix = Math.floor(sx), iy = Math.floor(sy), dx = sx - ix, dy = sy - iy;
    const sums = [0, 0, 0, 0];
    for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
      const i = (Math.min(image.height - 1, iy + yy) * image.width + Math.min(image.width - 1, ix + xx)) * 4;
      const weight = (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy), a = image.data[i + 3] / 255;
      for (let c = 0; c < 3; c++) sums[c] += image.data[i + c] * a * weight;
      sums[3] += a * weight;
    }
    const d = (y * width + x) * 4;
    if (sums[3] > 0) for (let c = 0; c < 3; c++) out.data[d + c] = Math.round(sums[c] / sums[3]);
    out.data[d + 3] = Math.round(sums[3] * 255);
  }
  return out;
}

export function enlarge(image) {
  const out = blank(image.width * 2, image.height * 2);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const src = (Math.floor(y / 2) * image.width + Math.floor(x / 2)) * 4;
    image.data.copy(out.data, (y * out.width + x) * 4, src, src + 4);
  }
  return out;
}

export function overlay(target, image, left = 0, top = 0) {
  left = Math.round(left); top = Math.round(top);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const tx = x + left, ty = y + top;
    if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
    const s = (y * image.width + x) * 4, d = (ty * target.width + tx) * 4;
    const a = image.data[s + 3] / 255, b = target.data[d + 3] / 255, result = a + b * (1 - a);
    if (!result) continue;
    for (let c = 0; c < 3; c++) target.data[d + c] = Math.round((image.data[s + c] * a + target.data[d + c] * b * (1 - a)) / result);
    target.data[d + 3] = Math.round(result * 255);
  }
  return target;
}

export function rectWeight(x, y, rect) {
  const [left, top, right, bottom, feather = 0] = rect;
  if (x < left || x >= right || y < top || y >= bottom) return 0;
  if (!feather) return 1;
  return Math.min(1, (x - left) / feather, (right - 1 - x) / feather, (y - top) / feather, (bottom - 1 - y) / feather);
}

// 只取指定区域的生成像素，外侧和 alpha 始终来自已验收原图。
export function patch(base, generated, rects) {
  const candidate = generated.width === base.width && generated.height === base.height ? generated : resize(generated, base.width, base.height);
  const out = { ...base, data: Buffer.from(base.data) };
  for (let y = 0; y < base.height; y++) for (let x = 0; x < base.width; x++) {
    const i = (y * base.width + x) * 4;
    const weight = Math.max(0, ...rects.map(rect => rectWeight(x, y, rect)));
    if (!weight || !base.data[i + 3] || candidate.data[i + 3] < 248) continue;
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(base.data[i + c] * (1 - weight) + candidate.data[i + c] * weight);
  }
  return out;
}

export function cut(image, rects) {
  const out = blank(image.width, image.height);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4;
    const weight = Math.max(0, ...rects.map(rect => rectWeight(x, y, rect)));
    if (weight) {
      image.data.copy(out.data, i, i, i + 4);
      out.data[i + 3] = Math.round(image.data[i + 3] * weight);
    }
  }
  return out;
}

function makePalette(frames) {
  const histogram = new Map();
  for (const frame of frames) for (let i = 0; i < frame.data.length; i += 4) {
    if (frame.data[i + 3] < 128) continue;
    const r = frame.data[i], g = frame.data[i + 1], b = frame.data[i + 2];
    const key = (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3);
    const entry = histogram.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    entry.count++; entry.r += r; entry.g += g; entry.b += b; histogram.set(key, entry);
  }
  const colors = [...histogram.values()].map(p => ({ count: p.count, rgb: [p.r / p.count, p.g / p.count, p.b / p.count] }));
  const boxes = [colors];
  while (boxes.length < 255) {
    let choice = -1, axis = 0, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      for (let c = 0; c < 3; c++) {
        const values = boxes[i].map(p => p.rgb[c]);
        const score = (Math.max(...values) - Math.min(...values)) * Math.sqrt(boxes[i].reduce((n, p) => n + p.count, 0));
        if (score > best) { choice = i; axis = c; best = score; }
      }
    }
    if (choice < 0) break;
    const box = boxes[choice].sort((a, b) => a.rgb[axis] - b.rgb[axis]);
    const half = box.reduce((n, p) => n + p.count, 0) / 2;
    let sum = 0, split = 1;
    for (; split < box.length - 1; split++) { sum += box[split - 1].count; if (sum >= half) break; }
    boxes.splice(choice, 1, box.slice(0, split), box.slice(split));
  }
  const palette = [[0, 0, 0], ...boxes.map(box => {
    const total = box.reduce((n, p) => n + p.count, 0);
    return [0, 1, 2].map(c => Math.round(box.reduce((n, p) => n + p.rgb[c] * p.count, 0) / total));
  })];
  while (palette.length < 256) palette.push(palette.at(-1));
  return palette;
}

// 字典在 9 位边界前重置，避免跨码宽实现差异；透明整帧按 disposal=2 清除。
function compress(indices) {
  const bytes = []; let bits = 0, count = 0;
  const emit = code => { bits |= code << count; count += 9; while (count >= 8) { bytes.push(bits & 255); bits >>>= 8; count -= 8; } };
  let table = new Map(), next = 258, prefix = indices[0];
  emit(256);
  for (let i = 1; i < indices.length; i++) {
    const value = indices[i], key = prefix * 256 + value, found = table.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next < 500) table.set(key, next++);
    else { emit(256); table = new Map(); next = 258; }
    prefix = value;
  }
  emit(prefix); emit(257); if (count) bytes.push(bits & 255);
  const blocks = [Buffer.from([8])];
  for (let i = 0; i < bytes.length; i += 255) { const part = bytes.slice(i, i + 255); blocks.push(Buffer.from([part.length, ...part])); }
  blocks.push(Buffer.from([0]));
  return Buffer.concat(blocks);
}

export function encodeGif(file, frames, delays) {
  const { width, height } = frames[0], palette = makePalette(frames), lookup = new Int16Array(32768).fill(-1);
  const word = n => [n & 255, n >> 8];
  const buffers = [Buffer.from('GIF89a'), Buffer.from([...word(width), ...word(height), 0xf7, 0, 0]), Buffer.from(palette.flat()),
    Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0])];
  frames.forEach((frame, index) => {
    const indices = Buffer.alloc(width * height);
    for (let p = 0; p < indices.length; p++) {
      const i = p * 4;
      if (frame.data[i + 3] < 128) continue;
      const r = frame.data[i], g = frame.data[i + 1], b = frame.data[i + 2], key = (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3);
      if (lookup[key] < 0) {
        let closest = 1, distance = Infinity;
        for (let k = 1; k < palette.length; k++) {
          const rgb = palette[k], delta = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
          if (delta < distance) { closest = k; distance = delta; }
        }
        lookup[key] = closest;
      }
      indices[p] = lookup[key];
    }
    buffers.push(Buffer.from([0x21, 0xf9, 4, 9, ...word(Math.round(delays[index] / 10)), 0, 0]),
      Buffer.from([0x2c, 0, 0, 0, 0, ...word(width), ...word(height), 0]), compress(indices));
  });
  buffers.push(Buffer.from([0x3b]));
  writeFileSync(file, Buffer.concat(buffers));
}
