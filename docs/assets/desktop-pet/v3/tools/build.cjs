const { fs, path, root, loadDependency, writeJson, hash, expressions } = require('./common.cjs');
const sharp = loadDependency('sharp');
const { writePsdBuffer, readPsd } = loadDependency('ag-psd');
sharp.concurrency(2);

const W = 1024;
const H = 1536;
const HEAD_END = 744;
const crop = { left: 288, top: 540, width: 380, height: 184 };
const pngOptions = { compressionLevel: 9, adaptiveFiltering: true, palette: false };

function createImage(data, width = W, height = H) {
  return sharp(data, { raw: { width, height, channels: 4 } });
}

async function writeMaster(data, file) {
  // 母版只复制原像素，避免插值改变对齐基准和窄尾尖的边界。
  const pixels = toPixelData(data);
  await createImage(pixels.data, pixels.width, pixels.height)
    .withIccProfile('srgb').png(pngOptions).toFile(path.join(root, file));
}

function cleanAlpha(data) {
  const result = Buffer.from(data);
  let cleared = 0;
  let solidified = 0;
  for (let offset = 0; offset < result.length; offset += 4) {
    if (result[offset + 3] <= 8) {
      if (result[offset + 3] > 0) cleared++;
      result.fill(0, offset, offset + 4);
    } else if (result[offset + 3] >= 248) {
      if (result[offset + 3] < 255) solidified++;
      result[offset + 3] = 255;
    }
  }
  // 仅清理完全孤立的四像素以下噪点，不切割半透明发丝。
  const visited = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let removedIslands = 0;
  for (let pixel = 0; pixel < W * H; pixel++) {
    if (visited[pixel] || !result[pixel * 4 + 3]) continue;
    let count = 1;
    let cursor = 0;
    stack[0] = pixel;
    visited[pixel] = 1;
    while (cursor < count) {
      const current = stack[cursor++];
      const x = current % W;
      const y = Math.floor(current / W);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const next = ny * W + nx;
        if (!visited[next] && result[next * 4 + 3]) {
          visited[next] = 1;
          stack[count++] = next;
        }
      }
    }
    if (count <= 4) {
      removedIslands++;
      for (let i = 0; i < count; i++) result.fill(0, stack[i] * 4, stack[i] * 4 + 4);
    }
  }
  return { data: result, report: { clearedLowAlphaPixels: cleared, solidifiedInteriorPixels: solidified,
    removedTinyIslands: removedIslands, threshold: 8, solidThreshold: 248 } };
}

async function createMasks() {
  const eyes = '<path d="M294 588 Q322 545 372 547 Q416 547 436 590 L444 638 Q439 679 400 681 L346 683 Q304 674 296 635 Z"/><path d="M520 578 Q545 540 592 541 Q637 542 660 580 L662 628 Q649 673 610 680 L557 679 Q522 667 518 623 Z"/>';
  const mouth = '<ellipse cx="479" cy="690" rx="37" ry="34"/>';
  const cheeks = '<ellipse cx="373" cy="686" rx="58" ry="25"/><ellipse cx="580" cy="683" rx="58" ry="26"/>';
  const masks = {};
  for (const [name, content] of [['eyes', eyes], ['face', eyes + mouth + cheeks]]) {
    const svg = `<svg width="1024" height="1536" xmlns="http://www.w3.org/2000/svg"><g fill="white">${content}</g></svg>`;
    masks[name] = await sharp(Buffer.from(svg)).blur(1.2).ensureAlpha().raw().toBuffer();
  }
  return masks;
}

async function assembleExpression(base, id, masks) {
  const result = Buffer.from(base);
  if (id === 'E1_default') return result;
  const edit = await sharp(path.join(root, `source/edits/${id}.png`)).ensureAlpha().raw().toBuffer();
  const mask = masks[id === 'E2_blink' ? 'eyes' : 'face'];
  for (let y = crop.top; y < crop.top + crop.height; y++) {
    for (let x = crop.left; x < crop.left + crop.width; x++) {
      const offset = (y * W + x) * 4;
      const local = ((y - crop.top) * crop.width + x - crop.left) * 4;
      const weight = mask[offset + 3] / 255;
      for (let channel = 0; channel < 3; channel++) {
        result[offset + channel] = Math.round(base[offset + channel] * (1 - weight) + edit[local + channel] * weight);
      }
    }
  }
  return result;
}

