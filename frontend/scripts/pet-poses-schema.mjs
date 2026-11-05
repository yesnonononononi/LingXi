/**
 * `pet-poses.json` 的按键白名单校验（**构建期**这一侧）。
 *
 * <p><b>为什么构建期必须有同一份校验：</b>如果只在运行时拦，`--check` 会对着一个含未知键的
 * 清单说"OK"，于是"生成物合法"和"消费端能读"变成两套口径——本项目已经为
 * "没断言所以没人发现"返工过两次（wiki `桌宠.md`：`sleep` 缺 11 个必备键、`walk` 缺 3 个）。
 * 反过来只拦构建期也不行：有人绕过构建脚本手改清单时，运行时必须自己站住。</p>
 *
 * <p><b>唯一真源：</b>允许的键来自 `frontend/pet-poses.schema.json`，
 * 与 `src/pet/poses/schema.ts` 读的是同一个文件；两条实现各自只写遍历逻辑，
 * 报错文案逐字一致（`tests/petPoseManifest.test.ts` 有对账用例）。</p>
 *
 * @module scripts/pet-poses-schema
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** schema 真源路径（`frontend/pet-poses.schema.json`）。 */
export const POSES_SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pet-poses.schema.json');

/** 缓存的 schema（只读一次，构建期会被反复调用）。 */
let cachedSchema = null;

/**
 * 读取 schema 真源（带缓存）。
 *
 * @returns {{layers: Record<string, string[]>}} schema
 * @throws {Error} 文件缺失或不可解析
 */
export function loadPosesSchema() {
  if (cachedSchema !== null) return cachedSchema;
  const text = readFileSync(POSES_SCHEMA_PATH, 'utf8');
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.layers !== 'object' || parsed.layers === null) {
    throw new Error(`[pet-poses] schema 真源缺少 layers：${POSES_SCHEMA_PATH}`);
  }
  cachedSchema = parsed;
  return cachedSchema;
}

/**
 * 取某层允许的键。
 *
 * @param {string} layer 层名
 * @returns {string[]} 允许的键（未登记层返回空数组）
 */
export function allowedKeysOf(layer) {
  const keys = loadPosesSchema().layers[layer];
  return Array.isArray(keys) ? keys : [];
}

/**
 * 「父层 → 直接子键 → 子层」映射（与 TS 侧 `CHILD_LAYERS` 逐项一致）。
 *
 * <p>写成嵌套查表而不是"按 `/` 拆键"，是因为多段键（`batch/bodyAnchor/byFacing`）会被拆错，
 * 导致真正的子层永远不被递归、同时把子层的键误判成未知键。</p>
 */
const CHILD_LAYERS = Object.freeze({
  batch: Object.freeze({
    canvas: 'batch.canvas',
    nativeCanvas: 'batch.nativeCanvas',
    bodyAnchor: 'batch.bodyAnchor',
    envelopeCss: 'batch.envelopeCss',
    provenance: 'batch.provenance',
  }),
  'batch.bodyAnchor': Object.freeze({ byFacing: 'batch.bodyAnchor.byFacing' }),
  frame: Object.freeze({
    files: 'frame.files',
    anchorNative: 'frame.anchorNative',
    inkNative: 'frame.inkNative',
  }),
  'frame.files': Object.freeze({ '1x': 'frame.files.*', '2x': 'frame.files.*' }),
});

/**
 * "动态键映射"层：这一层的键本身是数据（`byFacing` 的键是朝向 `-1`/`1`），
 * 不是 schema 能逐个枚举的键名，所以对每个值套同一个子层、且不对键本身报未知。
 */
const MAP_CHILD_LAYERS = Object.freeze({
  'batch.bodyAnchor.byFacing': 'batch.bodyAnchor.byFacing.*',
});

/**
 * 整理一条问题的可读文本。
 *
 * @param {{path: string, key: string, layer: string, allowed: string[]}} problem 问题
 * @returns {string} 文本（不含前缀）
 */
export function describeUnknownKey(problem) {
  return `${problem.path} 出现未声明的键「${problem.key}」（${problem.layer} 层只允许：${problem.allowed.join(' / ')}）`;
}

/**
 * 递归收集某个层对象里的未声明键。
 *
 * @param {unknown} value 值
 * @param {string} layer 层名
 * @param {string} path 当前路径
 * @param {Array<{path: string, key: string, layer: string, allowed: string[]}>} out 收集器
 */
function collect(value, layer, path, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, layer, `${path}[${index}]`, out));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const mapChild = MAP_CHILD_LAYERS[layer];
  if (mapChild !== undefined) {
    for (const [key, item] of Object.entries(value)) collect(item, mapChild, `${path}.${key}`, out);
    return;
  }
  const allowed = allowedKeysOf(layer);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) out.push({ path: `${path}.${key}`, key, layer, allowed });
  }
  const children = CHILD_LAYERS[layer] ?? {};
  for (const [child, childLayer] of Object.entries(children)) {
    if (value[child] === undefined) continue;
    collect(value[child], childLayer, `${path}.${child}`, out);
  }
}

/**
 * 扫描整份清单，返回全部未声明的键。
 *
 * @param {unknown} manifest 原始 JSON
 * @returns {Array<{path: string, key: string, layer: string, allowed: string[]}>} 问题列表
 */
export function findUnknownKeys(manifest) {
  /** @type {Array<{path: string, key: string, layer: string, allowed: string[]}>} */
  const out = [];
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return out;
  const batches = manifest.batches;
  if (batches === null || typeof batches !== 'object' || Array.isArray(batches)) return out;
  for (const [posture, batch] of Object.entries(batches)) {
    const path = `batches.${posture}`;
    collect(batch, 'batch', path, out);
    if (batch === null || typeof batch !== 'object') continue;
    if (Array.isArray(batch.clips)) collect(batch.clips, 'clip', `${path}.clips`, out);
    const frames = batch.frames;
    if (frames !== null && typeof frames === 'object' && !Array.isArray(frames)) {
      for (const [frameId, frame] of Object.entries(frames)) {
        collect(frame, 'frame', `${path}.frames.${frameId}`, out);
      }
    }
  }
  return out;
}

/**
 * 校验清单里没有未声明的键，返回门禁问题行（不抛异常，交给调用方汇总）。
 *
 * @param {unknown} manifest 原始 JSON
 * @returns {string[]} 问题列表（空数组 = 通过）
 */
export function checkUnknownKeys(manifest) {
  const problems = findUnknownKeys(manifest);
  if (problems.length === 0) return [];
  const lines = problems.slice(0, 20).map((problem) => `[pet-poses] ${describeUnknownKey(problem)}`);
  if (problems.length > lines.length) {
    lines.push(`[pet-poses] … 另有 ${problems.length - lines.length} 个未声明的键`);
  }
  return lines;
}

/**
 * 断言清单里没有未声明的键（抛错版，供单测与构建脚本早退使用）。
 *
 * @param {unknown} manifest 原始 JSON
 * @throws {TypeError} 存在未声明的键
 */
export function assertNoUnknownKeys(manifest) {
  const problems = checkUnknownKeys(manifest);
  if (problems.length === 0) return;
  throw new TypeError(
    `[pet-poses] pet-poses.json 里有未声明的键（静默忽略过一次，代价是两轮返工）：\n${problems.join('\n')}`,
  );
}
