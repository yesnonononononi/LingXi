/**
 * 分层合成器：把 `PresentationOp` 落到"多个 `<img>` 各自 transform"上（方案A 的分层实现）。
 *
 * <p><b>它解决什么：</b>压平合成帧把动画天花板焊死了——局部动作（抬手/摆尾/耳朵抖）没有承载物，
 * 只能请美术重画整图。分层之后每层是一个独立 `<img>`，动作由
 * {@link module:pet/layers/motion-compiler} 把关键帧编译成 CSS 注入，**不引 rAF、不引动画库**。</p>
 *
 * <p><b>写入面仍然只有三种</b>（设计文档 §8 共享知识第 2 条）：`<img>.src`、CSS 自定义属性、`data-*`。
 * 本模块刻意**不碰 `classList`**：状态类会让"当前是什么状态"散落在 CSS 选择器里，
 * 而分层模式下状态必须能被 `state` 快照读到。测试用不实现 `classList` 的假元素，一碰就抛。</p>
 *
 * <p><b>打断判定不在这里</b>（共享知识第 3 条）：优先级只由 `priority.ts` 判，本模块只负责"怎么画"。</p>
 *
 * @module pet/presentation/layered-presentation
 */
import type { Power } from '../power-policy';
import { compileMotion } from '../layers/motion-compiler';
import type { MotionCatalog } from '../layers/motion-catalog';
import { FACE_LAYER_ID, animatableLayerIds, layerAssetUrl } from '../layers/manifest';
import type { CompositePlan, LayerManifest, LayerRect, LayerSpec, Size } from '../layers/types';
import { DEFAULT_TIMER_PORT, type TimerPort } from './bus';
import { faceTileUrls as faceTileUrlMap } from '../assets/face-tiles';
import { BLINK_LIKE_EXPRESSIONS } from './priority';
import {
  CROSSFADE_CSS_VARIABLES,
  resolveCrossfade,
  type CrossfadeSpec,
  type ResolvedCrossfade,
} from './crossfade';
import {
  DEFAULT_PRESENTATION_STATE,
  DRIVEN_NEUTRAL,
  type DrivenParam,
  type ExpressionId,
  type MotionId,
  type PetPresentation,
  type PresentationOp,
  type PresentationState,
} from './types';
import type { ExpressionUrlMap } from './sprite-presentation';

/**
 * 元素的最小结构约定（真元素与测试假元素都满足它）。
 *
 * <p>刻意只声明本模块真正用到的成员：多声明一个成员，测试里的假元素就多一个实现负担，
 * 而"假元素碰不到 `classList`"正是我们要守住的纪律。</p>
 */
export interface ElementLike {
  /** `data-*` 写入面。 */
  readonly dataset: Record<string, string | undefined>;
  /** CSS 自定义属性写入面。 */
  readonly style: { setProperty(name: string, value: string): void };
  /** 图片地址（`<img>` 与 `<style>` 的文本都走这里，见 {@link LayeredPresentation.setStyleText}）。 */
  src: string;
  /** 是否隐藏。 */
  hidden: boolean;
  /** 文本内容（`<style>` 用）。 */
  textContent: string | null;
  /** 追加子节点。 */
  appendChild(child: ElementLike): unknown;
  /** 写属性。 */
  setAttribute(name: string, value: string): void;
  /** 读属性。 */
  getAttribute(name: string): string | null;
}

/** 创建元素所需的最小文档约定。 */
export interface DocumentLike {
  /** 创建元素。 */
  createElement(tagName: string): ElementLike;
}

/**
 * 表情承载层 id（本模块只做**转出**，真源在 `layers/manifest.ts`）。
 *
 * <p>为什么不在渲染层自己定义：`behavior/hit-profile.ts` 也要读这一层的 `rect`，
 * 而它不能 import 渲染层（会形成 `behavior → presentation → assets → behavior` 的环）。
 * 所以 id 归数据层，渲染层 `export { … }` 转出，既有 import 点一行不用改。</p>
 */
export { FACE_LAYER_ID };

