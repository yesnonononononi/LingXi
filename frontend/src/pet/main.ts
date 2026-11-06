/**
 * 桌宠窗口渲染入口（方案A：静态立牌 + 表现层指令调度，不接 Live2D）。
 *
 * <p>不引 Vue：窗口常驻但内容只有一张立绘，装框架只会拖慢首帧、白占内存。</p>
 *
 * <p><b>资源只走 `lxa://`：</b>页面是 `loadFile`/Vite 打开的，`file://` 下 `fetch` 会被 Chromium
 * 拒绝；`lxa://` 协议（`electron/lx-protocol.cjs`）把 `public/live2d` 与 `dist/live2d` 映射成
 * 可 fetch 的 URL，开发态与打包态同一路径。渲染层**不拼绝对路径**。</p>
 *
 * <p><b>本入口只做"接线"，不含业务规则：</b>尺寸在 `layout.ts`、"该不该切/该不该打断"在
 * `presentation/`、"鼠标是否在宠物身上"在 `hit/`。换实现时改那几个模块，这里不动。</p>
 */
import './pet.css';
import { PET_GEOMETRY, geometryCssVariables, toNormalized } from './layout';
import { HitPipeline } from './hit/hit-pipeline';
import { RectHitTester } from './hit/rect-hit-tester';
import { applyHitView } from './hit/hit-view';
import { classifyProfile, type HitProfile } from './behavior/hit-profile';
import { DEFAULT_TIMER_PORT, PresentationBus, type DispatchOutcome } from './presentation/bus';
import { BlinkDriver } from './presentation/blink-driver';
import { CommandRouter } from './presentation/command-router';
import { DEFAULT_CROSSFADE_EASING, DEFAULT_CROSSFADE_MS } from './presentation/crossfade';
import type { ExpressionUrlMap } from './presentation/sprite-presentation';
import { EXPRESSION_IDS, type ExpressionId, type MotionId, type PresentationOp } from './presentation/types';
import { emptyEntryReport, summarizeOutcomes, type EntryDispatchReport } from './presentation/entry-report';
import {
  PetBehaviorStateMachine,
  postureOf,
} from './behavior/state-machine';
import type { PetDebugHandle, PoseDebugSnapshot } from './debug/types';
// 只引类型（`import type` 在产物里被完全擦除）：序列运行时本体只在 DEV 分支动态 import，
// 生产构建不会因此产出 `sequences/*` 的 chunk。
import type { SequenceDebugHandle } from './sequences/types';
import { DRAG_THRESHOLD_PX, PressDragGesture, type GestureIntent } from './gesture/press-drag';
import { expressionFrameUrl, expressionFrameUrls } from './assets/manifest';
import { faceTileUrls as faceTileUrlMap, isFaceDegraded } from './assets/face-tiles';
import { loadArt } from './assets/loader';
import { MOTION_CATALOG } from './layers/motion-catalog';
import { PET_LAYERS, applyLayersQueryOverride, pickLayerDensity, requestedLayerIds } from './layers/manifest';
import { resolveCompositePlan } from './layers/plan';
import type { CompositePlan } from './layers/types';
import type { DocumentLike, ElementLike, LayerView } from './presentation/layered-presentation';
import { selectPresentationWithPlan, type SelectorDeps } from './presentation/select-presentation';
import type { PetPresentation } from './presentation/types';
import { PET_POSES, densityFor } from './poses/manifest';
import { PoseController, type PoseBlinkLike } from './poses/controller';
import { poseBoxOf } from './poses/placement';
import type { Facing, PostureId } from './poses/types';
import { PowerPolicy } from './power-policy';
import { isCalibrationEnabled, mountCalibration } from './visual/calibrate';
import { mountHalo } from './visual/halo';
import { applyMicroMotion, applyMotionDuration, isDebugEnabled, prefersReducedMotion } from './visual/micro-motion';
import { HintBar } from './visual/hint-bar';
import { MOTION_REST_ATTRIBUTE, MotionPacer } from './visual/motion-pacer';

/** 调试 UI 是否开启（`?debug=1` 或开发态；发布态必须隐藏——用户明确要求别再露调试标记）。 */
const DEBUG_ENABLED = isDebugEnabled(window.location.search, import.meta.env.DEV);
/** 标定页是否开启（`?calibrate=1`，P1 开发工具）。 */
const CALIBRATE_ENABLED = isCalibrationEnabled(window.location.search);

/**
 * 系统是否要求减少动态效果。
 *
 * <p>CSS 那边已经用 `@media` 停掉了动画；这里再判一次是因为**定时器停不掉**：
 * 眨眼与"偶发停顿"节奏器都是 `setTimeout` 驱动的，用户开了"减少动态"之后
 * 它们仍会继续跑，既白吃 CPU 又继续打断表情。</p>
 */
const REDUCED_MOTION = prefersReducedMotion(
  typeof window.matchMedia === 'function' ? (query: string) => window.matchMedia(query) : null,
);

/**
 * 运行时密度：按 `devicePixelRatio` 挑一档（不用 srcset，因为我们是手动 `<img>.src`）。
 *
 * <p>@2x 是 320×480，覆盖 DPR2 下的 156×234 立绘箱（需 312×468）；@1x 是 160×240，DPR1 够用。
 * 两档来自美术 `runtime/`，工程侧不重编码。</p>
 */
const DENSITY: '1x' | '2x' = (typeof window !== 'undefined' && window.devicePixelRatio >= 2 ? '2x' : '1x');

/**
 * 本次运行的层清单（已被 `?layers=1` / `?layers=0` 覆写，排障与回归手测用）。
 *
 * <p>默认值来自 `frontend/pet-layers.json` 的 `enabled`。M1 起它是 `true`（P1 十层齐了，
 * 含第 10 层 `face`），于是 {@link resolveCompositePlan} 在资产齐备时选 `layered`：
 * 脸层换贴片、身体层微动。任一必需层缺文件/解码失败都会整条链回落 `composite`（压平帧），
 * 表情仍然可见——那是有意降级，不是缺陷。</p>
 */
const LAYER_MANIFEST = applyLayersQueryOverride(PET_LAYERS, window.location.search);

/** 分层件密度（与压平帧同一规则：DPR≥2 取 `@2x`，否则 `@1x`）。 */
const LAYER_DENSITY = pickLayerDensity(
  typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1,
  LAYER_MANIFEST,
);

/** 默认帧（neutral 完整帧）。 */
const ART_URL = expressionFrameUrl('neutral', DENSITY);
/** 降级档（首选档解码失败/超时时用它，宁可糊一点也别在桌面上留一块空白）。 */
const ART_URL_FALLBACK = expressionFrameUrl('neutral', DENSITY === '2x' ? '1x' : '2x');

/**
 * 表情完整帧 URL 表（美术 `composites/*`，与立绘同画布同位置）。
 *
 * <p>换表情＝换整张帧图，不做"整头叠在完整立绘上"的合成——美术 `composition` 契约明确禁止
 * （立绘头顶有羽化半透明边缘，叠上去会出现双层头皮硬边）。</p>
 */
const EXPRESSION_URLS: ExpressionUrlMap = expressionFrameUrls(DENSITY);

/**
 * 姿态帧的密度档（≥1.5 → `@2x`）。
 *
 * <p>与既有 `LAYER_DENSITY` 同一口径（`densityFor`），但**只决定选哪一档文件**：
 * 姿态盒的 `left/top/width/height` 是 CSS px（DIP），DPR 从 1.0 改到 2.0 必须逐位不变
 * （设计 §A1.7.1 第 ④ 条）。
 */
const POSE_DENSITY = densityFor(
  typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1,
);

/**
 * 把 `BlinkDriver` 适配成姿态层能用的最小接口。
 *
 * <p><b>为什么不在 controller 里直接拿 `BlinkDriver`：</b>姿态层只需要
 * 停/启/在跑吗三件事，拿整个驱动等于把阈值、随机源、睡眠判定都暴露给它。
 * 另外能不能启动有两条既有否决权——减少动态（不该自启）与功耗 `off` 档
 * （主进程明确要求停掉一切持续定时器）——这两个判断只属于这里，不属于姿态层。</p>
 *
 * @returns 眨眼端口
 */
