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
import type { Facing, PostureId } from '../poses/types';

/**
 * 姿态快照（dev 后门断言"真的在播这个姿态这个朝向"用）。
 *
 * <p>为什么带 `clipFacing`：只断言 `posture` 会放过最危险的那种坏法——姿态对了但播的是
 * **另一朝向**的片段（角色突然翻转）。`override` 用来确认"后门确实接管了行为拍"。</p>
 */
export interface PoseDebugSnapshot {
  /** 当前姿态。 */
  readonly posture: PostureId;
  /** 当前朝向（控制器的朝向状态）。 */
  readonly facing: Facing;
  /** 当前片段 id（`null` = 没有在放姿态）。 */
  readonly clipId: string | null;
  /** 当前片段的朝向（`null` = 没有在放姿态）。 */
  readonly clipFacing: Facing | null;
  /** 当前帧 id（`null` = 没有在放姿态）。 */
  readonly frameId: string | null;
  /** 是否在播放。 */
  readonly playing: boolean;
  /** 当前 dev 强制姿态（`null` = 由行为状态机派生）。 */
  readonly override: PostureId | null;
}

/**
 * 片段时序（判定采样时机的依据）。
 *
 * <p>为什么要把它显式带出来：判定"这个姿态在播吗"必须**在片段还在播的时候**拍照。
 * `jump` 的 `once` 只有 `5 × 130 = 650ms` 且 `onEnd:'return-stand'`——固定等 700ms
 * 拍到的已经是"播完回站姿"，正确行为会被判成三条失败。所以时长必须从片段自己算。</p>
 */
export interface PoseClipTiming {
  /** 片段 id。 */
  readonly clipId: string;
  /** 片段总时长（毫秒，= `frameMs` 之和）。 */
  readonly clipMs: number;
  /**
   * 片段帧数（= `clip.frames.length`）。
   *
   * <p>只为一件事存在：判"帧在推进"时区分**多帧**与**单帧**。单帧片段（如 `sit` 的 `hold`）
   * 根本没有"下一帧"，要求它换帧是错的——所以必须显式豁免并在报告里写清 `motionChecked: false`，
   * 不许用"帧数 > 1 才检查"这种隐式豁免蒙过去（那样读报告的人会以为每一格都验过"在动"）。</p>
   */
  readonly frameCount: number;
  /** 是否循环。 */
  readonly loop: boolean;
  /** 播完是否回站姿（`onEnd === 'return-stand'`）。 */
  readonly returnsToStand: boolean;
}

/** 一次姿态试验的结果（`ok:false` 时 `problems` 说明哪里没生效）。 */
export interface PoseDebugStep {
  /** 试验的姿态（**用户输入原样回显**，所以是 `string`：非法名也要能如实带回来）。 */
  readonly posture: string;
  /** 试验的朝向（同上，非法值是 `number` 而不是 `Facing`）。 */
  readonly facing: number;
  /** 是否真的播起来了（姿态 + 片段朝向 + 播放中 + 帧在推进，四项都对）。 */
  readonly ok: boolean;
  /** 采样时刻的快照（读不到时 `null`）。 */
  readonly snapshot: PoseDebugSnapshot | null;
  /** 没生效的具体原因（`ok:true` 时为空数组）。 */
  readonly problems: readonly string[];
  /** 片段总时长（毫秒；查不到时序时 `null`）——让人一眼看出这个组合有多长。 */
  readonly clipMs: number | null;
  /** **判定采样时刻**（毫秒，从 `play()` 起算）——让人一眼看出它是在哪一刻判的。 */
  readonly sampleAtMs: number;
  /** 是否补验了"播完回站姿"的终态（只有一次性 + `return-stand` 片段才为 `true`）。 */
  readonly terminalChecked: boolean;
  /** 采样前的帧 id（"帧在推进"判据的起点；读不到时 `null`）。 */
  readonly startFrameId: string | null;
  /** 采样时刻的帧 id（与 {@link startFrameId} 比对）。 */
  readonly sampleFrameId: string | null;
  /**
   * 是否真的验了"帧在推进"。
   *
   * <p><b>`false` 不等于通过，等于"这一项没验"</b>：单帧片段没有帧可推进、或时序查不到（帧数未知）
   * 时为 `false`，具体原因见 {@link motionReason}。绝对不许把 `motionChecked: false` 读成"动画在动"。</p>
   */
  readonly motionChecked: boolean;
  /** 为什么没验 / 或验了什么（人话，直接可读）。 */
  readonly motionReason: string;
}

/** 6 组合矩阵的结果（一条命令验完 `walk`/`run`/`jump` × 左右）。 */
export interface PoseMatrixReport {
  /** 6 个组合是否全部 OK。 */
  readonly ok: boolean;
  /** 逐个组合的结果（顺序即执行顺序）。 */
  readonly steps: readonly PoseDebugStep[];
  /** 汇总问题（`ok:true` 时为空数组）。 */
  readonly problems: readonly string[];
}

/** 姿态调试后门（`import.meta.env.DEV` 下才有）。 */
export interface PetPoseDebugHandle {
  /**
   * 指定姿态 + 朝向播放一次（走生产路径 `setPosture` / `setFacing`）。
   *
   * @param posture 姿态名（不可信输入，非法名给 `ok:false` 的结果而不是抛错）
   * @param facing 朝向（缺省 = 当前朝向）
   * @returns 试验结果（含真实快照）
   */
  play: (posture: string, facing?: Facing) => PoseDebugStep;
  /** 停在站姿（保持后门接管，行为拍仍不会抢回来）。 */
  stop: () => PoseDebugStep;
  /** 交还控制权给行为状态机。 */
  release: () => void;
  /** 只改朝向（站姿下也就只记下，不重启播放）。 */
  facing: (next: Facing) => Facing;
  /** 读当前快照。 */
  snapshot: () => PoseDebugSnapshot;
  /**
   * 一条命令验完 `walk`/`run`/`jump` × 左右 6 个组合。
   *
   * <p>采样时机按**片段真实时长**算（循环片段 `min(总时长/2, 300ms)`、一次性片段
   * `min(总时长×0.4, 300ms)`）；一次性 + `return-stand` 的片段再等到 `总时长 + 缓冲`
   * 补一条"回站姿"终态断言。每步都会带回 `clipMs` / `sampleAtMs` / `terminalChecked`。</p>
   *
   * @param holdMs 采样时刻的**上限**（毫秒；缺省 300。不是固定等待时长）
   * @returns 矩阵报告（`ok:false` 时 `problems` 逐条说明）
   */
  verifyMatrix: (holdMs?: number) => Promise<PoseMatrixReport>;
}

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
  /**
   * 姿态通道（T04）：指定姿态 + 朝向 + 播放/停止 + 6 组合一条命令校验。
   *
   * <p>真机验收只需要一条命令：`await petDebug.pose.verifyMatrix()`。</p>
   */
  pose: PetPoseDebugHandle;
}
