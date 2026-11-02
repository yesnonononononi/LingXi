/**
 * 点击 / 拖拽手势判定（**纯逻辑**：不碰 DOM、不碰定时器、不读时钟）。
 *
 * <p><b>为什么必须单独成层（M6-b 的 D-B1 / D-B4 就是这个缺失的直接后果）：</b>
 * 以前"点一下"和"开始拖拽"写在同一个 `pointerdown` 回调里——一次按下同时表达了两件事，
 * 于是 tap 刚下发（优先级 1）就被 drag（优先级 2）打断，用户看到的"单击无反应"；
 * 而"点一下"带来的 1~2px 微动又会真的把窗口挪走。两种语义挤在一个回调里，
 * 谁先谁后全靠调用顺序，改一处必然伤另一处。</p>
 *
 * <p><b>本模块的边界：</b></p>
 * <ul>
 *   <li><b>它拥有语义</b>：这次按下到底是"点击"还是"拖拽"——判定只在这里发生，
 *       阈值 {@link DRAG_THRESHOLD_PX} 也只有这个常量一处真源。</li>
 *   <li><b>它只做执行</b>：不调 IPC、不碰 DOM、不写 CSS、不认识行为状态机。
 *       调用方（`main.ts`）拿到 {@link GestureIntent} 后再决定"下发 tap / 开始拖拽 / 上报位置"。</li>
 * </ul>
 *
 * <p><b>四条收尾路径缺一不可（D-B4 的验收要求）：</b>指针事件在桌面窗口上并不可靠——
 * 用户可能在窗口外松手、指针捕获可能被系统抢走。因此
 * {@link PressDragGesture.release} / {@link PressDragGesture.cancel} /
 * `move` 时 `buttons === 0` / `pointercancel` 都必须能把状态收回 `idle`，
 * 任何一条漏了都会让桌宠卡在"拖拽姿势"里不再响应点击。</p>
 *
 * @module pet/gesture/press-drag
 */

/**
 * 拖拽判定阈值（CSS px）。
 *
 * <p>4px 是"手抖"与"真的想拖"的分界线：小于它的一律读作点击（窗口绝不移动），
 * 越过它才下发 `drag-start`。取 4 而不是 2，是因为触控板轻点时的抖动通常有 2~3px。</p>
 */
export const DRAG_THRESHOLD_PX = 4;

/** 一次按下/移动的坐标（判定用；坐标空间由调用方决定，一般传窗口内 `clientX/clientY`）。 */
export interface GesturePoint {
  /** 指针 id（多指场景下只认最先按下的那根）。 */
  readonly pointerId: number;
  /** 判定空间的 x。 */
  readonly x: number;
  /** 判定空间的 y。 */
  readonly y: number;
}

/** 一次移动的输入（比 {@link GesturePoint} 多一个按键状态）。 */
export interface GestureMoveInput extends GesturePoint {
  /**
   * `event.buttons`：0 = 主键已经松开。
   *
   * <p>这是"没收到 pointerup"的兜底信号：指针在窗口外松开时浏览器不会补发 `pointerup`，
   * 但下一次 `pointermove` 的 `buttons` 已经是 0。不判它就会永久卡在拖拽。</p>
   */
  readonly buttons: number;
}

/**
 * 手势意图（**本模块唯一的产出物**）。
 *
 * <p>调用方只需对这四个值做穷尽分支，不必知道阈值、偏移、指针 id 的来龙去脉。</p>
 */
