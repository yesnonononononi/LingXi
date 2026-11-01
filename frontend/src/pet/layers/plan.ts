/**
 * 合成降级选路（纯函数）：清单 + 就绪情况 → 渲染模式。
 *
 * <p><b>为什么单独成模块：</b>"该不该走分层"是**数据判断**，不是渲染判断。把它做成纯函数之后，
 * 可以在 node 里用一份份假清单把降级矩阵全部跑一遍（含负样本），
 * 而不必起 Electron 去看屏幕——这是本设计"零风险前半程"的关键。</p>
 *
 * <p><b>三级模式（设计文档 §1.6）：</b></p>
 * <ol>
 *   <li>`composite`：默认。等于今天的两张 `<img>` 双缓冲，一行代码不变；</li>
 *   <li>`partial`：压平帧打底 + **只用前景层**（`z &gt; SAFE_OVERLAY_Z`）叠上去。
 *       尾巴/耳朵/身体这些"会被身体遮住"的层一旦参与叠加就是穿模，所以它们缺一件就整体回退；</li>
 *   <li>`layered`：全部层就绪，各层独立动。</li>
 * </ol>
 *
 * <p><b>为什么"缺前景层可以、缺后景层不行"：</b>压平帧里已经画好了尾巴/耳朵/身体，
 * 所以前景层（呆毛、蝴蝶结）单独叠上去只是"同一个东西画两遍"；而后景层叠上去会浮到身体外面，
 * 是明确的视觉错误。这条物理约束把"P1 四件到齐"拆成两次可用性解锁。</p>
 *
 * @module pet/layers/plan
 */
import type { PetDensity } from '../assets/manifest';
import type { CompositePlan, LayerManifest, LayerSpec, PlanInput, ResolvedLayer } from './types';

/**
 * 可以安全叠在压平帧上的最小 `z`。
 *
 * <p><b>P1 真契约的层序（美术 manifest 的 renderOrder，不许重排）：</b>
 * `underpainting(0) → tail-base(10) → tail-tip(15) → ear-left(20) → ear-right(25)
 * → body-occluder(30) → ahoge(40) → bow(45) → foreground-occluder(50)`。</p>
 *
 * <p>安全线必须落在 `body-occluder(30)` 与 `ahoge(40)` 之间：呆毛/蝴蝶结在所有身体内容之上，
 * 单独叠上去只是"同一个东西画两遍"；而尾巴/双耳/遮挡片一旦叠上去就会浮到身体外面或露出补绘缝，
 * 是明确的视觉错误。取 35 给中间留半档余量。</p>
 */
export const SAFE_OVERLAY_Z = 35;

/** 选路理由码（排障与断言共用，改文案不改语义）。 */
export const PLAN_REASONS = {
  /** 总闸关闭（默认态）。 */
  DISABLED: 'manifest-disabled',
  /** 没有任何层被请求（清单为空 = P1 未交付）。 */
  NO_REQUESTED: 'no-requested-layers',
  /** 有层没就绪，且缺的层属于"必须整体分层"的后景层。 */
  MISSING_BACK_LAYER: 'missing-back-layer',
  /** 有层没就绪，且缺的是前景层，但没有任何前景层可用（partial 叠不出东西）。 */
  NO_FRONT_LAYER: 'no-front-layer-ready',
  /** 解码失败（本进程内不再重试）。 */
  DECODE_FAILED: 'decode-failed',
  /** 请求里出现了清单中没有的层 id（契约漂移，必须回退现状）。 */
  UNKNOWN_LAYER: 'unknown-layer',
} as const;

/** 选路理由码的类型。 */
export type PlanReason = (typeof PLAN_REASONS)[keyof typeof PLAN_REASONS];

/**
 * 判断某层在给定密度下是否有可用文件。
 *
 * @param layer 层契约
 * @param density 渲染密度
 * @param failed 解码失败过的层 id 集合
 * @returns 就绪则返回 null，否则返回原因
 */
function layerProblem(layer: LayerSpec, density: PetDensity, failed: ReadonlySet<string>): string | null {
  if (failed.has(layer.layerId)) return 'decode-failed';
  const file = layer.files[density] ?? layer.files['2x'] ?? layer.files['1x'];
  if (!file) return 'no-file';
  if (!file.url) return 'no-url';
  return null;
}

/**
 * 解析一条层请求。
 *
 * @param layerId 层 id
 * @param manifest 层清单
 * @param density 渲染密度
 * @param failed 解码失败过的层 id 集合
 * @returns 解析后的层（找不到契约时 `ready=false`）
 */
