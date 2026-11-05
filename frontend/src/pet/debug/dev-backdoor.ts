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
import { PET_POSES, batchOf, clipOf } from '../poses/manifest';
import { POSTURE_IDS, type Facing, type PetPoses, type PosePostureId, type PostureId } from '../poses/types';
import type {
  PetDebugHandle,
  PetPoseDebugHandle,
  PoseClipTiming,
  PoseDebugSnapshot,
  PoseDebugStep,
  PoseMatrixReport,
} from './types';

/**
 * 姿态矩阵的姿态（3 个多朝向批次）。
 *
 * <p>只列 `walk`/`run`/`jump`：它们的 `clips` 是「同 id 左右各一条」，是**唯一**能验出
 * "朝向没生效 / 回落到另一朝向"的姿态。`sit` 只有 `-1` 一条，验不出朝向差异。</p>
 */
export const POSE_MATRIX_POSTURES: readonly PosePostureId[] = ['walk', 'run', 'jump'];

/** 姿态矩阵的朝向（左 / 右）。 */
export const POSE_MATRIX_FACINGS: readonly Facing[] = [-1, 1];

/** 单片段的采样上限（毫秒）：再长也不会更有信息量，只会让验收变慢。 */
export const SAMPLE_CAP_MS = 300;

/** 一次性片段播完之后，为"回站姿"终态断言多等的缓冲（毫秒）。 */
export const TERMINAL_BUFFER_MS = 200;

/**
 * 采样时刻的上限（毫秒，旧的"每组合停留时长"常量，已降级为**上限**）。
 *
 * <p>保留这个名字是为了让 `verifyMatrix(700)` 这类既有调用继续有效——但它的语义已经变了：
 * 真正的采样时刻由片段真实时长算出（见 {@link sampleDelayOf}），这里只负责封顶。
 * 把等待时间当成一个可以随便调大的旋钮是错的：`jump` 的 `once` 只有 650ms，
 * 等得越久拍到的越是"已经回站姿"。</p>
 */
export const POSE_MATRIX_HOLD_MS = SAMPLE_CAP_MS;

/**
 * 判断一个字符串是不是合法姿态名。
 *
 * @param value 不可信输入
 * @returns 是否合法
 */
function isPostureId(value: string): value is PostureId {
  return (POSTURE_IDS as readonly string[]).includes(value);
}

/**
 * 判断一个值是不是合法朝向。
 *
 * @param value 不可信输入
 * @returns 是否合法
 */
function isFacingValue(value: unknown): value is Facing {
  return value === -1 || value === 1;
}

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
  /** 指定姿态 + 朝向播放（**走生产路径** `setPosture` / `setFacing`，不直接改 DOM）。 */
  readonly posePlay?: ((posture: PostureId, facing: Facing) => PoseDebugSnapshot) | null;
  /** 停在站姿（保持后门接管）。 */
  readonly poseStop?: (() => void) | null;
  /** 交还控制权给行为状态机。 */
  readonly poseRelease?: (() => void) | null;
  /** 只改朝向。 */
  readonly poseFacing?: ((next: Facing) => Facing) | null;
  /** 读当前姿态快照。 */
  readonly poseSnapshot?: (() => PoseDebugSnapshot) | null;
  /** 等待（矩阵校验用；注入才能测）。 */
  readonly poseWait?: ((ms: number) => Promise<void>) | null;
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
 * 查一个片段的时序（**判定采样时机的唯一依据**）。
 *
 * <p>为什么要按片段真实时长采样：`jump` 的 `once` 是 5 帧 × 130ms = **650ms** 且
 * `onEnd:'return-stand'`。旧实现固定等 700ms 再拍照，拍到的已经是"播完回站姿"——
 * 于是**完全正确的 jump 被判成三条失败**（姿态没切过去 / 朝向没生效 / 没有在播）。
 * 验收工具把"正确行为"判成"失败"比不检查更糟：它会诱导下一个人去修一个没坏的姿态。
 * 所以时机必须从片段自己算，不许硬编码等待。</p>
 *
 * @param poses 姿态清单
 * @param posture 姿态
 * @param facing 朝向
 * @param clipId 片段 id（来自快照；`null` = 没有在播）
 * @returns 时序；查不到时 `null`（调用方据此退化为"立即采样"，绝不猜一个时长）
 */