export type GestureIntent =
  | {
      /** 点击：按下后未越过阈值就松开，且恰好一次。 */
      readonly type: 'tap';
      /** 指针 id。 */
      readonly pointerId: number;
    }
  | {
      /** 越过阈值：从这里开始才允许调 `startDrag` IPC（窗口因此不会因微动而抖）。 */
      readonly type: 'drag-start';
      /** 指针 id。 */
      readonly pointerId: number;
      /** 相对按下点的位移 x（CSS px）。 */
      readonly dx: number;
      /** 相对按下点的位移 y（CSS px）。 */
      readonly dy: number;
    }
  | {
      /** 拖拽中继续移动。 */
      readonly type: 'drag-move';
      /** 指针 id。 */
      readonly pointerId: number;
      /** 相对按下点的位移 x（CSS px）。 */
      readonly dx: number;
      /** 相对按下点的位移 y（CSS px）。 */
      readonly dy: number;
    }
  | {
      /** 拖拽结束（松手 / 取消 / 按键已松开三条路径都会产出它）。 */
      readonly type: 'drag-end';
      /** 指针 id。 */
      readonly pointerId: number;
    };

/** 手势所处阶段。 */
export type GesturePhase = 'idle' | 'pressed' | 'dragging';

/** 构造选项。 */
export interface PressDragOptions {
  /**
   * 阈值覆盖（CSS px），缺省 {@link DRAG_THRESHOLD_PX}。
   *
   * 只在测试里需要用到；生产路径一律用常量，避免"每个调用点各自决定手感"。
   */
  readonly thresholdPx?: number;
}

/**
 * 点击 / 拖拽手势状态机。
 *
 * <p>用法（`main.ts` 里只有这几行）：</p>
 * <pre>
 *   const gesture = new PressDragGesture();
 *   onPointerDown = (e) => run(gesture.press({ pointerId: e.pointerId, x: e.clientX, y: e.clientY }));
 *   onPointerMove = (e) => run(gesture.move({ pointerId: e.pointerId, x: e.clientX, y: e.clientY, buttons: e.buttons }));
 *   onPointerUp   = (e) => run(gesture.release(e.pointerId));
 * </pre>
 */
export class PressDragGesture {
  /** 拖拽判定阈值（CSS px）。 */
  private readonly threshold: number;

  /** 当前阶段。 */
  private phaseValue: GesturePhase = 'idle';

  /** 正在跟踪的指针 id；`null` = 没有按下。 */
  private pointerIdValue: number | null = null;

  /** 按下点（判定空间）。 */
  private originX = 0;

  /** 按下点（判定空间）。 */
  private originY = 0;

  /** 上一次移动点（去重用，避免重复上报同一坐标）。 */
  private lastX = 0;

  /** 上一次移动点（去重用）。 */
  private lastY = 0;

  /**
   * 构造手势判定器。
   *
   * @param options 可选项（阈值覆盖；非有限数或 ≤0 时回落到 {@link DRAG_THRESHOLD_PX}）
   */
  constructor(options: PressDragOptions = {}) {
    const raw = Number(options.thresholdPx ?? DRAG_THRESHOLD_PX);
    this.threshold = Number.isFinite(raw) && raw > 0 ? raw : DRAG_THRESHOLD_PX;
  }

  /** 当前阶段。 */
  get phase(): GesturePhase {
    return this.phaseValue;
  }

  /** 是否处于"按下但还没越过阈值"的中间态。 */
  get isPressed(): boolean {
    return this.phaseValue !== 'idle';
  }

  /** 是否正在拖拽（调用方据此决定要不要上报位置）。 */
  get isDragging(): boolean {
    return this.phaseValue === 'dragging';
  }

  /** 正在跟踪的指针 id；`null` = 空闲。 */
  get activePointerId(): number | null {
    return this.pointerIdValue;
  }

  /** 判定阈值（排障与调试面板用）。 */
  get thresholdPx(): number {
    return this.threshold;
  }

  /**
   * 喂一次按下。
   *
   * @param point 按下点
   * @returns 意图列表（按下本身不产生意图，恒为空数组）
   */
  press(point: GesturePoint): GestureIntent[] {
    // 已经有手势在进行（第二根手指 / 重复按下）：以先按下的那根为准，后来的忽略
    if (this.phaseValue !== 'idle') return [];
    if (!isFinitePoint(point)) return [];
    this.phaseValue = 'pressed';
    this.pointerIdValue = point.pointerId;
    this.originX = point.x;
    this.originY = point.y;
    this.lastX = point.x;
    this.lastY = point.y;
    return [];
  }

