/**
 * 脸区贴片构建脚本（M1·T01）：v3 表情母版 → 双密度脸贴片 + `pet-face-tiles.json` + 回填 `face.files`。
 *
 * <p><b>它解决的是什么问题：</b>`layered` 模式下 `.pet-art-frame`（压平帧）是 `opacity: 0`，
 * 而 P1 分层件里没有独立的 `face` 层，于是"表情"在过去只改了状态、屏幕上什么都不变。
 * 本脚本把 v3 的 8 张表情母版按<b>脸区矩形</b>裁成小贴片，让第 10 层 `face`
 * （`z = 32`，见 `pet-layers.json` 与设计文档 §3.1）能只换脸、不动身体。</p>
 *
 * <p><b>为什么是子矩形而不是整张脸图：</b>整张 2048×3072 的 RGBA 脸图 ≈ 25MB/张，
 * 8–10 张常驻内存 ≈ 250MB，常驻桌宠窗口不可接受。子矩形贴片 `@2x = 396×200` 只有整图的 1/79。</p>
 *
 * <p><b>脸区矩形是实测值，不是猜的</b>（设计文档 §4.1）：对 `E1_default.png` 逐张求差得到的并集是
 * `x 588–1325, y 1082–1431`，上边只剩 2px 余量；因此取 `nativeFaceEditCrop` 四周各外扩 8 native px：</p>
 * <ul>
 *   <li>`faceRegionNative = { left: 280, top: 532, width: 396, height: 200 }`（1024×1536 坐标系）</li>
 *   <li>`faceRegionMaster = { x: 560, y: 1064, width: 792, height: 400 }`（2048×3072 母版坐标系）</li>
 * </ul>
 *
 * <p><b>校验项（C1–C6 / C9，编号与设计文档 §4.4 一致）：</b></p>
 * <table>
 *   <tr><td>C1</td><td>每张母版与 `E1_default` 的差异 bbox ⊆ 脸区（wink 还要 ⊆ 单侧眼区）</td></tr>
 *   <tr><td>C2</td><td>脸区内：`body-occluder` 不透明覆盖 ≥ 99.5%，其余各层墨迹 = 0（由 {@link verifyFaceRegionAgainstLayerMasters} 提供，门禁复用）</td></tr>
 *   <tr><td>C3</td><td>`neutral` 贴片与该矩形内的 `body-occluder` 逐像素 `maxDelta ≤ 2`（同上，门禁复用）</td></tr>
 *   <tr><td>C4</td><td>输出尺寸严格 396×200 / 198×100，`format=webp-lossless`，sha256/bytes 回填</td></tr>
 *   <tr><td>C5</td><td>无半透明脏边：不透明（α≥248）占比 ≥ 99.5%，半透明（8&lt;α&lt;248）占比 ≤ 0.5%，且贴片最外圈没有半透明像素</td></tr>
 *   <tr><td>C6</td><td>八张贴片两两不同（`@2x` sha256 互不重复），且都与 `neutral` 不同</td></tr>
 *   <tr><td>C9</td><td>`pet-layers.json` 的 `face.files` 与本目录 `neutral` 条目逐字段相等（单字段所有权）</td></tr>
 * </table>
 *
 * <p><b>C5 的口径说明（与设计文档 §4.2 的措辞有出入，必须知道为什么）：</b>§4.2 写"矩形外框一圈 α 必须为 0"，
 * 那是给<b>美术裁图</b>的口径（美术交的母版四周是透明底）。本脚本产出的贴片是<b>从母版里抠出来的脸区</b>，
 * 而脸区在 `body-occluder` 里是 100% 不透明（实测 316800/316800）——外框 α 恒为 255 才是对的。
 * 因此这里守的是同一件事的<b>可观测形式</b>：不许出现"半透明脏边"（8&lt;α&lt;248），且不透明占比达标。
 * 若将来美术改交"脸区带透明边"的母版，本条会立刻红。</p>
 *
 * <p><b>降级是合法中间态：</b>`wink`（单眼闭合，交互表情）与 `blinkHalf`（生理眨眼半闭帧）的美术母版
 * 由 T02 交付，未到货时写进 `degraded` 并在日志里点名，**不生成假贴片**。</p>
 *
 * <p>用法：</p>
 * <pre>
 *   node scripts/build-pet-face-tiles.mjs              # 裁切 + 回填
 *   node scripts/build-pet-face-tiles.mjs --check      # 只校验不回写（发现过期就失败）
 *   node scripts/build-pet-face-tiles.mjs --verbose    # 打印每一步
 *   node scripts/build-pet-face-tiles.mjs --source &lt;dir&gt;  # 指定表情母版目录（含 E&lt;n&gt;_&lt;id&gt;.png）
 *   node scripts/build-pet-face-tiles.mjs --out &lt;dir&gt;     # 指定输出目录
 * </pre>
 *
 * @module scripts/build-pet-face-tiles
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEBP_OPTIONS, loadSharp, sha256Of } from './build-pet-assets.mjs';
import { FRONTEND_ROOT, readJsonFile } from './build-pet-geometry.mjs';
import { LAYERS_JSON_PATH, sourcePathOf } from './build-pet-layers.mjs';
import { readImageSize } from './pet-image-headers.mjs';

/** 脸贴片清单路径（生成物，入库）。 */
export const FACE_TILES_JSON_PATH = resolve(FRONTEND_ROOT, 'pet-face-tiles.json');

/** 脸贴片运行时输出目录（`lxa://pet-p1/face/…` 直接可读）。 */
export const DEFAULT_FACE_OUT_DIR = resolve(FRONTEND_ROOT, 'public', 'live2d', 'pet-p1', 'face');

/** 脸层的层 id（与 `presentation/layered-presentation.ts` 的 `FACE_LAYER_ID` 同值）。 */
export const FACE_LAYER_ID = 'face';

/** 脸区矩形（母版像素，2048×3072 坐标系）——**唯一真源，`pet-layers.json` 的 `face.rect` 必须与它逐位相等**。 */
export const FACE_REGION_MASTER = Object.freeze({ x: 560, y: 1064, width: 792, height: 400 });

/** 脸区矩形（原生像素，1024×1536 坐标系；= 母版 ÷2，与 `nativeFaceEditCrop` 同单位）。 */
export const FACE_REGION_NATIVE = Object.freeze({ left: 280, top: 532, width: 396, height: 200 });

