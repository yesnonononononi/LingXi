/**
 * 开发态调试后门（O1）——**整个模块只在开发构建里存在**。
 *
 * <p><b>为什么是"整模块"而不只是"几个键"：</b>M6-b 第二轮前 `window.petDebug` 的骨架
 * （`dispatch` / `setExpression` / `behaviorState` …）是在 `main.ts` 里按运行时条件
 * `isDebugEnabled(search, import.meta.env.DEV)` 构造的，于是"生产构建 + `?debug=1`"
 * 照样能挂上一个调试句柄，`petDebug` 这个键名也照样留在产物里。现在：
 * <b>`main.ts` 里只剩一句 `if (import.meta.env.DEV) mountDevTools()`</b>，
 * 句柄的构造、键名、面板 DOM 全部搬到这里，由那段动态 `import()` 决定生死。
 * 生产构建里条件恒假 → 动态 import 被摇掉 → 本模块不产出任何 chunk →
 * `dist/` 里搜 `petDebug` 命中数为 0。</p>
 *
 * <p><b>本模块拥有什么：</b>调试面板 DOM、调试句柄的键名与形状
 * （契约见 `debug/types.ts`）、"状态名 → 指令"的转发。
 * <b>它不拥有什么：</b>状态语义（在 `behavior/state-machine.ts` 的 `enterState`）、
 * 指令投递与失败回滚（`main.ts` 注入的 `dispatchEntry`）、优先级判定
 * （`presentation/priority.ts` 的规则表）。于是调试看到的路径与真机完全一致。</p>
 *
 * @module pet/debug/dev-backdoor
 */
import {
  PET_BEHAVIOR_DEBUG_STATES,
  isPetBehaviorDebugState,
  type PetBehaviorStateMachine,
} from '../behavior/state-machine';
import type { EntryDispatchReport, ForceStateResult } from '../presentation/entry-report';
import type { ExpressionId, MotionId, PresentationOp } from '../presentation/types';
import type { PetDebugHandle } from './types';

/** 后门需要的依赖（由 `main.ts` 注入，本模块不读任何全局状态）。 */
export interface DevBackdoorDeps {
  /** 行为状态机（状态语义的真源）。 */
  readonly behavior: PetBehaviorStateMachine;
  /**
   * 直接投递一条指令（不复检 / 不回滚；给 `petDebug.dispatch` 用）。
   *
   * @param op 指令
   * @returns 调度结果
   */
  readonly dispatch: (op: PresentationOp) => string;
  /**
   * 投递一批<b>入态</b>指令，并带回落地报告（失败时 main 侧已回滚行为层）。
   *
   * @param ops 指令列表
   * @param label 排障标签
   * @returns 落地报告
   */
  readonly dispatchEntry: (ops: readonly PresentationOp[], label: string) => EntryDispatchReport;
  /** 切换基底层表情。 */
  readonly setExpression: (name: string) => boolean;
  /** 读当前表情。 */
  readonly getExpression: () => ExpressionId;
  /** 全部合法表情 id。 */
  readonly listExpressions: () => string[];
  /** 当前手势阶段。 */
  readonly gesturePhase: () => string;
  /** 拖拽阈值（CSS px）。 */
  readonly dragThresholdPx: () => number;
  /** 当前持续动作。 */
  readonly sustainedMotion: () => MotionId | null;
  /** 当前合成模式。 */
  readonly compositeMode: () => string;
  /** 参与合成的层 id。 */
  readonly layerIds: () => string[];
  /** 调试面板挂在哪里（必须落在立绘的命中区之内，否则鼠标到不了）。 */
  readonly host: HTMLElement;
  /** 任何一次调试操作都算"有交互"（顺带把提示行点亮）。 */
  readonly onPoke?: () => void;
}

/** 后门键名（字面量只允许出现在本文件里——它是"发布态零暴露"的边界）。 */
const FORCE_STATE_KEY = 'forceState';
/** 重置入睡计时的键名。 */
const RESET_IDLE_KEY = 'resetIdleTimer';
/** 调试句柄挂载点（同样是本文件独占的字面量）。 */
const DEBUG_HANDLE_KEY = 'petDebug';