function poseBlinkPort(): PoseBlinkLike {
  return {
    get isRunning(): boolean {
      return blinkDriver?.isRunning === true;
    },
    stop: () => {
      blinkDriver?.stop();
    },
    start: () => {
      if (REDUCED_MOTION) return;
      if ((powerPolicy?.power ?? 'idle') === 'off') return;
      blinkDriver?.start();
    },
  };
}

/** 主进程推来的指令。类型与 `pet-window.cjs` 的 `pet:command` 一一对应。 */
type PetCommand =
  | { type: 'ready'; clickThrough?: boolean; visible?: boolean; size?: { width: number; height: number } }
  | { type: 'hit-state'; hit?: boolean }
  | { type: 'visible'; visible?: boolean }
  | { type: 'ping'; at?: number }
  | { type: 'play'; motion?: string; priority?: number; durationMs?: number; reason?: string }
  | { type: 'expression'; expression?: string; priority?: number; durationMs?: number; reason?: string };

/** 拖拽上报的坐标（屏幕坐标 == DIP，与主进程 setPosition 同一坐标空间）。 */
interface PetPoint {
  cursorX: number;
  cursorY: number;
}

/** 主进程 IPC 的统一回执。 */
interface PetIpcResult {
  ok: boolean;
  error?: string;
}

/** preload 暴露的桥（见 `electron/pet-preload.cjs`）。 */
interface PetBridge {
  startDrag: (payload?: PetPoint) => Promise<PetIpcResult>;
  moveDrag: (payload: PetPoint) => void;
  endDrag: () => Promise<PetIpcResult>;
  /**
   * 悬停提示：把"有鼠标在动"告诉主进程（**只叫醒，不判定**）。
   *
   * <p>主进程收到后自己读系统光标并同步 apply；载荷坐标不参与判定。
   * 详见 `electron/pet-preload.cjs` 的同名方法。</p>
   */
  hoverHint: (payload: { x: number; y: number }) => void;
  close: () => Promise<PetIpcResult>;
  /**
   * 弹出原生右键菜单（显隐 / 关闭 / 退出）——M6-b 起这是**关闭与显隐的唯一入口**。
   *
   * <p>单向事件：菜单项由主进程点击执行，渲染层不需要回执。</p>
   */
  openContextMenu: () => void;
  onCommand: (callback: (command: PetCommand) => void) => () => void;
}

/*
 * 调试句柄的契约在 `debug/types.ts`（纯类型模块，构建期擦除）。
 * 这里只保留 `Window` 上的可选声明：句柄本体由 `debug/dev-backdoor.ts` 在
 * `import.meta.env.DEV` 分支里构造并挂载，生产构建连模块都不会产出。
 */

declare global {
  interface Window {
    petAPI?: PetBridge;
    petDebug?: PetDebugHandle;
  }
}

/**
 * 手势判定（点击 vs 拖拽的**唯一**语义来源）。
 *
 * <p>M6-b 之前没有这一层：`pointerdown` 同时下发 tap 又立刻开始拖拽，
 * 于是 tap 被优先级 2 的 drag 打断（D-B1），松手时又被 idle 清掉；
 * 而"点一下"的 1~2px 抖动又会真的挪窗口（D-B4）。现在这里只产出意图，
 * `wireEvents` 只做执行。</p>
 */
const gesture: PressDragGesture = new PressDragGesture();
/** 最近一次指针的屏幕坐标（拖拽 `drag-move` 用；与判定用的 client 坐标解耦）。 */
let lastScreenPoint: PetPoint | null = null;
/**
 * **按下那一刻**的屏幕坐标（`drag-start` 锚点）。
 *
 * <p>不能用 {@link lastScreenPoint}：它在 `pointermove` 里已经被更新成**首次越阈的移动点**，
 * 拿它当锚点会让窗口相对光标有一个恒定偏移（大小 = 首次越阈位移，真机 4~6px，
 * 拖动全程都偏）。锚点必须是"手指按下去的位置"，不是"发现自己在拖时的位置"。</p>
 */
let pressScreenPoint: PetPoint | null = null;
/**
 * 拖拽是否已真正开始（`drag-start` IPC 已发出）。
 *
 * <p>不复用 {@link gesture} 的阶段：手势层在产出 `drag-end` 的那一刻就已经回到 `idle`，
 * 用它做守卫会让收尾流程永远不执行。这里是"IPC 侧"的状态，与手势层各管一边。</p>
 */
let dragActive = false;

/**
 * **按下那一刻**的命中分区（头部 / 身体）。
 *
 * <p>M1 的"摸头"语义靠它：头部连点 2 次 / 按住 ≥600ms 才是抚摸，身体单击只是 happy。
 * 分区在 `pointerdown` 里就算好并缓存——`pointerup` 产出的 `tap` 意图里没有坐标
 * （手势层只回 `pointerId`），到这里再算就只能拿错点。</p>
 */
let pressProfile: HitProfile = 'body';

/** **按下那一刻**的时间戳（毫秒）：`holdMs = 松开时刻 - 按下时刻`，判定长按抚摸用。 */
let pressStartedAt = 0;

/** 命中实现（本批矩形；换 alpha 掩码只改这一处构造）。 */
let hitTester: RectHitTester | null = null;
/** 命中管线：每帧最多判一次 + 值变化才上报 + 主进程回执优先。 */
let hitPipeline: HitPipeline | null = null;

/** 表现层：指令 → 界面写入（`composite` 时是立牌实现，分层时是合成器实现）。 */
let presentation: PetPresentation | null = null;

/** 本次合成计划（`composite` / `partial` / `layered`；调试面板与排障用）。 */
let compositePlan: CompositePlan | null = null;

/** 分层模式的层视图（`composite` 时为空 Map）。 */
let layerViews: ReadonlyMap<string, LayerView> = new Map<string, LayerView>();
/** 调度总线：打断判定 + 层 TTL。 */
let bus: PresentationBus | null = null;
/** 指令路由：`pet:command` → op。 */
let router: CommandRouter | null = null;
/** 眨眼调度器（发布态也开，它是"活"感的主要来源）。 */
let blinkDriver: BlinkDriver | null = null;

/** 微动态节奏器（偶发长停顿）。 */
let motionPacer: MotionPacer | null = null;

/** 行为状态机（纯逻辑；驱动表现层指令）。 */
let behavior: PetBehaviorStateMachine | null = null;

/** 行为状态机的推进定时器句柄。 */
let behaviorTimer: number | null = null;
/** 功耗策略：可见性/隐藏/拖拽 → 四档。 */
let powerPolicy: PowerPolicy | null = null;

/** `#pet-root`（CSS 变量与 `data-*` 的写入目标）。 */
let rootElement: HTMLElement | null = null;
/** 双缓冲立绘帧（交替显示，切表情不白闪）。 */
let artFrames: [HTMLImageElement, HTMLImageElement] | null = null;

/** 拖拽时同样按帧节流位置上报。 */
let moveFrame = 0;
let pendingMovePoint: PetPoint | null = null;

/**
 * 悬停提示的合并帧句柄（`0` = 当前帧没有待合并的尾巴）。
 *
 * <p>提示走"前沿必发 + 帧末补一条"：第一次 `mousemove` 立刻发（首击能不能中就靠它），
 * 同一帧内后续移动只记最后一点，帧末再补一次。这样 4000Hz 的游戏鼠标也不会把 IPC 打满。</p>
 */
let hoverHintFrame = 0;
/** 本帧内最后一次移动点（前沿已经发过，帧末补一条收尾）。 */
let hoverHintTail: { x: number; y: number } | null = null;

/** 关键 DOM 引用（构建时赋值，之后只读）。 */
let artElement: HTMLDivElement | null = null;
/**
 * 动作宿主（`.pet-action`）：包住两张压平帧与层栈，**动作动画挂在它身上**。
 *
 * <p>为什么要有这一层：压平帧在 layered 模式下被 `opacity: 0` 让位，
 * 动画挂它等于挂在一个看不见的元素上（M6-b 第三轮）。宿主不参与命中判定，
 * 也不含接地光晕（影子不该跟着跳）。</p>
 */
let actionElement: HTMLDivElement | null = null;
let badgeElement: HTMLSpanElement | null = null;
/** 提示行控制器（自动淡出；O2）。 */
let hintBar: HintBar | null = null;

