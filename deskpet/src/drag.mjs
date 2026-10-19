// 拖拽与缩放相关的纯几何计算：主进程与渲染进程共用，也供单测直接调用。

/** 指针移动超过该距离才判定为「拖动」，否则视为「点击」。 */
export const DRAG_THRESHOLD_PX = 5;

/** 按下到抬起短于该毫秒数才可能是点击。 */
export const CLICK_MAX_MS = 400;

/**
 * 是否需要从点击切成拖动。
 * @param {number} dx 相对按下点的 x 位移
 * @param {number} dy 相对按下点的 y 位移
 */
export function shouldStartDrag(dx, dy) {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
}

/**
 * 是否是一次有效点击。
 * 时间与位移两个条件都要满足：久按后抬起不算点击，抖动也不算。
 */
export function isClick(elapsedMs, dx, dy) {
  if (elapsedMs > CLICK_MAX_MS) return false;
  return !shouldStartDrag(dx, dy);
}

/**
 * 把窗口左上角夹进屏幕工作区，保证宠物不会跑到屏幕外找不回来。
 * 当窗口比工作区还大时，按工作区左上角对齐（否则 min/max 会互相打架算出负数）。
 */
export function clampToWorkArea(position, size, workArea) {
  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;
  const limitX = Math.max(workArea.x, maxX);
  const limitY = Math.max(workArea.y, maxY);
  return {
    x: Math.round(Math.min(Math.max(position.x, workArea.x), limitX)),
    y: Math.round(Math.min(Math.max(position.y, workArea.y), limitY)),
  };
}

/**
 * 缩放时以「底部中心」为锚点：宠物的脚站在原处不动，视觉上不会突然陷进任务栏或飘起来。
 */
export function resolveScaledPosition(topLeft, currentSize, nextSize) {
  return {
    x: Math.round(topLeft.x + (currentSize.width - nextSize.width) / 2),
    y: Math.round(topLeft.y + (currentSize.height - nextSize.height)),
  };
}