/**
 * 子矩形层的四个放置变量名（与 `pet.css` 的 `[data-placement='rect']` 一一对应）。
 *
 * <p>只有**声明了子矩形**的层会写这四个变量；整画布层（既有 9 层）一个字节都不写，
 * 于是它们的 DOM 写入面与 M1 之前完全一致（可回归性优先）。</p>
 */
export const RECT_PLACEMENT_VARIABLES = {
  /** 左边界（容器宽度百分比）。 */
  left: '--pet-layer-left',
  /** 上边界（容器高度百分比）。 */
  top: '--pet-layer-top',
  /** 宽度（容器宽度百分比）。 */
  width: '--pet-layer-width',
  /** 高度（容器高度百分比）。 */
  height: '--pet-layer-height',
} as const;

/** 一个子矩形层的四个百分比取值。 */
export type RectPlacement = Readonly<Record<keyof typeof RECT_PLACEMENT_VARIABLES, string>>;

/** 判定矩形"等于整画布"时允许的误差（像素；JSON 里都是整数，留余量只为防脏数据）。 */
const RECT_EPSILON = 1e-6;

/**
 * 判断一个层矩形是否就是整张画布。
 *
 * <p>整画布层是 M1 之前的唯一形态（每层一张 2048×3072 的图），它们**不参与**子矩形放置：
 * 写了 `inset:auto` + 百分比反而会把 `object-fit: contain` 换成 `fill`，画面会变形。</p>
 *
 * @param rect 层矩形（母版像素）
 * @param canvas 画布尺寸（母版像素）
 * @returns `true` = 整画布（不写放置变量）
 */
export function isFullCanvasRect(rect: LayerRect | undefined, canvas: Size | undefined): boolean {
  if (!rect || !canvas) return true;
  if (!(canvas.width > 0) || !(canvas.height > 0)) return true;
  return (
    Math.abs(rect.x) <= RECT_EPSILON &&
    Math.abs(rect.y) <= RECT_EPSILON &&
    Math.abs(rect.width - canvas.width) <= RECT_EPSILON &&
    Math.abs(rect.height - canvas.height) <= RECT_EPSILON
  );
}

/**
 * 把层矩形换算成四个百分比（相对画布）。
 *
 * <p>用百分比而不是 px：窗口尺寸与 DPR 变化时层栈整体缩放，百分比会自动跟随，
 * 不需要任何 JS 重算（也就不需要 resize 监听）。</p>
 *
 * @param value 偏移或尺寸（母版像素）
 * @param total 画布对应边长（母版像素）
 * @returns 形如 `27.34375%`
 */
function percentOf(value: number, total: number): string {
  const ratio = Number.isFinite(value) && Number.isFinite(total) && total > 0 ? value / total : 0;
  return `${Number((ratio * 100).toFixed(6))}%`;
}

/**
 * 计算子矩形层的放置数值。
 *
 * @param rect 层矩形（母版像素）
 * @param canvas 画布尺寸（母版像素）
 * @returns 四个百分比；整画布 / 脏数据时返回 null（**null = 不写任何放置属性**）
 */
export function rectPlacementOf(rect: LayerRect | undefined, canvas: Size | undefined): RectPlacement | null {
  if (!rect || !canvas) return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  if (isFullCanvasRect(rect, canvas)) return null;
  return {
    left: percentOf(rect.x, canvas.width),
    top: percentOf(rect.y, canvas.height),
    width: percentOf(rect.width, canvas.width),
    height: percentOf(rect.height, canvas.height),
  };
}

/**
 * 从合成计划推断画布尺寸（**只在调用方没给画布时兜底**）。
 *
 * <p>整画布层本身就是画布：取计划里所有层矩形的最大宽高即为画布。
 * 正式路径（`select-presentation.ts` / `applyPlan`）一律用清单里的 `manifest.canvas`，
 * 这条兜底只服务"直接手搓 plan 的老调用点"。</p>
 *
 * @param plan 合成计划
 * @returns 推断的画布尺寸（推断不出时退回 2048×3072，与 P1 母版同值）
 */
export function inferPlanCanvas(plan: CompositePlan): Size {
  let width = 0;
  let height = 0;
  for (const item of plan.layers) {
    width = Math.max(width, item.spec.rect?.width ?? 0);
    height = Math.max(height, item.spec.rect?.height ?? 0);
  }
  return { width: width > 0 ? width : 2048, height: height > 0 ? height : 3072 };
}

