/**
 * 脸区贴片契约单测（R7，tsx 执行，不碰 DOM / Electron）。
 *
 * <p><b>守的是什么：</b>M1 的整套方案压在一个接缝上——<b>脸贴片就是母版在脸区矩形内的原样裁切</b>。
 * 这个接缝一旦错位（`rect` 抄错一位、贴片尺寸漂 1px、贴片是复制粘贴的），
 * 屏幕上的表现只是"脸边缘有点怪"，代码里查不出根因。所以这里把六条判据钉死：</p>
 * <ol>
 *   <li><b>矩形同源</b>：`pet-face-tiles.json` 的 `faceRegion` 与 `pet-layers.json` 的 `face.rect` 逐位相等；</li>
 *   <li><b>尺寸严格</b>：磁盘上的贴片恰好 396×200 / 198×100（C4）；</li>
 *   <li><b>摘要对齐</b>：`bytes` / `sha256` 与磁盘一致（清单过期会立刻红）；</li>
 *   <li><b>两两不同</b>：八张 `@2x` 贴片 sha256 互不重复，且都不等于 `neutral`（C6）；</li>
 *   <li><b>单字段所有权</b>：`face.files` 与清单的 `neutral` 条目逐字段相等（C9）；</li>
 *   <li><b>降级属实</b>：`degraded` 里的 id 真的没有贴片（磁盘上也没有），
 *       其余 id 真的有贴片 —— 不许"假装有资产"，也不许"有资产却标降级"。</li>
 * </ol>
 *
 * <p>最后一条用例用子进程跑 `node scripts/build-pet-face-tiles.mjs --check`，
 * 把 C1/C5/C6/C9 对着<b>美术母版</b>重算一遍（含"清单是否过期"），
 * 这是"生成物入库"与"源仍在库"之间唯一的硬连接。</p>
 *
 * <p>运行：`npm run test:pet`。</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FACE_DEGRADED_IDS,
  FACE_REGION,
  FACE_REGION_NATIVE,
  FACE_TILES,
  FACE_TILES_MANIFEST,
  faceTileFile,
  faceTileUrl,
  faceTileUrls,
  isFaceDegraded,
} from '../src/pet/assets/face-tiles';
import { findLayer, PET_LAYERS } from '../src/pet/layers/manifest';
import { EXTERNAL_LAYER_IDS } from '../scripts/build-pet-layers.mjs';
import {
  FACE_DEFERRED_IDS,
  FACE_LAYER_ID,
  FACE_REGION_MASTER,
  FACE_TILE_IDS,
  FACE_TILE_SIZES,
} from '../scripts/build-pet-face-tiles.mjs';
import { readImageSize } from '../scripts/pet-image-headers.mjs';

/** 前端根目录。 */
const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 脸贴片运行时目录。 */
const FACE_OUT_DIR = resolve(FRONTEND_ROOT, 'public', 'live2d', 'pet-p1', 'face');

/**
 * 映射文件为磁盘绝对路径（`face/<id>@<density>.webp` 相对 `pet-p1/`）。
 *
 * @param file 清单里的 `file` 字段
 * @returns 绝对路径
 */