/** 姿态控制器（M2）：`.pet-pose` 层与 `data-posture` 的唯一主人。 */
let poseController: PoseController | null = null;

/**
 * 当前朝向（T04）。只可能是 `-1`（左）/ `1`（右）。
 *
 * <p><b>生产态没有朝向来源</b>：漫游（D8）未做，"角色正在往哪走"这件事今天不存在，
 * 所以它恒为 `-1`，姿态通道与切片 1 **逐字节相同**。把朝向变成可变状态只是把入口留出来
 * （`applyPoseFacing`），任何"根据光标/窗口位置猜朝向"的写法都属于 D8，不在本轮。</p>
 */
let petFacing: Facing = -1;

/**
 * 开发态强制姿态（`null` = 由行为状态派生）。
 *
 * <p>只有 `import.meta.env.DEV` 下的 `debug/dev-backdoor.ts` 会写它（生产构建里那段动态
 * `import()` 被摇掉 ⇒ 这个变量恒为 `null` ⇒ `syncPosture` 的两条分支与今天完全一致）。
 * 它的唯一用途是让真机验收能一条命令验完 `walk`/`run`/`jump` × 左右 6 个组合：
 * 否则行为状态机每 250ms 一拍会把手工指定的姿态抢回去。</p>
 */
let poseOverride: PostureId | null = null;

/**
 * 提示行文案（O2：压成一行小字、**去掉"表情：xx"实时值**、不再提示双击）。
 *
 * <p>关闭入口已经收敛到右键原生菜单（O3/D-B2），所以这里也不该再教用户"双击隐藏"——
 * 教一个不存在的手势比不教更糟。</p>
 */
const HINT_TEXT = '拖动移动 · 点击互动 · 右键菜单';

/** 取桥；拿不到时返回 null（纯浏览器里打开 pet.html 也能看见画面，便于排查）。 */
function petBridge(): PetBridge | null {
  return window.petAPI ?? null;
}

/**
 * 把命中状态应用到界面。
 *
 * <p><b>命中的唯一收口。</b>值只可能来自主进程（`pet:command{type:'hit-state'}` 或
 * `ready.clickThrough`）：渲染层已经没有上报命中的通道，也没有本地判定驱动 UI —— 这是本次
 * 重构的核心（回声耦合的物理消灭）。真正的 DOM 写入在 `hit-view.ts` 的纯函数里。</p>
 *
 * <p>注意这里**没有**第二份模块级 `hit` 变量：状态存在 DOM 上（`is-hit` /
 * `dataset.hitSource`），`hit-view.ts` 是唯一写入口。曾经那份本地 `hit` 只被已删除的
 * 上报函数读，回声通道删掉后它就成了死状态，留着只会诱使下一个人把它当成判定源。</p>
 *
 * @param next 是否可交互
 */
function applyHitState(next: boolean): void {
  applyHitView({ root: rootElement, art: artElement, badge: badgeElement }, next);
}

/**
 * 更新提示行（**O2：不再显示"表情：xx"实时值**）。
 *
 * <p>表情是看得见的东西，用文字复述一遍既占地方又容易和画面打架。
 * 提示行现在只讲"能做什么"，并且在 3 秒无交互后自动淡出（见 {@link HintBar}）。</p>
 *
 * @param next 可选：想临时强调的一句话（缺省用 {@link HINT_TEXT}）
 */
function showHint(next: string = HINT_TEXT): void {
  if (!hintBar) return;
  hintBar.setText(next);
  hintBar.poke();
}

/**
 * 直接投递一条表现层指令。
 *
 * @param op 指令
 * @returns 调度结果（`applied` / `queued` / `rejected`；没有总线时返回 `rejected`）
 */
export function dispatchOp(op: PresentationOp): DispatchOutcome {
  if (!bus) return 'rejected';
  // 动作动画时长与配方表同源：表现层认为 tap 是 480ms，CSS 就播 480ms
  if (op.kind === 'motion' && rootElement) {
    applyMotionDuration(rootElement, op.id as MotionId);
  }
  return bus.dispatch(op);
}

/**
 * 批量下发一组指令（行为状态机的产出走这里）。
 *
 * <p>先 `prepare` 再 `dispatch`：预解码不阻塞下发，但能让紧接着的淡入不出现空白档。</p>
 *
 * @param ops 指令列表
 * @returns 各条的调度结果
 */
function dispatchOps(ops: readonly PresentationOp[]): DispatchOutcome[] {
  const results: DispatchOutcome[] = [];
  for (const op of ops) {
    void presentation?.prepare(op);
    results.push(dispatchOp(op));
  }
  return results;
}


/**
 * 把"当前行为状态"同步到"当前姿态"（M2）。
 *
 * <p><b>姿态只有一个派生点</b>：`postureOf(state)`。本函数只做两件事——</p>
 * <ol>
 *   <li>姿态变了就 `setPosture()`；</li>
 *   <li>**拖拽期间不重算**（§A1.8.2 最高优先级那一行）：拖着一只坐着的猫是合理的，
 *       所以 drag 态只 `player.pause()`，松手后由下一拍 `resume()` 接上。
 *       这条规则写在这里而不是 `postureOf` 里，是为了不引入"上一个姿态"这份第二状态。</li>
 * </ol>
 *
 * <p>每 250ms 的行为拍与每次交互后都会调用；`postureOf` 是纯函数、`setPosture` 同值早退，
 * 所以高频调用没有代价。</p>
 *
 * @param label 排障标签（只在姿态真变时进日志）
 */
function syncPosture(label: string): void {
  const controller = poseController;
  const machine = behavior;
  if (!controller || !machine) return;
  if (poseOverride !== null) {
    // dev 后门正在手动指定姿态：行为拍不许把它抢回去。
    // 生产态 `poseOverride` 恒为 null（唯一写入点在 dev-only 模块里），这一行永远不成立。
    return;
  }
  const state = machine.state;
  if (state === 'drag') {
    controller.pause();
    return;
  }
  const desired = postureOf(state, PET_POSES, petFacing);
  if (desired !== controller.posture) {
    if (DEBUG_ENABLED) console.debug(`[pet] 姿态 ${controller.posture} → ${desired}（${label}: ${state}）`);
    controller.setPosture(desired);
    return;
  }
  // 姿态没变：把拖拽期间的暂停接上（未暂停时是空操作）
  controller.resume();
}

/**
 * 改朝向：**唯一的朝向写入点**（T04）。
 *
 * <p>顺序固定：先记下朝向（`postureOf` 与 `pickClip` 都读它），再让控制器重排播放。
 * 朝向未变时控制器内部是 no-op（不重启播放，否则走路会一顿一顿）。</p>
 *
 * @param next 目标朝向（`-1` 左 / `1` 右）
 * @returns 生效后的朝向
 * @throws {TypeError} 非法朝向（与 `PoseController` 同口径）
 */
function applyPoseFacing(next: Facing): Facing {
  if (next !== -1 && next !== 1) {
    throw new TypeError(`[pet] 朝向只能是 -1 或 1，实际为 ${JSON.stringify(next)}`);
  }
  petFacing = next;
  poseController?.setFacing(next);
  return petFacing;
}

/**
 * 读当前姿态快照（dev 后门断言"真的在播这个姿态这个朝向"用）。
 *
 * @returns 快照（控制器未就绪时给出站姿空快照，不抛错——排障时抛错只会掩盖现场）
 */
function readPoseSnapshot(): PoseDebugSnapshot {
  const controller = poseController;
  if (!controller) {
    return {
      posture: 'stand',
      facing: petFacing,
      clipId: null,
      clipFacing: null,
      frameId: null,
      playing: false,
      override: poseOverride,
    };
  }
  return {
    posture: controller.posture,
    facing: controller.facing,
    clipId: controller.clipId,
    clipFacing: controller.clipFacing,
    frameId: controller.currentFrameId,
    playing: controller.isPlaying,
    override: poseOverride,
  };
}

/**
 * 强制指定姿态 + 朝向（**dev 后门专用**）。
 *
 * <p>姿态的可用性判定仍由 `setPosture()` 内部的 `isPlayable` + `pickClip` 负责：
 * 不可播或缺该朝向的片段就降级站姿，返回的快照会如实反映"现在是站姿"，
 * 不许假装切成功了——这正是之前那套 `debug-force-hit` 后门坑人的方式。</p>
 *
 * @param posture 目标姿态（`stand` = 回站姿并停在站姿）
 * @param facing 目标朝向
 * @returns 切换后的快照
 * @throws {Error} 姿态控制器未就绪
 */
