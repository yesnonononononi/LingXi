/**
 * 调试句柄的类型契约（**纯类型模块，零运行时代码**）。
 *
 * <p>为什么单独一份：`window.petDebug` 的构造已经整体搬进 `debug/dev-backdoor.ts`
 * （生产构建连模块都不产出），但 `main.ts` 还要给 `Window` 补声明、`dev-backdoor.ts`
 * 还要实现它。契约放这里，两边各 import 一次类型——类型在构建期被完全擦除，
 * 所以 `petDebug` 这个键名不会因此漏进生产产物。</p>
 *
 * @module pet/debug/types
 */
import type { ExpressionId, MotionId, PresentationOp } from '../presentation/types';
import type { ForceStateResult } from '../presentation/entry-report';
import type { PetBehaviorState } from '../behavior/state-machine';

/** 调试句柄（`import.meta.env.DEV` 下才有；生产态整个对象不挂到 window）。 */
export interface PetDebugHandle {
  /** 直接投递一条表现层指令（排障用）。 */
  dispatch: (op: PresentationOp) => string;
  /** 按表情 id 切一刀（基底层，不会自己回退）。 */
  setExpression: (name: string) => boolean;
  /** 当前表情 id。 */
  getExpression: () => ExpressionId;
  /** 全部合法表情 id（与美术规格书 §5 的 E1–E8 对应）。 */
  list: () => string[];
  /** 当前行为状态（idle / tap / angry / sleeping / wake / drag）。 */
  behaviorState: () => PetBehaviorState;
  /** 派发一次点击行为（等价于点一下桌宠；连点 3 次可触发生气）。 */
  tap: () => string[];
  /**
   * 后门：瞬间切到任意状态（O1；不必再等 90 秒）。
   *
   * <p><b>返回值带失败信息</b>（M6-b 第二轮必修项 1）：以前它返回 `string[]`，
   * 被总线拒绝的入态指令就只剩一个 `'rejected'` 字符串，没有任何人看。
   * 现在返回结构化报告，`ok === false` 时调用方能直接发现"状态没切成功"。</p>
   *
   * @param state `idle` / `tap` / `happy` / `angry` / `sleeping` / `wake` / `drag`
   * @returns 落地报告（非法状态名返回 `ok: false` 的报告，而不是静默空数组）
   */
  forceState: (state: string) => ForceStateResult;
  /** 后门：把"无交互 90 秒入睡"的计时起点拉回现在。 */
  resetIdleTimer: () => void;
  /** 当前手势阶段（`idle` / `pressed` / `dragging`；验"不卡 drag"用）。 */
  gesturePhase: () => string;
  /** 拖拽阈值（CSS px；验"微动不算拖"用）。 */
  dragThresholdPx: () => number;
  /** 当前正在持续的动作（状态型；`null` = 没有）。 */
  sustainedMotion: () => MotionId | null;
  /** 当前合成模式（`composite` / `partial` / `layered`；排障用）。 */
  compositeMode: () => string;
  /** 参与本次合成的层 id（`composite` 时为空数组）。 */
  layerIds: () => string[];
}