/**
 * 把放置数值写到层元素上（`data-placement='rect'` + 四个 CSS 变量）。
 *
 * @param element 层元素
 * @param placement 放置数值
 */
export function applyRectPlacement(element: ElementLike, placement: RectPlacement): void {
  element.dataset.placement = 'rect';
  element.style.setProperty(RECT_PLACEMENT_VARIABLES.left, placement.left);
  element.style.setProperty(RECT_PLACEMENT_VARIABLES.top, placement.top);
  element.style.setProperty(RECT_PLACEMENT_VARIABLES.width, placement.width);
  element.style.setProperty(RECT_PLACEMENT_VARIABLES.height, placement.height);
}

/**
 * 某个表情是否是"生理眨眼类"（`blink` / `blinkHalf` / `wink`）。
 *
 * <p>这三档切换时**禁止交叉过渡**：闭眼窗口只有 80–100ms，再叠 100ms 淡入
 * 等于全程半透明，用户看到的不是"眨了一下"而是"眼睛糊了一下"。
 * 判定真源在 `priority.ts` 的 {@link BLINK_LIKE_EXPRESSIONS}（窗口抑制眨眼也用同一份）。</p>
 *
 * @param id 表情 id
 * @returns `true` = 切换时必须硬切
 */
export function isBlinkLikeExpression(id: ExpressionId): boolean {
  return (BLINK_LIKE_EXPRESSIONS as readonly string[]).includes(id);
}

/**
 * 解析一次表情切换实际使用的过渡时长（毫秒）。
 *
 * <p>规则只有两条，且顺序有意义：</p>
 * <ol>
 *   <li>眨眼类是**硬切**（0ms）——即使调用方传了 `fadeMs` 也不许覆盖；</li>
 *   <li>其余按 `op.fadeMs` 走，缺省回落交叉过渡的默认时长（100ms）。</li>
 * </ol>
 *
 * @param id 表情 id
 * @param op 表情指令（读它的 `fadeMs`）
 * @param defaultMs 缺省时长（毫秒）
 * @returns 实际过渡时长（毫秒，非负）
 */
export function resolveExpressionFadeMs(id: ExpressionId, op: PresentationOp, defaultMs: number): number {
  if (isBlinkLikeExpression(id)) return 0;
  const raw = op.fadeMs;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, raw);
  return Math.max(0, defaultMs);
}

/** 分层模式的根选择器（编译出的 CSS 规则挂在它下面）。 */
export const LAYER_SELECTOR_ROOT = '#pet-root';

/**
 * `driven` 参数 → 目标层 id 列表。
 *
 * <p>两段尾巴要一起驱动（`tail-base` 与 `tail-tip` 是链式的，只转根段会让尾梢断开）；
 * 光晕与视线属于装饰层，留在 `#pet-root` 上。</p>
 */
export const DRIVEN_LAYER_TARGETS: Readonly<Record<DrivenParam, readonly string[]>> = {
  tailAngle: ['tail-base', 'tail-tip'],
  earLAngle: ['ear-left'],
  earRAngle: ['ear-right'],
  haloOpacity: [],
  gazeX: [],
};

/** 一层的渲染视图。 */
export interface LayerView {
  /** 层契约。 */
  readonly spec: LayerSpec;
  /** 承载该层的 `<img>`。 */
  readonly element: ElementLike;
}