function forcePose(posture: PostureId, facing: Facing): PoseDebugSnapshot {
  const controller = poseController;
  if (!controller) throw new Error('[pet] 姿态控制器未就绪：先等 boot 完成');
  applyPoseFacing(facing);
  poseOverride = posture;
  controller.setPosture(posture);
  return readPoseSnapshot();
}

/**
 * 交还控制权给行为状态机（**dev 后门专用**）。
 *
 * <p>必须先清 `poseOverride` 再 `syncPosture`：否则早退分支会把这次同步也吃回去。</p>
 */
function releasePose(): void {
  poseOverride = null;
  poseController?.setPosture('stand');
  syncPosture('debug:release');
}

/**
 * 下发一批**入态指令**，并保证"行为层说切了"与"画面切了"是同一件事。
 *
 * <p><b>为什么不直接用 {@link dispatchOps}：</b>它把 `'rejected'` 丢在地上。QA 抓到的正是这条：
 * `forceState('angry')` 之后 1.2s 内 `forceState('sleeping')`，睡眠的两条优先级 0 指令被总线
 * 按"低优先级锁"拒掉，而状态机早就把 `state` 改成了 `sleeping`——两边永久不一致、
 * 而且没有任何人发现。</p>
 *
 * <p><b>现在的处置：</b></p>
 * <ol>
 *   <li>下发前拍一张行为层快照；</li>
 *   <li>逐条下发并统计（`applied` / `queued` / `rejected`）；</li>
 *   <li>只要有一条没<b>立即</b>落地，就把行为层整体回滚到下发前，
 *       再用 {@link PetBehaviorStateMachine.repairOps} 把画面强制定向到回滚后的状态——
 *       两层重新讲同一件事；</li>
 *   <li>把结论（含失败原因）返回给调用方，永远不静默。</li>
 * </ol>
 *
 * @param ops 入态指令（一般由行为状态机产出，每条都带 `force: true`）
 * @param label 排障标签（进日志）
 * @returns 落地报告
 */
export function dispatchEntryOps(ops: readonly PresentationOp[], label: string): EntryDispatchReport {
  if (ops.length === 0) return emptyEntryReport(`${label}: 无指令`);
  const snapshot = behavior ? behavior.snapshot() : null;
  const outcomes = dispatchOps(ops);
  const summary = summarizeOutcomes(outcomes);
  if (summary.ok) {
    return { ...summary, outcomes, rolledBack: false, message: `${label}: ${summary.applied} 条已生效` };
  }

  // —— 没落地：先回滚行为层，再把画面强制定向到回滚后的状态 ——
  const rolledBack = behavior ? behavior.restore(snapshot, `入态指令未落地(${label})`) : false;
  console.warn(
    `[pet] 入态指令未落地: label=${label} applied=${summary.applied} queued=${summary.queued} ` +
      `rejected=${summary.rejected} 回滚=${rolledBack}`,
  );
  if (behavior) {
    // 修复指令同样是 force 入态指令：正常情况下一定能落地；万一还是不行，只记日志不再递归
    const repair = summarizeOutcomes(dispatchOps(behavior.repairOps()));
    if (!repair.ok) {
      console.error(`[pet] 失败修复也未能落地: applied=${repair.applied} rejected=${repair.rejected}`);
    }
  }
  return {
    ok: false,
    outcomes,
    applied: summary.applied,
    queued: summary.queued,
    rejected: summary.rejected,
    rolledBack,
    message:
      `${label}: ${summary.rejected} 条被拒/${summary.queued} 条排队` +
      `${rolledBack ? '，行为已回滚并重新对齐画面' : ''}`,
  };
}

/**
 * 切换表情（调试/验收与外部调度共用的公开接口）。
 *
 * <p>走基底层且不带 TTL：调用方要的就是"停在这一档"，自动回退是 transient 层的事。</p>
 *
 * @param name 表情 id
 * @returns 是否切换成功（未知 id 一律返回 false，避免静默假成功）
 */
export function setExpression(name: string): boolean {
  const candidate = EXPRESSION_IDS.find((item) => item === name);
  if (!candidate) {
    console.warn(`[pet] 未知表情，已忽略: name=${name}`);
    return false;
  }
  dispatchOp({
    kind: 'expression',
    id: candidate,
    layer: 'base',
    // **优先级必须是 0（M6-b 第四轮）**：base 的 expression 槽是"回落目标"，
    // 不是"抢占指令"。给它优先级 1 会永久压死优先级 0 的眨眼
    // （规则表：低优先级 + 活动记录永不到期 → reject），
    // 于是调试徽标点几下表情切换之后，桌宠就再也不眨眼了——和本轮修的缺陷同一类。
    priority: 0,
    fadeMs: 0,
    reason: 'api:setExpression',
  });
  return true;
}

/** 读当前表情（调试/验收用）。 */
export function getExpression(): ExpressionId {
  return presentation?.state.expression ?? 'neutral';
}

/**
 * 按帧上报一次拖拽位置。
 *
 * @param point 光标屏幕坐标
 */
function scheduleMoveReport(point: PetPoint): void {
  pendingMovePoint = point;
  if (moveFrame) return;
  moveFrame = requestAnimationFrame(() => {
    moveFrame = 0;
    const next = pendingMovePoint;
    pendingMovePoint = null;
    if (!next) return;
    petBridge()?.moveDrag(next);
  });
}

/**
 * 执行手势层产出的意图（**本函数只做执行，不做判定**）。
 *
 * <p>判定全部在 {@link PressDragGesture} 里：这里看到 `tap` 就下发行为、看到
 * `drag-start` 才调 IPC。分工明确之后，"点一下"与"拖一下"不可能再互相抢语义。</p>
 *
 * @param intents 意图列表（可能为空）
 */
function runGesture(intents: readonly GestureIntent[]): void {
  for (const intent of intents) {
    if (intent.type === 'tap') {
      // 分区 + 按住时长一起交给行为层：它才知道这次是"摸头"还是"点一下"
      const ctx = { profile: pressProfile, holdMs: Math.max(0, Date.now() - pressStartedAt) };
      dispatchEntryOps(behavior ? behavior.handle('tap', ctx) : fallbackTapOps(), 'gesture:tap');
      // 点击一律退出姿态（§A1.8.2：动作与脸层只在 stand 可见），所以这里紧跟一次姿态同步
      syncPosture('gesture:tap');
      hintBar?.poke();
      continue;
    }
    if (intent.type === 'drag-start') {
      beginDrag(intent.pointerId);
      continue;
    }
    if (intent.type === 'drag-move') {
      // 位置用屏幕坐标（窗口自己在动，client 坐标不适合算位移）
      if (lastScreenPoint) scheduleMoveReport(lastScreenPoint);
      continue;
    }
    endDrag(intent.pointerId);
  }
}

/**
 * 没有行为层时的兜底点击表现（纯浏览器里打开 pet.html 排障时用）。
 *
 * @returns 指令列表
 */
function fallbackTapOps(): PresentationOp[] {
  return (
    router?.route({ type: 'play', motion: 'tap', reason: 'pointer:tap' }) ?? [
      { kind: 'motion', id: 'tap', layer: 'base', priority: 1, durationMs: 480, fadeMs: 0, reason: 'pointer:tap' },
      { kind: 'expression', id: 'happy', layer: 'transient', priority: 1, durationMs: 480, fadeMs: 0, reason: 'pointer:tap:expression' },
    ]
  );
}

/**
 * 开始拖拽（**只在手势层判定越过阈值后调用**）。
 *
 * <p>阈值过滤放在调用方之前，是"点一下窗口不抖"的关键：这里的 `startDrag` 一旦发出，
 * 主进程就会按光标位移挪窗口，1~2px 的抖动也就变成了真的位移。</p>
 *
 * @param pointerId 指针 id（拿指针捕获用）
 */
