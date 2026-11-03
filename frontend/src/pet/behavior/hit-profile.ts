/**
 * 命中分区（头部 / 身体）——**纯函数，无 DOM、无时钟、可单测**。
 *
 * <p><b>为什么需要它：</b>M1 要区分"被摸头"和"普通点一下"：头部连点 2 次 / 按住 ≥600ms
 * 是"抚摸"（害羞 → 回礼 wink），身体单击是"happy"。而既有的 {@link HitPipeline} 只回答
 * "在不在宠物身上"，那是另一种问题（决定窗口是否穿透）。把两件事塞进一个接口，
 * 任何一侧改动都会牵连另一侧，所以这里只做**纯分类**，不改 `HitTester` 契约。</p>
 *
 * <p><b>数据来源是脸层契约本身（单一真源）：</b>脸区矩形来自 `pet-layers.json` 的
 * `face.rect`（母版像素）+ `canvas`，由 {@link faceRectNormalized} 归一化到 0..1。
 * 不额外引入 `pet-geometry.json` 字段，也不许在这里写坐标字面量——换母版时只改契约一处。</p>
 *
 * <p><b>为什么还要外扩：</b>脸区矩形是"贴片能被换掉的最小矩形"（实测紧贴差异 bbox），
 * 而用户心里的"头"包括耳朵内侧与下巴边缘。上下各外扩 {@link HEAD_MARGIN_Y}、
 * 左右各外扩 {@link HEAD_MARGIN_X}（画布归一化比例）之后，手指落在下巴上也算摸头。</p>
 *
 * @module pet/behavior/hit-profile
 */
import { faceLayer, PET_LAYERS } from '../layers/manifest';
import type { LayerManifest } from '../layers/types';

/**
 * 命中分区。
 *
 * <ul>
 *   <li>`head`：脸区（含外扩）——抚摸语义；</li>
 *   <li>`body`：其余部分——普通点击语义。</li>
 * </ul>
 */
export type HitProfile = 'head' | 'body';

/** 归一化矩形（0..1，原点画布左上）。 */
export interface NormalizedRect {
  /** 左边界。 */
  readonly left: number;
  /** 上边界。 */
  readonly top: number;
  /** 右边界。 */
  readonly right: number;
  /** 下边界。 */
  readonly bottom: number;
}

/** 头部判定的左右外扩（画布归一化）：0.08 × 2048 ≈ 164 母版 px。 */
export const HEAD_MARGIN_X = 0.08;

/** 头部判定的上下外扩（画布归一化）：0.06 × 3072 ≈ 184 母版 px。 */
export const HEAD_MARGIN_Y = 0.06;

/**
 * 把数值夹到 0..1（脏值按 0 处理，绝不产生 NaN 进比较）。
 *
 * @param value 原始值
 * @returns 落在 [0,1] 的数
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 脸区矩形（归一化到画布 0..1）。
 *
 * @param manifest 层清单（缺省用运行时真清单）
 * @returns 归一化矩形；清单里没有脸层或数据非法时返回 null（调用方按"全是身体"处理）
 */
export function faceRectNormalized(manifest: LayerManifest = PET_LAYERS): NormalizedRect | null {
  const face = faceLayer(manifest);
  if (!face) return null;
  const canvas = manifest.canvas;
  const rect = face.rect;
  if (!rect || !(canvas.width > 0) || !(canvas.height > 0)) return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    left: clamp01(rect.x / canvas.width),
    top: clamp01(rect.y / canvas.height),
    right: clamp01((rect.x + rect.width) / canvas.width),
    bottom: clamp01((rect.y + rect.height) / canvas.height),
  };
}

/**
 * 分类一个归一化坐标点。
 *
 * <p>判定顺序：不在脸区外扩框内就是 `body`，在就是 `head`。坐标越界（点在立绘箱外）
 * 一律 `body`——点击本来就已经被 `HitTester` 过滤过一轮，这里只是第二道门。</p>
 *
 * @param u 归一化 x（0..1，原点画布左）
 * @param v 归一化 y（0..1，原点画布上）
 * @param manifest 层清单
 * @returns `head` 或 `body`
 */
export function classifyProfile(u: number, v: number, manifest: LayerManifest = PET_LAYERS): HitProfile {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return 'body';
  const rect = faceRectNormalized(manifest);
  if (!rect) return 'body';
  const nu = clamp01(u);
  const nv = clamp01(v);
  const withinX = nu >= rect.left - HEAD_MARGIN_X && nu <= rect.right + HEAD_MARGIN_X;
  const withinY = nv >= rect.top - HEAD_MARGIN_Y && nv <= rect.bottom + HEAD_MARGIN_Y;
  return withinX && withinY ? 'head' : 'body';
}

/**
 * 视口坐标 → 画布归一化坐标（与 `layout.ts` 的 `toNormalized` 同口径，但**钳制**到 0..1）。
 *
 * <p>渲染入口只需要"点在画布哪儿"，而 `toNormalized` 刻意不钳制（它要让调用方区分
 * "刚好在边缘"与"在窗口外"。这里要的是能直接喂给 {@link classifyProfile} 的值，
 * 越界点钳到边缘即可——反正 {@link classifyProfile} 会按外扩框判成 `body`）。</p>
 *
 * @param point 视口坐标（CSS px）
 * @param origin 立绘箱左上角（视口坐标）
 * @param size 立绘箱尺寸（CSS px）
 * @returns 归一化坐标；尺寸非法时返回 null
 */
export function normalizeCanvasPoint(
  point: Readonly<{ x: number; y: number }>,
  origin: Readonly<{ x: number; y: number }>,
  size: Readonly<{ width: number; height: number }>,
): { readonly u: number; readonly v: number } | null {
  if (!point || !origin || !size) return null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (!(size.width > 0) || !(size.height > 0)) return null;
  return {
    u: clamp01((point.x - origin.x) / size.width),
    v: clamp01((point.y - origin.y) / size.height),
  };
}
