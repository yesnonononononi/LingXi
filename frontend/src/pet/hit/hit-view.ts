/**
 * 命中状态的**界面收口**（纯函数，只认 DOM 三件套）。
 *
 * <p><b>为什么单独一个模块：</b>命中判定已经归主进程（`electron/pet-hit-poller.cjs`），
 * 渲染层只剩"把权威值画到界面上"这一件事。把它抽成纯函数有两个好处：</p>
 * <ol>
 *   <li>可以在 node 里用假元素直接断言"主进程说命中 ⇒ 徽标变成可交互、根节点打上
 *       `data-hit-source='main'`"，不需要整套 DOM 环境（本仓没有 jsdom）；</li>
 *   <li>`main.ts` 里不再有第二处写命中样式的地方 —— 想加回声就必须改这里，一眼可见。</li>
 * </ol>
 *
 * <p><b>`data-hit-source` 的含义：</b>它标注"当前这次命中状态是谁给的"。重构之后
 * **只可能是 `main`**；若将来有人把渲染层本地判定接回来，这个属性会立刻暴露成 `local`，
 * 调试徽标的配色也随之不同。</p>
 *
 * @module pet/hit/hit-view
 */

/** 命中来源：主进程（唯一合法值）。 */
export const HIT_SOURCE_MAIN = 'main' as const;

/** 徽标文案（穿透中 / 可交互）。 */
export const HIT_BADGE_TEXT = {
  /** 命中：窗口可交互。 */
  interactive: '可交互',
  /** 未命中：窗口穿透。 */
  passThrough: '穿透中',
} as const;

/** `classList` 的最小依赖面（`DOMTokenList` 结构上满足它）。 */
export interface HitClassListLike {
  /**
   * 加/去一个类。
   *
   * @param token 类名
   * @param force 强制加（true）或去（false）
   * @returns 任何值（DOMTokenList 返回 boolean，这里不关心）
   */
  toggle(token: string, force?: boolean): unknown;
}

/** 参与命中着色的三个 DOM 目标（任一可为 null：DOM 还没建好时要能安全跳过）。 */
export interface HitViewTargets {
  /** 根节点（`#pet-root`）：只写 `dataset.hitSource`。 */
  root: { dataset: { hitSource?: string } } | null;
  /** 立绘元素：命中时加 `is-hit`。 */
  art: { classList: HitClassListLike } | null;
  /** 调试徽标（生产态被 CSS 强制隐藏）。 */
  badge: { classList: HitClassListLike; textContent: string | null } | null;
}

/**
 * 把权威命中状态画到界面上。
 *
 * <p>纯函数：不改模块级状态、不读全局、不发 IPC。同一个 `hit` 反复调用结果一致。</p>
 *
 * @param targets 三个 DOM 目标（可为 null）
 * @param hit 是否可交互（true = 命中）
 * @returns {void}
 */
export function applyHitView(targets: HitViewTargets | null, hit: boolean): void {
  if (!targets) return;
  const interactive = hit === true;
  if (targets.root) {
    targets.root.dataset.hitSource = HIT_SOURCE_MAIN;
  }
  if (targets.art) {
    targets.art.classList.toggle('is-hit', interactive);
  }
  if (targets.badge) {
    targets.badge.textContent = interactive ? HIT_BADGE_TEXT.interactive : HIT_BADGE_TEXT.passThrough;
    targets.badge.classList.toggle('is-hit', interactive);
  }
}