/** 构造依赖。 */
export interface LayeredPresentationDeps {
  /** 文档（创建 `<style>` 与层元素）。 */
  readonly doc: DocumentLike;
  /** `#pet-root`。 */
  readonly root: ElementLike;
  /** 层视图（`layerId` → 元素）。 */
  readonly views: ReadonlyMap<string, LayerView>;
  /** 层清单。 */
  readonly manifest: LayerManifest;
  /** 动作目录。 */
  readonly catalog: MotionCatalog;
  /** 本次合成计划。 */
  readonly plan: CompositePlan;
  /** 压平帧兜底实现（表情与降级基线的唯一承载者，`partial` 模式必需）。 */
  readonly baseFallback: PetPresentation | null;
  /**
   * 表情帧 URL 表（整画布合成图，**只喂给压平帧兜底**）。
   *
   * <p>它与 {@link LayeredPresentationDeps.faceTileUrls} 是两套数据，不要混：
   * 整帧 URL 塞进子矩形层会被 `object-fit: fill` 压扁成一条（设计文档 §3.2 的变异体 M5）。</p>
   */
  readonly expressionUrls: ExpressionUrlMap;
  /**
   * 脸层贴片 URL 表（`assets/face-tiles.ts` 的 `faceTileUrls()`，只含**已交付**的表情）。
   *
   * <p>缺省按 `plan.density` 从生成物 `pet-face-tiles.json` 取——这样"忘记注入"不会
   * 变成"表情看不见"，而只是拿到与生产一致的数据。`degraded`（美术母版未交付）的 id
   * 不在表里，此时**保持当前贴片并记日志**，绝不拿别的表情顶替（`wink` ≠ `blink`）。</p>
   */
  readonly faceTileUrls?: Partial<Record<ExpressionId, string>>;
  /** 交叉过渡配置（复用 `crossfade.ts` 的钳制规则，不重写）。 */
  readonly crossfade?: CrossfadeSpec;
  /** 定时器端口（旧帧退场用）。 */
  readonly timer?: TimerPort;
  /** 当前功耗档（`low` 档时长 ×2）。 */
  readonly power?: () => Power;
  /** 系统是否要求减少动态（true → 不注入任何动画）。 */
  readonly reducedMotion?: () => boolean;
  /** 日志出口。 */
  readonly log?: (message: string) => void;
}

/**
 * 分层表现层实现。
 *
 * <p>三种 `kind` 的去向：</p>
 * <ol>
 *   <li>`motion`：查目录 → {@link compileMotion} → 整体替换自己持有的 `<style>` 文本
 *       （替换而不是追加：不清理会无限堆积规则）；同时仍写 `data-motion` 保留调试可读性；</li>
 *   <li>`expression`：**有 `face` 层时**只换那一层的 `src`；没有 `face` 层（当前 P1 资产）
 *       交给 {@link LayeredPresentationDeps.baseFallback} 整帧切换——表情帧是全画布合成图，
 *       拆不出来，硬拆会得到"双层头皮"；</li>
 *   <li>`driven`：变量名沿用 `sprite-presentation.ts` 的 `DRIVEN_CSS_VARIABLES` 契约，
 *       但落到对应层的元素上（见 {@link DRIVEN_LAYER_TARGETS}）。</li>
 * </ol>
 */
export class LayeredPresentation implements PetPresentation {
  /** 依赖（构造后只读）。 */
  private readonly deps: LayeredPresentationDeps;

  /** 层视图。 */
  private readonly views: ReadonlyMap<string, LayerView>;

  /** 动作规则用的 `<style>`（懒创建：没有动作就不产生节点）。 */
  private styleElement: ElementLike | null = null;

  /** 解析后的过渡参数。 */
  private readonly crossfade: ResolvedCrossfade;

  /** 定时器端口。 */
  private readonly timer: TimerPort;

  /** 日志出口。 */
  private readonly log: (message: string) => void;

  /** 当前状态快照。 */
  private current: PresentationState = DEFAULT_PRESENTATION_STATE;

  /** 是否已释放。 */
  private disposed = false;

  /** 当前注入的动作规则（释放与替换时用）。 */
  private currentRules: readonly string[] = [];

  /**
   * 动作重播序号。
   *
   * <p>它进选择器（`[data-motion-seq='n']`），于是"同一动作连播两次"会得到不同的规则文本，
   * 浏览器判定为旧规则失效、新规则生效，动画真的从头播。没有它，连点第二下毫无反应。</p>
   */
  private motionSeq = 0;

  /**
   * 本次计划里**可见**的层 id（`applyPlan` 维护）。
   *
   * <p><b>为什么表情分支必须看它，而不是看 `views` 里有没有 face 元素：</b>
   * `partial` 模式下所有层元素都已挂载（`views` 里恒有 `face`），但 `face` 可能不在本次
   * 计划里（`hidden = true`）。只看"元素存在"就会把 `src` 写进一个隐藏元素并 `return`，
   * 于是**既不换脸也不回落压平帧**，表情又变没了（设计文档 §3.2(b) 记录的真实漏洞）。</p>
   */
  private visibleLayerIds: ReadonlySet<string> = new Set<string>();