function beginDrag(pointerId: number): void {
  const bridge = petBridge();
  if (dragActive) return;
  dragActive = true;
  powerPolicy?.update({ dragging: true });
  artElement?.classList.add('is-dragging');
  // 行为层同步进入 drag：拖拽期间不该触发睡眠（也不该被眨眼打断）
  if (behavior) dispatchEntryOps(behavior.handle('drag-start'), 'gesture:drag-start');
  // 拖拽期间姿态保持、只暂停播放（拖着坐着的猫是合理的）；窗口位置仍由主进程独占
  syncPosture('gesture:drag-start');
  // 指针捕获：光标移动快于窗口时事件也不会丢，否则会出现「甩一下就掉」。
  // 捕获失败（指针 id 已失效等）不能中断拖拽本身，故吞掉异常。
  try {
    artElement?.setPointerCapture(pointerId);
  } catch {
    // 忽略：拿不到捕获时仍能靠 window 上的 pointermove 拖动
  }
  // 锚点一律用**按下那一刻**的屏幕坐标（不是首次越阈的移动点，否则全程恒定偏移）；
  // 坐标缺失时传 undefined，主进程会退回系统光标位置
  void bridge?.startDrag(pressScreenPoint ?? undefined);
}

/**
 * 结束拖拽（四条收尾路径都汇到这里：pointerup / pointercancel / lostpointercapture /
 * move 时 `buttons === 0`）。
 *
 * @param pointerId 需要释放捕获的指针 id
 */
function endDrag(pointerId: number): void {
  if (!dragActive) return;
  dragActive = false;
  powerPolicy?.update({ dragging: false });
  artElement?.classList.remove('is-dragging');
  // 行为层回到 idle（先落桥接 idle，等 drag 的高优先级记录过期再落到常驻 idle）
  if (behavior) dispatchEntryOps(behavior.handle('drag-end'), 'gesture:drag-end');
  syncPosture('gesture:drag-end');
  try {
    if (artElement?.hasPointerCapture(pointerId)) {
      artElement.releasePointerCapture(pointerId);
    }
  } catch {
    // 同上：捕获可能已随指针释放而消失，释放失败不影响结束流程
  }
  // 先冲掉未发出的最后一帧位置，再告诉主进程结束（主进程会在结束时落盘）
  const last = pendingMovePoint;
  pendingMovePoint = null;
  if (last) petBridge()?.moveDrag(last);
  void petBridge()?.endDrag();
}

/**
 * 立绘加载失败时的兜底：显眼报错，而不是留一个空窗口让人以为程序挂了。
 *
 * <p><b>只"盖上"而不"拆掉"</b>：早期实现是 `replaceChildren(box)`，那会把双缓冲的两张
 * 帧元素一起删掉——之后哪怕资源恢复，表情切换也没有落点（表现为"能点但永远没表情"）。
 * 现在把错误框追加进去并压在帧之上，帧元素原地保留。</p>
 *
 * @param detail 失败原因
 */
function renderArtError(detail: string): void {
  if (!artElement) return;
  const box = document.createElement('div');
  box.className = 'pet-art-error';
  box.textContent = `立绘加载失败：${detail}`;
  artElement.append(box);
  console.warn(`[pet] 立绘加载失败: url=${ART_URL}, density=${DENSITY}, detail=${detail}`);
}

/**
 * 异步加载默认帧并上屏（双缓冲的第 0 张）。
 *
 * <p>先 `decode()` 再 `hidden=false`：`load` 只代表字节到齐，此时上屏会出现"先空白再刷新"。
 * 失败/超时换另一档密度，再失败才显示错误提示。</p>
 */
async function startArtLoad(): Promise<void> {
  const frames = artFrames;
  if (!frames) return;
  const image = frames[0];
  const result = await loadArt(image, {
    primaryUrl: ART_URL,
    fallbackUrl: ART_URL_FALLBACK,
    markLabel: 'pet-art',
  });
  if (result.ok) {
    image.hidden = false;
    if (DEBUG_ENABLED) {
      console.debug(
        `[pet] 默认帧上屏: url=${result.url} 密度=${DENSITY} 耗时=${result.elapsedMs.toFixed(1)}ms` +
          `${result.usedFallback ? '（已降级到另一档密度）' : ''}`,
      );
    }
    return;
  }
  renderArtError(result.error ?? (result.timedOut ? 'decode 超时' : '未知错误'));
}

/** 构建画面（立绘 + 表情层 + 关闭按钮 + 调试标记）。 */
function buildDom(): void {
  const root = document.getElementById('pet-root');
  if (!root) return;
  rootElement = root;
  // 调试可见性由 data-debug 决定：CSS 默认把 badge/hint 藏起来，这里再关一次（双保险）
  root.dataset.debug = DEBUG_ENABLED ? '1' : '0';

  const stage = document.createElement('div');
  stage.className = 'pet-stage';

  const motion = document.createElement('div');
  motion.className = 'pet-motion';
  const sway = document.createElement('div');
  sway.className = 'pet-sway';

  artElement = document.createElement('div');
  artElement.className = 'pet-art';
  artElement.setAttribute('role', 'img');
  artElement.setAttribute('aria-label', 'LX 桌宠');

  // 落地光晕：贴在立绘底层，管"站在桌面上"的接地感（drop-shadow 管轮廓立体感，两者分工）
  mountHalo(document, artElement, PET_GEOMETRY);

  // 动作宿主：两张压平帧与层栈都装进这一层，动作动画（tap/angry/wake/drag…）挂在它身上。
  // 放在 `.pet-art` 里、光晕之外：影子不该跟着跳；命中判定仍以外层 `.pet-art` 为锚。
  actionElement = document.createElement('div');
  actionElement.className = 'pet-action';

  const front = document.createElement('img');
  front.className = 'pet-art-frame';
  front.alt = '';
  front.decoding = 'async';
  front.draggable = false;
  // 解码完成前保持隐藏：先挂上去会出现"上半身先到、下半身后到"的闪动
  front.hidden = true;

  // 第二张帧：切表情时载入另一张并淡入，避免换 src 造成的一帧白闪
  const back = document.createElement('img');
  back.className = 'pet-art-frame';
  back.alt = '';
  back.decoding = 'async';
  back.draggable = false;
  back.hidden = true;
  artFrames = [front, back];

  // M6-b（O3/D-B2）：**不再有常驻的 × 关闭按钮**。关闭与显隐统一收敛到右键原生菜单
  // （`electron/pet-window.cjs` 的 `pet:context-menu`），窗口内因此没有任何关闭元素。
  // 理由写在决策单里：关闭入口必须唯一，两套手势（双击 + 按钮）迟早再打架。
  actionElement.append(front, back);
  artElement.append(actionElement);

  // 调试标记、调试面板与提示行**只在调试态创建**：发布态零调试元素（用户明确要求"别再露调试标记"）
  if (DEBUG_ENABLED) {
    const badge = document.createElement('span');
    badge.className = 'pet-badge';
    badge.textContent = '穿透中';
    badge.title = '点击循环切表情（手动验收用）';
    badge.addEventListener('click', (event) => {
      // 点调试标记循环切表情：没有行为状态机，这是唯一的手动验收入口
      event.stopPropagation();
      const index = EXPRESSION_IDS.findIndex((item) => item === getExpression());
      const next = EXPRESSION_IDS[(index + 1) % EXPRESSION_IDS.length];
      setExpression(next);
    });
    badgeElement = badge;
    artElement.append(badge);
  }

  sway.appendChild(artElement);
  motion.appendChild(sway);
  stage.appendChild(motion);
  root.replaceChildren(stage);

  // 提示行挂在 `#pet-root` 上而不是立绘箱里：它要被摆到窗口底部那条 18px 的空带上，
  // 那里永远压不到立绘的脚（立绘箱下沿 330 / 窗口高 348）。挂在立绘箱里就做不到这一点。
  if (DEBUG_ENABLED) {
    const hint = document.createElement('span');
    hint.className = 'pet-hint';
    hint.textContent = HINT_TEXT;
    root.append(hint);
    hintBar = new HintBar(hint, { timer: DEFAULT_TIMER_PORT });
  }

  // 立绘解码完成后再上屏（失败/超时换档降级，最终失败才显示错误提示）
  void startArtLoad();
}

