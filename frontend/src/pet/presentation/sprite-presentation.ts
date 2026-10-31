/**
 * 静态立牌表现层实现（方案A）。
 *
 * <p><b>写入面只有三种（设计文档 §9.4 纪律 5）：</b></p>
 * <ol>
 *   <li>`expressionHost.src`（表情贴片）；</li>
 *   <li>CSS 自定义属性（`--pet-tail-angle` 等参数驱动档）；</li>
 *   <li>`data-*` 状态（`data-expression` / `data-motion`，给 CSS 用来触发动画）。</li>
 * </ol>
 *
 * <p><b>禁止</b>外部 `classList.add('is-happy')`：class 列表归实现独占，两种实现之间只认 op。</p>
 *
 * <p><b>为什么表情贴片能"零标定"：</b>每档贴片与立绘**同画布、同位置**（美术规格书 §5 的
 * 硬要求），所以这里只需要 `inset:0 + object-fit:contain`，没有任何 `background-position` 算术。</p>
 *
 * @module pet/presentation/sprite-presentation
 */
import { PET_GEOMETRY, type PetGeometry } from '../layout';
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

/**
 * 参数驱动档 → CSS 自定义属性与钳制区间。
 *
 * <p>变量名进 `pet.css`（`.pet-tail { transform: rotate(var(--pet-tail-angle)) }`），
 * 方案B 换成 Cubism 参数时只改这张表（seam S4）。</p>
 */
export const DRIVEN_CSS_VARIABLES: Readonly<
  Record<DrivenParam, { readonly name: string; readonly unit: '' | 'deg'; readonly min: number; readonly max: number }>
> = {
  tailAngle: { name: '--pet-tail-angle', unit: 'deg', min: -30, max: 30 },
  earLAngle: { name: '--pet-ear-l-angle', unit: 'deg', min: -30, max: 30 },
  earRAngle: { name: '--pet-ear-r-angle', unit: 'deg', min: -30, max: 30 },
  haloOpacity: { name: '--pet-halo-opacity', unit: '', min: 0, max: 1 },
  gazeX: { name: '--pet-gaze-x', unit: '', min: -1, max: 1 },
};

/** 表情贴片 URL 表（缺项 = 该档没有贴片，`apply` 保持立绘自带脸）。 */
export type ExpressionUrlMap = Partial<Record<ExpressionId, string>>;

/** 表现层需要挂载的宿主元素。 */
export interface LayerHosts {
  /** `#pet-root`：用于写 `data-*` 状态。 */
  readonly root: HTMLElement;
}

/** 静态立牌实现所需的 DOM 引用。 */
export interface SpritePresentationDom {
  /** 表情贴片 `<img>`。 */
  readonly expressionHost: HTMLImageElement;
  /** 宿主元素。 */
  readonly layerHosts: LayerHosts;
  /** 几何（用于写光晕尺寸等，本文件只读 artWidth）。 */
  readonly geometry: PetGeometry;
}

/** 构造选项。 */
export interface SpritePresentationOptions {
  /** 表情贴片 URL 表；缺省为空（没有贴片时表情只改状态不上屏）。 */
  readonly expressionUrls?: ExpressionUrlMap;
  /** 日志出口（调试面板用）。 */
  readonly log?: (message: string) => void;
}

/**
 * 静态立牌表现层。
 *
 * <p>每次 `apply` 只做"写入"，不判断优先级/不挂定时器——那些是
 * {@link module:pet/presentation/bus} 的职责。</p>
 */
export class SpritePresentation implements PetPresentation {
  /** 表情贴片宿主。 */
  private readonly expressionHost: HTMLImageElement;

  /** `#pet-root`。 */
  private readonly root: HTMLElement;

  /** 几何。 */
  private readonly geometry: PetGeometry;

  /** 贴片 URL 表。 */
  private readonly expressionUrls: ExpressionUrlMap;

  /** 日志出口。 */
  private readonly log: (message: string) => void;

  /** 已预解码成功的 URL（避免重复解码）。 */
  private readonly prepared: Set<string> = new Set();

  /** 当前状态快照。 */
  private current: PresentationState = DEFAULT_PRESENTATION_STATE;

  /** 是否已释放。 */
  private disposed = false;

