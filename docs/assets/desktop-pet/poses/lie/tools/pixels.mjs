import crypto from 'node:crypto';
import fs from 'node:fs';

export function measure(image) {
  const { width, height, data } = image;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let left = width, top = height, right = -1, bottom = -1;
  let lowAlpha = 0, visible = 0;
  const islands = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const alpha = data[index * 4 + 3];
      if (!alpha) continue;
      visible++;
      if (alpha < 8) lowAlpha++;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
      if (visited[index]) continue;
      let head = 0, tail = 1;
      queue[0] = index; visited[index] = 1;
      while (head < tail) {
        const current = queue[head++];
        const cx = current % width, cy = Math.floor(current / width);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const next = ny * width + nx;
            if (visited[next] || !data[next * 4 + 3]) continue;
            visited[next] = 1; queue[tail++] = next;
          }
        }
      }
      if (tail < 4) islands.push(Array.from(queue.subarray(0, tail)));
    }
  }
  return { bbox: { left, top, right, bottom }, visible, lowAlpha, islands };
}

export function clean(image) {
  let clearedLowAlpha = 0, solidifiedInterior = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3];
    if (alpha < 8) {
      if (alpha) clearedLowAlpha++;
      image.data.fill(0, i, i + 4);
    } else if (alpha >= 248 && alpha < 255) {
      image.data[i + 3] = 255; solidifiedInterior++;
    }
  }
  const islands = measure(image).islands;
  for (const island of islands) for (const index of island) image.data.fill(0, index * 4, index * 4 + 4);
  return { clearedLowAlpha, solidifiedInterior, removedTinyIslands: islands.length };
}

export function describe(file, image) {
  const bytes = fs.readFileSync(file);
  return { width: image.width, height: image.height, bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bbox: measure(image).bbox };
}
