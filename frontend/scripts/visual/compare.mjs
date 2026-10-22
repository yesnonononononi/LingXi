/**
 * 视觉回归像素比对（零依赖：自带 PNG 解码/编码）。
 *
 * <p>为什么不用 pixelmatch/pngjs：仓库没有这两个依赖，本工具的定位是「能进 CI、不需要额外装包」，
 * 因此内置 <b>只支持 8bit 非隔行 RGB/RGBA PNG</b> 的解码与 RGB 编码——正好覆盖 Chromium
 * {@code Page.captureScreenshot} 的输出格式。</p>
 *
 * <h3>判据（三重，任一命中即判回归）</h3>
 * <ol>
 *   <li><b>面积判据</b>：单通道差 &gt; {@code --pixel-delta} 的像素占比 &gt; {@code --threshold}。
 *       抓颜色/大块内容变化（改色、整块消失、排版重排）。</li>
 *   <li><b>强差异小面积判据</b>：单通道差 ≥ {@code --strong-delta} 的像素数 ≥ {@code --strong-pixels}。
 *       专门抓「面积很小但差异确凿」的回归——典型是暗色主题下阴影消失（暗底上的暗阴影几乎不改变
 *       大面积像素，却会在阴影边缘留下十几个到几十个高差值像素）。只靠面积判据会因为它险过阈值而漏检。</li>
 *   <li><b>锐度判据</b>：全图平均梯度（清晰度）下降比例 &gt; {@code --sharpness-drop}。
 *       专门抓「模糊/发光/抗锯齿退化」：1px 模糊不改变任何像素超过 8，但会把整图梯度能量显著压低。</li>
 * </ol>
 *
 * <p>退出码：0 = 全部通过；1 = 有图判回归或缺失/尺寸不一致（可直接当门禁）。</p>
 *
 * 用法：
 *   node scripts/visual/compare.mjs --baseline <基线目录> --current <本次目录> \
 *        [--threshold 0.001] [--pixel-delta 12] [--strong-delta 24] [--strong-pixels 40] \
 *        [--sharpness-drop 0.02] [--ignore x,y,w,h]... [--diff-dir <目录>]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** CRC32 查表（PNG 编码需要）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/**
 * 计算 CRC32。
 *
 * @param {Buffer} buffer 数据。
 * @returns {number} 无符号 CRC32。
 */
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 解码 8bit、非隔行的 RGB/RGBA PNG。
 *
 * @param {Buffer} buffer PNG 文件内容。
 * @returns {{width: number, height: number, channels: number, data: Buffer}} 像素数据。
 */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let position = 8;
  let header = null;
  const idat = [];
  while (position < buffer.length) {
    const length = buffer.readUInt32BE(position);
    const type = buffer.toString('ascii', position + 4, position + 8);
    const data = buffer.subarray(position + 8, position + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    position += 12 + length;
  }
  if (!header) throw new Error('PNG 缺少 IHDR');
  if (header.bitDepth !== 8 || header.interlace !== 0 || ![2, 6].includes(header.colorType)) {
    throw new Error(`不支持的 PNG 格式（bitDepth=${header.bitDepth}, colorType=${header.colorType}, interlace=${header.interlace}）`);
  }
  const channels = header.colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(header.height * stride);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + left) & 0xff;
      else if (filter === 2) line[x] = (line[x] + up) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
        line[x] = (line[x] + predictor) & 0xff;
      }
    }
    line.copy(pixels, y * stride);
    previous = line;
  }
  return { width: header.width, height: header.height, channels, data: pixels };
}

/**
 * 编码 8bit RGB PNG（filter 0）。
 *
 * @param {number} width 宽。
 * @param {number} height 高。
 * @param {Buffer} rgb 像素（3 通道）。
 * @returns {Buffer} PNG 文件内容。
 */
export function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 计算一张图的平均梯度（清晰度代理值）：横纵相邻像素亮度差绝对值之和 / 像素数。
 *
 * @param {{width: number, height: number, channels: number, data: Buffer}} image 解码后的图。
 * @param {(x: number, y: number) => boolean} isIgnored 忽略区域判定。
 * @returns {number} 平均梯度（0 表示纯色）。
 */
function meanGradient(image, isIgnored) {
  const { width, height, channels, data } = image;
  const luma = (x, y) => {
    const offset = (y * width + x) * channels;
    return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
  };
  let total = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isIgnored(x, y)) continue;
      const center = luma(x, y);
      if (x + 1 < width) { total += Math.abs(luma(x + 1, y) - center); count += 1; }
      if (y + 1 < height) { total += Math.abs(luma(x, y + 1) - center); count += 1; }
    }
  }
  return count === 0 ? 0 : total / count;
}

