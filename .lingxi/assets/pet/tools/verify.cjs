const assert = require('node:assert/strict');
const { fs, path, root, loadDependency, writeJson, hash, expressions } = require('./common.cjs');
const sharp = loadDependency('sharp');
const { readPsd } = loadDependency('ag-psd');
const WIDTH = 2048;
const HEIGHT = 3072;
const HEAD_END = 1488;

function checkPngHeader(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名不正确');
  assert.equal(buffer.readUInt32BE(16), WIDTH, '母版宽度不正确');
  assert.equal(buffer.readUInt32BE(20), HEIGHT, '母版高度不正确');
  assert.equal(buffer[24], 8, '母版必须是 8 位通道');
  assert.equal(buffer[25], 6, '母版必须是 RGBA，不能是索引色');
  let hasSrgb = false;
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    assert.ok(offset + length + 12 <= buffer.length, 'PNG 块越界');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const payload = buffer.subarray(offset + 8, offset + 8 + length);
    if (['tEXt', 'zTXt', 'iTXt'].includes(type)) assert.fail('母版不应包含文本元数据块');
    if (type === 'sRGB' || type === 'iCCP') hasSrgb = true;
    offset += length + 12;
  }
  assert.ok(hasSrgb, '母版必须声明 sRGB 色彩空间');
}

function checkTransparentEdges(data) {
  for (let x = 0; x < WIDTH; x++) {
    assert.equal(data[x * 4 + 3], 0, '顶部贴边');
    assert.equal(data[((HEIGHT - 1) * WIDTH + x) * 4 + 3], 0, '底部贴边');
  }
  for (let y = 0; y < HEIGHT; y++) {
    assert.equal(data[y * WIDTH * 4 + 3], 0, '左侧贴边');
    assert.equal(data[(y * WIDTH + WIDTH - 1) * 4 + 3], 0, '右侧贴边');
  }
}

function checkInventory(manifest, inventory) {
  assert.equal(manifest.version, 3);
  assert.ok(manifest.assetId);
  assert.deepEqual(manifest.canvas, { width: WIDTH, height: HEIGHT });
  assert.deepEqual(manifest.anchor, { x: 1024, y: 2908 });
  for (const [id, expressionId] of expressions) {
    const file = `expr/${id}.png`;
    assert.ok(manifest.files.some(entry => entry.file === file && entry.expressionId === expressionId), `表情清单缺少 ${id}`);
    assert.ok(inventory.includes(file), `磁盘缺少表情 ${id}`);
  }
  assert.equal(new Set(manifest.files.map(entry => entry.file)).size, manifest.files.length, '清单文件重复');
  for (const entry of manifest.files) {
    assert.match(entry.file, /^[\x20-\x7e]+$/, '资源路径必须是 ASCII');
    assert.ok(!entry.file.includes('..') && !path.isAbsolute(entry.file), '资源路径越界');
    assert.ok(entry.purpose && entry.width && entry.height && entry.sha256, '资源清单缺少用途、尺寸或摘要');
    assert.ok(inventory.includes(entry.file), `磁盘缺少 ${entry.file}`);
  }
  const known = new Set(manifest.files.map(entry => entry.file));
  for (const file of inventory) {
    assert.match(file, /^[\x20-\x7e]+$/, '存在非 ASCII 文件路径');
    if (/^(expr\/|runtime\/|front-standing\.png$|body-without-head\.png$)/.test(file) && /\.(png|webp)$/.test(file)) {
      assert.ok(known.has(file), `存在未登记的交付图片 ${file}`);
    }
  }
}

function collectFiles(directory, prefix = '') {
  const result = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name === '.git') continue;
    const relative = `${prefix}${item.name}`;
    if (item.isDirectory()) result.push(...collectFiles(path.join(directory, item.name), `${relative}/`));
    else result.push(relative);
  }
  return result;
}

function clearHiddenRgb(data) {
  // WebP 编码器可以重写全透明像素的 RGB，比较时先统一不可见数据。
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) data.fill(0, offset, offset + 3);
  }
  return data;
}