export function clipTimingOf(
  poses: PetPoses,
  posture: PostureId,
  facing: Facing,
  clipId: string | null,
): PoseClipTiming | null {
  if (clipId === null) return null;
  const batch = batchOf(poses, posture);
  if (batch === null) return null;
  const clip = clipOf(batch, clipId, facing);
  if (clip === null) return null;
  const clipMs = clip.frameMs.reduce((sum, ms) => sum + (Number.isFinite(ms) ? ms : 0), 0);
  return {
    clipId: clip.id,
    clipMs,
    loop: clip.loop === true,
    returnsToStand: clip.onEnd === 'return-stand',
  };
}

/**
 * 算判定采样时刻（毫秒）——**按片段真实时长**，不是固定等待。
 *
 * <ul>
 *   <li><b>循环片段</b>：`min(clipMs / 2, capMs)`（必须仍在播，且已走过去一段，能看出"在动"）；</li>
 *   <li><b>一次性片段</b>：`min(clipMs × 0.4, capMs)`（早于收尾，仍在播）；</li>
 *   <li><b>查不到时序</b>：`0`（立刻拍，宁可不等待也不猜一个可能已过期的时长）。</li>
 * </ul>
 *
 * @param timing 时序（可空）
 * @param capMs 采样上限（缺省 {@link SAMPLE_CAP_MS}）
 * @returns 采样时刻（毫秒，`0` = 立即）
 */
export function sampleDelayOf(timing: PoseClipTiming | null, capMs: number = SAMPLE_CAP_MS): number {
  const cap = Number.isFinite(capMs) && capMs >= 0 ? Math.min(capMs, SAMPLE_CAP_MS) : SAMPLE_CAP_MS;
  if (timing === null) return 0;
  if (!(timing.clipMs > 0)) return 0;
  const raw = timing.loop ? timing.clipMs / 2 : timing.clipMs * 0.4;
  return Math.max(0, Math.min(raw, cap));
}

/**
 * 判断一次姿态试验是否真的生效。
 *
 * <p>三条基础判据缺一不可：①姿态对；②**片段朝向**对（只对姿态会放过"播了另一朝向"这种最危险的坏法）；
 * ③真的在播。任何一条不满足都返回具体原因，绝不返回"看起来成功了"。</p>
 *
 * <p><b>第四条判据（`return-stand` 的终态）</b>：一次性 + `onEnd:'return-stand'` 的片段
 * 播完后必须自己回到站姿（`posture === 'stand' && playing === false`）。这条以前**根本没验**
 * ——而它正是 `jump` 的真实语义。给了 `timing` 却不给 `terminal` 快照，说明"该验的没验"，
 * 同样判红（否则删掉这条断言不会有任何人发现）。</p>
 *
 * @param snapshot 采样时刻的快照
 * @param posture 期望姿态
 * @param facing 期望朝向
 * @param options 选项
 * @param options.timing 片段时序（给了一次性 return-stand 片段就必须同时给 `terminal`）
 * @param options.terminal 播完（`clipMs + 缓冲`）后的终态快照
 * @returns 问题列表（空数组 = 生效了）
 */