/** 默认判据参数。 */
export const DEFAULT_OPTIONS = {
  /** 单通道差超过它才算「这个像素变了」（吸收抗锯齿/次像素渲染抖动）。 */
  pixelDelta: 6,
  /** 变化像素占参与比对像素的比例上限。 */
  threshold: 0.001,
  /** 「强差异」的单通道差门槛。 */
  strongDelta: 24,
  /** 强差异像素数的下限（面积判据抓不到的小面积阴影变化靠它）。 */
  strongPixels: 40,
  /** 平均梯度下降比例上限（抓模糊/发光退化）。 */
  sharpnessDrop: 0.02,
  /** 忽略区域列表（{x,y,w,h}）。 */
  ignoreRects: [],
};

/**
 * 比对一对已解码的图，返回全部判据数值与结论。
 *
 * @param {{width: number, height: number, channels: number, data: Buffer}} baseline 基线图。
 * @param {{width: number, height: number, channels: number, data: Buffer}} current 本次图。
 * @param {typeof DEFAULT_OPTIONS} options 判据参数。
 * @returns {{sizeMismatch: boolean, width: number, height: number, consideredPixels: number,
 *   changedPixels: number, changedRatio: number, maxChannelDelta: number, strongPixels: number,
 *   baselineSharpness: number, currentSharpness: number, sharpnessDrop: number,
 *   reasons: string[], passed: boolean, diffRgb: Buffer | null}} 比对结果（含差异图像素）。
 */
export function compareImagePair(baseline, current, options = DEFAULT_OPTIONS) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      sizeMismatch: true, width: baseline.width, height: baseline.height,
      consideredPixels: 0, changedPixels: 0, changedRatio: 0, maxChannelDelta: 0, strongPixels: 0,
      baselineSharpness: 0, currentSharpness: 0, sharpnessDrop: 0,
      reasons: [`尺寸不一致：${baseline.width}x${baseline.height} → ${current.width}x${current.height}`],
      passed: false, diffRgb: null,
    };
  }
  const isIgnored = (x, y) => opts.ignoreRects.some(rect =>
    x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h);

  const { width, height, channels } = baseline;
  const diffRgb = Buffer.alloc(width * height * 3);
  let considered = 0;
  let changed = 0;
  let strong = 0;
  let maxDelta = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const outOffset = (y * width + x) * 3;
      const red = baseline.data[offset];
      const green = baseline.data[offset + 1];
      const blue = baseline.data[offset + 2];
      diffRgb[outOffset] = red;
      diffRgb[outOffset + 1] = green;
      diffRgb[outOffset + 2] = blue;
      if (isIgnored(x, y)) continue;
      considered += 1;
      const delta = Math.max(
        Math.abs(red - current.data[offset]),
        Math.abs(green - current.data[offset + 1]),
        Math.abs(blue - current.data[offset + 2]),
      );
      if (delta > maxDelta) maxDelta = delta;
      if (delta >= opts.strongDelta) {
        strong += 1;
        diffRgb[outOffset] = 255;
        diffRgb[outOffset + 1] = 60;
        diffRgb[outOffset + 2] = 0;
      } else if (delta > opts.pixelDelta) {
        diffRgb[outOffset] = 255;
        diffRgb[outOffset + 1] = 220;
        diffRgb[outOffset + 2] = 0;
      }
      if (delta > opts.pixelDelta) changed += 1;
    }
  }

  const ratio = considered === 0 ? 0 : changed / considered;
  const baselineSharpness = meanGradient(baseline, isIgnored);
  const currentSharpness = meanGradient(current, isIgnored);
  const sharpnessDrop = baselineSharpness === 0 ? 0 : (baselineSharpness - currentSharpness) / baselineSharpness;

  const reasons = [];
  if (ratio > opts.threshold) {
    reasons.push(`面积判据：变化像素占比 ${(ratio * 100).toFixed(3)}% > ${(opts.threshold * 100).toFixed(3)}%`);
  }
  if (strong >= opts.strongPixels) {
    reasons.push(`强差异判据：≥${opts.strongDelta} 通道差像素 ${strong} 个 ≥ 下限 ${opts.strongPixels}`);
  }
  if (sharpnessDrop > opts.sharpnessDrop) {
    reasons.push(`锐度判据：平均梯度下降 ${(sharpnessDrop * 100).toFixed(2)}% > ${(opts.sharpnessDrop * 100).toFixed(2)}%`);
  }

  return {
    sizeMismatch: false, width, height,
    consideredPixels: considered,
    changedPixels: changed,
    changedRatio: Number(ratio.toFixed(6)),
    maxChannelDelta: maxDelta,
    strongPixels: strong,
    baselineSharpness: Number(baselineSharpness.toFixed(3)),
    currentSharpness: Number(currentSharpness.toFixed(3)),
    sharpnessDrop: Number(sharpnessDrop.toFixed(4)),
    reasons,
    passed: reasons.length === 0,
    diffRgb,
  };
}

