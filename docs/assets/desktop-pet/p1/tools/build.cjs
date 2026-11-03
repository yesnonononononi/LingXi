const { fs, path, root, sharp, W, H, parts, image, hash, writeJson, readRaw, writeMaster, over } = require('./common.cjs');
const { P0_SHA256, referencePath, supportLayers, checkReference, checkRegisteredAsset } = require('./contract.cjs');

async function raster(content) {
  const buffer = await sharp(Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><g fill="white">${content}</g></svg>`)).ensureAlpha().raw().toBuffer();
  return Uint8Array.from({ length: W * H }, (_, i) => buffer[i * 4 + 3] >= 128 ? 1 : 0);
}

function dilate(mask, radius) {
  const horizontal = new Uint8Array(W * H), result = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let count = 0;
    for (let x = -radius; x < W + radius; x++) {
      if (x + radius < W && x + radius >= 0) count += mask[y * W + x + radius];
      if (x - radius - 1 >= 0 && x - radius - 1 < W) count -= mask[y * W + x - radius - 1];
      if (x >= 0 && x < W) horizontal[y * W + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < W; x++) {
    let count = 0;
    for (let y = -radius; y < H + radius; y++) {
      if (y + radius < H && y + radius >= 0) count += horizontal[(y + radius) * W + x];
      if (y - radius - 1 >= 0 && y - radius - 1 < H) count -= horizontal[(y - radius - 1) * W + x];
      if (y >= 0 && y < H) result[y * W + x] = count > 0 ? 1 : 0;
    }
  }
  return result;
}

function fillHoles(mask) {
  const seen = new Uint8Array(W * H), queue = new Int32Array(W * H);
  let count = 0;
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) { const i = y * W + x; if (!mask[i] && !seen[i]) { seen[i] = 1; queue[count++] = i; } }
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) { const i = y * W + x; if (!mask[i] && !seen[i]) { seen[i] = 1; queue[count++] = i; } }
  for (let cursor = 0; cursor < count; cursor++) {
    const i = queue[cursor], x = i % W, y = Math.floor(i / W);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const next = ny * W + nx;
      if (!mask[next] && !seen[next]) { seen[next] = 1; queue[count++] = next; }
    }
  }
  return Uint8Array.from(mask, (value, i) => value || !seen[i] ? 1 : 0);
}

function nearestOpaque(data) {
  const nearest = new Int32Array(W * H).fill(-1), queue = new Int32Array(W * H);
  let count = 0;
  for (let i = 0; i < W * H; i++) if (data[i * 4 + 3] >= 248 && Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) >= 125) { nearest[i] = i; queue[count++] = i; }
  if (!count) throw new Error('补绘源图没有可用的不透明像素');
  for (let cursor = 0; cursor < count; cursor++) {
    const i = queue[cursor], x = i % W, y = Math.floor(i / W);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const next = ny * W + nx;
      if (nearest[next] < 0) { nearest[next] = nearest[i]; queue[count++] = next; }
    }
  }
  return nearest;
}

async function createVisibleMasks(base) {
  const tailBoundary = [[820,849],[840,854],[860,867],[880,878],[900,880],[920,874],[940,858],[950,846],[970,839],[990,848],[1007,886],[1020,866],[1030,843],[1050,846],[1070,849],[1090,846],[1110,839],[1130,826],[1150,815],[1160,794],[1170,787],[1180,799],[1190,790],[1200,755],[1210,753],[1220,723],[1230,698],[1240,673],[1250,651],[1260,646],[1280,674],[1300,705],[1320,752],[1350,815]];
  const maskTail = new Uint8Array(W * H);
  for (let y = 820; y <= 1350; y++) {
    let segment = 0;
    while (segment < tailBoundary.length - 2 && y > tailBoundary[segment + 1][0]) segment++;
    const [y0, x0] = tailBoundary[segment], [y1, x1] = tailBoundary[segment + 1];
    let left = Math.ceil(x0 + (x1 - x0) * (y - y0) / (y1 - y0));
    if (y >= 850 && y <= 1230) {
      let hairEdge = -1;
      for (let x = Math.max(0, left - 30); x <= Math.min(W - 1, left + 60); x++) {
        const offset = (y * W + x) * 4;
        if (base[offset + 3] === 255 && base[offset] < 175 && base[offset + 1] < 135 && base[offset + 2] < 130 && base[offset] - base[offset + 2] > 15) hairEdge = x;
      }
      if (hairEdge >= 0) left = hairEdge + 3;
    }
    for (let x = left; x < W; x++) if (base[(y * W + x) * 4 + 3]) maskTail[y * W + x] = 1;
  }
  const left = await raster('<path d="M225 155 L418 255 Q353 242 291 296 Q238 344 208 402 Q194 432 180 456 L145 456 L141 400 L150 354 Q154 250 225 155 Z"/>');
  const right = await raster('<path d="M543 256 L719 156 Q772 210 787 354 L810 370 L796 395 L818 423 L798 440 L775 448 L739 421 Q684 369 638 323 Q592 274 543 256 Z"/>');
  const ahoge = await raster('<path d="M338 60 H583 V201 L535 205 L526 232 L504 255 L486 277 L468 265 L458 247 L444 236 L397 234 L370 244 L367 228 L397 207 L419 201 L382 185 L345 171 Z"/>');
  const cloud = await raster('<path d="M617 444 C616 431 621 417 634 414 C634 401 647 395 660 400 C670 383 685 384 695 396 C711 393 727 403 726 417 C745 425 747 440 738 454 C734 469 721 478 707 477 C696 491 683 487 676 481 C659 489 647 484 646 480 C633 483 623 476 621 467 C617 461 615 455 617 444 Z"/>');
  const blue = new Uint8Array(W * H);
  for (let y = 410; y < 640; y++) for (let x = 705; x < 902; x++) {
    const i = y * W + x, offset = i * 4;
    if (y >= 490 && x < 720) continue;
    if (!cloud[i] && base[offset + 3] && base[offset + 2] - base[offset] > 16 && base[offset + 2] - base[offset + 1] > 3) blue[i] = 1;
  }
  const bow = fillHoles(dilate(blue, 1));
  const masks = new Map(parts.map(part => [part.id, new Uint8Array(W * H)]));
  for (let i = 0; i < W * H; i++) {
    const y = Math.floor(i / W);
    if (!base[i * 4 + 3]) continue;
    if (maskTail[i]) masks.get(y >= 1080 ? '01_tail_base' : '02_tail_tip')[i] = 1;
    if (left[i]) masks.get('03_ear_left')[i] = 1;
    if (right[i] && !cloud[i] && !bow[i]) masks.get('04_ear_right')[i] = 1;
    if (ahoge[i] && !left[i] && !right[i]) masks.get('05_ahoge')[i] = 1;
    if (bow[i] && !cloud[i]) masks.get('06_bow')[i] = 1;
  }
  return { masks, cloud, tailBoundary };
}

async function main() {
  const reference = { path: referencePath, sha256: P0_SHA256, localNative: 'source/reference-p0-native.png' };
  // 必须先校验锁定的 P0，再写任何产物，防止无意替换基准后覆盖已交付资源。
  checkReference(reference);
  for (const directory of ['support/masks', 'qa', 'tools']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  const base = await readRaw('source/reference-p0-native.png');
  const { masks, cloud, tailBoundary } = await createVisibleMasks(base);
  const owner = new Uint8Array(W * H);
  for (let index = 0; index < parts.length; index++) for (let i = 0; i < W * H; i++) if (masks.get(parts[index].id)[i]) owner[i] = index + 1;
  // 交叠处只归最前方部件所有，避免把同一条头发边缘带到两个独立部件里。
  for (let index = 0; index < parts.length; index++) for (let i = 0; i < W * H; i++) masks.get(parts[index].id)[i] = owner[i] === index + 1 ? 1 : 0;
  const body = Buffer.from(base), underpaint = Buffer.alloc(base.length), foreground = Buffer.alloc(base.length);
  const backing = await readRaw('source/backing-generated.png');
  const bowBacking = await readRaw('source/clean_plate-generated.png');
  for (let i = 0; i < W * H; i++) if (owner[i]) {
    const offset = i * 4;
    body.fill(0, offset, offset + 4);
    if (owner[i] >= 3 && base[offset + 3] === 255) {
      const fill = owner[i] === 6 ? bowBacking : backing;
      if (fill[offset + 3] > 64) {
        fill.copy(underpaint, offset, offset, offset + 4);
        if (underpaint[offset + 3] >= 248) underpaint[offset + 3] = 255;
      }
    }
  }
  const output = new Map(), records = [];
  for (const part of parts) {
    const visible = masks.get(part.id), expanded = dilate(visible, part.id.startsWith('0') && part.source.startsWith('tail') ? 45 : 22);
    const generated = await readRaw(`source/${part.source}-generated.png`), nearest = nearestOpaque(generated);
    const result = Buffer.alloc(base.length), hidden = new Uint8Array(W * H);
    let visiblePixels = 0, hiddenPixels = 0, sharedPixels = 0;
    const [sx, sy, tx, ty] = part.transform;
    for (let y = part.roi[1]; y <= part.roi[3]; y++) for (let x = part.roi[0]; x <= part.roi[2]; x++) {
      const i = y * W + x, offset = i * 4;
      if (visible[i]) { base.copy(result, offset, offset, offset + 4); visiblePixels++; continue; }
      let shared = false;
      if (part.source === 'tail_base' && y >= 1077 && y < 1080 && owner[i] === 2 && base[offset + 3] === 255) shared = true;
      if (part.source === 'tail_tip' && y >= 1080 && y < 1083 && owner[i] === 1 && base[offset + 3] === 255) shared = true;
      if (shared) { base.copy(result, offset, offset, offset + 4); sharedPixels++; continue; }
      if (!expanded[i] || base[offset + 3] !== 255 || (owner[i] && !(part.source === 'bow' && cloud[i]))) continue;
      if (part.source === 'bow' && !cloud[i]) continue;
      // 隐藏补绘只进入现有不透明遮挡物之下，不改变角色静止时的外轮廓。
      const gx = Math.max(0, Math.min(W - 1, Math.round(x * sx + tx)));
      const gy = Math.max(0, Math.min(H - 1, Math.round(y * sy + ty)));
      if (part.source === 'bow' && generated[(gy * W + gx) * 4 + 3] < 200) continue;
      const sample = nearest[gy * W + gx] * 4;
      generated.copy(result, offset, sample, sample + 3);
      result[offset + 3] = 255;
      hidden[i] = 1; hiddenPixels++;
      if (part.source === 'ahoge' || (part.source === 'bow' && cloud[i])) base.copy(foreground, offset, offset, offset + 4);
    }
    const softened = await image(result).blur(4).ensureAlpha().raw().toBuffer();
    for (let i = 0; i < W * H; i++) if (hidden[i]) softened.copy(result, i * 4, i * 4, i * 4 + 3);
    output.set(part.id, result);
    await writeMaster(`${part.id}.png`, result);
    const visibleRgba = Buffer.alloc(base.length), hiddenRgba = Buffer.alloc(base.length);
    for (let i = 0; i < W * H; i++) {
      if (visible[i]) visibleRgba.fill(255, i * 4, i * 4 + 4);
      if (hidden[i]) hiddenRgba.fill(255, i * 4, i * 4 + 4);
    }
    await writeMaster(`support/masks/${part.id}_visible.png`, visibleRgba);
    await writeMaster(`support/masks/${part.id}_hidden.png`, hiddenRgba);
    records.push({ kind: 'part', file: `${part.id}.png`, id: part.id, purpose: part.label, width: 2048, height: 3072,
      pivot: { x: part.pivot[0] * 2, y: part.pivot[1] * 2 }, allowedRegion: part.roi.map(value => value * 2),
      visiblePixelsNative: visiblePixels, hiddenPixelsNative: hiddenPixels, overlapPixelsNative: sharedPixels,
      occlusionFill: part.fill, generatedSource: `source/${part.source}-generated.png`, mirrored: false,
      visibleMask: `support/masks/${part.id}_visible.png`, hiddenMask: `support/masks/${part.id}_hidden.png`,
      sha256: hash(`${part.id}.png`), bytes: fs.statSync(path.join(root, `${part.id}.png`)).size });
  }
  for (let i = 0; i < W * H; i++) if (cloud[i] && base[i * 4 + 3]) base.copy(foreground, i * 4, i * 4, i * 4 + 4);
  await writeMaster('support/body-occluder.png', body);
  await writeMaster('support/underpainting.png', underpaint);
  await writeMaster('support/foreground-occluder.png', foreground);
  for (const layer of supportLayers) {
    const metadata = await sharp(path.join(root, layer.file)).metadata();
    records.push({ ...layer, kind: 'support', width: metadata.width, height: metadata.height,
      sha256: hash(layer.file), bytes: fs.statSync(path.join(root, layer.file)).size });
  }
  for (const record of records) checkRegisteredAsset(record);
  const scene = Buffer.from(underpaint);
  for (const id of ['01_tail_base', '02_tail_tip', '03_ear_left', '04_ear_right']) over(scene, output.get(id));
  over(scene, body); over(scene, output.get('05_ahoge')); over(scene, output.get('06_bow')); over(scene, foreground);
  await writeMaster('support/reconstructed.png', scene);
  writeJson('manifest.json', { version: 1, assetId: 'lingxi-pet-p1-v1', canvas: { width: 2048, height: 3072 }, anchor: { x: 1024, y: 2908 },
    colorSpace: 'sRGB', alpha: 'straight', sourceNativeScale: 2,
    reference,
    naming: '左右按屏幕坐标；06_bow 为右上头饰蝴蝶结，非颈部蝴蝶结。',
    renderOrder: ['support/underpainting.png', '01_tail_base.png', '02_tail_tip.png', '03_ear_left.png', '04_ear_right.png', 'support/body-occluder.png', '05_ahoge.png', '06_bow.png', 'support/foreground-occluder.png'],
    orderingNote: '不能仅按 01～06 画在完整立绘上；耳朵在前发下，云朵发夹压住头饰蝴蝶结局部，呆毛根部由发根盖片遮挡。',
    tailJoin: { y: 2160, overlapBand: { top: 2154, bottomExclusive: 2166, height: 12 }, delayMs: [120, 180] },
    tailVisibilityBoundaryNative: tailBoundary, files: records });
  console.log(JSON.stringify({ output: root, referenceSha256: P0_SHA256,
    parts: records.filter(record => record.kind === 'part').length, supportLayers: records.filter(record => record.kind === 'support').length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