/**
 * 挂载开发态调试后门（O1）：调试句柄 + 一排直达按钮。
 *
 * <p><b>能挂上来的唯一条件是"这是开发构建"</b>（M6-b 第二轮必修项 3）：
 * 以前是 `if (DEBUG_ENABLED)`，而 `DEBUG_ENABLED = isDebugEnabled(search, import.meta.env.DEV)`
 * ——生产构建带 `?debug=1` 照样能挂上 `window.petDebug`。现在判断题换成构建期常量
 * `import.meta.env.DEV`，于是生产构建里这段条件恒假，动态 `import()` 被摇掉，
 * `debug/dev-backdoor.ts` 不产出任何 chunk，`dist/` 里搜 `petDebug` 命中 0。</p>
 */
function mountDevTools(): void {
  if (!import.meta.env.DEV) return;
  const host = artElement;
  const machine = behavior;
  if (!host || !machine) return;
  void import('./debug/dev-backdoor').then((module) => {
    const installed = module.installDevBackdoor({
      behavior: machine,
      dispatch: (op) => dispatchOp(op),
      dispatchEntry: (ops, label) => dispatchEntryOps(ops, label),
      setExpression: (name) => setExpression(name),
      getExpression: () => getExpression(),
      listExpressions: () => [...EXPRESSION_IDS],
      gesturePhase: () => gesture.phase,
      dragThresholdPx: () => DRAG_THRESHOLD_PX,
      sustainedMotion: () => behavior?.sustainedMotion ?? null,
      compositeMode: () => compositePlan?.mode ?? 'composite',
      layerIds: () => [...layerViews.keys()],
      // 姿态通道（T04）：指定姿态 + 朝向 + 播放/停止。
      // 这是**只读真状态**的后门——它调用生产路径（`setPosture` / `setFacing`），
      // 不给"跳过判定直接改 DOM"的第二条路。
      posePlay: (posture, facing) => forcePose(posture, facing),
      poseStop: () => {
        forcePose('stand', petFacing);
      },
      poseRelease: () => releasePose(),
      poseFacing: (next) => applyPoseFacing(next),
      poseSnapshot: () => readPoseSnapshot(),
      poseWait: (ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
      host,
      onPoke: () => hintBar?.poke(),
    });
    mountSequenceBackdoor(installed.handle);
  });
}

/**
 * 序列通道（T05/B1）：把 `petDebug.sequence.play('cloud_react')` / `.stop()` 挂到后门句柄上。
 *
 * <p><b>只做三件事</b>：建伙伴层元素、建导演、把动画循环接到 `director.tick(now)`。
 * 触发方式只有后门——**生产态一行都不执行**（本函数只被 `mountDevTools` 调用，而后者在
 * `import.meta.env.DEV` 恒假时整段被摇掉）。生产态行为因此与 B1 之前逐字节一致：
 * `petFacing` 恒 `-1`、没有任何自动触发的序列。</p>
 *
 * <p><b>为什么 `sequence` 这个键是"事后"挂上去的：</b>`PetDebugHandle` 的形状由
 * `debug/types.ts` 定义，而本批文件白名单不允许改它（并行的 pose 工作正在同域改动）。
 * 这里用交叉类型就地补一个可选键，键名只出现在本 DEV 分支里——生产产物搜不到
 * `sequence` 这个后门键。</p>
 *
 * @param handle `installDevBackdoor` 返回的调试句柄（与 `window.petDebug` 同一个对象）
 */
function mountSequenceBackdoor(handle: PetDebugHandle): void {
  const host = rootElement;
  if (!host) return;
  void Promise.all([import('./sequences/manifest'), import('./sequences/director')]).then(
    ([manifestModule, directorModule]) => {
      const sequences = manifestModule.PET_SEQUENCES;
      const layer = new directorModule.DomSequenceLayer({
        doc: document,
        host: host as unknown as ElementLike,
        layerId: 'companion',
        density: POSE_DENSITY,
        log: (message) => console.debug(message),
      });
      // B1 只验 dy：伙伴的舞台基准取美术 `play_cloud` 第 0 步的静止位置
      // （`companionCenterX=1080, companionFootY=1454`，gif-v1 manifest 原文），
      // 不自己编坐标。B2 起逐 step 的坐标会写进清单，这个基准就不再需要。
      const director = new directorModule.SequenceDirector({
        sequences,
        clock: { now: () => Date.now() },
        layers: { companion: layer },
        base: { centerX: 1080, footY: 1454 },
        onSceneEnd: (sceneId, onEnd) => console.debug(`[pet] 场景 ${sceneId} 结束：${onEnd}`),
        log: (message) => console.debug(message),
      });

      let frameHandle = 0;
      const loop = (): void => {
        director.tick(Date.now());
        frameHandle = director.isPlaying ? window.requestAnimationFrame(loop) : 0;
      };
      const stopLoop = (): void => {
        if (frameHandle !== 0) window.cancelAnimationFrame(frameHandle);
        frameHandle = 0;
      };
      const sequenceHandle: SequenceDebugHandle = {
        play: (sceneId) => {
          const report = director.play(sceneId);
          stopLoop();
          frameHandle = window.requestAnimationFrame(loop);
          return report;
        },
        stop: () => {
          stopLoop();
          director.stop();
        },
        snapshot: () => director.snapshot(),
        scenes: () => manifestModule.sceneIdsOf(sequences),
      };
      (handle as PetDebugHandle & { sequence?: SequenceDebugHandle }).sequence = sequenceHandle;
      window.addEventListener('pagehide', () => {
        stopLoop();
        director.stop();
      });
    },
  );
}

/**
 * 派发初始状态（base 层默认表情 + idle 动作）。
 *
 * <p>必须排在 `createPresentation()` 之后：此时总线已就绪，指令才有落点。
 * 顺带保证首帧就是"睁眼默认脸 + 呼吸中"。</p>
 */
function applyInitialState(): void {
  dispatchOp({
    kind: 'expression',
    id: 'neutral',
    layer: 'base',
    priority: 0,
    fadeMs: 0,
    reason: 'boot:base',
  });
  dispatchOp({ kind: 'motion', id: 'idle', layer: 'base', priority: 0, loop: true, reason: 'boot:idle' });
  showHint();
}

/**
 * 绑定鼠标与指针事件。
 *
 * <p><b>本函数只做两件事：把事件喂给手势层、把手势层产出的意图转给
 * {@link runGesture} 执行。</b>它不再决定"这次按下是不是点击/拖拽"——
 * 那是 D-B1/D-B4 的共同根因，判定权已经交给 `gesture/press-drag.ts`。</p>
 */
function wireEvents(): void {
  if (!artElement) return;

  // 命中的**判定**接线已从渲染层删除（M2）：
  //   ① "是否在宠物身上"只由主进程算（`electron/pet-hit-poller.cjs` 读系统光标 +
  //      `pet-hit-region.cjs` 半开区间/滞回），渲染层没有判定权；
  //   ② `mouseleave → hitPipeline.reset()` 会把"切换穿透"本身误读成"光标离开"，
  //      而切换穿透又会制造 enter/leave —— 同一个状态既因又果，就是手↔穿透闪烁的来源。
  // 这里只保留一条**触发**通道（见下方 `mousemove → hoverHint`）与 `hit-state` 消费。

  // 即时触发器（M2 修正版）：转发的 mousemove 只是**叫醒**，不是判定。
  // 前沿必发 —— 手型/可交互在 1~5ms 内出现，不会"迟到一拍"；同帧后续移动合并成帧末一条，
  // 这样 4000Hz 的游戏鼠标也不会把 IPC 打满。主进程收到后会自己读一遍系统光标，
  // 所以这里传的坐标即使过期/伪造也改不了任何状态。
  window.addEventListener(
    'mousemove',
    (event) => {
      const point = { x: Math.round(event.screenX), y: Math.round(event.screenY) };
      if (hoverHintFrame !== 0) {
        hoverHintTail = point;
        return;
      }
      petBridge()?.hoverHint(point);
      hoverHintFrame = requestAnimationFrame(() => {
        hoverHintFrame = 0;
        const tail = hoverHintTail;
        hoverHintTail = null;
        if (tail) petBridge()?.hoverHint(tail);
      });
    },
    { passive: true },
  );

  artElement.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // 二道门：DOM 事件已经落在立绘箱上，但立绘箱比可见轮廓大一圈（透明留白），
    // 再用命中实现判一次，避免"点在猫旁边的空气里也能把窗口拖走"
    if (!(hitTester?.test(event.clientX, event.clientY) ?? false)) return;
    if (event.currentTarget instanceof HTMLElement) {
      // 记录屏幕坐标：**按下点**是拖拽锚点（`pressScreenPoint`），
      // 而 `lastScreenPoint` 会随每次 pointermove 前进，只能用于 `drag-move`
      pressScreenPoint = { cursorX: Math.round(event.screenX), cursorY: Math.round(event.screenY) };
      lastScreenPoint = pressScreenPoint;
    }
    // 头部/身体分区在**按下那一刻**算好（`pointerup` 的意图里没有坐标）。
    // 归一化坐标由 `layout.ts` 的 `toNormalized` 给（与命中、锚点同一坐标空间），
    // 脸区矩形来自层清单的 `face.rect`（单一真源）。
    const uv = toNormalized(PET_GEOMETRY, event.clientX, event.clientY);
    pressProfile = classifyProfile(uv.u, uv.v, LAYER_MANIFEST);
    pressStartedAt = Date.now();
    hintBar?.poke();
    runGesture(gesture.press({ pointerId: event.pointerId, x: event.clientX, y: event.clientY }));
  });

  window.addEventListener(
    'pointermove',
    (event) => {
      lastScreenPoint = { cursorX: Math.round(event.screenX), cursorY: Math.round(event.screenY) };
      runGesture(
        gesture.move({
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          buttons: event.buttons,
        }),
      );
    },
    { passive: true },
  );
  window.addEventListener('pointerup', (event) => {
    runGesture(gesture.release(event.pointerId));
    // 一次按压结束：按下点作废（下一次按压会重新记录）。留着只会让下一次拖拽
    // 有极小概率读到过期坐标。
    pressScreenPoint = null;
  });  window.addEventListener('pointercancel', (event) => {
    runGesture(gesture.cancel(event.pointerId));
    pressScreenPoint = null;
  });
  // 指针捕获被系统/浏览器抢走时不会再有 pointerup：不清掉就会永远卡在拖拽
  artElement.addEventListener('lostpointercapture', (event) => {
    runGesture(gesture.cancel(event.pointerId));
    pressScreenPoint = null;
  });

  // 鼠标进到桌宠身上就把提示行淡回来（3 秒没动作再自己走）
  artElement.addEventListener('pointerenter', () => hintBar?.poke());

  // 右键 → 原生菜单（显隐 / 关闭 / 退出）。这是**唯一**的关闭入口，
  // 不再有双击关闭（D-B2）也不再有一常一悬的 × 按钮（O3）。
  artElement.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!(hitTester?.test(event.clientX, event.clientY) ?? false)) return;
    hintBar?.poke();
    petBridge()?.openContextMenu();
  });
}