function runCanaries(baseHeader, basePixels, manifest, inventory) {
  const rgba = Buffer.from(baseHeader);
  rgba[25] = 3;
  assert.throws(() => checkPngHeader(rgba), /RGBA/);
  const textChunk = Buffer.concat([Buffer.from([0, 0, 0, 6]), Buffer.from('tEXt'), Buffer.from([0, 0xe4, 0xb8, 0xad, 0, 0]), Buffer.alloc(4)]);
  const withNulText = Buffer.concat([baseHeader.subarray(0, 33), textChunk, baseHeader.subarray(33)]);
  assert.throws(() => checkPngHeader(withNulText), /文本元数据/);
  const edge = Buffer.from(basePixels);
  edge[3] = 255;
  assert.throws(() => checkTransparentEdges(edge), /贴边/);
  const missing = structuredClone(manifest);
  missing.files = missing.files.filter(entry => entry.file !== 'expr/E8_sleepy.png');
  assert.throws(() => checkInventory(missing, inventory.filter(file => file !== 'expr/E8_sleepy.png')), /E8_sleepy/);
  assert.throws(() => checkInventory(manifest, [...inventory, 'expr/nested/unlisted.png']), /未登记/);
  console.log('金丝雀通过: RGBA 退化、含 NUL 的文本块、边缘污染、漏表情、嵌套目录漏登记均被拒绝');
  return ['indexed-color', 'nul-text-chunk', 'opaque-corner', 'missing-expression', 'nested-unlisted-file'];
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const inventory = collectFiles(root);
  const baseHeader = fs.readFileSync(path.join(root, 'front-standing.png'));
  const base = await sharp(baseHeader).ensureAlpha().raw().toBuffer();
  const canaries = runCanaries(baseHeader, base, manifest, inventory);
  if (process.argv.includes('--canaries')) return;
  checkInventory(manifest, inventory);
  let pngCount = 0;
  let webpCount = 0;
  const modelBytes = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
  assert.ok(modelBytes <= 25 * 1024 * 1024, `模型超过 25MB: ${modelBytes}`);
  for (const entry of manifest.files) {
    const file = path.join(root, entry.file);
    assert.equal(hash(entry.file), entry.sha256, `${entry.file} 摘要不一致`);
    assert.equal(fs.statSync(file).size, entry.bytes, `${entry.file} 文件大小不一致`);
    if (entry.file.endsWith('.psd')) continue;
    const meta = await sharp(file).metadata();
    assert.equal(meta.width, entry.width, `${entry.file} 宽度不一致`);
    assert.equal(meta.height, entry.height, `${entry.file} 高度不一致`);
    assert.ok(meta.hasAlpha, `${entry.file} 丢失透明通道`);
    if (entry.file.endsWith('.png')) {
      pngCount++;
      assert.ok(entry.bytes <= 2 * 1024 * 1024, `${entry.file} 超过 2MB`);
      checkPngHeader(fs.readFileSync(file));
      const data = await sharp(file).ensureAlpha().raw().toBuffer();
      checkTransparentEdges(data);
    } else webpCount++;
  }
  const body = await sharp(path.join(root, 'body-without-head.png')).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < WIDTH * HEAD_END * 4; i++) assert.equal(body[i], 0, '身体底图残留头部像素');
  let left = WIDTH, top = HEIGHT, right = -1, bottom = -1;
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    if (base[(y * WIDTH + x) * 4 + 3] >= 128) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  const bounds = { left, top, right, bottom };
  for (const [key, expected] of Object.entries({ left: 18, top: 80, right: 1019, bottom: 1454 })) {
    assert.ok(Math.abs(bounds[key] / 2 - expected) <= 2, `${key} 可见边界偏离 v2`);
  }
  assert.ok(WIDTH - 1 - right >= 8, '尾尖安全边距不足');
  const details = [];
  for (const [id, expressionId] of expressions) {
    const head = await sharp(path.join(root, `expr/${id}.png`)).ensureAlpha().raw().toBuffer();
    let changed = 0;
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 4;
      if (y >= HEAD_END) {
        for (let channel = 0; channel < 4; channel++) assert.equal(head[offset + channel], 0, `${id} 头区外不透明`);
        continue;
      }
      assert.equal(head[offset + 3], base[offset + 3], `${id} 头部轮廓或透明度改变`);
      const differs = head[offset] !== base[offset] || head[offset + 1] !== base[offset + 1] || head[offset + 2] !== base[offset + 2];
      if (differs) {
        changed++;
        assert.ok(x >= 576 && x < 1336 && y >= 1080 && y < 1448, `${id} 改到了规定面部区域外`);
        if (id === 'E2_blink') assert.ok(x < 890 || x > 1020, '眨眼修改了嘴部');
      }
    }
    if (id === 'E1_default') assert.equal(changed, 0, 'E1 必须与立绘完全一致');
    else assert.ok(changed > 1000, `${id} 缺少实际表情变化`);
    const composite = Buffer.concat([head.subarray(0, WIDTH * HEAD_END * 4), body.subarray(WIDTH * HEAD_END * 4)]);
    if (id === 'E1_default') assert.equal(Buffer.compare(composite, base), 0, '身体与 E1 的无重叠合成不等于立绘');
    const skinOffset = (1460 * WIDTH + 960) * 4;
    assert.equal(Buffer.compare(head.subarray(skinOffset, skinOffset + 4), base.subarray(skinOffset, skinOffset + 4)), 0, '皮肤调色锚偏移');
    details.push({ expressionId, changedPixels: changed, silhouetteChangedPixels: 0 });
  }
  for (const [scale, width, height, headEnd] of [['1x', 160, 240, 116], ['2x', 320, 480, 233]]) {
    const runtimeBody = clearHiddenRgb(await sharp(path.join(root, `runtime/body-without-head@${scale}.webp`)).ensureAlpha().raw().toBuffer());
    const split = width * headEnd * 4;
    assert.ok(runtimeBody.subarray(0, split).every(value => value === 0), '运行时身体残留头区像素');
    for (const [, expressionId] of expressions) {
      const runtimeHead = clearHiddenRgb(await sharp(path.join(root, `runtime/expressions/${expressionId}@${scale}.webp`)).ensureAlpha().raw().toBuffer());
      const full = clearHiddenRgb(await sharp(path.join(root, `runtime/composites/${expressionId}@${scale}.webp`)).ensureAlpha().raw().toBuffer());
      assert.ok(runtimeHead.subarray(split).every(value => value === 0), '运行时头部残留身体像素');
      const assembled = Buffer.concat([runtimeHead.subarray(0, split), runtimeBody.subarray(split)]);
      assert.equal(assembled.length, width * height * 4);
      assert.equal(Buffer.compare(assembled, full), 0, `运行时 ${expressionId}@${scale} 分层重组不一致`);
    }
  }
  const psd = readPsd(fs.readFileSync(path.join(root, 'psd/pet_p0.psd')), {
    useImageData: true, skipThumbnail: true });
  assert.equal(psd.width, WIDTH); assert.equal(psd.height, HEIGHT);
  const psdBase = psd.children.find(layer => layer.name === 'front_standing_base');
  assert.equal(Buffer.compare(Buffer.from(psdBase.imageData.data), base), 0, 'PSD 立绘图层不等于母版');
  // PSD 缓存合成图带白色衬底，低透明度会放大量化误差；按合成后的可见误差验收，图层自身仍须无损。
  let psdCompositeMaxRgbDelta = 0;
  let psdCompositeMaxVisibleDelta = 0;
  for (let i = 0; i < base.length; i += 4) {
    assert.equal(psd.imageData.data[i + 3], base[i + 3], 'PSD 缓存合成图透明度变化');
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(psd.imageData.data[i + channel] - base[i + channel]);
      psdCompositeMaxRgbDelta = Math.max(psdCompositeMaxRgbDelta, delta);
      const visibleDelta = delta * base[i + 3] / 255;
      psdCompositeMaxVisibleDelta = Math.max(psdCompositeMaxVisibleDelta, visibleDelta);
      assert.ok(base[i + 3] === 255 ? delta === 0 : visibleDelta <= 1.5, 'PSD 缓存合成图色差超出半透明量化范围');
    }
  }
  for (const layer of psd.children) {
    if (layer.children) continue;
    assert.deepEqual([layer.left, layer.top, layer.right, layer.bottom], [0, 0, WIDTH, HEIGHT], 'PSD 图层被裁边');
  }
  assert.equal(psd.children[0].children.length, 7, 'PSD 缺少材质色板');
  const palette = JSON.parse(fs.readFileSync(path.join(root, 'palette.json'), 'utf8'));
  assert.deepEqual(palette.materials.map(material => material.id), ['hair', 'skin', 'robe', 'scarf', 'inner_ear', 'paw_pad', 'outline']);
  const report = { status: 'passed', assetId: manifest.assetId, canaries, coverage: { inventoryFiles: inventory.length, masterPngs: pngCount, runtimeWebps: webpCount },
    modelBytes, visibleBoundsAlpha128: bounds, anchor: manifest.anchor, psdCompositeMaxRgbDelta, psdCompositeMaxVisibleDelta,
    checks: ['RGBA8、sRGB、同画布', '完整边缘透明扫描', '8 档清单及摘要', '每 PNG ≤2MB、模型 ≤25MB',
      'v2 可见边界与尾尖留白', 'E1 无损重组', '8 档轮廓逐像素一致', '面部以外像素不变', '运行时 16 组可见像素与 alpha 无损重组', 'PSD 复读及色板'], expressions: details,
    visualReview: '见 qa/expressions-208px.png、faces-detail.png 和 preview.html；H1 的 P1/P2 部件旋转接缝不属于本批。' };
  writeJson('qa/validation-report.json', report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