export function judgePoseStep(
  snapshot: PoseDebugSnapshot | null,
  posture: PostureId,
  facing: Facing,
  options: { readonly timing?: PoseClipTiming | null; readonly terminal?: PoseDebugSnapshot | null } = {},
): string[] {
  if (snapshot === null) return ['读不到姿态快照（姿态控制器未就绪）'];
  const problems: string[] = [];
  if (snapshot.posture !== posture) {
    problems.push(`姿态没切过去：期望 ${posture}，实际 ${snapshot.posture}`);
  }
  if (snapshot.clipFacing !== facing) {
    problems.push(
      `朝向没生效：期望片段朝向 ${JSON.stringify(facing)}，实际 ${JSON.stringify(snapshot.clipFacing)}` +
        '（回落到另一朝向就是这个症状：角色会突然翻转）',
    );
  }
  if (snapshot.playing !== true) problems.push('没有在播（playing=false）');

  const timing = options.timing ?? null;
  if (timing !== null && timing.returnsToStand && !timing.loop) {
    const terminal = options.terminal ?? null;
    if (terminal === null) {
      problems.push(
        `一次性片段 ${timing.clipId} 是 onEnd:return-stand，但没有验"播完回站姿"的终态` +
          '（该验的没验等于没守：删掉终态断言必须有人红）',
      );
    } else if (terminal.posture !== 'stand' || terminal.playing !== false) {
      problems.push(
        `一次性片段 ${timing.clipId}（${timing.clipMs}ms）播完后没有回站姿：` +
          `posture=${JSON.stringify(terminal.posture)}，playing=${JSON.stringify(terminal.playing)}` +
          '（onEnd:return-stand 该有的语义是"自己回站姿"，现在没做到）',
      );
    }
  }
  return problems;
}

/** 矩阵校验的端口集（**不含 DOM**，因此可以在 node 里直接跑与断言）。 */
export interface PoseMatrixPorts {
  /** 指定姿态 + 朝向播放，返回快照。 */
  readonly posePlay: (posture: PostureId, facing: Facing) => PoseDebugSnapshot | null;
  /** 停在站姿。 */
  readonly poseStop: () => void;
  /** 读快照。 */
  readonly poseSnapshot: () => PoseDebugSnapshot | null;
  /** 等待。 */
  readonly poseWait: (ms: number) => Promise<void>;
  /** 片段时序查询（缺省按 `PET_POSES` 查；测试可注入合成片段）。 */
  readonly poseClip?: ((posture: PostureId, facing: Facing, clipId: string | null) => PoseClipTiming | null) | null;
}

/**
 * 一条命令验完 6 个组合（`walk`/`run`/`jump` × 左右）。
 *
 * <p><b>为什么要有这个函数而不是只给 `play()`：</b>"验完 6 个组合"如果靠人敲 12 次命令，
 * 就会出现"看了 4 个觉得没问题就收工"的验收；把它做成一次遍历，同时把每一步的判据
 * 与期望写在代码里（`judgePoseStep`），验收结论就不依赖记忆。</p>
 *
 * <p><b>采样时机按片段真实时长算</b>（见 {@link sampleDelayOf}），不再固定等一个数：
 * `jump` 的 `once` 只有 650ms，固定等 700ms 拍到的是"已经回站姿"，会把正确行为判红。
 * 一次性 + `return-stand` 的片段还会**再等到 `clipMs + 缓冲`** 补一条终态断言。</p>
 *
 * <p>顺序固定：姿态外层、朝向内层（`-1` 先），所以报告顺序稳定、可 diff。
 * 结束后一定 `poseStop()`——不留一个"矩阵跑完还在跳"的现场。</p>
 *
 * @param ports 端口
 * @param options 选项
 * @param options.holdMs 采样时刻的**上限**（毫秒，缺省 {@link SAMPLE_CAP_MS}）。
 *   **不是**固定等待时长：真正的采样时刻由片段时长决定，这个值只负责封顶。
 * @returns 矩阵报告
 */
