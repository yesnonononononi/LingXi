/**
 * `pet-poses.json` 的**按键白名单**校验（运行时的 G-16：未知键必须抛错，不许静默丢弃）。
 *
 * <p><b>为什么需要这一层：</b>历史缺陷不是"算错了"，而是"没人看见"——
 * `sleep` 少 11 个必备键、`walk` 少 3 个（见 wiki `桌宠.md`），两次都是因为
 * "多出来的/少掉的字段无人断言"才拖到验收后。反向写法（"凡不认识的都放过"）等于
 * 把这道守卫写成恒真，所以这里用**正向白名单**：只有
 * {@link POSES_SCHEMA_LAYERS} 里列出的键才是认识的，多一个就抛 {@link TypeError}。</p>
 *
 * <p><b>为什么白名单放在 JSON 里：</b>同一份校验还必须在**构建期**
 * （`scripts/check-pet-poses.mjs`）跑一遍，否则"生成物"和"消费端"会各说各话。
 * 构建脚本是 `.mjs`（node 直接跑），运行时是 TS，两者不能互相 import，
 * 于是把**数据**（允许的键）放进 `frontend/pet-poses.schema.json` 这一份真源，
 * 两侧各自只写一遍 40 行遍历逻辑。</p>
 *
 * <p><b>覆盖范围：</b>任务要求的 batch / frame / clip 三层，外加它们内部形状固定的子对象
 * （`canvas`、`nativeCanvas`、`bodyAnchor`、`envelopeCss`、`provenance`、`files`、
 * `anchorNative`、`inkNative`）——这些子对象同样是"生产者写入 → 消费端丢弃"的高危区。
 * 数组型字段（`frames[]`、`consumedKeys[]`）是值不是键，不在本模块职责内。</p>
 *
 * @module pet/poses/schema
 */
import schemaSource from '../../../pet-poses.schema.json';

/** schema 里允许的层名 → 该层允许出现的键（顺序即报错里的提示顺序）。 */
export const POSES_SCHEMA_LAYERS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries((schemaSource as { layers: Record<string, string[]> }).layers).map(([layer, keys]) => [
      layer,
      Object.freeze([...keys]),
    ]),
  ),
);

/**
 * 每个"父层 + 键"对应的子层名（表里没有的组合一律不递归：不猜结构）。
 *
 * <p>写成显式映射而不是"凡是对象就递归"，是因为后者会给未声明的键一次递归机会，
 * 报错路径会漂移，也违背"正向白名单"的原则。</p>
 */
const CHILD_LAYERS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
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
 * "动态键映射"层：这一层的键本身是**数据**（如 `byFacing` 的键是朝向 `-1`/`1`），
 * 不是 schema 里能逐个枚举的键名，所以对它的每个值套同一个子层，且不对它的键报未知。
 */
const MAP_CHILD_LAYERS: Readonly<Record<string, string>> = Object.freeze({
  'batch.bodyAnchor.byFacing': 'batch.bodyAnchor.byFacing.*',
});

/** 一个未声明的键（`path` 就是报错里要打出来的位置，例如 `batches.walk.clips[0].unknownKey`）。 */
export interface UnknownKeyProblem {
  /** 完整路径（含键名本身）。 */
  readonly path: string;
  /** 键名。 */
  readonly key: string;
  /** 该键所在层（如 `clip`）。 */
  readonly layer: string;
  /** 该层允许的键（报错里逐条列出，便于直接照着改）。 */
  readonly allowed: readonly string[];
}

/**
 * 取某层允许的键；未登记的层返回空数组（= 不校验，交给别处的显式校验）。
 *
 * @param layer 层名
 * @returns 允许的键
 */
export function allowedKeysOf(layer: string): readonly string[] {
  return POSES_SCHEMA_LAYERS[layer] ?? [];
}

/**
 * 整理一条问题的可读文本（两侧实现必须逐字一致，`tests/petPoseManifest.test.ts` 有对账）。
 *
 * @param problem 问题
 * @returns 文本（不含前缀）
 */
export function describeUnknownKey(problem: UnknownKeyProblem): string {
  return `${problem.path} 出现未声明的键「${problem.key}」（${problem.layer} 层只允许：${problem.allowed.join(' / ')}）`;
}

/**
 * 递归收集某个层对象里的未声明键。
 *
 * @param value 值（数组会逐项、对象会查键、标量直接跳过）
 * @param layer 层名
 * @param path 当前路径
 * @param out 收集器
 */
function collect(value: unknown, layer: string, path: string, out: UnknownKeyProblem[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, layer, `${path}[${index}]`, out));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const mapChild = MAP_CHILD_LAYERS[layer];
  if (mapChild !== undefined) {
    // 动态键层（`byFacing` 的键是朝向数据）：只逐值递归，不对键本身报未知
    for (const [key, item] of Object.entries(record)) collect(item, mapChild, `${path}.${key}`, out);
    return;
  }
  const allowed = allowedKeysOf(layer);
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) out.push({ path: `${path}.${key}`, key, layer, allowed });
  }
  for (const [child, childLayer] of Object.entries(CHILD_LAYERS[layer] ?? {})) {
    if (record[child] === undefined) continue;
    collect(record[child], childLayer, `${path}.${child}`, out);
  }
}

/**
 * 扫描整份 `pet-poses.json`，返回全部未声明的键（顺序稳定：batch → 子对象 → clips → frames）。
 *
 * <p>结构不认识（缺 `batches`、某批不是对象）时返回空数组：那是别的校验的职责，
 * 本函数只回答"有没有 schema 没声明的键"，不做多重报错。</p>
 *
 * @param manifest 原始 JSON（不可信输入）
 * @returns 问题列表（空数组 = 通过）
 */
export function findUnknownKeys(manifest: unknown): UnknownKeyProblem[] {
  const out: UnknownKeyProblem[] = [];
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return out;
  const batches = (manifest as Record<string, unknown>).batches;
  if (batches === null || typeof batches !== 'object' || Array.isArray(batches)) return out;
  for (const [posture, batch] of Object.entries(batches as Record<string, unknown>)) {
    const path = `batches.${posture}`;
    collect(batch, 'batch', path, out);
    if (batch === null || typeof batch !== 'object') continue;
    const record = batch as Record<string, unknown>;
    const clips = record.clips;
    if (Array.isArray(clips)) collect(clips, 'clip', `${path}.clips`, out);
    const frames = record.frames;
    if (frames !== null && typeof frames === 'object' && !Array.isArray(frames)) {
      for (const [frameId, frame] of Object.entries(frames as Record<string, unknown>)) {
        collect(frame, 'frame', `${path}.frames.${frameId}`, out);
      }
    }
  }
  return out;
}

/**
 * 断言清单里没有未声明的键（运行时反序列化的第一道闸门）。
 *
 * @param manifest 原始 JSON（不可信输入）
 * @throws {TypeError} 存在未声明的键（消息里逐条给出路径与键名）
 */
export function assertNoUnknownKeys(manifest: unknown): void {
  const problems = findUnknownKeys(manifest);
  if (problems.length === 0) return;
  const lines = problems.slice(0, 20).map((problem) => `   - ${describeUnknownKey(problem)}`);
  if (problems.length > lines.length) {
    lines.push(`   … 另有 ${problems.length - lines.length} 个未声明的键`);
  }
  throw new TypeError(
    `[pet-poses] pet-poses.json 里有 ${problems.length} 个 schema 未声明的键（静默忽略过一次，代价是两轮返工）：\n` +
      lines.join('\n'),
  );
}