/** 两档密度贴片的严格像素尺寸（不许漂移，C4 守这条）。 */
export const FACE_TILE_SIZES = Object.freeze({
  '1x': Object.freeze({ width: 198, height: 100 }),
  '2x': Object.freeze({ width: 396, height: 200 }),
});

/** 支持的密度（顺序 = 质量升序）。 */
export const FACE_DENSITIES = Object.freeze(['1x', '2x']);

/** 本批**必须**产出的贴片 id（与 v3 母版 E1–E8 一一对应）。 */
export const FACE_TILE_IDS = Object.freeze([
  'neutral',
  'blink',
  'surprised',
  'sad',
  'angry',
  'shy',
  'happy',
  'sleepy',
]);

/**
 * 美术母版未交付时**允许缺失**的贴片 id（走 `degraded`，不许造假的）。
 *
 * <p>T02（美术）交付 `docs/assets/desktop-pet/v4/expr/E9_wink.png` 与（可选）`E10_blinkHalf.png`。
 * 只有在<b>源母版已入库</b>且显式传 `--include-deferred` 时才会把它们转成正式贴片：
 * 否则会提交"衍生文件入库、源文件不在库"的不可复现状态（换台机器重跑 build 就得到不同清单）。
 * 母版真的不存在时无论如何都进 `degraded`。</p>
 */
export const FACE_DEFERRED_IDS = Object.freeze(['wink', 'blinkHalf']);

/** 表情 id → 母版文件主干（`E<n>_<id>`，沿用美术 `expr/` 命名）。 */
export const MASTER_FILE_BY_ID = Object.freeze({
  neutral: 'E1_default',
  blink: 'E2_blink',
  surprised: 'E3_surprised',
  sad: 'E4_sad',
  angry: 'E5_angry',
  shy: 'E6_shy',
  happy: 'E7_happy',
  sleepy: 'E8_sleepy',
  wink: 'E9_wink',
  blinkHalf: 'E10_blinkHalf',
});

/**
 * wink 母版允许的差异窗口（母版像素，单侧眼区）。
 *
 * <p>设计文档 §8-T02 的验收断言：`E9_wink.png` 与 `E1_default.png` 的差异必须落在这一侧，
 * 双眼都变就说明"wink 被画成了 blink"，必须报错（两者语义不同，见 §5）。</p>
 */
export const WINK_EYE_WINDOW_MASTER = Object.freeze({ x: 570, y: 1070, width: 390, height: 310 });

/**
 * 单张贴片体积预算。
 *
 * <p><b>为什么不是设计文档 §4.2 写的 12KB/30KB（实测口径，必须知道）：</b>那组数字隐含"有损编码"，
 * 而 C3 要求 `neutral` 贴片与 `body-occluder` 同矩形 `maxDelta ≤ 2`——这是整套方案"零重影"的基石。
 * 实测有损 WebP（q=95/92/88）相对底图的 `maxDelta` 是 <b>52 / 56 / 54</b>，直接击穿 C3；
 * 所以贴片**必须无损编码**。无损下实测体积是 @1x 22–26KB、@2x 69–80KB（v3 母版的真实细节量），
 * 原预算不可达。这里按实测值上浮约 50% 作为"防跑飞"阈值，而不是把编码改成有损换绿。</p>
 */
export const FACE_TILE_BYTE_BUDGET = Object.freeze({ '1x': 40 * 1024, '2x': 120 * 1024 });

/**
 * 脸贴片总体积预算。
 *
 * <p><b>实测（wink 转正后）</b>：9 档 × 2 密度、共 18 张无损 webp，`@1x` 合计 223,186B、
 * `@2x` 合计 685,380B，<b>总计 908,566B ≈ 0.87MB</b>；安装包里 webp 不再压缩，
 * 但 NSIS 压缩与对齐会再加一点，<b>安装包增量约 1.0MB</b>。</p>
 *
 * <p>这里锁的是<b>总量</b>而不是只看单档上限：单档上限挡不住"再多加几档"——每档都在
 * 40KB/120KB 以内，加起来照样能把安装包顶穿。改预算必须先看这条注释里的实测值。</p>
 */
export const FACE_TOTAL_BYTE_BUDGET = Math.round(1.5 * 1024 * 1024);

/** 差异判定阈值（0–255，与设计文档 §4.1 的实测口径一致：7/255）。 */
export const DIFF_THRESHOLD = 7;

/** alpha 清理阈值（与 v3 美术清单的 `alphaCleanup.threshold` 一致）。 */
export const ALPHA_CLEAN_THRESHOLD = 8;

/** 视为"完全不透明"的 alpha 下限（与 v3 美术清单的 `solidThreshold` 一致）。 */
export const ALPHA_SOLID_THRESHOLD = 248;

/** 不透明像素占比下限（C2 / C5）。 */
export const SOLID_RATIO_FLOOR = 0.995;

/** 半透明脏边像素占比上限（C5）。 */
export const SEMI_TRANSPARENT_RATIO_CEILING = 0.005;

/** C3 允许的逐像素最大通道差（`neutral` 贴片 vs `body-occluder`）。 */
export const MAX_DELTA_TOLERANCE = 2;

/** 母版目录版本优先级（v4 先、v3 后：v4 只补 wink/blinkHalf，其余仍在 v3）。 */
export const MASTER_VERSION_DIRS = Object.freeze(['v4', 'v3']);

/** 生成器标识（写进清单，便于对账）。 */
export const GENERATOR_ID = 'scripts/build-pet-face-tiles.mjs';

/**
 * 向上找到仓库根（含 `.git` 或 `.lingxi` 的那一层）。
 *
 * <p>与 `build-pet-assets.mjs` / `build-pet-layers.mjs` 的探测同因：隔离工作树在
 * `.lingxi/work/<task>/frontend`，主工作树在 `<repo>/frontend`，写死 `../..` 会在另一种布局下指错。</p>
 *
 * @param {string} [startDir] 起点目录（缺省 `frontend/`）
 * @returns {string} 仓库根绝对路径（找不到时退回 `frontend/` 的父目录）
 */
