/**
 * 开发态调试后门（O1）——**只在开发构建里存在**。
 *
 * <p><b>为什么要单独一个模块并且用动态 `import()` 挂载：</b>用户明确要求
 * "发布态零暴露"。以前 `window.petDebug` 是运行时按 `?debug=1` 判断的，
 * 于是这些调试入口（尤其是能直接跳到任意状态的后门）会**留在发布产物里**，
 * 只是没被赋值——`forceState` 这样的标识符照样能在打包后的 JS 里被搜到。
 * 现在改成：`main.ts` 里那段挂载代码被 `import.meta.env.DEV` 包着（构建期常量），
 * 生产构建会把它连同本模块一起 DCE 掉，产物里连字符串都不剩。</p>
 *
 * <p><b>本模块拥有什么：</b>调试面板 DOM、后门函数名（`forceState` / `resetIdleTimer` 这两个
 * 键名只在这里以字面量出现）、以及"状态名 → 指令"的转发。
 * <b>它不拥有什么：</b>状态语义（在 `behavior/state-machine.ts` 的 `enterState`）、
 * 指令投递（`main.ts` 注入的 `dispatch`）。于是调试看到的路径与真机完全一致。</p>
 *
 * @module pet/debug/dev-backdoor
 */
import {
  PET_BEHAVIOR_DEBUG_STATES,
  isPetBehaviorDebugState,
  type PetBehaviorStateMachine,
} from '../behavior/state-machine';
import type { PresentationOp } from '../presentation/types';

/** 后门需要的依赖（由 `main.ts` 注入，本模块不读任何全局状态）。 */
export interface DevBackdoorDeps {
  /** 行为状态机（状态语义的真源）。 */
  readonly behavior: PetBehaviorStateMachine;
  /**
   * 批量投递指令。
   *
   * @param ops 指令列表
   * @returns 各条的调度结果
   */
  readonly dispatch: (ops: readonly PresentationOp[]) => string[];
  /** 调试面板挂在哪里（必须落在立绘的命中区之内，否则鼠标到不了）。 */
  readonly host: HTMLElement;
  /** `window.petDebug` 句柄（后门把两个键写进去）。 */
  readonly handle: Record<string, unknown>;
  /** 任何一次调试操作都算"有交互"（顺带把提示行点亮）。 */
  readonly onPoke?: () => void;
}

/** 后门键名（字面量只允许出现在本文件里——它是"发布态零暴露"的边界）。 */
const FORCE_STATE_KEY = 'forceState';
/** 重置入睡计时的键名。 */
const RESET_IDLE_KEY = 'resetIdleTimer';

/** 安装结果。 */
export interface DevBackdoorHandle {
  /** 调试面板元素（没装成就为 null）。 */
  readonly bar: HTMLDivElement | null;
  /**
   * 强制切到某个状态。
   *
   * @param state 状态名（不可信输入）
   * @returns 各条指令的调度结果（非法状态名返回空数组）
   */
  forceState(state: string): string[];
}

/**
 * 切到某个状态并把"首发指令"投递出去。
 *
 * @param deps 依赖
 * @param state 状态名（不可信）
 * @returns 各条指令的调度结果
 */
function forceState(deps: DevBackdoorDeps, state: string): string[] {
  if (!isPetBehaviorDebugState(state)) return [];
  deps.onPoke?.();
  return deps.dispatch(deps.behavior.enterState(state));
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
      forceState(deps, state);
    });
    bar.append(button);
  }
  return bar;
}

/**
 * 安装后门：把 `forceState` / `resetIdleTimer` 写进调试句柄，并把按钮挂到立绘上。
 *
 * @param deps 依赖
 * @returns 句柄（面板元素 + 后门函数）
 */
export function installDevBackdoor(deps: DevBackdoorDeps): DevBackdoorHandle {
  if (!deps || !deps.behavior || !deps.host) {
    throw new TypeError('installDevBackdoor 需要 behavior 与 host');
  }
  deps.handle[FORCE_STATE_KEY] = (state: string): string[] => forceState(deps, state);
  deps.handle[RESET_IDLE_KEY] = (): void => {
    deps.onPoke?.();
    deps.behavior.markInteraction();
  };
  const bar = buildBar(deps);
  deps.host.append(bar);
  return { bar, forceState: (state: string) => forceState(deps, state) };
}