/** 安装结果。 */
export interface DevBackdoorHandle {
  /** 调试面板元素（没装成就为 null）。 */
  readonly bar: HTMLDivElement | null;
  /** 挂到 `window` 上的调试句柄。 */
  readonly handle: PetDebugHandle;
  /**
   * 强制切到某个状态。
   *
   * @param state 状态名（不可信输入）
   * @returns 落地报告
   */
  forceState(state: string): ForceStateResult;
}

/**
 * 切到某个状态并把"首发指令"投递出去，返回**带失败信息**的落地报告。
 *
 * <p>非法状态名也要给报告（`ok: false` + 说明），不能返回空数组——空数组与
 * "切成功了但没有指令"无法区分，正是"静默"的来源。</p>
 *
 * @param deps 依赖
 * @param state 状态名（不可信）
 * @returns 落地报告
 */
function forceState(deps: DevBackdoorDeps, state: string): ForceStateResult {
  if (!isPetBehaviorDebugState(state)) {
    return {
      state,
      ok: false,
      outcomes: [],
      applied: 0,
      queued: 0,
      rejected: 0,
      rolledBack: false,
      message: `未知状态名: ${state}`,
    };
  }
  deps.onPoke?.();
  const ops = deps.behavior.enterState(state);
  const report = deps.dispatchEntry(ops, `debug:force:${state}`);
  return { ...report, state };
}

/**
 * 造一排直达按钮（O1：idle / tap / happy / angry / sleeping / wake / drag）。
 *
 * @param deps 依赖
 * @returns 面板元素
 */
function buildBar(deps: DevBackdoorDeps): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'pet-debugbar';
  for (const state of PET_BEHAVIOR_DEBUG_STATES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = state;
    button.dataset.petDebugState = state;
    // 按下就拦住：否则点按钮会顺带喂给手势层，变成一次"点击桌宠"
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const report = forceState(deps, state);
      // 失败必须看得见：以前这里连返回值都丢了，于是"点了没反应"只能靠肉眼猜
      button.dataset.lastOutcome = report.ok ? 'ok' : `failed:${report.message}`;
      if (!report.ok) console.warn(`[pet] 调试后门切状态失败: ${JSON.stringify(report)}`);
    });
    bar.append(button);
  }
  return bar;
}

/**
 * 构造调试句柄（形状由 `debug/types.ts` 的 `PetDebugHandle` 约束）。
 *
 * @param deps 依赖
 * @returns 调试句柄
 */
function buildHandle(deps: DevBackdoorDeps): PetDebugHandle {
  return {
    dispatch: (op: PresentationOp): string => deps.dispatch(op),
    setExpression: (name: string): boolean => deps.setExpression(name),
    getExpression: (): ExpressionId => deps.getExpression(),
    list: (): string[] => deps.listExpressions(),
    behaviorState: () => deps.behavior.state,
    tap: (): string[] => deps.dispatchEntry(deps.behavior.handle('tap'), 'debug:tap').outcomes,
    [FORCE_STATE_KEY]: (state: string): ForceStateResult => forceState(deps, state),
    [RESET_IDLE_KEY]: (): void => {
      deps.onPoke?.();
      deps.behavior.markInteraction();
    },
    gesturePhase: (): string => deps.gesturePhase(),
    dragThresholdPx: (): number => deps.dragThresholdPx(),
    sustainedMotion: (): MotionId | null => deps.sustainedMotion(),
    compositeMode: (): string => deps.compositeMode(),
    layerIds: (): string[] => deps.layerIds(),
  } as PetDebugHandle;
}

/**
 * 安装调试后门：把句柄挂到 `window` 上，并把一排按钮挂到立绘里。
 *
 * <p><b>调用方必须在 `import.meta.env.DEV` 分支里动态 import 本模块</b>
 * （见 `main.ts` 的 `mountDevTools`），否则"发布态零暴露"这条就断了。</p>
 *
 * @param deps 依赖
 * @returns 句柄（面板元素 + 后门函数）
 */
export function installDevBackdoor(deps: DevBackdoorDeps): DevBackdoorHandle {
  if (!deps || !deps.behavior || !deps.host) {
    throw new TypeError('installDevBackdoor 需要 behavior 与 host');
  }
  const handle = buildHandle(deps);
  (window as unknown as Record<string, unknown>)[DEBUG_HANDLE_KEY] = handle;
  const bar = buildBar(deps);
  deps.host.append(bar);
  return { bar, handle, forceState: (state: string) => forceState(deps, state) };
}