  /** 脸层贴片 URL 表（构造时解析一次；缺省取生成物）。 */
  private readonly faceTiles: Partial<Record<ExpressionId, string>>;

  /** 已经预解码过的贴片 URL（`prepare()` 去重用，避免同一张反复建 img）。 */
  private readonly preloadedTiles: Set<string> = new Set<string>();

  /**
   * 构造分层表现层。
   *
   * @param deps 依赖
   */
  constructor(deps: LayeredPresentationDeps) {
    this.deps = deps;
    this.views = deps.views;
    this.crossfade = resolveCrossfade(deps.crossfade ?? {});
    this.timer = deps.timer ?? DEFAULT_TIMER_PORT;
    this.log = deps.log ?? (() => {});
    this.faceTiles = deps.faceTileUrls ?? faceTileUrlMap(deps.plan.density);
    this.applyPlan(deps.plan);
  }

  /** 只读状态快照。 */
  get state(): PresentationState {
    return this.current;
  }

  /**
   * 按计划把层摆上屏（`src` / `z` / `transform-origin` / 可见性）。
   *
   * <p>每次重算计划都会再调一次：层就绪情况变化（解码失败、新层到货）时不需要重建实例。</p>
   *
   * @param plan 合成计划
   */
  applyPlan(plan: CompositePlan): void {
    const root = this.deps.root;
    root.dataset.compositeMode = plan.mode;
    root.dataset.layers = String(plan.layers.length);
    this.deps.root.style.setProperty(CROSSFADE_CSS_VARIABLES.duration, `${this.crossfade.durationMs}ms`);
    this.deps.root.style.setProperty(CROSSFADE_CSS_VARIABLES.easing, this.crossfade.easing);

    const visible = new Set(plan.layers.map((item) => item.spec.layerId));
    // 可见性是"表情走贴片还是回落整帧"的唯一判据（见 visibleLayerIds 的注释）
    this.visibleLayerIds = visible;
    for (const [layerId, view] of this.views) {
      const isVisible = visible.has(layerId);
      view.element.hidden = !isVisible;
      view.element.dataset.visible = isVisible ? '1' : '0';
      if (!isVisible) continue;
      view.element.dataset.role = view.spec.role;
      view.element.dataset.layer = layerId;
      view.element.style.setProperty('z-index', String(view.spec.z));
      view.element.style.setProperty('opacity', String(view.spec.opacity));
      view.element.style.setProperty('transform-origin', `${view.spec.pivot.u * 100}% ${view.spec.pivot.v * 100}%`);
      // 子矩形层（脸层）额外写四个百分比；整画布层这一段整体不执行，DOM 写入面零变化
      const placement = rectPlacementOf(view.spec.rect, this.deps.manifest.canvas);
      if (placement) applyRectPlacement(view.element, placement);
      const file = view.spec.files[plan.density];
      if (file) {
        const url = file.url || layerAssetUrl(file.file, this.deps.manifest);
        if (view.element.getAttribute('src') !== url) {
          view.element.setAttribute('src', url);
          view.element.src = url;
        }
      }
    }
  }

  /**
   * 应用一条指令。
   *
   * @param op 指令
   */
  apply(op: PresentationOp): void {
    if (this.disposed) return;
    if (op.kind === 'motion') {
      this.applyMotion(op);
      return;
    }
    if (op.kind === 'expression') {
      this.applyExpression(op);
      return;
    }
    this.applyDriven(op);
  }

  /**
   * 预准备：把表情贴片提前解码（层文件由浏览器自身缓存，无需额外预取）。
   *
   * <p>分支口径与 {@link LayeredPresentation} 的 `applyExpression` **完全一致**：
   * 脸层可见 → 预解码脸贴片；脸层不可见 → 把预准备交给压平帧兜底。
   * 两处口径一旦分叉，就会出现"预解码了整帧、真正应用时走的却是贴片"的白闪。</p>
   *
   * @param next 即将应用的指令
   * @returns 完成后 resolve（永不 reject：缺帧只记日志）
   */
  async prepare(next: PresentationOp): Promise<void> {
    if (this.disposed) return;
    if (next.kind === 'motion') {
      // 动作本身不需要预解码：层图已在 `applyPlan` 里设好 src
      return;
    }
    if (next.kind === 'expression' && this.hasFaceLayer()) {
      const tile = this.faceTiles[next.id as ExpressionId];
      if (tile) this.preloadTile(tile);
      return;
    }
    const base = this.deps.baseFallback;
    if (!base) return;
    await base.prepare(next);
  }