/** 订阅主进程指令。 */
function subscribeCommands(): void {
  const bridge = petBridge();
  if (!bridge) return;
  bridge.onCommand((command) => {
    if (command.type === 'hit-state') {
      // 主进程回执是权威值：先对齐管线内部状态（不再回声），再统一走 applyHitState 收口
      hitPipeline?.reconcileFromMain(command.hit === true);
      applyHitState(command.hit === true);
      return;
    }
    if (command.type === 'ready') {
      hitPipeline?.reconcileFromMain(command.clickThrough !== true);
      applyHitState(command.clickThrough !== true);
      // 首帧就把可见性对齐：桌宠可能在"窗口已隐藏"的状态下被重新加载（托盘踢隐藏再开）
      powerPolicy?.update({ visible: command.visible !== false });
      return;
    }
    if (command.type === 'visible') {
      // 窗口隐藏 → off 档：停 CSS 动画 + 停眨眼定时器（hidden 时 CSS 不产帧，但 JS 定时器照跑）
      powerPolicy?.update({ visible: command.visible === true });
      if (DEBUG_ENABLED) console.debug(`[pet] 可见性变化: visible=${command.visible === true}`);
      return;
    }
    // play / expression 等表现类指令统一走路由 → 调度总线（未知类型由路由器记日志丢弃）
    const ops = router?.route(command) ?? [];
    for (const op of ops) {
      void presentation?.prepare(op);
      dispatchOp(op);
    }
  });
}

/**
 * 把几何真源注入 CSS 变量。
 *
 * <p>CSS 里的静态默认值只是首帧兜底，**逻辑上以 `pet-geometry.json` 为准**：
 * 启动第一件事就重写一遍，避免"改了真源忘了改 CSS"这种漂移。</p>
 */
function injectGeometryVariables(): void {
  const variables = geometryCssVariables(PET_GEOMETRY);
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(variables)) {
    style.setProperty(name, value);
  }
}

/**
 * 建表现层三件套：实现 + 调度总线 + 指令路由，并启动眨眼调度。
 *
 * <p>顺序有意义：先有实现（写 DOM 的那一层），总线才有落点；路由最后建，
 * 因为它只产出 op。</p>
 *
 * <p>这里也是"换实现"的唯一改动点：`select-presentation.ts` 按合成计划选
 * `SpritePresentation` 还是 `LayeredPresentation`，调度器、指令 id、命中、拖拽、
 * 位置持久化全部不动（设计文档 §1.5 的 seam S1 / §8.3）。</p>
 */
