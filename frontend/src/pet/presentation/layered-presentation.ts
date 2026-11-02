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
import { animatableLayerIds, layerAssetUrl } from '../layers/manifest';
import type { CompositePlan, LayerManifest, LayerSpec } from '../layers/types';
import { DEFAULT_TIMER_PORT, type TimerPort } from './bus';
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

/** 表情承载层 id：目前 P1 资产没有独立脸部层，故缺省走整帧（见 {@link LayeredPresentation}）。 */
export const FACE_LAYER_ID = 'face';

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
  /** 表情帧 URL 表（有 `face` 层时才用得上）。 */
  readonly expressionUrls: ExpressionUrlMap;
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
   * 预准备：把表情帧提前解码（层文件由浏览器自身缓存，无需额外预取）。
   *
   * @param next 即将应用的指令
   * @returns 完成后 resolve（永不 reject：缺帧只记日志）
   */
  async prepare(next: PresentationOp): Promise<void> {
    if (this.disposed) return;
    const base = this.deps.baseFallback;
    if (!base) return;
    // 没有 face 层时表情由整帧兜底，预解码也交给它
    if (next.kind === 'expression' && !this.hasFaceLayer()) {
      await base.prepare(next);
      return;
    }
    if (next.kind === 'motion') {
      // 动作本身不需要预解码：层图已在 `applyPlan` 里设好 src
      return;
    }
    await base.prepare(next);
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
   * 切表情：有 `face` 层只换脸层，没有则整帧兜底。
   *
   * @param op 表情指令
   */
  private applyExpression(op: PresentationOp): void {
    const id = op.id as ExpressionId;
    this.current = { ...this.current, expression: id };
    this.deps.root.dataset.expression = id;
    const face = this.views.get(FACE_LAYER_ID);
    const url = this.deps.expressionUrls[id];
    if (face && url) {
      // P1 之后补了独立脸层时走这里：只换脸，前景层（呆毛/蝴蝶结）不动。
      // 过渡靠 CSS 变量（`.pet-layer[data-fading]` 读 --pet-crossfade-*），
      // 淡入结束后撤掉临时标记，避免它与下一次淡入叠加。
      face.element.dataset.expression = id;
      if (face.element.getAttribute('src') !== url) face.element.src = url;
      face.element.dataset.fading = 'in';
      this.timer.setTimeout(() => {
        if (this.disposed) return;
        delete face.element.dataset.fading;
      }, this.crossfade.durationMs);
      return;
    }
    const base = this.deps.baseFallback;
    if (!base) {
      this.log(`[pet] 没有 face 层也没有整帧兜底，表情 ${id} 只改状态不改画面`);
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
   * 当前清单里是否有独立脸层。
   *
   * @returns 有则为 true
   */
  private hasFaceLayer(): boolean {
    return this.views.has(FACE_LAYER_ID);
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
 * @param doc 文档
 * @param host 宿主（`#pet-root .pet-art`）
 * @param plan 合成计划
 * @returns 层视图表
 */
export function mountLayerViews(
  doc: DocumentLike,
  host: ElementLike,
  plan: CompositePlan,
): ReadonlyMap<string, LayerView> {
  const container = doc.createElement('div');
  container.setAttribute('class', 'pet-layers');
  container.dataset.compositeMode = plan.mode;
  host.appendChild(container);
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
    container.appendChild(element);
    views.set(item.spec.layerId, { spec: item.spec, element });
  }
  return views;
}