  /**
   * 预解码一张脸贴片：建一个不挂到文档上的 `<img>` 并设 `src`。
   *
   * <p>浏览器在 `src` 赋值时就开始下载/解码，元素不入 DOM 也会进图片缓存，
   * 于是紧接着的 `<img>.src` 切换不会有空白档。同一 URL 只做一次。</p>
   *
   * @param url 贴片 URL
   */
  private preloadTile(url: string): void {
    if (!url || this.preloadedTiles.has(url)) return;
    this.preloadedTiles.add(url);
    const image = this.deps.doc.createElement('img');
    image.setAttribute('decoding', 'async');
    image.src = url;
  }

  /** 释放：撤掉注入的样式与临时属性（DOM 节点由 `main.ts` 决定去留）。 */
  dispose(): void {
    this.disposed = true;
    this.currentRules = [];
    if (this.styleElement) this.styleElement.textContent = '';
    const root = this.deps.root;
    delete root.dataset.motion;
    delete root.dataset.motionSeq;
    delete root.dataset.expression;
    delete root.dataset.compositeMode;
  }

  /**
   * 播动作：编译成 CSS 并整体替换样式文本。
   *
   * <p><b>为什么整体替换而不是追加：</b>追加会让每条动作留下一段永不过期的 `@keyframes`，
   * 跑一天之后样式表里会有上万字节死规则（桌宠是常驻窗口）。</p>
   *
   * <p><b>循环与否由 op 决定（M6-b 新增）：</b>`op.loop === true` 表示"状态型持续动作"，
   * 编译成无限迭代；`undefined` 时回落到目录值，因此一次性动作的 TTL 语义不受影响。</p>
   *
   * @param op 动作指令
   */
  private applyMotion(op: PresentationOp): void {
    const id = op.id as MotionId;
    this.current = { ...this.current, motion: id };
    // 递增序号进选择器：同一动作连播两次（连点 tap）时规则文本会变，
    // 旧规则被整体替换掉，浏览器的动画也就真的重头播——否则第二次点击毫无反应。
    this.motionSeq += 1;
    const compiled = compileMotion(this.deps.catalog, id, {
      power: this.deps.power?.() ?? 'idle',
      reducedMotion: this.deps.reducedMotion?.() ?? false,
      // 运行期第二道防线：只有可动层能接动画（支撑层转一下就会露补绘缝）
      allowedLayerIds: animatableLayerIds(this.deps.manifest),
      // 状态型持续动作 = 无限循环（睡眠）；一次性动作保持目录值
      loop: op.loop,
      selectorRoot: `${LAYER_SELECTOR_ROOT}[data-motion='${id}'][data-motion-seq='${this.motionSeq}']`,
    });
    this.currentRules = compiled.cssRules;
    this.setStyleText(compiled.cssRules.join('\n'));
    if (compiled.unsupportedTracks.length > 0) {
      this.log(`[pet] 动作 ${id} 有 ${compiled.unsupportedTracks.length} 条轨道无法编译: ${compiled.unsupportedTracks.join(', ')}`);
    }
    // `data-motion` 仍然写：调试面板与既有 CSS 动作选择器都读它
    const root = this.deps.root;
    root.dataset.motion = id;
    root.dataset.motionSeq = String(this.motionSeq);
  }