function resolveOne(
  layerId: string,
  manifest: LayerManifest,
  density: PetDensity,
  failed: ReadonlySet<string>,
): ResolvedLayer {
  const spec = manifest.layers.find((layer) => layer.layerId === layerId);
  if (!spec) {
    // 契约里没有这一层：构造一个占位 spec，让调用方仍能读到 id 与顺序信息
    const placeholder: LayerSpec = {
      layerId,
      role: 'animatable',
      z: Number.MAX_SAFE_INTEGER,
      parent: 'root',
      pivot: { u: 0.5, v: 0.5 },
      rect: { x: 0, y: 0, width: 0, height: 0 },
      source: layerId,
      blend: 'normal',
      opacity: 1,
      occludes: [],
      files: {},
      required: true,
    };
    return { spec: placeholder, ready: false, missingReason: 'unknown-layer' };
  }
  const problem = layerProblem(spec, density, failed);
  return { spec, ready: problem === null, missingReason: problem ?? '' };
}

/**
 * 计算本次渲染计划。
 *
 * @param input 选路输入
 * @returns 合成计划（`layers` 按 `z` 升序）
 */
export function resolveCompositePlan(input: PlanInput): CompositePlan {
  const density: PetDensity = input.density;
  const manifest = input.manifest;
  const requested = Array.isArray(input.requested) ? input.requested : [];
  const failed = new Set<string>(input.failedLayers ?? []);

  /** 关闸或没请求：直接回现状。 */
  if (!manifest || manifest.enabled !== true) {
    return { mode: 'composite', layers: [], fallbackReason: PLAN_REASONS.DISABLED, density };
  }
  if (requested.length === 0) {
    return { mode: 'composite', layers: [], fallbackReason: PLAN_REASONS.NO_REQUESTED, density };
  }

  const resolved = requested.map((layerId) => resolveOne(layerId, manifest, density, failed));
  const byZ = (left: ResolvedLayer, right: ResolvedLayer): number => left.spec.z - right.spec.z;
  const ready = resolved.filter((item) => item.ready).sort(byZ);
  const missing = resolved.filter((item) => !item.ready).sort(byZ);

  if (missing.length === 0) {
    return { mode: 'layered', layers: ready, fallbackReason: '', density };
  }

  // 缺的层必须全是"前景可动层"，否则分层无法安全叠加：
  //   · 后景层（尾巴/双耳）叠上去会浮到身体前面；
  //   · 支撑层（底绘/遮挡）缺一件，合成本身就是错的（比穿模更难察觉）；
  //   · 未知层（清单里没有这个 id）当作硬错误，宁可回退现状，也不要"少画一层却显示成功"。
  const missingBack = missing.filter(
    (item) =>
      item.spec.z <= SAFE_OVERLAY_Z ||
      item.spec.role === 'support' ||
      item.missingReason === 'unknown-layer',
  );
  if (missingBack.length > 0) {
    const failedBack = missingBack.filter((item) => item.missingReason === 'decode-failed');
    const unknownBack = missingBack.filter((item) => item.missingReason === 'unknown-layer');
    return {
      mode: 'composite',
      layers: [],
      fallbackReason:
        unknownBack.length > 0
          ? PLAN_REASONS.UNKNOWN_LAYER
          : failedBack.length > 0
            ? PLAN_REASONS.DECODE_FAILED
            : PLAN_REASONS.MISSING_BACK_LAYER,
      density,
    };
  }

  // 前景层缺了几个不怕（压平帧里已经有它们），但至少要有一个**可动**前景层到位，
  // 否则 partial 等于空操作（支撑层不参与动画，叠上去只是把已有像素再画一遍）。
  const readyFront = ready.filter((item) => item.spec.z > SAFE_OVERLAY_Z && item.spec.role === 'animatable');
  if (readyFront.length === 0) {
    return { mode: 'composite', layers: [], fallbackReason: PLAN_REASONS.NO_FRONT_LAYER, density };
  }

  return { mode: 'partial', layers: readyFront, fallbackReason: '', density };
}

/**
 * 判断一个计划是否需要分层渲染。
 *
 * @param plan 合成计划
 * @returns `true` = 由 `LayeredPresentation` 渲染；`false` = 走 `SpritePresentation`
 */
export function isLayered(plan: CompositePlan): boolean {
  return plan.mode === 'layered' || plan.mode === 'partial';
}

/**
 * 计划的层 id 列表（按绘制顺序）。
 *
 * @param plan 合成计划
 * @returns 层 id 数组
 */
export function planLayerIds(plan: CompositePlan): readonly string[] {
  return plan.layers.map((item) => item.spec.layerId);
}