export async function runPoseMatrix(
  ports: PoseMatrixPorts,
  options: { readonly holdMs?: number } = {},
): Promise<PoseMatrixReport> {
  const capMs =
    typeof options.holdMs === 'number' && Number.isFinite(options.holdMs) && options.holdMs >= 0
      ? Math.min(options.holdMs, SAMPLE_CAP_MS)
      : SAMPLE_CAP_MS;
  /** 查时序：优先用注入的，其次按真清单查。 */
  const queryTiming = (posture: PostureId, facing: Facing, clipId: string | null): PoseClipTiming | null => {
    if (typeof ports.poseClip === 'function') return ports.poseClip(posture, facing, clipId);
    return clipTimingOf(PET_POSES, posture, facing, clipId);
  };
  const steps: PoseDebugStep[] = [];
  const problems: string[] = [];
  try {
    for (const posture of POSE_MATRIX_POSTURES) {
      for (const facing of POSE_MATRIX_FACINGS) {
        const started = ports.posePlay(posture, facing);
        const timing = queryTiming(posture, facing, started?.clipId ?? null);
        const sampleAtMs = sampleDelayOf(timing, capMs);
        if (sampleAtMs > 0) await ports.poseWait(sampleAtMs);
        const settled = ports.poseSnapshot() ?? started;
        // 一次性 + return-stand：等到 clipMs + 缓冲再补一条终态断言（这才是它该有的语义）
        let terminal: PoseDebugSnapshot | null = null;
        let terminalChecked = false;
        if (timing !== null && timing.returnsToStand && !timing.loop) {
          const totalMs = timing.clipMs + TERMINAL_BUFFER_MS;
          const remaining = Math.max(0, totalMs - sampleAtMs);
          if (remaining > 0) await ports.poseWait(remaining);
          terminal = ports.poseSnapshot();
          terminalChecked = true;
        }
        const stepProblems = judgePoseStep(settled, posture, facing, { timing, terminal });
        steps.push({
          posture,
          facing,
          ok: stepProblems.length === 0,
          snapshot: settled,
          problems: stepProblems,
          clipMs: timing === null ? null : timing.clipMs,
          sampleAtMs,
          terminalChecked,
        });
        for (const problem of stepProblems) problems.push(`${posture}@${facing}: ${problem}`);
      }
    }
  } finally {
    ports.poseStop();
  }
  return { ok: problems.length === 0, steps, problems };
}

/**
 * 姿态后门的最小依赖集（只用到姿态端口 + 交互提示，因此可以在 node 里直接构造）。
 */
export interface PoseHandleDeps {
  /** 指定姿态 + 朝向播放。 */
  readonly posePlay?: ((posture: PostureId, facing: Facing) => PoseDebugSnapshot) | null;
  /** 停在站姿。 */
  readonly poseStop?: (() => void) | null;
  /** 交还控制权给行为状态机。 */
  readonly poseRelease?: (() => void) | null;
  /** 只改朝向。 */
  readonly poseFacing?: ((next: Facing) => Facing) | null;
  /** 读快照。 */
  readonly poseSnapshot?: (() => PoseDebugSnapshot) | null;
  /** 等待。 */
  readonly poseWait?: ((ms: number) => Promise<void>) | null;
  /** 片段时序查询（不注入就按真清单 `PET_POSES` 查）。 */
  readonly poseClip?: ((posture: PostureId, facing: Facing, clipId: string | null) => PoseClipTiming | null) | null;
  /** 任何一次操作都算"有交互"。 */
  readonly onPoke?: () => void;
}

/**
 * 构造姿态调试句柄（`petDebug.pose`）。
 *
 * <p><b>为什么导出：</b>它是纯函数（只吃端口、不碰 DOM / `window`），导出后可以在 node 测试里
 * 直接构造并用假端口验证"非法输入给 `ok:false` 而不是假成功"。</p>
 *
 * @param deps 依赖
 * @returns 句柄
 * @throws {Error} 调用方没有注入某个端口时（明确报错，不静默降级成"假成功"）
 */