  /**
   * 切表情：**脸层可见**时只换脸层贴片，否则回落压平帧。
   *
   * <p><b>分支判据是"计划可见性"而不是"元素是否存在"：</b>元素永远都挂在那儿
   * （`partial` 模式下 10 个 `<img>` 全在），只有 `applyPlan` 里那份 `visibleLayerIds`
   * 才说明"这一层这次真的在场"。按存在性判会出现"写进隐藏元素 + 不回落到整帧"的漏洞。</p>
   *
   * <p><b>过渡：</b>时长写在**脸层元素**的 `--pet-crossfade-ms` 上（`pet.css` 的
   * `[data-fading='in']` 读它）。根上的那份是全局节奏，不能被眨眼改掉——眨眼类一律 0ms 硬切。</p>
   *
   * @param op 表情指令
   */
  private applyExpression(op: PresentationOp): void {
    const id = op.id as ExpressionId;
    this.current = { ...this.current, expression: id };
    this.deps.root.dataset.expression = id;

    const faceVisible = this.hasFaceLayer();
    const face = this.views.get(FACE_LAYER_ID);
    if (faceVisible && face) {
      const tileUrl = this.faceTiles[id];
      if (!tileUrl) {
        // 降级：脸层在场但这档贴片未交付（`pet-face-tiles.json` 的 `degraded`）。
        // 两条底线：① 不把整帧 URL 塞进子矩形层（object-fit:fill 会压扁成一条）；
        // ② 不拿别的表情顶替（wink ≠ blink，会变成语义谎言）。保持当前贴片，只记日志。
        this.log(`[pet] 表情 ${id} 没有脸贴片（degraded），保持当前贴片不动`);
        return;
      }
      const fadeMs = resolveExpressionFadeMs(id, op, this.crossfade.durationMs);
      // 过渡时长写在层元素上：根上的 --pet-crossfade-ms 是全局节奏，不因眨眼被覆盖
      face.element.style.setProperty(CROSSFADE_CSS_VARIABLES.duration, `${fadeMs}ms`);
      face.element.dataset.expression = id;
      const changed = face.element.getAttribute('src') !== tileUrl;
      if (changed) {
        face.element.setAttribute('src', tileUrl);
        face.element.src = tileUrl;
      }
      if (fadeMs > 0 && changed) {
        // 先挂标记再交给 CSS 播 `pet-face-in`；到点撤掉，避免与下一次淡入叠加
        face.element.dataset.fading = 'in';
        this.timer.setTimeout(() => {
          if (this.disposed) return;
          delete face.element.dataset.fading;
        }, fadeMs);
      } else {
        delete face.element.dataset.fading;
      }
      return;
    }

    const base = this.deps.baseFallback;
    if (!base) {
      this.log(`[pet] 没有可见 face 层也没有整帧兜底，表情 ${id} 只改状态不改画面`);
      return;
    }
    base.apply(op);
  }

  /**
   * 写参数驱动档：变量落到对应层元素上（支撑层不接受指令）。
   *
   * @param op 指令（`value` 缺省回落中性值）
   */
  private applyDriven(op: PresentationOp): void {
    const param = op.id as DrivenParam;
    const value = typeof op.value === 'number' ? op.value : DRIVEN_NEUTRAL[param];
    this.current = { ...this.current, driven: { ...this.current.driven, [param]: value } };
    const targets = DRIVEN_LAYER_TARGETS[param] ?? [];
    const cssValue = this.drivenCssValue(param, value);
    if (targets.length === 0) {
      this.deps.root.style.setProperty(drivenVariableName(param), cssValue);
      return;
    }
    for (const layerId of targets) {
      const view = this.views.get(layerId);
      if (!view) {
        this.log(`[pet] 参数 ${param} 的目标层 ${layerId} 不在本次合成计划里，已跳过`);
        continue;
      }
      if (view.spec.role !== 'animatable') continue;
      view.element.style.setProperty(drivenVariableName(param), cssValue);
    }
  }

  /**
   * 计算某个参数对应的 CSS 值（含单位与钳制）。
   *
   * @param param 参数
   * @param value 原始值
   * @returns CSS 值字符串
   */
  private drivenCssValue(param: DrivenParam, value: number): string {
    const numeric = Number.isFinite(value) ? value : DRIVEN_NEUTRAL[param];
    if (param === 'tailAngle' || param === 'earLAngle' || param === 'earRAngle') {
      const clamped = Math.min(30, Math.max(-30, numeric));
      return `${clamped}deg`;
    }
    const clamped = Math.min(1, Math.max(0, numeric));
    return String(clamped);
  }

