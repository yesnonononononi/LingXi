/**
 * 静态立牌表现层实现（方案A）。
 *
 * <p><b>为什么换表情是"换整帧"而不是"叠贴片"：</b>美术的 `composition` 契约明确写
 * 「优先使用完整 WebP 帧；<b>不要把整头叠在完整立绘的半透明边缘上</b>」。v3 立绘头顶有一圈
 * 羽化半透明边缘，把整头贴片压上去会得到"双层头皮"的硬边。所以本实现走
 * `composites/<id>@<density>.webp`（美术已合成的完整帧），换表情＝换一张图，<b>零合成算术</b>。</p>
 *
 * <p><b>为什么用双缓冲：</b>直接改同一个 `<img>` 的 `src` 会先清空再重绘，209px 的宠物上能看见
 * 一帧白闪。两张叠放的 `<img>` 交替 `data-active` + 120ms 透明度过渡，就得到"表情淡入"而
 * 不是"闪一下"。</p>
 *
 * <p><b>写入面只有三种（设计文档 §9.4 纪律 5）：</b>`<img>.src`、CSS 自定义属性、`data-*`。
 * **禁止**外部 `classList.add('is-happy')`。</p>
 *
 * @module pet/presentation/sprite-presentation
 */
import { PET_GEOMETRY, type PetGeometry } from '../layout';
import { DEFAULT_TIMER_PORT, type TimerPort } from './bus';
import {
  CROSSFADE_CSS_VARIABLES,
  CrossfadePlanner,
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

/** 表情完整帧 URL 表（缺项 = 该档没有帧，`apply` 保持当前画面）。 */
export type ExpressionUrlMap = Partial<Record<ExpressionId, string>>;

/** 表现层需要挂载的宿主元素。 */
export interface LayerHosts {
  /** `#pet-root`：用于写 `data-*` 状态。 */
  readonly root: HTMLElement;
}

/** 静态立牌实现所需的 DOM 引用。 */
export interface SpritePresentationDom {
  /** 两张叠放的立绘帧（双缓冲，交替显示）。 */
  readonly frames: readonly [HTMLImageElement, HTMLImageElement];
  /** 宿主元素。 */
  readonly layerHosts: LayerHosts;
  /** 几何。 */
  readonly geometry: PetGeometry;
}

/** 构造选项。 */
export interface SpritePresentationOptions {
  /** 表情完整帧 URL 表；缺省为空（没有帧时表情只改状态、不改画面）。 */
  readonly expressionUrls?: ExpressionUrlMap;
  /** 日志出口（调试面板用）。 */
  readonly log?: (message: string) => void;
  /** 初始表情（缺省 `neutral`，与已加载的默认帧一致）。 */
  readonly initialExpression?: ExpressionId;
  /** 交叉过渡配置（时长会被钳制到 80–120ms；缺省 100ms）。 */
  readonly crossfade?: CrossfadeSpec;
  /** 定时器端口（"旧帧何时退场"用；测试注入假定时器即可断言不堆积）。 */
  readonly timer?: TimerPort;
}

/**
 * 静态立牌表现层。
 *
 * <p>每次 `apply` 只做"写入"，不判断优先级/不挂定时器——那些是
 * {@link module:pet/presentation/bus} 的职责。</p>
 */
export class SpritePresentation implements PetPresentation {
  /** 双缓冲的两张帧。 */
  private readonly frames: readonly [HTMLImageElement, HTMLImageElement];

  /** `#pet-root`。 */
  private readonly root: HTMLElement;

  /** 几何。 */
  private readonly geometry: PetGeometry;

  /** 表情帧 URL 表。 */
  private readonly expressionUrls: ExpressionUrlMap;

  /** 日志出口。 */
  private readonly log: (message: string) => void;

  /** 已预解码成功的 URL（避免重复解码）。 */
  private readonly prepared: Set<string> = new Set();

  /** 过渡规划器（令牌 + 单飞约束）。 */
  private readonly planner: CrossfadePlanner = new CrossfadePlanner();

  /** 解析后的过渡参数。 */
  private readonly crossfade: ResolvedCrossfade;

  /** 定时器端口（旧帧退场用）。 */
  private readonly timer: TimerPort;

  /** 旧帧退场定时器句柄；新过渡一来就清掉，保证同一时刻只有一个。 */
  private retireHandle: number | null = null;

  /** 当前真正不透明的帧下标（淡入完成的那张）。 */
  private visibleIndex: 0 | 1 = 0;

  /** 当前状态快照。 */
  private current: PresentationState = DEFAULT_PRESENTATION_STATE;

  /** 是否已释放。 */
  private disposed = false;

  /**
   * 构造静态立牌表现层。
   *
   * @param dom DOM 引用
   * @param options 可选项（表情帧表、日志、初始表情、过渡参数、定时器）
   */
  constructor(dom: SpritePresentationDom, options: SpritePresentationOptions = {}) {
    if (!dom || !Array.isArray(dom.frames) || dom.frames.length < 2 || !dom.frames[0] || !dom.frames[1]) {
      throw new TypeError('SpritePresentation 需要 frames[0] 与 frames[1]（双缓冲）');
    }
    if (!dom.layerHosts || !dom.layerHosts.root) {
      throw new TypeError('SpritePresentation 需要 layerHosts.root');
    }
    this.frames = dom.frames;
    this.root = dom.layerHosts.root;
    this.geometry = dom.geometry ?? PET_GEOMETRY;
    this.expressionUrls = options.expressionUrls ?? {};
    this.log = options.log ?? (() => {});
    this.crossfade = resolveCrossfade(options.crossfade);
    this.timer = options.timer ?? DEFAULT_TIMER_PORT;
    const initialExpression = options.initialExpression ?? 'neutral';
    this.current = { ...DEFAULT_PRESENTATION_STATE, expression: initialExpression };
    this.root.dataset.expression = initialExpression;
    this.root.dataset.motion = 'idle';
    // 第 0 张缓冲由 main.ts 通过 loadArt 载入默认帧，这里只标记它是激活的那张
    this.frames[0].dataset.active = 'true';
    this.frames[1].dataset.active = 'false';
    this.writeCrossfadeVariables();
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
   * 预准备：把目标帧提前 `decode()` 掉，避免淡入时出现空白档。
   *
   * <p>失败只记日志不抛：缺一帧表情不该让桌宠黑屏（降级为"停在当前帧"）。</p>
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
      this.log(`[pet] 表情帧预解码失败: url=${url}, error=${String(err)}`);
    }
  }

  /** 释放：把宿主上的状态属性清干净（DOM 元素本身由 main.ts 决定去留）。 */
  dispose(): void {
    this.disposed = true;
    this.clearRetire();
    this.planner.cancel();
    this.prepared.clear();
    delete this.root.dataset.expression;
    delete this.root.dataset.motion;
  }

  /**
   * 切表情：把目标帧放进"另一张"缓冲再交叉淡入。
   *
   * <p><b>为什么旧帧要等淡入结束才撤：</b>两张帧是叠放的，若同时把旧帧压到透明，
   * 中途会出现"两张各半透明"的一瞬（窗口本身是透明的，读起来就是宠物忽然变淡）。
   * 这里让新帧在<b>上层</b>淡入、旧帧保持不透明垫在底下，淡入结束后旧帧才退场，
   * 于是全程不透明度都够，也不会白闪。</p>
   *
   * <p><b>连点怎么不堆积：</b>每次切换先 `clearRetire()` 撤掉上一段退场定时器，
   * 再用规划器的 token 作废旧过渡；等解码的异步回调落地前必须 `isCurrent()` 自查，
   * 否则会把已经换掉的帧重新点亮。</p>
   *
   * @param id 表情 id
   */
  private applyExpression(id: ExpressionId): void {
    this.current = { ...this.current, expression: id };
    this.root.dataset.expression = id;
    const url = this.expressionUrls[id];
    if (!url) {
      // 没有这一档的帧：保持当前画面（立绘自带脸就是 neutral，切回去才对）
      if (id !== 'neutral') this.log(`[pet] 表情 ${id} 没有运行时帧，保持当前画面`);
      return;
    }
    // 目标帧已经在屏上（含"上一次淡入就是它"的情况）：不必再过渡一次
    if (this.frames[this.visibleIndex].getAttribute('src') === url) return;
    if (this.planner.isTransitioning && this.frames[this.pendingIndex].getAttribute('src') === url) return;

    const fromIndex = this.visibleIndex;
    const toIndex: 0 | 1 = fromIndex === 0 ? 1 : 0;
    const plan = this.planner.plan(fromIndex, toIndex, this.crossfade);
    this.clearRetire();

    const target = this.frames[plan.toIndex];
    if (target.getAttribute('src') !== url) target.src = url;
    target.hidden = false;

    const flip = (): void => {
      // 过渡期间可能又来了更新的切换：此时本次已作废，直接放弃
      if (this.disposed || !this.planner.isCurrent(plan.token)) return;
      const previousIndex = this.visibleIndex;
      this.visibleIndex = plan.toIndex;
      target.dataset.fading = 'in';
      target.dataset.active = 'true';
      if (previousIndex !== plan.toIndex) {
        this.frames[previousIndex].dataset.fading = 'out';
      }
      this.retireHandle = this.timer.setTimeout(() => {
        this.retireHandle = null;
        if (this.disposed || !this.planner.complete(plan.token)) return;
        if (previousIndex !== this.visibleIndex) {
          this.frames[previousIndex].dataset.active = 'false';
        }
      }, plan.durationMs);
    };

    // 帧已解码就直接翻；没解码就等它 ready —— 等的时候旧帧原样可见，不会闪白
    if (target.complete && target.naturalWidth > 0) {
      flip();
      return;
    }
    const onReady = (): void => {
      target.removeEventListener('load', onReady);
      target.removeEventListener('error', onError);
      flip();
    };
    const onError = (): void => {
      target.removeEventListener('load', onReady);
      target.removeEventListener('error', onError);
      if (!this.planner.isCurrent(plan.token)) return;
      // 取不到帧就维持当前画面（宁可表情不换，也不要留一张破图）
      this.planner.cancel();
      this.log(`[pet] 表情帧加载失败，保持当前画面: url=${url}`);
    };
    target.addEventListener('load', onReady, { once: true });
    target.addEventListener('error', onError, { once: true });
  }

  /** 撤掉尚未执行的"旧帧退场"定时器（新过渡开始时调用，保证同一时刻只有一段）。 */
  private clearRetire(): void {
    if (this.retireHandle === null) return;
    this.timer.clearTimeout(this.retireHandle);
    this.retireHandle = null;
  }

  /** 把过渡时长与缓动写到宿主的 CSS 变量上（CSS 只负责用它，不自己定值）。 */
  private writeCrossfadeVariables(): void {
    const style = this.root.style;
    style.setProperty(CROSSFADE_CSS_VARIABLES.duration, `${this.crossfade.durationMs}ms`);
    style.setProperty(CROSSFADE_CSS_VARIABLES.easing, this.crossfade.easing);
  }

  /** 当前正在淡入的帧下标（没有过渡时等于可见帧）。 */
  private get pendingIndex(): 0 | 1 {
    return this.visibleIndex === 0 ? 1 : 0;
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