  /**
   * 喂一次移动。
   *
   * @param input 移动点 + 按键状态
   * @returns 意图列表（越过阈值时是一次 `drag-start`，之后是 `drag-move`；按键已松开时是收尾意图）
   */
  move(input: GestureMoveInput): GestureIntent[] {
    if (this.phaseValue === 'idle') return [];
    if (input.pointerId !== this.pointerIdValue) return [];
    // 兜底收尾路径之三：没收到 pointerup 但按键已经松开（在窗口外松手最常见）
    if (input.buttons === 0) return this.release(input.pointerId);
    if (!isFinitePoint(input)) return [];

    const dx = input.x - this.originX;
    const dy = input.y - this.originY;

    if (this.phaseValue === 'pressed') {
      // 阈值之内：仍然是"一次点击"，窗口绝不能被挪动
      if (Math.hypot(dx, dy) < this.threshold) return [];
      this.phaseValue = 'dragging';
      this.lastX = input.x;
      this.lastY = input.y;
      const pointerId = this.pointerIdValue as number;
      return [{ type: 'drag-start', pointerId, dx, dy }];
    }

    // 拖拽中：坐标没变就不上报（避免每帧一次无意义的 IPC）
    if (input.x === this.lastX && input.y === this.lastY) return [];
    this.lastX = input.x;
    this.lastY = input.y;
    return [{ type: 'drag-move', pointerId: this.pointerIdValue as number, dx, dy }];
  }

  /**
   * 喂一次松开（`pointerup`）。
   *
   * <p>未越阈值 → 恰好一次 `tap`（这是"点一下"的唯一来源）；
   * 已越阈值 → 一次 `drag-end`。两种都必然把状态收回 `idle`。</p>
   *
   * @param pointerId 可选：只接受匹配的指针 id（缺省 = 无条件收尾）
   * @returns 意图列表
   */
  release(pointerId?: number): GestureIntent[] {
    const intents = this.finish(pointerId, true);
    return intents;
  }

  /**
   * 喂一次中止（`pointercancel` / `lostpointercapture`）。
   *
   * <p>中止**不是点击**：不产出 `tap`（用户没有"点完"），但**必须**产出 `drag-end`，
   * 否则窗口会跟着鼠标飘到用户松手为止。</p>
   *
   * @param pointerId 可选：只接受匹配的指针 id（缺省 = 无条件收尾）
   * @returns 意图列表
   */
  cancel(pointerId?: number): GestureIntent[] {
    return this.finish(pointerId, false);
  }

  /** 强制回到空闲（页面卸载 / 重新初始化时用）。 */
  reset(): void {
    this.phaseValue = 'idle';
    this.pointerIdValue = null;
    this.originX = 0;
    this.originY = 0;
    this.lastX = 0;
    this.lastY = 0;
  }

  /**
   * 收尾的公共实现。
   *
   * @param pointerId 可选：只接受匹配的指针 id
   * @param asTap 未越阈值时是否算作一次点击
   * @returns 意图列表
   */
  private finish(pointerId: number | undefined, asTap: boolean): GestureIntent[] {
    if (this.phaseValue === 'idle') return [];
    if (pointerId !== undefined && pointerId !== this.pointerIdValue) return [];
    const id = this.pointerIdValue as number;
    const wasDragging = this.phaseValue === 'dragging';
    this.reset();
    if (wasDragging) return [{ type: 'drag-end', pointerId: id }];
    return asTap ? [{ type: 'tap', pointerId: id }] : [];
  }
}

/**
 * 坐标是否可用（NaN / Infinity 一律丢弃，避免把脏值算进阈值）。
 *
 * @param point 待判断坐标
 * @returns 是否有限数值
 */
function isFinitePoint(point: GesturePoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}