  /**
   * 构造静态立牌表现层。
   *
   * @param dom DOM 引用
   * @param options 可选项（贴片 URL 表、日志）
   */
  constructor(dom: SpritePresentationDom, options: SpritePresentationOptions = {}) {
    if (!dom || !dom.expressionHost || !dom.layerHosts || !dom.layerHosts.root) {
      throw new TypeError('SpritePresentation 需要 expressionHost 与 layerHosts.root');
    }
    this.expressionHost = dom.expressionHost;
    this.root = dom.layerHosts.root;
    this.geometry = dom.geometry ?? PET_GEOMETRY;
    this.expressionUrls = options.expressionUrls ?? {};
    this.log = options.log ?? (() => {});
    this.current = DEFAULT_PRESENTATION_STATE;
    this.root.dataset.expression = this.current.expression;
    this.root.dataset.motion = this.current.motion ?? 'idle';
    this.writeDriven(DRIVEN_NEUTRAL);
  }

  /** 只读状态快照。 */
  get state(): PresentationState {
    return this.current;
  }

  /**
   * 应用一条指令。
   *
   * @param op 指令
   */
  apply(op: PresentationOp): void {
    if (this.disposed) return;
    if (op.kind === 'expression') {
      this.applyExpression(op.id as ExpressionId);
      return;
    }
    if (op.kind === 'motion') {
      this.applyMotion(op.id as MotionId);
      return;
    }
    const param = op.id as DrivenParam;
    // driven 档的值走 op.value（缺省回落中性值）；角度/不透明度会按表钳制
    const value = typeof op.value === 'number' ? op.value : DRIVEN_NEUTRAL[param];
    this.writeDriven({ ...this.current.driven, [param]: value });
  }

  /**
   * 预准备：把贴片提前 `decode()` 掉，避免首次切换出现"空白一帧"。
   *
   * <p>失败只记日志不抛：缺一张贴片不该让桌宠黑屏（降级为立绘自带脸）。</p>
   *
   * @param next 即将应用的指令
   */
  async prepare(next: PresentationOp): Promise<void> {
    if (this.disposed) return;
    if (next.kind !== 'expression') return;
    const url = this.expressionUrls[next.id as ExpressionId];
    if (!url || this.prepared.has(url)) return;
    try {
      const probe = new Image();
      probe.decoding = 'async';
      probe.src = url;
      await probe.decode();
      this.prepared.add(url);
    } catch (err) {
      this.log(`[pet] 表情贴片预解码失败: url=${url}, error=${String(err)}`);
    }
  }

  /** 释放：把宿主上的状态属性清干净（DOM 元素本身由 main.ts 决定去留）。 */
  dispose(): void {
    this.disposed = true;
    this.prepared.clear();
    delete this.root.dataset.expression;
    delete this.root.dataset.motion;
  }

  /**
   * 切表情：有贴片就换 `src`，没贴片就只更新状态（立绘自带脸）。
   *
   * @param id 表情 id
   */
  private applyExpression(id: ExpressionId): void {
    this.current = { ...this.current, expression: id };
    this.root.dataset.expression = id;
    const url = this.expressionUrls[id];
    if (!url) {
      // 没有贴片：保持立绘自带脸，遮住它反而是错的
      this.expressionHost.hidden = true;
      if (id !== 'neutral') this.log(`[pet] 表情 ${id} 无贴片，降级为立绘自带脸`);
      return;
    }
    if (this.expressionHost.getAttribute('src') !== url) {
      this.expressionHost.src = url;
    }
    this.expressionHost.hidden = false;
    this.expressionHost.dataset.expression = id;
  }

  /**
   * 播动作：靠 `data-motion` + CSS 动画（纯合成器，不产生重排）。
   *
   * <p>同值属性不会重启 CSS 动画，所以先删属性、强制一次样式计算、再写回
   * （`void offsetWidth` 读布局即触发重算——这是重启动画的标式写法，代价仅一次）。</p>
   *
   * @param id 动作 id
   */
  private applyMotion(id: MotionId): void {
    this.current = { ...this.current, motion: id };
    delete this.root.dataset.motion;
    void this.root.offsetWidth;
    this.root.dataset.motion = id;
  }

  /**
   * 写参数驱动档（钳制后写 CSS 变量）。
   *
   * @param driven 待写入的参数
   */
  private writeDriven(driven: Readonly<Record<DrivenParam, number>>): void {
    this.current = { ...this.current, driven };
    const style = this.root.style;
    for (const param of Object.keys(DRIVEN_CSS_VARIABLES) as DrivenParam[]) {
      const spec = DRIVEN_CSS_VARIABLES[param];
      const raw = Number(driven[param]);
      const value = Number.isFinite(raw) ? Math.min(spec.max, Math.max(spec.min, raw)) : DRIVEN_NEUTRAL[param];
      style.setProperty(spec.name, `${value}${spec.unit}`);
    }
  }

  /**
   * 当前立绘箱宽度（光晕等装饰层排版用，避免各自去读 DOM 尺寸）。
   *
   * @returns 立绘箱宽度（CSS px）
   */
  artWidth(): number {
    return this.geometry.artWidth;
  }
}
