/**
 * 表现层工厂：按合成计划选实现。
 *
 * <p><b>它是全工程唯一构造 `PetPresentation` 的地方。</b>换实现（分层 / 将来的 Cubism）
 * 只改这里一行，`main.ts` 与调度总线都不动——这正是设计文档 §1.5 的 seam S1。</p>
 *
 * <p><b>`composite` 模式下必须返回"与今天完全相同"的 `SpritePresentation`</b>：
 * 同样的构造参数、同样的交叉过渡配置、同样的日志出口。这是"flag off 时行为逐字节等价"
 * 的落点，也是既有 204 条测试不需要改一个字的根本原因。</p>
 *
 * <p>`partial` / `layered` 模式下返回 {@link LayeredPresentation}，并把压平帧实现作为
 * `baseFallback` 传进去：表情帧是全画布合成图（P1 资产没有独立脸层），必须由它承载。</p>
 *
 * @module pet/presentation/select-presentation
 */
import type { PetGeometry } from '../layout';
import type { MotionCatalog } from '../layers/motion-catalog';
import { isLayered } from '../layers/plan';
import type { CompositePlan, LayerManifest } from '../layers/types';
import type { Power } from '../power-policy';
import type { TimerPort } from './bus';
import type { CrossfadeSpec } from './crossfade';
import {
  LayeredPresentation,
  mountLayerViews,
  type DocumentLike,
  type ElementLike,
  type LayerView,
} from './layered-presentation';
import { SpritePresentation, type ExpressionUrlMap } from './sprite-presentation';
import { DEFAULT_PRESENTATION_STATE, type ExpressionId, type PetPresentation } from './types';

/** 选路依赖（全部由 `main.ts` 注入，工厂自己不去读全局）。 */
export interface SelectorDeps {
  /** 文档（分层模式下创建层元素与 `<style>`）。 */
  readonly doc: DocumentLike;
  /** `#pet-root`。 */
  readonly root: ElementLike;
  /** 分层模式的层宿主（通常是 `.pet-art`）；缺省用 `root`。 */
  readonly layerHost?: ElementLike;
  /** 双缓冲立绘帧（压平帧实现必需）。 */
  readonly frames: readonly [HTMLImageElement, HTMLImageElement];
  /** 几何。 */
  readonly geometry: PetGeometry;
  /** 动作目录。 */
  readonly catalog: MotionCatalog;
  /** 表情帧 URL 表。 */
  readonly expressionUrls: ExpressionUrlMap;
  /** 层清单（`LayeredPresentation` 解析 `assetBase` 用）。 */
  readonly manifest: LayerManifest;
  /** 交叉过渡配置。 */
  readonly crossfade?: CrossfadeSpec;
  /** 定时器端口。 */
  readonly timer?: TimerPort;
  /** 初始表情（应等于已加载的默认帧）。 */
  readonly initialExpression?: ExpressionId;
  /** 功耗档读取器（分层模式编译动作时按档位乘时长）。 */
  readonly power?: () => Power;
  /** 减少动态读取器。 */
  readonly reducedMotion?: () => boolean;
  /** 日志出口。 */
  readonly log?: (message: string) => void;
}

/** 选路结果（带上 mode 便于调用方打日志/断言，不参与表现层契约）。 */
export interface SelectionOutcome {
  /** 选中的实现。 */
  readonly presentation: PetPresentation;
  /** 计划模式（与 `presentation` 对应）。 */
  readonly mode: CompositePlan['mode'];
  /** 分层模式下的层视图（`composite` 时为空 Map）。 */
  readonly views: ReadonlyMap<string, LayerView>;
}

/**
 * 构造压平帧实现（`composite` 与所有降级路径共用）。
 *
 * @param deps 依赖
 * @returns `SpritePresentation` 实例
 */
export function createSpritePresentation(deps: SelectorDeps): SpritePresentation {
  return new SpritePresentation(
    {
      frames: deps.frames,
      layerHosts: { root: deps.root as unknown as HTMLElement },
      geometry: deps.geometry,
    },
    {
      expressionUrls: deps.expressionUrls,
      log: deps.log ?? (() => {}),
      initialExpression: deps.initialExpression ?? DEFAULT_PRESENTATION_STATE.expression,
      crossfade: deps.crossfade,
      timer: deps.timer,
    },
  );
}

/**
 * 按计划选实现。
 *
 * @param plan 合成计划
 * @param deps 依赖
 * @returns 选路结果
 */
export function selectPresentationWithPlan(plan: CompositePlan, deps: SelectorDeps): SelectionOutcome {
  const sprite = createSpritePresentation(deps);
  if (!isLayered(plan)) {
    return { presentation: sprite, mode: plan.mode, views: new Map<string, LayerView>() };
  }
  const host = deps.layerHost ?? deps.root;
  const views = mountLayerViews(deps.doc, host, plan);
  const layered = new LayeredPresentation({
    doc: deps.doc,
    root: deps.root,
    views,
    manifest: deps.manifest,
    catalog: deps.catalog,
    plan,
    baseFallback: sprite,
    expressionUrls: deps.expressionUrls,
    crossfade: deps.crossfade,
    timer: deps.timer,
    power: deps.power,
    reducedMotion: deps.reducedMotion,
    log: deps.log,
  });
  return { presentation: layered, mode: plan.mode, views };
}

/**
 * 按计划选实现（只要实例的简版入口，`main.ts` 用这个）。
 *
 * @param plan 合成计划
 * @param deps 依赖
 * @returns 表现层实现
 */
export function selectPresentation(plan: CompositePlan, deps: SelectorDeps): PetPresentation {
  return selectPresentationWithPlan(plan, deps).presentation;
}