function extractHead(frame) {
  const head = Buffer.from(frame);
  head.fill(0, W * HEAD_END * 4);
  return head;
}

function toPixelData(data) {
  const scaled = new Uint8Array(W * H * 16);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const offset = (y * W + x) * 4;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      scaled.set(data.subarray(offset, offset + 4), ((y * 2 + dy) * W * 2 + x * 2 + dx) * 4);
    }
  }
  return { width: W * 2, height: H * 2, data: scaled };
}

async function createPalette(base) {
  const ref = await sharp(path.join(root, 'source/design-reference.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const groups = [
    ['hair', '头发', [[450, 350], [580, 410]], 'v2'],
    ['skin', '皮肤', [[480, 712], [465, 660]], 'v2'],
    ['robe', '长袍', [[410, 940], [397, 888]], 'v2'],
    ['scarf', '围巾', [[306, 807], [650, 806]], 'v2'],
    ['inner_ear', '内耳', [[250, 240], [695, 250]], 'v2'],
    ['paw_pad', '肉垫', [[205, 533], [197, 511]], 'design-reference'],
    ['outline', '描边', [[494, 81], [500, 81]], 'v2'],
  ];
  const materials = groups.map(([id, label, points, source]) => ({
    id, label, source, samples: points.map(([x, y]) => {
      const input = source === 'v2' ? base : ref.data;
      const width = source === 'v2' ? W : ref.info.width;
      const offset = (y * width + x) * 4;
      return { x, y, hex: `#${Array.from(input.subarray(offset, offset + 3), value => value.toString(16).padStart(2, '0')).join('').toUpperCase()}` };
    }),
  }));
  writeJson('palette.json', { version: 1, colorSpace: 'sRGB', sampleCoordinates: '原始源图像素坐标',
    note: '立绘可见材质从 v2 实取；站姿未露出肉垫，肉垫仅从设定稿取样，不能用于声称 v2 存在该材质。', materials });
  return materials;
}

async function writePsd(base, frames, materials) {
  const paletteLayers = materials.map((material, i) => {
    const data = Buffer.alloc(W * H * 4);
    const rgb = material.samples[0].hex.slice(1).match(/../g).map(hex => parseInt(hex, 16));
    for (let y = 20; y < 70; y++) for (let x = 20 + i * 135; x < 130 + i * 135; x++) {
      const offset = (y * W + x) * 4;
      data.set([...rgb, 255], offset);
    }
    return { name: `${material.id}_${material.samples[0].hex}`, imageData: toPixelData(data), left: 0, top: 0 };
  });
  const icc = (await sharp(path.join(root, 'front-standing.png')).metadata()).icc;
  const psd = { width: W * 2, height: H * 2, bitsPerChannel: 8, colorMode: 3,
    imageData: toPixelData(base), imageResources: { iccProfile: icc },
    children: [
      { name: 'palette_srgb_reference', hidden: true, children: paletteLayers },
      ...expressions.slice(1).reverse().map(([id]) => {
        const patch = Buffer.alloc(W * H * 4);
        const frame = frames.get(id);
        // PSD 只保存脸区替换层，避免重复存储七份相同头发；导出贴片仍是完整头部。
        for (let y = crop.top; y < crop.top + crop.height; y++) {
          const start = (y * W + crop.left) * 4;
          frame.copy(patch, start, start, start + crop.width * 4);
        }
        return { name: id, hidden: true, left: 0, top: 0, imageData: toPixelData(patch) };
      }),
      { name: 'front_standing_base', left: 0, top: 0, imageData: toPixelData(base) },
    ] };
  fs.writeFileSync(path.join(root, 'psd/pet_p0.psd'), writePsdBuffer(psd, { trimImageData: false, compress: true }));
  const reopened = readPsd(fs.readFileSync(path.join(root, 'psd/pet_p0.psd')), {
    useImageData: true, skipCompositeImageData: false, skipThumbnail: true });
  const baseLayer = reopened.children.find(layer => layer.name === 'front_standing_base');
  if (Buffer.compare(Buffer.from(baseLayer.imageData.data), Buffer.from(psd.imageData.data)) !== 0) {
    throw new Error('PSD 复读后的立绘图层与母版不一致');
  }
}

async function buildPreviews(frames, materials) {
  const cells = [];
  for (let i = 0; i < expressions.length; i++) {
    const [id, , label] = expressions[i];
    for (let row = 0; row < 2; row++) {
      const dark = row === 1;
      const bg = dark ? '#1a1a2e' : '#f5f5f7';
      const foreground = await createImage(frames.get(id)).resize(156, 234).png().toBuffer();
      const labelSvg = Buffer.from(`<svg width="200" height="36" xmlns="http://www.w3.org/2000/svg"><text x="100" y="25" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="16" fill="${dark ? '#e4e7ef' : '#564d50'}">${i + 1} ${label}</text></svg>`);
      const cell = await sharp({ create: { width: 200, height: 292, channels: 4, background: bg } })
        .composite([{ input: foreground, left: 22, top: 10 }, { input: labelSvg, left: 0, top: 250 }]).png().toBuffer();
      cells.push({ input: cell, left: i * 200, top: row * 292 });
    }
  }
  await sharp({ create: { width: 1600, height: 584, channels: 4, background: '#f5f5f7' } })
    .composite(cells).png().toFile(path.join(root, 'qa/expressions-208px.png'));
  const faces = [];
  for (let i = 0; i < expressions.length; i++) {
    const input = await createImage(frames.get(expressions[i][0])).extract({ left: 270, top: 530, width: 410, height: 215 })
      .flatten({ background: '#f5f5f7' }).png().toBuffer();
    faces.push({ input, left: (i % 4) * 410, top: Math.floor(i / 4) * 215 });
  }
  await sharp({ create: { width: 1640, height: 430, channels: 4, background: '#f5f5f7' } })
    .composite(faces).png().toFile(path.join(root, 'qa/faces-detail.png'));
  const swatches = materials.map((material, i) => `<rect x="${i * 190 + 12}" y="12" width="166" height="92" rx="8" fill="${material.samples[0].hex}" stroke="#d5cacc"/><text x="${i * 190 + 95}" y="132" text-anchor="middle">${material.label}</text><text x="${i * 190 + 95}" y="159" text-anchor="middle">${material.samples[0].hex}</text>`).join('');
  await sharp(Buffer.from(`<svg width="1330" height="185" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f5f5f7"/><g font-family="Microsoft YaHei, sans-serif" font-size="17" fill="#564d50">${swatches}</g></svg>`))
    .png().toFile(path.join(root, 'qa/palette.png'));
}

async function main() {
  for (const dir of ['expr', 'runtime/expressions', 'runtime/composites', 'psd', 'qa']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const original = await sharp(path.join(root, 'source/front-standing-v2.png')).ensureAlpha().raw().toBuffer();
  const cleaned = cleanAlpha(original);
  const base = cleaned.data;
  const body = Buffer.from(base);
  body.fill(0, 0, W * HEAD_END * 4);
  const masks = await createMasks();
  const heads = new Map();
  const frames = new Map();
  const files = [];
  async function register(file, purpose, extra = {}) {
    const meta = await sharp(path.join(root, file)).metadata();
    files.push({ file, purpose, width: meta.width, height: meta.height, bytes: fs.statSync(path.join(root, file)).size, sha256: hash(file), ...extra });
  }
  await writeMaster(base, 'front-standing.png');
  await writeMaster(body, 'body-without-head.png');
  await register('front-standing.png', '默认站姿母版');
  await register('body-without-head.png', '与整头贴片无重叠的身体底图');
  for (const [id, expressionId] of expressions) {
    const frame = await assembleExpression(base, id, masks);
    const head = extractHead(frame);
    frames.set(id, frame);
    heads.set(id, head);
    await writeMaster(head, `expr/${id}.png`);
    await register(`expr/${id}.png`, '同画布整头表情贴片', { expressionId });
    for (const [scale, width, height] of [['1x', 160, 240], ['2x', 320, 480]]) {
      const resized = await createImage(frame).resize(width, height).ensureAlpha().raw().toBuffer();
      const resizedHead = Buffer.from(resized);
      resizedHead.fill(0, width * Math.round(HEAD_END / H * height) * 4);
      // 先缩放完整帧再分离，避免两层各自采样在分界线制造重叠的半透明边缘。
      for (const [folder, data] of [['expressions', resizedHead], ['composites', resized]]) {
        const file = `runtime/${folder}/${expressionId}@${scale}.webp`;
        await createImage(data, width, height).webp({ lossless: true, effort: 6 }).toFile(path.join(root, file));
        await register(file, folder === 'expressions' ? '运行时整头贴片' : '运行时完整表情帧', { expressionId });
      }
    }
  }
  for (const [scale, width, height] of [['1x', 160, 240], ['2x', 320, 480]]) {
    const resized = await createImage(base).resize(width, height).ensureAlpha().raw().toBuffer();
    const resizedBody = Buffer.from(resized);
    resizedBody.fill(0, 0, width * Math.round(HEAD_END / H * height) * 4);
    for (const [name, data] of [['front-standing', resized], ['body-without-head', resizedBody]]) {
      const file = `runtime/${name}@${scale}.webp`;
      await createImage(data, width, height).webp({ lossless: true, effort: 6 }).toFile(path.join(root, file));
      await register(file, '运行时立绘或身体底图');
    }
  }
  const materials = await createPalette(base);
  await writePsd(base, frames, materials);
  await buildPreviews(frames, materials);
  files.push({ file: 'psd/pet_p0.psd', purpose: 'P0 表情合成及色板工程，不是语义拆层或 Cubism 模型', width: 2048, height: 3072,
    bytes: fs.statSync(path.join(root, 'psd/pet_p0.psd')).size, sha256: hash('psd/pet_p0.psd') });
  writeJson('manifest.json', { version: 3, assetId: 'lingxi-pet-p0-v3', scope: 'P0', canvas: { width: 2048, height: 3072 },
    anchor: { x: 1024, y: 2908 }, headRegion: { left: 0, top: 0, width: 2048, height: HEAD_END * 2 },
    nativeSourceCanvas: { width: W, height: H }, masterScale: { factor: 2, kernel: 'nearest', addsDetail: false },
    colorSpace: 'sRGB', alpha: 'straight', expressionIds: expressions.map(([, id]) => id),
    composition: '优先使用完整 WebP 帧；PNG 整头与 body-without-head 无重叠合成。不要把整头叠在完整立绘的半透明边缘上。',
    blink: { open: 'neutral', closed: 'blink', half: 'sleepy', eyeRegionNative: { left: 288, top: 540, width: 380, height: 138 } },
    nativeFaceEditCrop: crop, alphaCleanup: cleaned.report,
    deferred: ['P1 尾巴、双耳、呆毛及蝴蝶结独立补绘', 'P2 语义分层、三视图及 Cubism 绑定', '60px 迷你画与桌面跟随'], files });
  writeJson('runtime/manifest.json', { version: 3, assetId: 'lingxi-pet-p0-v3-runtime',
    usage: 'composites 是已合成的完整角色帧；expressions 是整头，需与 body-without-head 合成。眨眼只替换眼区，不替换 sleepy 的嘴。',
    anchorNormalized: { x: 0.5, y: 2908 / 3072 }, headEndByScale: { '1x': 116, '2x': 233 },
    files: files.filter(entry => entry.file.startsWith('runtime/')).map(entry => ({ ...entry, file: entry.file.slice(8) })) });
  console.log(JSON.stringify({ output: root, images: files.length, modelBytes: files.reduce((sum, entry) => sum + entry.bytes, 0), alphaCleanup: cleaned.report }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