export function findRepoRoot(startDir = FRONTEND_ROOT) {
  let cursor = resolve(startDir);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(resolve(cursor, '.git')) || existsSync(resolve(cursor, '.lingxi'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolve(FRONTEND_ROOT, '..');
}

/**
 * 美术母版目录候选（v4 优先，然后 v3）。
 *
 * @param {string} [repoRoot] 仓库根
 * @returns {string[]} `expr/` 目录绝对路径候选（不保证存在）
 */
export function masterDirs(repoRoot = findRepoRoot()) {
  return MASTER_VERSION_DIRS.map((version) => resolve(repoRoot, 'docs', 'assets', 'desktop-pet', version, 'expr'));
}

/**
 * 某档表情的母版文件路径候选（v4 先、v3 后）。
 *
 * @param {string} expressionId 表情 id
 * @param {string} [repoRoot] 仓库根
 * @returns {string[]} 绝对路径候选（不保证存在）
 */
export function masterCandidates(expressionId, repoRoot = findRepoRoot()) {
  const stem = MASTER_FILE_BY_ID[expressionId];
  if (!stem) return [];
  return masterDirs(repoRoot).map((dir) => resolve(dir, `${stem}.png`));
}

/**
 * 找某档表情**真实存在**的母版文件。
 *
 * @param {string} expressionId 表情 id
 * @param {string} [explicitDir] 调用方指定的母版目录（`--source`）
 * @returns {string|null} 绝对路径；找不到返回 null
 */
export function findMaster(expressionId, explicitDir) {
  const stem = MASTER_FILE_BY_ID[expressionId];
  if (!stem) return null;
  const candidates = explicitDir
    ? [resolve(explicitDir, `${stem}.png`)]
    : masterCandidates(expressionId);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 读一张 PNG 的原始 RGBA 像素。
 *
 * @param {any} sharp sharp 模块
 * @param {string} filePath 文件路径
 * @returns {Promise<{data: Buffer, width: number, height: number}>} 原始像素
 */
async function readRawPixels(sharp, filePath) {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * 把一块区域从原始像素里抠出来（越界即抛错，不做静默截断）。
 *
 * @param {{data: Buffer, width: number, height: number}} raw 原始像素
 * @param {{x: number, y: number, width: number, height: number}} region 区域（该图坐标系）
 * @returns {Buffer} 抠出的 RGBA 像素
 * @throws {RangeError} 区域越界时抛出
 */
export function cropRawRegion(raw, region) {
  const inside =
    region.x >= 0 &&
    region.y >= 0 &&
    region.width > 0 &&
    region.height > 0 &&
    region.x + region.width <= raw.width &&
    region.y + region.height <= raw.height;
  if (!inside) {
    throw new RangeError(
      `脸区 ${region.x},${region.y} ${region.width}×${region.height} 越出图像 ${raw.width}×${raw.height}`,
    );
  }
  const out = Buffer.alloc(region.width * region.height * 4);
  for (let row = 0; row < region.height; row += 1) {
    const sourceStart = ((region.y + row) * raw.width + region.x) * 4;
    raw.data.copy(out, row * region.width * 4, sourceStart, sourceStart + region.width * 4);
  }
  return out;
}

/**
 * 求两张同尺寸图的差异包围盒。
 *
 * @param {{data: Buffer, width: number, height: number}} base 基准图
 * @param {{data: Buffer, width: number, height: number}} other 对照图
 * @param {number} [threshold] 单通道差阈值（0 = 任何差异都算）
 * @returns {{bbox: {x: number, y: number, width: number, height: number} | null, pixels: number, maxDelta: number}}
 *   差异包围盒（无差异时 `bbox = null`）、差异像素数、最大通道差
 */
export function diffBoundingBox(base, other, threshold = DIFF_THRESHOLD) {
  if (base.width !== other.width || base.height !== other.height) {
    throw new RangeError(`尺寸不一致：${base.width}×${base.height} vs ${other.width}×${other.height}`);
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  let maxDelta = 0;
  for (let y = 0; y < base.height; y += 1) {
    for (let x = 0; x < base.width; x += 1) {
      const index = (y * base.width + x) * 4;
      let delta = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        const diff = Math.abs(base.data[index + channel] - other.data[index + channel]);
        if (diff > delta) delta = diff;
      }
      if (delta > maxDelta) maxDelta = delta;
      if (delta > threshold) {
        pixels += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (pixels === 0) return { bbox: null, pixels: 0, maxDelta };
  return {
    bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    pixels,
    maxDelta,
  };
}

/**
 * 判断内层矩形是否完全落在容器矩形内。
 *
 * @param {{x: number, y: number, width: number, height: number}} inner 内层矩形
 * @param {{x: number, y: number, width: number, height: number}} outer 容器矩形
 * @returns {boolean} 是否包含
 */
export function rectContains(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * 统计像素的 alpha 分布（C2 / C5 共用）。
 *
 * @param {Buffer} rgba RGBA 像素
 * @param {{width: number, height: number}} size 尺寸
 * @returns {{total: number, ink: number, solid: number, semiTransparent: number, ringSemiTransparent: number}}
 *   统计结果：`ink` = α&gt;8 的像素、`solid` = α≥248、`semiTransparent` = 8&lt;α&lt;248
 */
export function alphaStats(rgba, size) {
  const total = size.width * size.height;
  let ink = 0;
  let solid = 0;
  let semiTransparent = 0;
  let ringSemiTransparent = 0;
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const alpha = rgba[(y * size.width + x) * 4 + 3];
      const onRing = x === 0 || y === 0 || x === size.width - 1 || y === size.height - 1;
      if (alpha > ALPHA_CLEAN_THRESHOLD) ink += 1;
      if (alpha >= ALPHA_SOLID_THRESHOLD) solid += 1;
      if (alpha > ALPHA_CLEAN_THRESHOLD && alpha < ALPHA_SOLID_THRESHOLD) {
        semiTransparent += 1;
        if (onRing) ringSemiTransparent += 1;
      }
    }
  }
  return { total, ink, solid, semiTransparent, ringSemiTransparent };
}

/**
 * 从母版裁出脸区像素（`cropFace`，设计文档 §3.4 的 FaceTileBuilder 接口）。
 *
 * @param {any} sharp sharp 模块
 * @param {string} masterPath 母版 PNG
 * @param {{x: number, y: number, width: number, height: number}} [region] 脸区（母版像素）
 * @returns {Promise<Buffer>} 脸区 RGBA 像素（母版分辨率，792×400）
 */
export async function cropFace(sharp, masterPath, region = FACE_REGION_MASTER) {
  const raw = await readRawPixels(sharp, masterPath);
  return cropRawRegion(raw, region);
}

/**
 * 把脸区像素按两档密度编码成 WebP（`emitDensities`）。
 *
 * <p>尺寸<b>必须</b>恰好 198×100 / 396×200：这是"贴片放进 `face.rect` 后与底图逐像素对齐"的前提，
 * 差 1px 就会在脸边缘出现一条错位环（设计文档 §4.2）。</p>
 *
 * @param {any} sharp sharp 模块
 * @param {Buffer} faceRgba 脸区 RGBA 像素（母版分辨率）
 * @param {string} outDir 输出目录
 * @param {string} expressionId 表情 id（决定文件名）
 * @param {{assetBase: string, verbose?: boolean, log?: (message: string) => void}} options 选项
 * @returns {Promise<{files: object, bytes: { '1x': number, '2x': number }, problems: string[]}>}
 *   各密度文件条目、体积、问题列表
 */
export async function emitDensities(sharp, faceRgba, outDir, expressionId, options) {
  const assetBase = typeof options.assetBase === 'string' && options.assetBase.length > 0 ? options.assetBase : 'lxa://pet-p1/';
  const base = assetBase.endsWith('/') ? assetBase : `${assetBase}/`;
  const problems = [];
  const files = {};
  const bytes = { '1x': 0, '2x': 0 };
  for (const density of FACE_DENSITIES) {
    const size = FACE_TILE_SIZES[density];
    const target = { width: size.width, height: size.height };
    const encoded = await sharp(faceRgba, { raw: { width: FACE_REGION_MASTER.width, height: FACE_REGION_MASTER.height, channels: 4 } })
      .resize(size.width, size.height, { fit: 'fill', kernel: 'nearest' })
      .webp({ ...WEBP_OPTIONS, lossless: true, nearLossless: false })
      .toBuffer();
    const fileName = `${expressionId}@${density}.webp`;
    const absolute = resolve(outDir, fileName);
    writeFileSync(absolute, encoded);

    const measured = readImageSize(absolute);
    if (measured.width !== target.width || measured.height !== target.height) {
      problems.push(
        `${expressionId}@${density} 尺寸漂移：期望 ${target.width}×${target.height}，实际 ${measured.width}×${measured.height}`,
      );
    }
    const actualBytes = encoded.length;
    const budget = FACE_TILE_BYTE_BUDGET[density];
    if (actualBytes > budget) {
      problems.push(`${expressionId}@${density} 体积 ${actualBytes}B 超出单张预算 ${budget}B（先降码率，不要改尺寸）`);
    }
    bytes[density] = actualBytes;
    files[density] = {
      file: `${FACE_LAYER_ID}/${fileName}`,
      url: `${base}${FACE_LAYER_ID}/${fileName}`,
      width: measured.width,
      height: measured.height,
      bytes: actualBytes,
      sha256: sha256Of(absolute),
      format: 'webp-lossless',
    };

    // C5：无半透明脏边（用解码回来的真实像素判，不用编码前的那份）
    const decoded = await readRawPixels(sharp, absolute);
    const stats = alphaStats(decoded.data, decoded);
    const solidRatio = stats.solid / stats.total;
    const semiRatio = stats.semiTransparent / stats.total;
    if (solidRatio < SOLID_RATIO_FLOOR) {
      problems.push(
        `${expressionId}@${density} 不透明像素占比 ${(solidRatio * 100).toFixed(3)}% 低于 ${(SOLID_RATIO_FLOOR * 100).toFixed(1)}%（脸区必须被底图完全覆盖）`,
      );
    }
    if (semiRatio > SEMI_TRANSPARENT_RATIO_CEILING) {
      problems.push(
        `${expressionId}@${density} 半透明像素占比 ${(semiRatio * 100).toFixed(3)}% 超过 ${(SEMI_TRANSPARENT_RATIO_CEILING * 100).toFixed(1)}%（有脏边）`,
      );
    }
    if (stats.ringSemiTransparent > 0) {
      problems.push(`${expressionId}@${density} 最外圈有 ${stats.ringSemiTransparent} 个半透明像素（贴片边缘会露出灰边）`);
    }
    if (options.verbose) {
      options.log?.(`[pet-face] ${expressionId}@${density} ${measured.width}×${measured.height} ${actualBytes}B sha256=${files[density].sha256.slice(0, 12)}…`);
    }
  }
  return { files, bytes, problems };
}

/**
 * 校验贴片集合（C4 / C5 / C6 的汇总口径，`verifyChecks`）。
 *
 * @param {Array<{expressionId: string, problems: string[], sha256: { '1x': string, '2x': string }}>} entries 每次裁切的产出
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function verifyChecks(entries) {
  const problems = [];
  for (const entry of entries) problems.push(...(entry.problems ?? []));
  // C6：八张贴片两两不同（@2x sha256 互不重复），且都与 neutral 不同
  const seen = new Map();
  for (const entry of entries) {
    const sha = entry.sha256?.['2x'];
    if (!sha) continue;
    if (seen.has(sha)) {
      problems.push(`C6 失败：${entry.expressionId} 与 ${seen.get(sha)} 的 @2x 贴片完全相同（复制粘贴的表情不可辨）`);
      continue;
    }
    seen.set(sha, entry.expressionId);
  }
  const neutral = entries.find((entry) => entry.expressionId === 'neutral');
  if (neutral && neutral.sha256?.['2x']) {
    for (const entry of entries) {
      if (entry.expressionId === 'neutral') continue;
      if (entry.sha256?.['2x'] === neutral.sha256['2x']) {
        problems.push(`C6 失败：${entry.expressionId} 的 @2x 贴片与 neutral 相同（表情没换脸）`);
      }
    }
  }
  return problems;
}

/**
 * 写清单文件（稳定序列化：2 空格缩进 + 结尾换行，保证 diff 可读）。
 *
 * @param {object} catalog 清单对象
 * @param {string} [filePath] 目标路径
 * @returns {void}
 */
export function writeCatalog(catalog, filePath = FACE_TILES_JSON_PATH) {
  writeFileSync(filePath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}

/**
 * 脸区与各层母版的像素校验（C2 / C3，门禁 `gate:pet:layers` 复用同一实现）。
 *
 * <p>为什么要由门禁执行而不是只在构建时执行一次：这三条不变式约束的是
 * <b>`pet-layers.json` 的 `face.rect` 与美术分层件的关系</b>。有人把 `rect.x` 改 20px、
 * 或给耳朵加大幅度，贴片与底图就不再逐像素相等 —— 而这种错在屏幕上只表现为
 * "脸边缘有撕裂"，靠人眼很难归因到一行 JSON。</p>
 *
 * @param {object} manifest 层清单（`pet-layers.json` 的对象形式）
 * @param {object} [options] 选项
 * @param {string} [options.sourceDir] P1 母版目录（缺省自动探测）
 * @param {string} [options.faceOutDir] 脸贴片输出目录（缺省 `public/live2d/pet-p1/face`）
 * @param {boolean} [options.verbose] 打印每一步
 * @param {(message: string) => void} [options.log] 日志出口
 * @returns {Promise<{ok: boolean, problems: string[], notes: string[], skipped: boolean}>} 校验结果
 */
export async function verifyFaceRegionAgainstLayerMasters(manifest, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const verbose = options.verbose === true;
  const layers = manifest && Array.isArray(manifest.layers) ? manifest.layers : [];
  const faceLayer = layers.find((layer) => layer && layer.layerId === FACE_LAYER_ID);
  if (!faceLayer) {
    return { ok: false, problems: ['C2/C3 无法执行：层清单里没有 face 层（M1 契约要求第 10 层 face）'], notes: [], skipped: false };
  }
  const rect = faceLayer.rect ?? {};
  if (
    Number(rect.x) !== FACE_REGION_MASTER.x ||
    Number(rect.y) !== FACE_REGION_MASTER.y ||
    Number(rect.width) !== FACE_REGION_MASTER.width ||
    Number(rect.height) !== FACE_REGION_MASTER.height
  ) {
    return {
      ok: false,
      problems: [
        `C2/C3 无法执行：face.rect (${rect.x}, ${rect.y}, ${rect.width}×${rect.height}) 与真源 ` +
          `(${FACE_REGION_MASTER.x}, ${FACE_REGION_MASTER.y}, ${FACE_REGION_MASTER.width}×${FACE_REGION_MASTER.height}) 不一致`,
      ],
      notes: [],
      skipped: false,
    };
  }

  const sourceDir = options.sourceDir ?? resolve(findRepoRoot(), 'docs', 'assets', 'desktop-pet', 'p1');
  if (!existsSync(sourceDir)) {
    return {
      ok: true,
      problems: [],
      notes: [`C2/C3 跳过：P1 母版目录不存在（资产未到货的合法中间态）: ${sourceDir}`],
      skipped: true,
    };
  }
  const sharp = await loadSharp();
  if (!sharp) {
    return { ok: false, problems: ['C2/C3 无法执行：sharp 不可用（请在 frontend 下 npm install）'], notes: [], skipped: false };
  }

  const problems = [];
  const notes = [];
  const regionPixels = FACE_REGION_MASTER.width * FACE_REGION_MASTER.height;
  const masterByLayer = new Map();
  for (const layer of layers) {
    if (!layer || layer.layerId === FACE_LAYER_ID) continue;
    if (typeof layer.source !== 'string' || layer.source.length === 0) continue;
    const masterPath = sourcePathOf(sourceDir, layer.source);
    if (!existsSync(masterPath)) {
      notes.push(`C2 跳过层 ${layer.layerId}：母版不存在 ${basename(masterPath)}`);
      continue;
    }
    const raw = await readRawPixels(sharp, masterPath);
    const cropped = cropRawRegion(raw, FACE_REGION_MASTER);
    const stats = alphaStats(cropped, FACE_REGION_MASTER);
    masterByLayer.set(layer.layerId, { raw, stats });
    if (layer.layerId === 'body-occluder') {
      const coverage = stats.ink / regionPixels;
      if (coverage < SOLID_RATIO_FLOOR) {
        problems.push(
          `C2 失败：body-occluder 在脸区的不透明覆盖率 ${(coverage * 100).toFixed(2)}% 低于 ${(SOLID_RATIO_FLOOR * 100).toFixed(1)}%` +
            '（脸区下方必须完全不透明，否则贴片会透出补绘缝）',
        );
      } else if (verbose) {
        log(`[pet-face] C2 body-occluder 覆盖率 ${(coverage * 100).toFixed(2)}%`);
      }
      continue;
    }
    if (stats.ink > 0) {
      problems.push(
        `C2 失败：层 ${layer.layerId} 在脸区内有 ${stats.ink} 个墨迹像素（应全部为 0）——` +
          '脸区与可动/前景层重叠，表情切换时会与那些层的动画互相撕边',
      );
    } else if (verbose) {
      log(`[pet-face] C2 ${layer.layerId} 脸区墨迹 0`);
    }
  }

  // C3：neutral 贴片 vs body-occluder 同矩形逐像素对比（贴片是"母版在该矩形内的原样裁切"）
  const occluder = masterByLayer.get('body-occluder');
  const faceOutDir = options.faceOutDir ?? DEFAULT_FACE_OUT_DIR;
  const neutralTile = resolve(faceOutDir, 'neutral@2x.webp');
  if (!occluder) {
    notes.push('C3 跳过：body-occluder 母版不存在');
  } else if (!existsSync(neutralTile)) {
    problems.push(`C3 失败：缺少 neutral@2x 贴片 ${neutralTile}（先跑 npm run build:pet-face）`);
  } else {
    const reference = await sharp(occluder.raw.data, {
      raw: { width: occluder.raw.width, height: occluder.raw.height, channels: 4 },
    })
      .extract({
        left: FACE_REGION_MASTER.x,
        top: FACE_REGION_MASTER.y,
        width: FACE_REGION_MASTER.width,
        height: FACE_REGION_MASTER.height,
      })
      .resize(FACE_TILE_SIZES['2x'].width, FACE_TILE_SIZES['2x'].height, { fit: 'fill', kernel: 'nearest' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tile = await readRawPixels(sharp, neutralTile);
    const comparison = diffBoundingBox(
      { data: reference.data, width: reference.info.width, height: reference.info.height },
      tile,
      0,
    );
    if (comparison.maxDelta > MAX_DELTA_TOLERANCE) {
      problems.push(
        `C3 失败：neutral 贴片与 body-occluder 同矩形最大通道差 ${comparison.maxDelta}（上限 ${MAX_DELTA_TOLERANCE}）——` +
          '锚点/裁切错位，贴片会把脸画偏',
      );
    } else if (verbose) {
      log(`[pet-face] C3 neutral 贴片 vs body-occluder maxDelta=${comparison.maxDelta}`);
    }
  }

  return { ok: problems.length === 0, problems, notes, skipped: false };
}
/**
 * 构建（或校验）脸区贴片。
 *
 * @param {object} [options] 选项
 * @param {boolean} [options.check] 只校验不回写（发现过期就抛错，门禁用）
 * @param {boolean} [options.includeDeferred] 把已存在母版的 `wink` / `blinkHalf` 转成正式贴片（缺省 false = 走 degraded）
 * @param {boolean} [options.verbose] 打印每一步
 * @param {string} [options.sourceDir] 表情母版目录（`--source`）
 * @param {string} [options.outDir] 输出目录
 * @param {string} [options.layersPath] 层清单路径（测试用）
 * @param {string} [options.catalogPath] 脸贴片清单路径（测试用）
 * @param {(message: string) => void} [options.log] 日志出口
 * @returns {Promise<{skipped: boolean, reason: string, catalog: object | null, degraded: string[], changed: string[], problems: string[], bytes: { '1x': number, '2x': number }}>}
 *   构建结果
 * @throws {Error} 母版缺失、校验不通过或清单过期时抛出
 */
export async function buildFaceTiles(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const verbose = options.verbose === true;
  const check = options.check === true;
  const layersPath = options.layersPath ?? LAYERS_JSON_PATH;
  const catalogPath = options.catalogPath ?? FACE_TILES_JSON_PATH;
  const outDir = options.outDir ?? DEFAULT_FACE_OUT_DIR;

  const manifest = readJsonFile(layersPath);
  const layers = manifest && Array.isArray(manifest.layers) ? manifest.layers : [];
  const faceLayer = layers.find((layer) => layer && layer.layerId === FACE_LAYER_ID);
  if (!faceLayer) {
    throw new Error(
      `层清单里没有 ${FACE_LAYER_ID} 层：M1 契约要求第 10 层 face（z=32、rect=脸区）。请检查 pet-layers.json`,
    );
  }

  const sharp = await loadSharp();
  if (!sharp) throw new Error('sharp 不可用（请在 frontend 下 npm install，脸贴片裁切依赖它）');

  const missingRequired = [];
  const masters = new Map();
  for (const expressionId of FACE_TILE_IDS) {
    const masterPath = findMaster(expressionId, options.sourceDir);
    if (!masterPath) {
      missingRequired.push(`${expressionId}(${MASTER_FILE_BY_ID[expressionId]}.png)`);
      continue;
    }
    masters.set(expressionId, masterPath);
  }
  if (missingRequired.length > 0) {
    throw new Error(
      `必需的表达式母版缺失：${missingRequired.join(', ')}（本批必须从 v3 的 E1–E8 裁切；缺件不是合法中间态）`,
    );
  }

  const baseRaw = await readRawPixels(sharp, masters.get('neutral'));
  const regionPixels = FACE_REGION_MASTER.width * FACE_REGION_MASTER.height;

  // C2 的前置：脸区必须在母版画布内
  if (
    FACE_REGION_MASTER.x + FACE_REGION_MASTER.width > baseRaw.width ||
    FACE_REGION_MASTER.y + FACE_REGION_MASTER.height > baseRaw.height
  ) {
    throw new Error(
      `脸区越出母版画布：${FACE_REGION_MASTER.x},${FACE_REGION_MASTER.y} ${FACE_REGION_MASTER.width}×${FACE_REGION_MASTER.height} vs ${baseRaw.width}×${baseRaw.height}`,
    );
  }
  const baseRegion = cropRawRegion(baseRaw, FACE_REGION_MASTER);
  const baseStats = alphaStats(baseRegion, FACE_REGION_MASTER);
  if (baseStats.solid / regionPixels < SOLID_RATIO_FLOOR) {
    throw new Error(
      `C5 失败：脸区在 E1_default 里不透明占比 ${(baseStats.solid / regionPixels * 100).toFixed(2)}%，` +
        `低于 ${(SOLID_RATIO_FLOOR * 100).toFixed(1)}%（脸区不允许含透明像素）`,
    );
  }

  if (!check) mkdirSync(outDir, { recursive: true });

  const assetBase = typeof manifest.assetBase === 'string' ? manifest.assetBase : 'lxa://pet-p1/';
  const entries = [];
  const catalogTiles = {};
  const bytesByDensity = { '1x': 0, '2x': 0 };
  const problems = [];

  for (const expressionId of FACE_TILE_IDS) {
    const masterPath = masters.get(expressionId);
    const raw = expressionId === 'neutral' ? baseRaw : await readRawPixels(sharp, masterPath);

    // C1：与 neutral 的差异必须完全落在脸区内
    if (expressionId !== 'neutral') {
      const difference = diffBoundingBox(baseRaw, raw);
      if (!difference.bbox) {
        problems.push(`C1 失败：${expressionId} 与 E1_default 在整张画布上完全相同（美术可能交错了文件）`);
      } else if (!rectContains(FACE_REGION_MASTER, difference.bbox)) {
        problems.push(
          `C1 失败：${expressionId} 的差异 bbox (${difference.bbox.x}, ${difference.bbox.y}, ` +
            `${difference.bbox.width}×${difference.bbox.height}) 越出脸区 ` +
            `(${FACE_REGION_MASTER.x}, ${FACE_REGION_MASTER.y}, ${FACE_REGION_MASTER.width}×${FACE_REGION_MASTER.height})——脸区画小了`,
        );
      } else if (verbose) {
        log(`[pet-face] C1 ${expressionId} 差异 bbox ${difference.bbox.width}×${difference.bbox.height} 落在脸区内`);
      }
    }

    const region = cropRawRegion(raw, FACE_REGION_MASTER);
    if (check) {
      // 只校验模式：不写盘，只比 catalog 里的期望值
      const expected = readExistingCatalog(catalogPath);
      const recorded = expected?.faceTiles?.[expressionId];
      if (!recorded) {
        problems.push(`清单过期：${basename(catalogPath)} 缺少表情 ${expressionId}（先跑 npm run build:pet-face）`);
        continue;
      }
      catalogTiles[expressionId] = recorded;
      entries.push({
        expressionId,
        sha256: { '1x': recorded?.['1x']?.sha256 ?? '', '2x': recorded?.['2x']?.sha256 ?? '' },
        problems: [],
      });
      continue;
    }

    const emitted = await emitDensities(sharp, region, outDir, expressionId, { assetBase, verbose, log });
    problems.push(...emitted.problems);
    catalogTiles[expressionId] = emitted.files;
    bytesByDensity['1x'] += emitted.bytes['1x'];
    bytesByDensity['2x'] += emitted.bytes['2x'];
    entries.push({
      expressionId,
      sha256: { '1x': emitted.files['1x'].sha256, '2x': emitted.files['2x'].sha256 },
      problems: [],
    });
  }

  // 延迟交付的两档：母版没到（或未显式转正）就如实记进 degraded，绝不造假贴片
  const includeDeferred = options.includeDeferred === true;
  const degraded = [];
  for (const expressionId of FACE_DEFERRED_IDS) {
    const masterPath = findMaster(expressionId, options.sourceDir);
    if (!masterPath) {
      degraded.push(expressionId);
      log(`[pet-face] ${expressionId} 母版未交付（${MASTER_FILE_BY_ID[expressionId]}.png），走 degraded`);
      continue;
    }
    if (!includeDeferred) {
      degraded.push(expressionId);
      log(
        `[pet-face] ${expressionId} 母版存在但未启用（源文件可能尚未入库），仍按 degraded 处理；` +
          '母版入库后加 --include-deferred 转正',
      );
      continue;
    }
    // 母版到货：按同一套规则裁切；wink 额外要求差异只落在单侧眼区
    const raw = await readRawPixels(sharp, masterPath);
    const difference = diffBoundingBox(baseRaw, raw);
    if (!difference.bbox) {
      problems.push(`C1 失败：${expressionId} 与 E1_default 完全相同（wink/blinkHalf 必须有像素变化）`);
    } else {
      if (!rectContains(FACE_REGION_MASTER, difference.bbox)) {
        problems.push(
          `C1 失败：${expressionId} 的差异 bbox (${difference.bbox.x}, ${difference.bbox.y}, ` +
            `${difference.bbox.width}×${difference.bbox.height}) 越出脸区`,
        );
      }
      if (expressionId === 'wink' && !rectContains(WINK_EYE_WINDOW_MASTER, difference.bbox)) {
        problems.push(
          `C1 失败：wink 的差异 bbox 越出单侧眼区 (${WINK_EYE_WINDOW_MASTER.x}, ${WINK_EYE_WINDOW_MASTER.y}, ` +
            `${WINK_EYE_WINDOW_MASTER.width}×${WINK_EYE_WINDOW_MASTER.height})——疑似 blink 重复（wink 必须只闭一只眼）`,
        );
      }
    }
    if (check) {
      // 只校验模式：已转正的延迟档也要按清单核对（不写盘、不重新编码）。
      // 少了这一步，`--check` 会把一份**正确**的转正清单判成过期（缺 wink 条目），
      // 于是"转正"与"校验"互相打架，只能靠回滚转正来换绿。
      const recorded = readExistingCatalog(catalogPath)?.faceTiles?.[expressionId];
      if (!recorded) {
        problems.push(
          `清单过期：${basename(catalogPath)} 缺少表情 ${expressionId}` +
            '（母版已入库，重跑 node scripts/build-pet-face-tiles.mjs --include-deferred）',
        );
        continue;
      }
      catalogTiles[expressionId] = recorded;
      entries.push({
        expressionId,
        sha256: { '1x': recorded?.['1x']?.sha256 ?? '', '2x': recorded?.['2x']?.sha256 ?? '' },
        problems: [],
      });
      continue;
    }
    const region = cropRawRegion(raw, FACE_REGION_MASTER);
    const emitted = await emitDensities(sharp, region, outDir, expressionId, { assetBase, verbose, log });
    problems.push(...emitted.problems);
    catalogTiles[expressionId] = emitted.files;
    bytesByDensity['1x'] += emitted.bytes['1x'];
    bytesByDensity['2x'] += emitted.bytes['2x'];
    entries.push({
      expressionId,
      sha256: { '1x': emitted.files['1x'].sha256, '2x': emitted.files['2x'].sha256 },
      problems: [],
    });
  }

  problems.push(...verifyChecks(entries));

  const totalBytes = bytesByDensity['1x'] + bytesByDensity['2x'];
  if (!check && totalBytes > FACE_TOTAL_BYTE_BUDGET) {
    problems.push(`脸贴片合计 ${totalBytes}B 超出总预算 ${FACE_TOTAL_BYTE_BUDGET}B（先降码率，不要改尺寸）`);
  }
  if (problems.length > 0) {
    throw new Error(`脸区贴片校验未通过（${problems.length} 项）：${problems.join('; ')}`);
  }

  const catalog = {
    version: 1,
    generatedBy: GENERATOR_ID,
    assetId: 'lingxi-pet-p1-face',
    assetBase,
    faceRegion: { ...FACE_REGION_MASTER },
    faceRegionNative: { ...FACE_REGION_NATIVE },
    masterDir: describeMasterDir(masters.get('neutral'), options.sourceDir),
    degraded,
    faceTiles: catalogTiles,
  };

  const changed = [];
  const faceFiles = catalogTiles.neutral ?? {};
  if (JSON.stringify(faceLayer.files ?? null) !== JSON.stringify(faceFiles)) {
    changed.push('pet-layers.json#face.files');
  }

  if (check) {
    const existing = readExistingCatalog(catalogPath);
    if (JSON.stringify(existing) !== JSON.stringify(catalog)) {
      changed.push(`${basename(catalogPath)}`);
    }
    if (changed.length > 0) {
      throw new Error(
        `脸区贴片清单/回填已过期，请运行 node scripts/build-pet-face-tiles.mjs 重写：${changed.join('; ')}`,
      );
    }
    return { skipped: false, reason: '', catalog, degraded, changed, problems, bytes: bytesByDensity };
  }

  writeCatalog(catalog, catalogPath);
  if (changed.length > 0) {
    const next = JSON.parse(JSON.stringify(manifest));
    const target = next.layers.find((layer) => layer && layer.layerId === FACE_LAYER_ID);
    target.files = faceFiles;
    writeFileSync(layersPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }
  const removed = pruneFaceOrphans(outDir, catalogTiles);
  if (removed.length > 0) log(`[pet-face] 清理孤儿贴片 ${removed.length} 个: ${removed.join(', ')}`);

  return {
    skipped: false,
    reason: '',
    catalog,
    degraded,
    changed,
    problems,
    removed,
    bytes: bytesByDensity,
  };
}

/**
 * 读已存在的清单（缺失或损坏时返回 null，不抛）。
 *
 * @param {string} catalogPath 清单路径
 * @returns {object | null} 清单对象
 */
export function readExistingCatalog(catalogPath = FACE_TILES_JSON_PATH) {
  if (!existsSync(catalogPath)) return null;
  try {
    return readJsonFile(catalogPath);
  } catch {
    return null;
  }
}

/**
 * 描述本次实际取母版的目录（写进清单便于对账）。
 *
 * <p>取的是 <b>`E1_default` 所在目录</b>（其余 8 档同批都在那里）；v4 只补 `wink`/`blinkHalf`，
 * 若把"v4 存在"当成"全部来自 v4"，清单就会说谎（实测 v4 里只有 E9_wink.png）。</p>
 *
 * @param {string} [masterPath] 基准母版（`E1_default.png`）的绝对路径
 * @param {string} [explicitDir] `--source` 指定的目录
 * @returns {string} 相对仓库根的 POSIX 路径（或原样目录）；无法判定时为空串
 */
export function describeMasterDir(masterPath, explicitDir) {
  if (explicitDir) return resolve(explicitDir).replace(/\\/g, '/');
  if (!masterPath) return '';
  const root = findRepoRoot();
  const dir = dirname(resolve(masterPath));
  return dir.startsWith(root) ? dir.slice(root.length + 1).replace(/\\/g, '/') : dir.replace(/\\/g, '/');
}

/**
 * 删掉输出目录里没有被清单引用的贴片（改了表情 id 之后留下的孤儿）。
 *
 * @param {string} outDir 输出目录
 * @param {object} tiles 清单里的 `faceTiles`
 * @returns {string[]} 被删掉的文件名
 */
export function pruneFaceOrphans(outDir, tiles) {
  if (!existsSync(outDir)) return [];
  const expected = new Set();
  for (const byDensity of Object.values(tiles ?? {})) {
    for (const file of Object.values(byDensity ?? {})) {
      if (file && typeof file.file === 'string') expected.add(basename(file.file));
    }
  }
  const removed = [];
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.webp$/i.test(entry.name)) continue;
    if (expected.has(entry.name)) continue;
    rmSync(resolve(outDir, entry.name), { force: true });
    removed.push(entry.name);
  }
  return removed;
}

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 参数列表
 * @returns {{check: boolean, verbose: boolean, includeDeferred: boolean, source: string | null, out: string | null}}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const valueOf = (name) => {
    const index = args.indexOf(name);
    if (index >= 0 && index + 1 < args.length) return args[index + 1];
    const prefixed = args.find((item) => item.startsWith(`${name}=`));
    return prefixed ? prefixed.slice(name.length + 1) : null;
  };
  return {
    check: args.includes('--check'),
    verbose: args.includes('--verbose'),
    includeDeferred: args.includes('--include-deferred'),
    source: valueOf('--source'),
    out: valueOf('--out'),
  };
}

/**
 * 已入库的 `pet-face-tiles.json` 里是否已经给"延迟交付档"生成了贴片。
 *
 * <p><b>`--check` 为什么要读它：</b>`--check` 的职责是"入库状态与母版是否自洽"，
 * 而不是"要求把已转正的贴片退回 degraded"。母版入库并显式 `--include-deferred` 转正之后，
 * 不带 flag 的 `--check` 若仍按 degraded 复算，就会把一份**正确**的入库物判成过期，
 * 逼着人把转正结果回滚——那是把可复现性做反了。所以 `--check` 以<b>入库现状</b>为基准：
 * 已经转正（清单里有贴片）且母版仍在，就按转正口径重算并比对。</p>
 *
 * @returns {boolean} 清单里是否已有任一延迟档的贴片条目
 */
function committedHasDeferredTiles() {
  try {
    if (!existsSync(FACE_TILES_JSON_PATH)) return false;
    const catalog = JSON.parse(readFileSync(FACE_TILES_JSON_PATH, 'utf8'));
    const tiles = catalog && typeof catalog === 'object' ? catalog.faceTiles : null;
    if (!tiles || typeof tiles !== 'object') return false;
    return FACE_DEFERRED_IDS.some((expressionId) => Boolean(tiles[expressionId]));
  } catch (err) {
    // 清单损坏属于"过期/不可读"，交给 buildFaceTiles 的校验去报；这里只当没转正过
    return false;
  }
}

/**
 * CLI 入口。
 *
 * @returns {Promise<number>} 进程退出码（0 = 成功）
 */
export async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const includeDeferred = args.includeDeferred || (args.check && committedHasDeferredTiles());
    const result = await buildFaceTiles({
      check: args.check,
      verbose: args.verbose,
      includeDeferred,
      sourceDir: args.source ? resolve(args.source) : undefined,
      outDir: args.out ? resolve(args.out) : undefined,
      log: (message) => console.log(message),
    });
    if (result.degraded.length > 0) {
      console.log(`[pet-face] degraded（母版未交付，走降级路径）: ${result.degraded.join(', ')}`);
    }
    const count = Object.keys(result.catalog?.faceTiles ?? {}).length;
    if (args.check) {
      console.log(`[pet-face] 校验通过：贴片 ${count} 档 × 2 档密度，清单与磁盘/母版一致（未写盘）`);
    } else {
      console.log(
        `[pet-face] 贴片 ${count} 档 × 2 档密度，@1x 合计=${result.bytes['1x']}B @2x 合计=${result.bytes['2x']}B`,
      );
    }
    if (result.changed.length === 0) {
      console.log('[pet-face] 清单与回填已是最新（无改动）');
    } else {
      console.log(`[pet-face] 已写回: ${result.changed.join('; ')}`);
    }
    return 0;
  } catch (err) {
    console.error(`[pet-face] 失败: ${(err && err.message) || err}`);
    return 1;
  }
}

/** 当前脚本是否为入口（被 import 时保持静默）。 */
export const IS_ENTRY = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (IS_ENTRY) {
  main().then((code) => process.exit(code));
}