function diskPathOf(file: string): string {
  const relative = String(file).replace(/\\/g, '/').replace(/^face\//, '');
  return join(FACE_OUT_DIR, relative);
}

/**
 * 计算文件 sha256。
 *
 * @param absolute 绝对路径
 * @returns 小写十六进制摘要
 */
function sha256Of(absolute: string): string {
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

test('矩形同源：清单 faceRegion === 层契约 face.rect === 脚本真源 FACE_REGION_MASTER', () => {
  const faceLayer = findLayer(FACE_LAYER_ID, PET_LAYERS);
  assert.ok(faceLayer, `pet-layers.json 里没有 ${FACE_LAYER_ID} 层（M1 契约要求第 10 层）`);
  assert.deepEqual(
    { x: faceLayer.rect.x, y: faceLayer.rect.y, width: faceLayer.rect.width, height: faceLayer.rect.height },
    { x: FACE_REGION.x, y: FACE_REGION.y, width: FACE_REGION.width, height: FACE_REGION.height },
    'pet-layers.json 的 face.rect 与 pet-face-tiles.json 的 faceRegion 不一致：贴片会被画偏',
  );
  assert.deepEqual(
    { x: FACE_REGION.x, y: FACE_REGION.y, width: FACE_REGION.width, height: FACE_REGION.height },
    { x: FACE_REGION_MASTER.x, y: FACE_REGION_MASTER.y, width: FACE_REGION_MASTER.width, height: FACE_REGION_MASTER.height },
    '构建脚本真源与清单不一致（生成物过期，重跑 npm run build:pet-face）',
  );
  // 原生坐标 = 母版 ÷2（母版是 1024×1536 的最近邻 2× 放大）
  assert.deepEqual(FACE_REGION_NATIVE, {
    left: FACE_REGION.x / 2,
    top: FACE_REGION.y / 2,
    width: FACE_REGION.width / 2,
    height: FACE_REGION.height / 2,
  });
});

test('层 id 同源：EXTERNAL_LAYER_IDS / 脸贴片脚本 / 层清单三处一致', () => {
  assert.equal(EXTERNAL_LAYER_IDS[0], FACE_LAYER_ID, 'build-pet-layers 与 build-pet-face-tiles 的层 id 不一致');
  assert.ok(findLayer(FACE_LAYER_ID, PET_LAYERS), '层清单里没有脸层');
  assert.equal(FACE_LAYER_ID, 'face');
});

test('清单元数据：版本/生成器/资产前缀与层清单一致', () => {
  assert.equal(FACE_TILES_MANIFEST.version, 1);
  assert.equal(FACE_TILES_MANIFEST.generatedBy, 'scripts/build-pet-face-tiles.mjs');
  assert.equal(FACE_TILES_MANIFEST.assetId, 'lingxi-pet-p1-face');
  assert.equal(
    FACE_TILES_MANIFEST.assetBase,
    PET_LAYERS.assetBase,
    '脸贴片与分层件的 assetBase 必须同源，否则 lxa:// 会 404',
  );
});

test('基础 8 档贴片齐备（尺寸严格 396×200 / 198×100，bytes/sha256 与磁盘一致）', () => {
  for (const id of FACE_TILE_IDS) {
    assert.ok(FACE_TILES[id], `缺少表情 ${id} 的贴片条目`);
    for (const density of ['1x', '2x'] as const) {
      const file = faceTileFile(id, density);
      assert.ok(file, `${id}@${density} 缺条目`);
      const absolute = diskPathOf(file.file);
      assert.ok(existsSync(absolute), `${id}@${density} 文件不存在：${absolute}（重跑 npm run build:pet-face）`);
      const expected = FACE_TILE_SIZES[density];
      const size = readImageSize(absolute);
      assert.equal(size.width, expected.width, `${id}@${density} 宽度必须是 ${expected.width}`);
      assert.equal(size.height, expected.height, `${id}@${density} 高度必须是 ${expected.height}`);
      assert.equal(file.width, expected.width);
      assert.equal(file.height, expected.height);
      assert.equal(statSync(absolute).size, file.bytes, `${id}@${density} bytes 与磁盘不一致（清单过期）`);
      assert.equal(sha256Of(absolute), file.sha256, `${id}@${density} sha256 与磁盘不一致（清单过期）`);
      assert.equal(file.format, 'webp-lossless', `${id}@${density} 必须是无损 WebP（有损会让 C3 的 maxDelta 爆到 50+）`);
      assert.equal(file.url, `${FACE_TILES_MANIFEST.assetBase}${file.file}`, `${id}@${density} url 必须等于 assetBase+file`);
      assert.ok(file.file.startsWith('face/'), `${id}@${density} 文件必须落在 face/ 子目录`);
    }
  }
});

test('C6：八张 @2x 贴片两两不同，且都不等于 neutral', () => {
  const seen = new Map<string, string>();
  for (const id of FACE_TILE_IDS) {
    const file = faceTileFile(id, '2x');
    assert.ok(file, `${id}@2x 缺条目`);
    const previous = seen.get(file.sha256);
    assert.equal(previous, undefined, `${id} 与 ${previous} 的 @2x 贴片完全相同（复制粘贴的表情不可辨）`);
    seen.set(file.sha256, id);
  }
  const neutral = faceTileFile('neutral', '2x');
  assert.ok(neutral);
  for (const id of FACE_TILE_IDS) {
    if (id === 'neutral') continue;
    assert.notEqual(faceTileFile(id, '2x')?.sha256, neutral.sha256, `${id} 的贴片与 neutral 相同（表情没换脸）`);
  }
});

test('C9：pet-layers.json 的 face.files 与清单 neutral 条目逐字段相等', () => {
  const faceLayer = findLayer(FACE_LAYER_ID, PET_LAYERS);
  assert.ok(faceLayer);
  const recorded = faceLayer.files as Record<string, unknown>;
  const catalog = FACE_TILES.neutral as Record<string, unknown>;
  assert.ok(catalog, '清单缺少 neutral（脸层的静态文件就该是 neutral 贴片）');
  assert.deepEqual(recorded, catalog, 'face.files 与 pet-face-tiles.json 的 neutral 不一致：两个生成器打架');
  for (const density of ['1x', '2x']) {
    assert.ok(recorded[density], `face.files 缺少 ${density}（layered 模式会缺档）`);
  }
});

test('降级属实：degraded 的 id 没有贴片（磁盘上也没有），其余 id 都有贴片', () => {
  // 期望值由**入库状态**决定，而不是写死"wink + blinkHalf 两档"：
  // 美术母版到货并 `--include-deferred` 转正后，同一份用例必须继续守得住
  // （转正的那档不许还留着 degraded，没转正的那档也不许凭空有贴片）。
  const expectedDegraded = FACE_DEFERRED_IDS.filter((id) => FACE_TILES[id as never] === undefined).sort();
  const degraded = [...FACE_TILES_MANIFEST.degraded].sort();
  assert.deepEqual(degraded, expectedDegraded, 'degraded 必须恰好等于"延迟档里没有贴片的那几档"');
  for (const id of degraded) {
    assert.ok(
      (FACE_DEFERRED_IDS as readonly string[]).includes(id),
      `${id} 不在延迟交付清单里，不该出现在 degraded`,
    );
  }
  // 没转正的延迟档：清单里没有、磁盘上也没有、接口一律返回空（调用方据此走降级路径）
  for (const id of degraded) {
    assert.equal(FACE_DEGRADED_IDS.has(id as never), true, `${id} 必须在 FACE_DEGRADED_IDS 里`);
    assert.equal(isFaceDegraded(id as never), true);
    assert.equal(faceTileUrl(id as never), '', `${id} 没有贴片时 faceTileUrl 必须返回空串（调用方据此回落）`);
    assert.equal(faceTileFile(id as never), null);
    for (const density of ['1x', '2x']) {
      assert.equal(existsSync(join(FACE_OUT_DIR, `${id}@${density}.webp`)), false, `${id}@${density} 不该存在贴片文件`);
    }
  }
  // 反向：不在 degraded 里的都必须真的有贴片（"有资产却标降级"同样是缺陷）
  for (const id of Object.keys(FACE_TILES)) {
    assert.equal(FACE_DEGRADED_IDS.has(id), false, `${id} 有贴片却被标成降级`);
  }
});

test('faceTileUrls：只给有贴片的表情，degraded 的不出现', () => {
  const urls = faceTileUrls('2x');
  // 必备八档一定在；延迟档转正后也要跟着出现（否则贴片生成了却没人用）
  for (const id of FACE_TILE_IDS) {
    assert.ok(urls[id], `${id} 必须有贴片 URL`);
  }
  assert.deepEqual(Object.keys(urls).sort(), Object.keys(FACE_TILES).sort(), 'URL 表必须与清单条目一一对应');
  for (const id of FACE_TILES_MANIFEST.degraded) {
    assert.equal(urls[id as never], undefined, `${id} 是 degraded，不该出现在 faceTileUrls 里`);
  }
  const first = faceTileUrl('angry', '2x');
  assert.ok(first.startsWith(FACE_TILES_MANIFEST.assetBase), 'faceTileUrl 必须带 assetBase');
});

test('生成物与母版自洽：node scripts/build-pet-face-tiles.mjs --check 必须退出 0', () => {
  const script = join(FRONTEND_ROOT, 'scripts', 'build-pet-face-tiles.mjs');
  const result = spawnSync(process.execPath, [script, '--check'], { cwd: FRONTEND_ROOT, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(
    result.status,
    0,
    `脸贴片清单已过期或校验失败（重跑 npm run build:pet-face 后重试）：\n${output}`,
  );
  assert.ok(output.includes('校验通过'), `--check 的输出缺少通过标记：\n${output}`);
});
