/**
 * 提示行控制器（O2：脚下文字堆叠 → 窗口底部独立条 + 3 秒自动淡出）。
 *
 * <p><b>为什么要单独成模块：</b>"什么时候显示、什么时候淡出"是一段**带定时器**的小状态机。
 * 塞进 `main.ts` 的事件回调里就只能靠肉眼验收（3 秒后到底淡出了没有？），
 * 抽出来之后定时器可注入，`tests/petHintBar.test.ts` 能用假定时器精确断言
 * "2999ms 仍可见 / 3000ms 起淡出 / 再交互重新计时"。</p>
 *
 * <p><b>它不拥有的东西：</b>文案内容、位置、字号、颜色全部在 CSS（`.pet-hint`）与
 * `main.ts` 的常量里，本模块只负责把 `data-visible` 这一个属性写成 `'0'` / `'1'`——
 * 淡入淡出是 CSS `transition` 的事，JS 不逐帧改 `opacity`（桌宠是常驻窗口，逐帧写样式等于常驻耗电）。</p>
 *
 * @module pet/visual/hint-bar
 */
import type { TimerPort } from '../presentation/bus';

/** 无交互多久后自动淡出（毫秒）。 */
export const HINT_AUTO_FADE_MS = 3000;

/**
 * 提示行宿主元素的最小结构（真实的 `HTMLSpanElement` 天然满足）。
 *
 * <p>刻意收窄成结构化接口而不是直接写 `HTMLElement`：node 里跑单测时不需要 DOM，
 * 一个 `{ textContent, dataset }` 的假对象就够。</p>
 */
export interface HintBarHost {
  /** 文本内容（只在文案变化时写）。 */
  textContent: string | null;
  /** `data-*` 属性袋（本模块只写 `visible`）。 */
  readonly dataset: { [key: string]: string | undefined };
}

/** 构造选项。 */
export interface HintBarOptions {
  /** 定时器端口（缺省用全局定时器；测试注入假定时器）。 */
  readonly timer?: TimerPort;
  /** 自动淡出时长（毫秒，缺省 {@link HINT_AUTO_FADE_MS}；`<=0` 表示从不自动淡出）。 */
  readonly fadeAfterMs?: number;
}

/**
 * 提示行控制器。
 *
 * <p>状态只有两个：可见 / 不可见。每次 {@link HintBar.poke}（任何一次交互）都会
 * 把"淡出倒计时"重新计满，所以用户一动，提示就在，停手 3 秒后自动消失。</p>
 */
export class HintBar {
  /** 宿主元素。 */
  private readonly host: HintBarHost;

  /** 定时器端口。 */
  private readonly timer: TimerPort;

  /** 自动淡出时长（毫秒）。 */
  private readonly fadeAfterMs: number;

  /** 淡出定时器句柄；`null` = 没有排队。 */
  private handle: number | null = null;

  /** 当前是否可见（与 `dataset.visible` 保持同步）。 */
  private visibleValue = false;

  /** 已释放标记。 */
  private disposed = false;

  /**
   * 构造控制器。
   *
   * @param host 宿主元素（真实 DOM 元素或测试替身）
   * @param options 可选项（定时器 / 淡出时长）
   */
  constructor(host: HintBarHost, options: HintBarOptions = {}) {
    if (!host || typeof host !== 'object' || !host.dataset) {
      throw new TypeError('HintBar 需要一个带 dataset 的宿主元素');
    }
    this.host = host;
    this.timer = options.timer ?? DEFAULT_HINT_TIMER;
    const raw = Number(options.fadeAfterMs ?? HINT_AUTO_FADE_MS);
    this.fadeAfterMs = Number.isFinite(raw) ? raw : HINT_AUTO_FADE_MS;
    // 首帧就是隐藏态：CSS 里 `.pet-hint` 的 opacity 默认 0，这里同步一次避免"属性缺失"歧义
    this.host.dataset.visible = '0';
  }

  /** 当前是否可见。 */
  get isVisible(): boolean {
    return this.visibleValue;
  }

  /** 自动淡出时长（毫秒；调试面板与测试用）。 */
  get fadeAfterMsValue(): number {
    return this.fadeAfterMs;
  }

  /**
   * 设置文案（只在真的变化时写 DOM，避免每帧触发排版）。
   *
   * @param text 新文案（单行小字，调用方负责压短）
   */
  setText(text: string): void {
    if (this.disposed) return;
    const next = typeof text === 'string' ? text : '';
    if (this.host.textContent === next) return;
    this.host.textContent = next;
  }

  /**
   * 显示并（重新）开始淡出倒计时。
   *
   * <p>这是"有交互"的唯一入口：鼠标进入、按下、拖动、点击都调它。</p>
   */
  show(): void {
    if (this.disposed) return;
    this.visibleValue = true;
    this.host.dataset.visible = '1';
    this.restart();
  }

  /**
   * 立即隐藏（清掉倒计时）。
   */
  hide(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.visibleValue = false;
    this.host.dataset.visible = '0';
  }

  /**
   * 记一次交互：显示并重新计时（{@link HintBar.show} 的语义别名，调用点更可读）。
   */
  poke(): void {
    this.show();
  }

  /** 释放：清定时器并保持隐藏（页面卸载时调用）。 */
  dispose(): void {
    this.clearTimer();
    this.disposed = true;
    this.visibleValue = false;
    this.host.dataset.visible = '0';
  }

  /** 重新开始倒计时。 */
  private restart(): void {
    this.clearTimer();
    if (!(this.fadeAfterMs > 0)) return;
    this.handle = this.timer.setTimeout(() => {
      this.handle = null;
      this.visibleValue = false;
      this.host.dataset.visible = '0';
    }, this.fadeAfterMs);
  }

  /** 清掉倒计时句柄。 */
  private clearTimer(): void {
    if (this.handle === null) return;
    this.timer.clearTimeout(this.handle);
    this.handle = null;
  }
}

/**
 * 默认定时器端口（与调度总线同一实现口径，但不 import 那个模块的常量，
 * 避免 `visual → presentation` 的反向依赖扩散）。
 */
const DEFAULT_HINT_TIMER: TimerPort = {
  setTimeout(handler: () => void, delayMs: number): number {
    return globalThis.setTimeout(handler, delayMs) as unknown as number;
  },
  clearTimeout(handle: number): void {
    globalThis.clearTimeout(handle as unknown as Parameters<typeof globalThis.clearTimeout>[0]);
  },
};