/**
 * 递归列出目录下的 PNG（相对路径）。
 *
 * @param {string} root 根目录。
 * @param {string} [prefix] 内部递归用前缀。
 * @returns {string[]} 相对路径列表。
 */
function listPng(root, prefix = '') {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...listPng(root, relative));
    else if (entry.name.toLowerCase().endsWith('.png')) result.push(relative);
  }
  return result;
}

/**
 * 比对两个目录下同名 PNG。
 *
 * @param {{baselineDir: string, currentDir: string, diffDir: string, options: typeof DEFAULT_OPTIONS}} input 参数。
 * @returns {{images: number, failed: number, details: object[], failures: string[]}} 汇总。
 */
export function compareDirectories(input) {
  const { baselineDir, currentDir, diffDir, options } = input;
  const details = [];
  const failures = [];

  for (const relative of listPng(baselineDir)) {
    const baselinePath = path.join(baselineDir, relative);
    const currentPath = path.join(currentDir, relative);
    if (!fs.existsSync(currentPath)) {
      details.push({ image: relative, status: 'missing-current' });
      failures.push(`${relative}：本次截图缺失`);
      continue;
    }
    const baseline = decodePng(fs.readFileSync(baselinePath));
    const current = decodePng(fs.readFileSync(currentPath));
    const result = compareImagePair(baseline, current, options);
    if (result.diffRgb && diffDir) {
      const diffFile = path.join(diffDir, relative.replace(/\.png$/i, '.diff.png'));
      fs.mkdirSync(path.dirname(diffFile), { recursive: true });
      fs.writeFileSync(diffFile, encodePng(result.width, result.height, result.diffRgb));
      details.push({
        image: relative,
        status: result.passed ? 'pass' : 'fail',
        changedPixels: result.changedPixels,
        consideredPixels: result.consideredPixels,
        changedRatio: result.changedRatio,
        maxChannelDelta: result.maxChannelDelta,
        strongPixels: result.strongPixels,
        sharpnessDrop: result.sharpnessDrop,
        reasons: result.reasons,
        diffImage: diffFile,
      });
    } else {
      details.push({ image: relative, status: 'size-mismatch', reasons: result.reasons });
    }
    if (!result.passed) failures.push(`${relative}：${result.reasons.join('；')}`);
  }
  return { images: details.length, failed: failures.length, details, failures };
}

/** 读取 `--key value` 形式的命令行参数。 */
function argOf(args, key, fallback) {
  const index = args.indexOf(`--${key}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

/** 读取可重复的 `--key value` 参数。 */
function argAll(args, key) {
  return args.reduce((result, value, index) => (
    value === `--${key}` && args[index + 1] ? [...result, args[index + 1]] : result
  ), []);
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------
const isCli = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('visual', 'compare.mjs'));
if (isCli) {
  const args = process.argv.slice(2);
  const baselineDir = path.resolve(argOf(args, 'baseline', '.lingxi/tmp/visual/baseline'));
  const currentDir = path.resolve(argOf(args, 'current', '.lingxi/tmp/visual/current'));
  const diffDir = path.resolve(argOf(args, 'diff-dir', '.lingxi/tmp/visual/diff'));
  const reportFile = path.resolve(argOf(args, 'report', path.join(path.dirname(diffDir), 'compare-report.json')));
  const ignoreRects = argAll(args, 'ignore').map(text => {
    const [x, y, w, h] = text.split(',').map(Number);
    if ([x, y, w, h].some(value => !Number.isFinite(value))) throw new Error(`--ignore 格式应为 x,y,w,h：${text}`);
    return { x, y, w, h };
  });
  const options = {
    ...DEFAULT_OPTIONS,
    pixelDelta: Number(argOf(args, 'pixel-delta', DEFAULT_OPTIONS.pixelDelta)),
    threshold: Number(argOf(args, 'threshold', DEFAULT_OPTIONS.threshold)),
    strongDelta: Number(argOf(args, 'strong-delta', DEFAULT_OPTIONS.strongDelta)),
    strongPixels: Number(argOf(args, 'strong-pixels', DEFAULT_OPTIONS.strongPixels)),
    sharpnessDrop: Number(argOf(args, 'sharpness-drop', DEFAULT_OPTIONS.sharpnessDrop)),
    ignoreRects,
  };
  if (!fs.existsSync(baselineDir)) {
    console.error(`基线目录不存在：${baselineDir}\n请先运行 npm run visual:baseline`);
    process.exit(2);
  }
  const summary = compareDirectories({ baselineDir, currentDir, diffDir, options });
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify({ baselineDir, currentDir, options, ...summary }, null, 2));
  console.log(JSON.stringify({
    images: summary.images,
    failed: summary.failed,
    options,
    details: summary.details,
    failures: summary.failures,
  }, null, 2));
  process.exit(summary.failed === 0 ? 0 : 1);
}
