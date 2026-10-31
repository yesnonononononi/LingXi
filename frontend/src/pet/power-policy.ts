/**
 * 功耗策略：把"窗口可见性 / 焦点 / 拖拽 / 减少动态"换算成四档功耗。
 *
 * <p><b>为什么需要它：</b>主进程刻意关掉了 Chromium 的后台节流（桌宠必须永远最前），
 * 副作用是"窗口被遮挡时 JS 定时器照常跑"。没有档位约束的话，一个藏在别的窗口后面的桌宠
 * 会安静地吃 CPU。</p>
 *
 * <p>四档与执行者（设计文档 §6.1）：</p>
 * <ul>
 *   <li>`interactive`：hover / 拖拽 —— CSS 动画本来就在合成器上每帧跑，无需提速；</li>
 *   <li>`idle`：默认；</li>
 *   <li>`low`：`document.hidden` —— 视觉降频（动画时长 ×2），零成本；</li>
 *   <li>`off`：窗口隐藏 —— `animation-play-state: paused`，并且停掉眨眼定时器。</li>
 * </ul>
 *
 * @module pet/power-policy
 */

/** 功耗档位。 */
export type Power = 'interactive' | 'idle' | 'low' | 'off';

/** 档位判定的输入。 */
export interface PowerInput {
  /** 窗口是否可见（主进程 `win.isVisible()` / `pet:command{type:'visible'}`）。 */
  readonly visible: boolean;
  /** 是否有焦点（桌宠 `focusable:false`，这里恒 false，保留字段以便将来改）。 */
  readonly focused: boolean;
  /** 是否正在拖拽。 */
  readonly dragging: boolean;
  /** 系统是否要求"减少动态效果"。 */
  readonly reducedMotion: boolean;
  /** 页面是否被判定隐藏（`document.hidden`）。 */
  readonly hidden?: boolean;
}

/** 档位判定的默认输入（可见、无焦点、未拖拽、无减少动态）。 */
export const DEFAULT_POWER_INPUT: PowerInput = {
  visible: true,
  focused: false,
  dragging: false,
  reducedMotion: false,
  hidden: false,
};

/**
 * 由输入推导功耗档位（纯函数）。
 *
 * <p>优先级：不可见（off） &gt; 页面隐藏（low） &gt; 拖拽/焦点（interactive） &gt; idle。</p>
 *
 * <p>`reducedMotion` 本批**不改变档位**：减少动态效果由 CSS 的 `prefers-reduced-motion`
 * 分支直接关掉动画（关比降频更彻底）。字段保留是因为方案B 的 `RafTicker` 需要知道
 * 该不该起主循环——那时它才是决定性输入。</p>
 *
 * @param input 输入
 * @returns 档位
 */
export function resolvePower(input: PowerInput): Power {
  if (!input || input.visible !== true) return 'off';
  if (input.hidden === true) return 'low';
  if (input.dragging === true || input.focused === true) return 'interactive';
  return 'idle';
}

/**
 * 功耗策略（纯函数 + 一个订阅）。
 *
 * <p>只有档位真的变化时才通知订阅者，避免每帧重写 `data-power`。</p>
 */
export class PowerPolicy {
  /** 当前输入。 */
  private input: PowerInput;

  /** 当前档位。 */
  private currentPower: Power;

  /** 订阅者。 */
  private readonly listeners: Set<(power: Power) => void> = new Set();

  /**
   * 构造策略。
   *
   * @param initial 初始输入（缺省按默认值）
   */
  constructor(initial: Partial<PowerInput> = {}) {
    this.input = { ...DEFAULT_POWER_INPUT, ...initial };
    this.currentPower = resolvePower(this.input);
  }

  /** 当前档位。 */
  get power(): Power {
    return this.currentPower;
  }

  /** 当前输入的只读快照。 */
  get snapshot(): PowerInput {
    return this.input;
  }

  /**
   * 更新输入并重算档位。
   *
   * @param patch 需要覆盖的字段
   * @returns 重算后的档位
   */
  update(patch: Partial<PowerInput>): Power {
    this.input = { ...this.input, ...patch };
    const next = resolvePower(this.input);
    if (next !== this.currentPower) {
      this.currentPower = next;
      for (const listener of this.listeners) {
        try {
          listener(next);
        } catch (err) {
          console.warn(`[pet] 功耗订阅者异常: ${String(err)}`);
        }
      }
    }
    return this.currentPower;
  }

  /**
   * 订阅档位变化。
   *
   * @param listener 回调
   * @returns 取消订阅
   */
  onPower(listener: (power: Power) => void): () => void {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 释放全部订阅。 */
  dispose(): void {
    this.listeners.clear();
  }
}