export function buildPoseHandle(deps: PoseHandleDeps): PetPoseDebugHandle {
  /** 取端口，缺失就明确报错（假成功比不可用更糟）。 */
  const need = <T>(value: T | null | undefined, name: string): T => {
    if (value === undefined || value === null) {
      throw new Error(`[pet] 姿态后门缺少端口 ${name}：main.ts 没有把它接进来`);
    }
    return value;
  };
  /** 读快照（拿不到就是 null，交给判据说话）。 */
  const snapshot = (): PoseDebugSnapshot | null => {
    const read = deps.poseSnapshot;
    return typeof read === 'function' ? read() : null;
  };
  /** 查时序：优先用注入的，其次按真清单查（供 `play()` 报告 `clipMs`）。 */
  const timingOf = (posture: PostureId, facing: Facing, clipId: string | null): PoseClipTiming | null => {
    if (typeof deps.poseClip === 'function') return deps.poseClip(posture, facing, clipId);
    return clipTimingOf(PET_POSES, posture, facing, clipId);
  };
  return {
    play: (posture: string, facing?: Facing): PoseDebugStep => {
      const current = snapshot();
      const requestedFacing = isFacingValue(facing) ? facing : (current?.facing ?? -1);
      if (!isPostureId(posture)) {
        return {
          posture,
          facing: requestedFacing,
          ok: false,
          snapshot: current,
          problems: [`未知姿态名: ${posture}（合法值：${POSTURE_IDS.join(' / ')}）`],
          clipMs: null,
          sampleAtMs: 0,
          terminalChecked: false,
        };
      }
      if (!isFacingValue(requestedFacing)) {
        return {
          posture,
          facing: Number(requestedFacing),
          ok: false,
          snapshot: current,
          problems: [`朝向只能是 -1 或 1，实际为 ${JSON.stringify(requestedFacing)}`],
          clipMs: null,
          sampleAtMs: 0,
          terminalChecked: false,
        };
      }
      deps.onPoke?.();
      const play = need(deps.posePlay, 'posePlay');
      const played = play(posture, requestedFacing) ?? null;
      const timing = timingOf(posture, requestedFacing, played?.clipId ?? null);
      // `play()` 是**同步单点探针**：它判"这一刻在不在播"。`return-stand` 的终态需要等待，
      // 那是 `verifyMatrix()` 的职责——所以这里**不传 timing**，否则会把"没验终态"报成红。
      const problems = judgePoseStep(played, posture, requestedFacing);
      return {
        posture,
        facing: requestedFacing,
        ok: problems.length === 0,
        snapshot: played,
        problems,
        clipMs: timing === null ? null : timing.clipMs,
        sampleAtMs: 0,
        terminalChecked: false,
      };
    },
    stop: (): PoseDebugStep => {
      const stop = need(deps.poseStop, 'poseStop');
      stop();
      const settled = snapshot();
      return {
        posture: 'stand',
        facing: settled?.facing ?? -1,
        ok: settled === null ? false : settled.posture === 'stand' && settled.playing === false,
        snapshot: settled,
        problems: settled === null ? ['读不到姿态快照（姿态控制器未就绪）'] : [],
        clipMs: null,
        sampleAtMs: 0,
        terminalChecked: false,
      };
    },
    release: (): void => {
      const release = need(deps.poseRelease, 'poseRelease');
      release();
    },
    facing: (next: Facing): Facing => {
      if (!isFacingValue(next)) {
        throw new TypeError(`[pet] pose.facing 只能是 -1 或 1，实际为 ${JSON.stringify(next)}`);
      }
      const apply = need(deps.poseFacing, 'poseFacing');
      return apply(next);
    },
    snapshot: (): PoseDebugSnapshot => {
      const current = snapshot();
      if (current === null) throw new Error('[pet] 姿态控制器未就绪：读不到姿态快照');
      return current;
    },
    verifyMatrix: async (holdMs?: number): Promise<PoseMatrixReport> => {
      const play = need(deps.posePlay, 'posePlay');
      const stop = need(deps.poseStop, 'poseStop');
      const read = need(deps.poseSnapshot, 'poseSnapshot');
      const wait =
        typeof deps.poseWait === 'function'
          ? deps.poseWait
          : (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
      return runPoseMatrix(
        {
          posePlay: play,
          poseStop: stop,
          poseSnapshot: read,
          poseWait: wait,
          // 采样时机与"回站姿"终态都靠它：不注入就用真清单算，绝不用固定等待蒙过去
          poseClip: timingOf,
        },
        { holdMs },
      );
    },
  };
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
    pose: buildPoseHandle(deps),
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