  /**
   * 写/替换动作样式文本。
   *
   * @param text 完整 CSS 文本（空串 = 清空）
   */
  private setStyleText(text: string): void {
    if (!this.styleElement) {
      const style = this.deps.doc.createElement('style');
      style.setAttribute('data-pet-motion', '1');
      this.deps.root.appendChild(style);
      this.styleElement = style;
    }
    this.styleElement.textContent = text;
  }

  /**
   * 当前计划里是否有**可见**的独立脸层（不是"元素在不在"）。
   *
   * @returns 计划里含 `face` 层则为 true
   */
  private hasFaceLayer(): boolean {
    return this.visibleLayerIds.has(FACE_LAYER_ID);
  }

  /**
   * 当前注入的动作规则（测试与调试面板用）。
   *
   * @returns 规则文本数组
   */
  get rules(): readonly string[] {
    return this.currentRules;
  }

  /** 当前 `<style>` 文本（没有节点时为空串）。 */
  get styleText(): string {
    return this.styleElement?.textContent ?? '';
  }

  /** 交叉过渡时长（毫秒，已钳制）——供验收断言 CSS 与 JS 同源。 */
  get crossfadeMs(): number {
    return this.crossfade.durationMs;
  }
}

/**
 * 参数 → CSS 变量名（与 `sprite-presentation.ts` 的 `DRIVEN_CSS_VARIABLES` 同名）。
 *
 * @param param 参数
 * @returns 变量名
 */
export function drivenVariableName(param: DrivenParam): string {
  if (param === 'tailAngle') return '--pet-tail-angle';
  if (param === 'earLAngle') return '--pet-ear-l-angle';
  if (param === 'earRAngle') return '--pet-ear-r-angle';
  if (param === 'haloOpacity') return '--pet-halo-opacity';
  return '--pet-gaze-x';
}

/**
 * 按计划把层元素挂到宿主上（`<div class="pet-layers">` + 每层一个 `<img>`）。
 *
 * <p>层顺序按 `z` 升序 append，但真正的叠放仍由 `z-index` 决定——DOM 顺序只是让
 * 无 `z-index` 的兜底场景也是对的。</p>
 *
 * <p><b>子矩形层（脸层）在这里就写放置数值</b>：它与 `applyPlan()` 写的是同一组值，
 * 挂载即可见，不会出现"挂上去先按整画布 contain 错位一下、下一帧才对"的闪动。
 * 整画布层（既有 9 层）**一个字节都不写**——`rectPlacementOf` 对整画布返回 null，
 * 于是它们的 DOM 写入面与 M1 之前完全一致。</p>
 *
 * @param doc 文档
 * @param host 宿主（`#pet-root .pet-art`）
 * @param plan 合成计划
 * @param canvas 画布尺寸（缺省从计划里推断：整画布层的矩形就是画布）
 * @returns 层视图表
 */
export function mountLayerViews(
  doc: DocumentLike,
  host: ElementLike,
  plan: CompositePlan,
  canvas?: Size,
): ReadonlyMap<string, LayerView> {
  const container = doc.createElement('div');
  container.setAttribute('class', 'pet-layers');
  container.dataset.compositeMode = plan.mode;
  host.appendChild(container);
  const canvasSize = canvas ?? inferPlanCanvas(plan);
  const views = new Map<string, LayerView>();
  for (const item of plan.layers) {
    const element = doc.createElement('img');
    element.setAttribute('class', 'pet-layer');
    element.setAttribute('alt', '');
    element.dataset.layer = item.spec.layerId;
    element.dataset.role = item.spec.role;
    element.style.setProperty('z-index', String(item.spec.z));
    element.style.setProperty('opacity', String(item.spec.opacity));
    element.style.setProperty('transform-origin', `${item.spec.pivot.u * 100}% ${item.spec.pivot.v * 100}%`);
    // 只有子矩形层写放置数值；整画布层（既有 9 层）不写任何放置属性
    const placement = rectPlacementOf(item.spec.rect, canvasSize);
    if (placement) applyRectPlacement(element, placement);
    container.appendChild(element);
    views.set(item.spec.layerId, { spec: item.spec, element });
  }
  return views;
}