function createPresentation(): void {
  const root = document.getElementById('pet-root');
  if (!root || !artFrames) return;
  const frames = artFrames;

  // 选路：清单（可能被 `?layers=` 覆写）+ 密度 → 三级模式之一。
  // 总闸关闭时这里恒定得到 `composite`，下面的工厂也就恒定构造立牌实现。
  const plan = resolveCompositePlan({
    manifest: LAYER_MANIFEST,
    requested: requestedLayerIds(LAYER_MANIFEST),
    density: LAYER_DENSITY,
  });

  const deps: SelectorDeps = {
    doc: document as unknown as DocumentLike,
    root: root as unknown as ElementLike,
    // 层栈挂到动作宿主 `.pet-action` 上：它与压平帧同框（同一 2:3 画布、零标定），
    // 且动作位移时层栈与帧一起动——不会出现"帧跳了、层没跳"的错位。
    layerHost: (actionElement as unknown as ElementLike | null) ?? (artElement as unknown as ElementLike | null) ?? undefined,
    frames,
    geometry: PET_GEOMETRY,
    catalog: MOTION_CATALOG,
    expressionUrls: EXPRESSION_URLS,
    // 脸层贴片（`pet-face-tiles.json` 的生成物视图）：layered 下表情走这里，只换脸不动身体。
    // 与上面的整帧表是两套数据，别混——整帧 URL 塞进子矩形层会被 object-fit:fill 压扁。
    faceTileUrls: faceTileUrlMap(LAYER_DENSITY),
    manifest: LAYER_MANIFEST,
    // 交叉过渡：时长/缓动只有一个来源（crossfade.ts 的常量），CSS 通过变量消费
    crossfade: { durationMs: DEFAULT_CROSSFADE_MS, easing: DEFAULT_CROSSFADE_EASING },
    timer: DEFAULT_TIMER_PORT,
    initialExpression: 'neutral',
    power: () => powerPolicy?.power ?? 'idle',
    reducedMotion: () => REDUCED_MOTION,
    log: (message) => console.debug(message),
  };

  const outcome = selectPresentationWithPlan(plan, deps);
  presentation = outcome.presentation;
  compositePlan = plan;
  layerViews = outcome.views;
  if (DEBUG_ENABLED) {
    console.debug(
      `[pet] 合成模式=${plan.mode} 层数=${plan.layers.length} 理由=${plan.fallbackReason || '-'} 密度=${plan.density}`,
    );
  }

  // 眨眼抑制的判据：**只看行为状态**（M6-b 第四轮）。
  //
  // 以前这里还额外判"当前表情是不是 sleepy/half"——那是**倒推**，而且会自锁：
  // 眨眼三态的中间帧曾借用 `sleepy` 贴片，于是"半闭帧上屏"被读成"睡着了"，
  // BlinkDriver 从此不再眨眼，而不再眨眼就意味着表情永远停在 sleepy → 永远判成
  // "睡着了"，完美闭环。M1 已经把半闭帧拆成独立的 `blinkHalf`，倒推链从根上断了。
  //
  // 现在唯一的真源是 `behavior.isSleeping`（行为状态机），总线规则表里已有
  // 「睡眠中来 blink / blinkHalf / wink → 抑制」，所以"睡着别眨眼"由"行为状态 + 规则表"决定。
  //
  // 唯一保留的表情判据是 `yawn`：它不是"像睡着"，而是一个**明确的语义**——
  // "正在打哈欠"这个动作本身就是闭眼张嘴，这时候再叠一次眨眼是错的。
  // 它由行为/表现层显式下发（`yawn` 表情），不是从"脸的状态"反推行为状态。
  const sleepingNow = (): boolean => {
    if (behavior?.isSleeping === true) return true;
    return presentation?.state.expression === 'yawn';
  };

  bus = new PresentationBus(presentation, {
    log: (message) => console.debug(message),
    isSleeping: sleepingNow,
  });
  router = new CommandRouter({ log: (message) => console.debug(message) });

  // 行为状态机：时间与随机全部注入（内部不读 Date.now / Math.random）
  behavior = new PetBehaviorStateMachine(
    { now: () => Date.now(), rng: () => Math.random() },
    { log: (message) => console.debug(message) },
  );

  blinkDriver = new BlinkDriver(
    (op) => dispatchOp(op),
    // 随机源显式注入（设计文档 §9.4 纪律 9）：测试里换成固定序列即可断言分布
    () => Math.random(),
    sleepingNow,
    DEFAULT_TIMER_PORT,
    // 半闭帧是否可用：真源是生成的贴片清单（`pet-face-tiles.json` 的 degraded）。
    // 未交付时眨眼退化成两态，绝不回落 `sleepy`（§5.2 第 3 条）。
    () => !isFaceDegraded('blinkHalf'),
  );

  // 减少动态时不起任何"持续型"定时器：CSS 已经停了动画，JS 也该停手
  if (!REDUCED_MOTION) {
    blinkDriver.start();

    motionPacer = new MotionPacer(
      (resting) => {
        if (!rootElement) return;
        // 停顿只是一个 data-*：CSS 用 animation-play-state 暂停，保留相位
        rootElement.setAttribute(MOTION_REST_ATTRIBUTE, resting ? '1' : '0');
      },
      () => Math.random(),
      DEFAULT_TIMER_PORT,
    );
    motionPacer.start();
  }

  // 姿态通道（M2）：`.pet-pose` 层与 `data-posture` 的唯一主人。
  //
  // 挂到 `#pet-root` 而不是 `.pet-art`：placement 算出的是**窗口坐标**，而 `.pet-art`
  // 的原点是 (effectMargin.left, margin.top + bubble)；更要紧的是 `.pet-motion` /
  // `.pet-sway` 上的呼吸与摇摆 transform 会作用到子元素上——姿态层若挂在里面，
  // 接地基线就会随呼吸上下浮动，G-06 的 ±0.35 CSS 判据直接失效。
  if (root && artElement) {
    poseController = new PoseController({
      doc: document,
      root: root as unknown as ElementLike,
      host: root as unknown as ElementLike,
      poses: PET_POSES,
      density: POSE_DENSITY,
      ports: {
        now: () => Date.now(),
        schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
        cancel: (handle) => window.clearTimeout(handle),
        onFrame: () => {},
        onClipEnd: () => {},
      },
      // 唯一的位置来源：placement 的纯函数（切姿态不改窗口位置，C6）
      boxOf: (batch, frame) => poseBoxOf(batch, frame, PET_POSES.scale, PET_POSES.align, PET_GEOMETRY),
      blink: poseBlinkPort(),
      // T04：朝向显式传入（之前这里没有这个键 ⇒ 姿态通道被硬编码为 -1）。
      // 生产态 `petFacing` 恒为 -1（漫游未做，D8），与切片 1 逐字节相同。
      facing: petFacing,
      log: (message) => console.debug(message),
    });
  }
  syncPosture('boot');

  // 行为推进：250ms 一拍足够（最短的状态时长是 250ms 的桥接），
  // 比起每条转移各挂一个定时器，单拍轮询更好测也更好停。
  behaviorTimer = window.setInterval(() => {
    if (!behavior) return;
    // 走"入态"通道：tick 产出的都是状态进场指令（桥接 idle / 常驻 idle / 入睡），
    // 一旦没落地就会被回滚并记账，不会出现"行为层以为落地了"的静默失败
    dispatchEntryOps(behavior.tick(), 'behavior:tick');
    // 姿态与行为**同一拍**同步：sit 的入场不产生任何 PresentationOp（姿态走独立通道），
    // 所以不能只在 dispatchEntryOps 里同步，否则静置 20s 后姿态永远不会变。
    syncPosture('behavior:tick');
  }, 250);
}

/**
 * 建功耗策略并接上"可见性 / 页面隐藏 / 拖拽"三个输入。
 *
 * <p>`off` 档要同时停掉眨眼定时器：主进程关掉了 `backgroundThrottling`，
 * 窗口隐藏时 CSS 动画不产生帧，但 JS 定时器照跑——这是唯一会持续吃 CPU 的东西。</p>
 */
function createPowerPolicy(): void {
  powerPolicy = new PowerPolicy({ visible: true, hidden: document.hidden === true });
  const apply = (): void => {
    if (!rootElement || !powerPolicy) return;
    const timing = applyMicroMotion(rootElement, powerPolicy.power);
    if (powerPolicy.power === 'off') {
      blinkDriver?.stop();
      motionPacer?.stop();
    } else if (!REDUCED_MOTION) {
      if (blinkDriver && !blinkDriver.isRunning) blinkDriver.start();
      if (motionPacer && !motionPacer.isRunning) motionPacer.start();
    }
    if (DEBUG_ENABLED) {
      console.debug(`[pet] 功耗档位=${powerPolicy.power} 呼吸=${timing.breathMs}ms 播放=${timing.playState}`);
    }
  };
  powerPolicy.onPower(apply);
  apply();
  document.addEventListener('visibilitychange', () => {
    powerPolicy?.update({ hidden: document.hidden === true });
  });
}

/** 入口。 */
function boot(): void {
  injectGeometryVariables();
  // 命中二道门用的矩形实现：**永远创建**（pointerdown / contextmenu 仍用它筛掉
  // "点在猫旁边空气里"的误触）。它不决定穿透，只做事件级二次筛选。
  hitTester = new RectHitTester(PET_GEOMETRY);
  // HitPipeline 降级为**调试诊断器**：只有 DEBUG_ENABLED 才实例化。
  // 它的"本地视角 vs 主进程视角"对照是排查回声缺陷的唯一手段，但生产路径不跑（省 rAF、不留后门）。
  if (DEBUG_ENABLED) {
    hitPipeline = new HitPipeline(hitTester, {
      onHitChange: (next: boolean) => {
        console.debug(`[pet] 命中诊断（本地视角，不参与决策）: ${next ? '在立绘上' : '离开立绘'}`);
      },
    });
  }
  // 顺序有依赖：DOM（含双缓冲帧）→ 表现层（要帧）→ 初始指令（要总线）
  buildDom();
  createPresentation();
  applyInitialState();
  createPowerPolicy();
  wireEvents();
  subscribeCommands();
  // 初始一律按穿透渲染：主进程的窗口也是穿透态，两边从第 0 帧就一致
  applyHitState(false);
  if (CALIBRATE_ENABLED && rootElement) {
    mountCalibration(document, rootElement, PET_GEOMETRY);
  }
  // 页面卸载时把自建的定时器都收干净：桌宠窗口会被反复开关，
  // 留一个 setInterval 在后台跑就是在白吃 CPU（主进程关了 backgroundThrottling）。
  window.addEventListener('pagehide', () => {
    if (behaviorTimer !== null) {
      window.clearInterval(behaviorTimer);
      behaviorTimer = null;
    }
    blinkDriver?.stop();
    motionPacer?.stop();
    // 姿态层也要收：播放器的定时器是 window.setTimeout，不收就会在隐藏窗口里继续跑
    poseController?.reset();
    hintBar?.dispose();
    gesture.reset();
  });
  // 调试后门只在**开发构建**里挂（生产构建连 `petDebug` 这个键名都不进产物；
  // 与 `?debug=1` 无关——那是给开发者看的提示行/日志开关，不授予后门）
  if (import.meta.env.DEV) {
    mountDevTools();
  }
}

boot();
