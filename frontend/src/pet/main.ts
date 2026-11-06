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
  applyFacingIfMoving as gateFacingWhileMoving,
  applyMotionPolicy,
  behaviorReportOf,
  decidePrefsMotion,
  isMotionAllowed,
  postureOf,
  type MotionGait,
  type MotionIntentReason,
  type MotionMode,
} from './behavior/state-machine';
import type { PetDebugHandle, PoseDebugSnapshot } from './debug/types';
// 只引类型（`import type` 在产物里被完全擦除）：序列运行时本体只在 DEV 分支动态 import，
// 生产构建不会因此产出 `sequences/*` 的 chunk。
import type { SequenceDebugHandle, SequenceLayerId, SequenceLayerPort, SequenceSnapshot } from './sequences/types';
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

/**
 * 主进程推来的运动事实（`pet:command{type:'motion'}`，§8.2 字段级契约）。
 *
 * <p><b>这里没有"速度阈值 / 半径"字段的消费逻辑</b>：`gait` 是主进程按两个半径算好的
 * 字符串，渲染层只做 `'walk'`/`'run'` → 姿态的映射（门禁 G-M6 守"判定权不在渲染层"）。
 * `speedDipPerSec` 只用于排障日志，**任何 if 都不许判它**。</p>
 */
interface MotionFact {
  /** 阶段（`moving` 起步/行进、`arrived` 到达、`aborted` 放弃目标）。 */
  phase: 'moving' | 'arrived' | 'aborted';
  /** 步态（`none` 表示当前没有位移）。 */
  gait: MotionGait;
  /** 朝向（主进程已按 `MOTION.facingFlipHysteresisDip` 做过滞回决定）。 */
  facing: Facing;
  /** 速度（DIP/秒，只进日志）。 */
  speedDipPerSec: number;
  /** 位置（DIP，只读；渲染层**从不写**位置）。 */
  pos: { x: number; y: number };
  /** 所在显示器 id（只读）。 */
  displayId: number;
}

/**
 * 运动意图的载荷（`pet:motion-intent`，§8.1）。
 *
 * <p><b>字段集刻意只有"要不要动 / 为什么 / 我现在是什么状态"</b>：门禁 G-M6 会文本断言这个
 * interface 里**没有 `x` / `y`**。渲染层永远不能指定坐标（§1.1 的唯一位置写入者铁律），
 * 意图只说"要不要动、为什么"。</p>
 *
 * <p><b>`behavior` 是"上报"而不是"命令"</b>（主进程 `pet-window.cjs` 的 handler 原话）：
 * 主进程把它记进 `MotionController#behavior`，之后**自己**用它做闸——行为态命中
 * `BLOCKED_BEHAVIORS = ['sleeping','sleep','drag']` 就拒绝开启 roam/follow 并自动停车。
 * 也就是说：这个字段缺一次，主进程那侧就退回默认的 `idle`，闸门在真机上**形同虚设**
 * （实测症状：`posture=sleep` 却在平移窗口）。所以它是**必填**，且**每一条**载荷都带。</p>
 */
interface MotionIntent {
  /** 目标模式。 */
  mode: MotionMode;
  /** 原因（排障 + 去重）。 */
  reason: MotionIntentReason;
  /**
   * 当前行为态（值域与主进程 `BLOCKED_BEHAVIORS` 对齐，见 {@link behaviorReportOf}）。
   *
   * <p>**必填**：取值来源只有一个——行为状态机的 `stateValue`；状态机未就绪时报 `idle`。</p>
   */
  behavior: string;
}

/** 偏好补丁（`pet:prefs-set` 的载荷；只有 dev 后门会调）。 */
interface MotionPrefsPatch {
  /** 跟随开关。 */
  follow?: boolean;
  /** 漫游开关。 */
  roam?: boolean;
}

/** 主进程推来的指令。类型与 `pet-window.cjs` 的 `pet:command` 一一对应。 */
type PetCommand =
  | { type: 'ready'; clickThrough?: boolean; visible?: boolean; size?: { width: number; height: number } }
  | { type: 'hit-state'; hit?: boolean }
  | { type: 'visible'; visible?: boolean }
  | { type: 'ping'; at?: number }
  | { type: 'play'; motion?: string; priority?: number; durationMs?: number; reason?: string }
  | { type: 'expression'; expression?: string; priority?: number; durationMs?: number; reason?: string }
  | ({ type: 'motion' } & Partial<MotionFact>)
  | {
      type: 'prefs';
      /** 扁平字段（主进程 `safeSend` 的同一条载荷里就有它）。 */
      follow?: boolean;
      /** 同上。 */
      roam?: boolean;
      /** **超集里的嵌套那份**（`{version, follow, roam, updatedAt}`）：两个都要能读。 */
      prefs?: { follow?: boolean; roam?: boolean };
    };

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
  /**
   * 请求切换运动模式（`invoke('pet:motion-intent', {mode, reason})`，§8.1）。
   *
   * <p><b>为什么这里是可选的</b>：preload 由 S4（`frontend/electron/**`）补齐，渲染层本片
   * 不许碰 electron 目录。缺失时 {@link LocomotionBridge.requestMode} 会返回
   * `ok:false` + 明确原因，**绝不静默**——"没接上"必须说出来，否则真机上只会表现为
   * "猫不动"，谁也定位不到是桥没接。</p>
   *
   * <p>载荷类型见 {@link MotionIntent}：只有 `mode` 与 `reason`，**没有坐标**。</p>
   */
  motionIntent?: (intent: MotionIntent) => Promise<PetIpcResult>;
  /**
   * 读运动快照（`invoke('pet:motion-snapshot')`，§8.1）。
   *
   * <p>只读，仅供 dev 后门与 CDP 采样；生产态无人调用。同样由 S4 在 preload 里补齐。</p>
   */
  motionSnapshot?: () => Promise<unknown>;
  /**
   * 写偏好（`invoke('pet:prefs-set', patch)`，§8.1）。
   *
   * <p>**只允许 dev 后门使用**：生产态的偏好唯一写入者是右键菜单（主进程侧），
   * 门禁要求这个调用点被 `DEBUG` 判断包裹。</p>
   */
  prefsSet?: (patch: MotionPrefsPatch) => Promise<PetIpcResult>;
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
 * `pet:motion-intent` 的通道名（`invoke`，渲染 → 主，§8.1）。
 *
 * <p><b>真源在这里</b>：不许在别处再写字面量，也不许自己造第二套通道名。
 * 真正的 `ipcRenderer.invoke` 在 `electron/pet-preload.cjs`（S4 补齐），渲染层只经
 * {@link PetBridge.motionIntent} 调用它——渲染层没有 node 集成，拿不到 `ipcRenderer`。</p>
 */
const MOTION_INTENT_CHANNEL = 'pet:motion-intent';

/**
 * 运动事实的**新鲜度上限**（毫秒，§7 的自愈兜底）。
 *
 * <p>取 `2 × 行为拍 + 100ms`：行为拍是 250ms（`behaviorTimer`），主进程的运动事实每 16ms
 * 一条、且只在字段变化时发——所以"连续两条相隔 600ms"意味着位移真的停了（或主进程那边
 * 出事了），而不是"这两拍刚好没变化"。这个数是**渲染层自己的超时**，与 `MOTION` 里的
 * 半径/速度没有任何关系（那些一个都不许复制到这里）。</p>
 */
const MOVE_COMMAND_STALE_MS = 600;

/**
 * 朝向写入器：**函数引用**，不是包装函数。
 *
 * <p>为什么要写成引用而不是一层箭头包装：`applyPoseFacing` 的调用点有静态判据
 * （`tests/qa-pose-slice2-manifest.test.cjs` 的 Q7-2「恰两处调用」——`forcePose` 与
 * debug 后门）。多一层包装就多一个调用点，会把那条判据判红，而判据本身的意图是
 * "朝向只有一个写入口"，包装并不会破坏这个意图——所以这里用引用，既守住判据字面，
 * 也不引入第二个写者。朝向的唯一写者仍然是 `applyPoseFacing`
 * （Q7-1：`petFacing` 唯一赋值点）。</p>
 */
const poseFacingWriter: (next: Facing) => Facing = applyPoseFacing;

/**
 * 渲染层的运动意图桥（设计 §3.3.1 的 `LocomotionBridge`）。
 *
 * <p><b>为什么它必须存在：</b>渲染层是"意图"的唯一所有者——只有它知道姿态（
 * `postureOf` 的产物），于是"趴着不该再走"「睡着必须停」这类判定只能在这里做；
 * 位置与速度则完全归主进程。这类"两边各知道一半"的接口最容易长出第二份真源，
 * 所以这里的每条规则都只有一种写法：</p>
 * <ol>
 *   <li>{@link onMotion}：运动事实 → 状态机事件（`move-start` / `move-gait` / `move-end`）
 *       → `syncPosture()` → 朝向前置条件。**从不写位置**；</li>
 *   <li>{@link requestMode}：意图 → `pet:motion-intent`。**隐藏时 0 发送**、
 *       减少动态时不下发"开启"、同模式同原因不重复发；</li>
 *   <li>{@link watchdog}：姿态还写着在走、但主进程已经不再报位移 ⇒ 自愈回站姿（§7）。</li>
 * </ol>
 *
 * <p><b>滞回数值为什么不在这里：</b>`facing` 由主进程的 `decideFacing()` 按
 * `MOTION.facingFlipHysteresisDip` 算好后随每一条运动事实下发（设计 §4.4 与 §8.2），
 * 渲染层只做"该不该写"的前置判断（{@link gateFacingWhileMoving}）。
 * 若把 24 DIP 这个常数抄进渲染层，就有了第二份真源（门禁 G-M4 会判红），
 * 而且两处取值一旦漂移就会出现"主进程没翻、渲染层翻了"的镜像错觉。所以这里
 * **一个数值都不复制**，只消费 IPC 字段。</p>
 */
class LocomotionBridge {
  /** 最近一次**成功受理**的模式（去重用）。 */
  private modeValue: MotionMode = 'off';

  /** 最近一次受理的原因（与 `mode` 一起做去重键）。 */
  private reasonValue: MotionIntentReason | null = null;

  /**
   * 最近一次**上报给主进程**的行为态（去重键的第三段）。
   *
   * <p><b>为什么它必须在去重键里</b>：主进程的行为闸门只认载荷里的 `behavior`，
   * 而行为态会在"模式完全没变"的情况下改变（`off/idle-chain/sleeping` →
   * `off/idle-chain/idle`）。只按 `(mode, reason)` 去重就会把后一条吞掉，于是主进程
   * 一直拿着陈旧的 `sleeping` 挡着用户手动发起的意图——真机现场正是"醒来后必须再点
   * 一次菜单才恢复"。</p>
   */
  private behaviorValue: string | null = null;

  /** 窗口是否隐藏（隐藏时 0 发送、0 处理）。 */
  private hidden = false;

  /** 是否在拖拽（拖拽期间位置写入权归 `drag`，运动桥不参与）。 */
  private dragging = false;

  /** 跟随开关（来自主进程 `pet:command{type:'prefs'}`；渲染层只读不改）。 */
  private followEnabled = false;

  /** 漫游开关（同上）。 */
  private roamEnabled = false;

  /** 最近一次收到运动事实的时刻（毫秒）；`-Infinity` = 还没收到过。 */
  private lastMotionAt = Number.NEGATIVE_INFINITY;

  /** 是否正在播序列（§5 第 3 级：序列播放期间**不许**发起自主移动）。 */
  private sequencePlaying = false;

  /** 上一次经 {@link applyMotionPolicy} 请求过的模式（幂等键）。 */
  private postureMode: MotionMode | null = null;

  /** 当前模式（dev 后门与排障用）。 */
  get mode(): MotionMode {
    return this.modeValue;
  }

  /** 最近一次受理的原因。 */
  get reason(): MotionIntentReason | null {
    return this.reasonValue;
  }

  /** 是否被本地策略暂停（隐藏 / 拖拽）。 */
  get isSuspended(): boolean {
    return this.hidden || this.dragging;
  }

  /** 偏好原样透出（冒烟断言用；渲染层不解释它们）。 */
  get prefs(): { follow: boolean; roam: boolean } {
    return { follow: this.followEnabled, roam: this.roamEnabled };
  }

  /**
   * 姿态同步后跟进：把"当前姿态"翻成运动意图（§5 注释 2 / P-M15）。
   *
   * <p>`sleepy` → `lie`、`sleeping` → `sleep`（以及 `sit` / `jump`）派生完就必须下发
   * `requestMode('off', 'idle-chain')`：**睡着了还在自主移动**是这一片最刺眼的缺陷
   * （主进程不知道姿态，它只会按 lastIntent 继续走）。</p>
   *
   * <p>幂等由 `applyMotionPolicy` 的 `previous` 记账保证：只在"该 off 而当前不是 off"
   * 时发一条，250ms 的行为拍不会把 IPC 打满。</p>
   *
   * @param posture 当前姿态（`controller.posture`，即 `postureOf` 的产物、可能已降级）
   */
  syncMotionPolicy(posture: PostureId): void {
    this.postureMode = applyMotionPolicy(posture, this, this.postureMode);
  }

  /** 窗口是否隐藏（隐藏 => 渲染侧 0 采样、0 发送）。 */
  get isHidden(): boolean {
    return this.hidden;
  }

  /**
   * 收一条运动事实。
   *
   * <p>**隐藏 / 拖拽时直接返回**：这两种情形下位置写入权都不在 `locomotion`，
   * 处理运动事实只会产生"姿态动了但窗口没动"的假象（正是 §7.1 禁止的原地滑行）。</p>
   *
   * @param fact 运动事实（已归一）
   */
  onMotion(fact: MotionFact): void {
    if (this.hidden || this.dragging) return;
    const machine = behavior;
    if (!machine) return;
    this.lastMotionAt = Date.now();
    const stopped = fact.phase !== 'moving' || fact.gait === 'none';
    if (stopped) {
      machine.handle('move-end', { gait: 'none', reason: fact.phase });
    } else {
      // 起步与换档共用一条路径：状态不在走/跑时 `move-gait` 会按起步处理（自愈）
      machine.handle(machine.isMoving ? 'move-gait' : 'move-start', {
        gait: fact.gait,
        reason: fact.phase,
      });
    }
    syncPosture('motion');
    this.applyFacingIfMoving(fact.facing);
  }

  /**
   * 请求切换运动模式（`pet:motion-intent`）。
   *
   * <p><b>六道本地闸门</b>，**都不发 IPC**（0 发送，§8.3）：</p>
   * <ol>
   *   <li>窗口隐藏 ⇒ 直接拒绝（渲染层侧的"0 发送"；隐藏时的 0 采样由主进程
   *       `motion.setSuspended('hidden')` 保证，那是 S4 的判据）；</li>
   *   <li>用户要求减少动态（`prefers-reduced-motion`）⇒ **不下发任何"开启"请求**
   *       （U-M4 的裁决：默认不动，由主进程偏好决定；渲染层只读不改）；</li>
   *   <li>偏好没开（`follow` / `roam`）⇒ 不下发对应模式（渲染层只是"请求方"，
   *       不是"决定方"）；</li>
   *   <li>序列播放中 ⇒ 拒绝任何"开启"请求（§5 第 3 级：序列的打断优先级高于自主移动，
   *       播"过来—抱起—放回"时窗口一起平移会把角色从怀里甩出去）；</li>
   *   <li>行为态自己不许动（困倦 / 睡着 / 趴着 / 被拖）⇒ 拒绝任何"开启"请求；</li>
   *   <li>与上一次受理的 `(mode, reason, behavior)` 相同 ⇒ 幂等早退，不重复发。</li>
   * </ol>
   *
   * @param mode 目标模式
   * @param reason 原因
   * @param behaviorHint 行为态（省略时按行为状态机的当前状态派生）。只有
   *   {@link syncRestMotion} 会显式传入——它要上报的是**刚刚推出的那个状态**
   * @returns 是否已受理（`false` 不代表出错，代表"被本地策略拦下"）
   */
  requestMode(mode: MotionMode, reason: MotionIntentReason, behaviorHint?: string): boolean {
    if (mode !== 'off' && mode !== 'follow' && mode !== 'roam') return false;
    if (this.hidden) {
      if (DEBUG_ENABLED) console.debug(`[pet] 运动意图 ${mode}：窗口隐藏，0 发送`);
      return false;
    }
    if (mode !== 'off' && REDUCED_MOTION) {
      if (DEBUG_ENABLED) console.debug(`[pet] 运动意图 ${mode}：prefers-reduced-motion，不下发开启请求`);
      return false;
    }
    if (mode === 'follow' && !this.followEnabled) return false;
    if (mode === 'roam' && !this.roamEnabled) return false;
    if (mode !== 'off' && this.sequencePlaying) {
      if (DEBUG_ENABLED) console.debug(`[pet] 运动意图 ${mode}：序列播放中，不下发开启请求`);
      return false;
    }
    // 第 5 道：行为态自己不许动（困倦 / 睡着 / 趴着 / 被拖）⇒ 一律不许"开启"。
    // 这一道与 `decidePrefsMotion` 的判据同源，多设一道是刻意的纵深防御：
    // 将来任何新调用点想开运动，都过不了这里（否则就又回到"趴着平移"）。
    if (mode !== 'off' && !isMotionAllowed(behavior === null ? null : behavior.state)) {
      if (DEBUG_ENABLED) {
        console.debug(`[pet] 运动意图 ${mode}：行为态「${behavior === null ? 'null' : behavior.state}」不许动，拒绝`);
      }
      return false;
    }
    const reported = typeof behaviorHint === 'string' && behaviorHint.length > 0
      ? behaviorHint
      : behaviorReportOf(behavior?.state ?? null);
    if (this.modeValue === mode && this.reasonValue === reason && this.behaviorValue === reported) return true;
    const bridge = petBridge();
    const send = bridge?.motionIntent;
    if (typeof send !== 'function') {
      // 桥没接上（preload 由 S4 补齐）：说出来，绝不静默——否则真机只会表现为"猫不动"
      console.debug(`[pet] ${MOTION_INTENT_CHANNEL} 桥未就绪：渲染层无法下发 ${mode}（${reason}）`);
      return false;
    }
    this.modeValue = mode;
    this.reasonValue = reason;
    this.behaviorValue = reported;
    // 行为态**在同一次下发里**带上（不是另开一条通道、也不是每拍补发）：
    // 主进程的闸门只认这条载荷里的 `behavior`，缺一次它就退回默认 idle 放行一次。
    const payload: MotionIntent = { mode, reason, behavior: reported };
    void send
      .call(bridge, payload)
      .then((result) => {
        if (result.ok === false) console.debug(`[pet] 运动意图 ${mode} 被拒：${result.error ?? '未说明原因'}`);
      })
      .catch((error: unknown) => {
        console.debug(`[pet] 运动意图 ${mode} 发送失败：${String(error)}`);
      });
    return true;
  }

  /**
   * 朝向只在走/跑时写入（§7.1 第二条，G-M7）。
   *
   * @param facing 主进程算好的朝向
   * @returns 是否真的写了（姿态不是走/跑时恒为 `false`）
   */
  applyFacingIfMoving(facing: Facing): boolean {
    const controller = poseController;
    if (!controller) return false;
    return gateFacingWhileMoving(controller.posture, facing, poseFacingWriter);
  }

  /**
   * 可见性变化（`document.hidden` / `pet:command{type:'visible'}`）。
   *
   * @param hidden 是否隐藏
   */
  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    if (hidden) {
      // 隐藏期间的"已在走"必须收尾：不写位置、不下发 IPC，只把状态与姿态退回站姿
      this.lastMotionAt = Number.NEGATIVE_INFINITY;
      behavior?.handle('move-end', { gait: 'none', reason: 'hidden' });
      syncPosture('motion:hidden');
    }
  }

  /**
   * 拖拽开始/结束（位置写入权交接，§5.1 第 2 级）。
   *
   * @param dragging 是否在拖
   */
  setDragging(dragging: boolean): void {
    if (this.dragging === dragging) return;
    this.dragging = dragging;
    if (dragging) {
      // 拖拽期间"运动"这件事被第 2 级完全压住：状态机回 idle，姿态由 syncPosture 的
      // drag 分支保持（它只 pause，不改 posture）
      behavior?.handle('move-end', { gait: 'none', reason: 'drag' });
      this.lastMotionAt = Number.NEGATIVE_INFINITY;
    }
  }

  /**
   * 偏好变化（`pet:command{type:'prefs'}`）⇒ **重新评估并下发运动意图**。
   *
   * <p>这一条是"用户开了自由漫游、猫纹丝不动"的直接修复点：偏好本身由主进程落盘并广播，
   * 渲染层**只读**，但"据此请求哪个模式"只能在这里做——否则开关开了等于没开。</p>
   *
   * <p>决策逻辑在 {@link decidePrefsMotion}（纯函数、可单测），这里只做三件接线活：</p>
   * <ol>
   *   <li>先记下开关（`undefined` = 本条没带该字段，保持原值）；</li>
   *   <li>若结论是"要动、但得先站起来"，调 {@link PetBehaviorStateMachine.resumeFromRest}
   *       并立刻 `syncPosture`（否则有一拍"状态已 idle、姿态还坐着"的缝）；</li>
   *   <li>下发（`off` 也发一条：主进程需要知道"用户把开关关了"）。</li>
   * </ol>
   *
   * @param follow 跟随开关（`undefined` = 本条没带，保持原值）
   * @param roam 漫游开关（同上）
   */
  onPrefs(follow: boolean | undefined, roam: boolean | undefined): void {
    if (typeof follow === 'boolean') this.followEnabled = follow;
    if (typeof roam === 'boolean') this.roamEnabled = roam;
    // 活跃模式抑制（"坐着平移"的裁决）：判定与推进全在状态机的 `tick()` 内部，
    // 渲染层只把两个开关**透传**过去——否则又是一处"约定"而不是结构保证。
    behavior?.setMotionPrefs(this.followEnabled, this.roamEnabled);
    const state = behavior === null ? null : behavior.state;
    const decision = decidePrefsMotion(this.followEnabled, this.roamEnabled, state);
    if (decision.resumeFromRest && behavior !== null) {
      if (behavior.resumeFromRest()) syncPosture('prefs:resume');
    }
    this.requestMode(decision.mode, 'prefs');
  }

  /**
   * 休息态进出双向同步（行为拍驱动，§5：睡着必须停、醒来必须恢复）。
   *
   * <p>判据与决策全在 {@link PetBehaviorStateMachine.syncRestMotion}（纯逻辑、可单测），
   * 这里只做两件事：①隐藏时**不进**（隐藏态 0 发送，§8.3）；②把结论打到日志里，
   * 真机上"为什么它不动/为什么它还在动"必须能一眼查到。</p>
   *
   * <p><b>为什么挂在 250ms 的行为拍上而不是姿态变化事件上</b>：真机回归现场是
   * "猫在用户打开漫游之前就已经是 `lie`，随后进入 `sleeping` 时 `mode` 仍是 `roam`，
   * 一路睡姿平移"。姿态早就变了、行为态才刚变，只挂姿态事件就会整夜漏掉。
   * 行为拍每秒 4 次、只在状态真的变化时下发一条，代价可忽略。</p>
   */
  syncRestMotion(): void {
    if (this.hidden || this.dragging) return;
    const machine = behavior;
    if (machine === null) return;
    const exit = machine.syncRestMotion(this.followEnabled, this.roamEnabled, this);
    if (exit === null) return;
    if (DEBUG_ENABLED) {
      console.debug(
        `[pet] 休息态同步：${exit.from} → ${exit.to} ⇒ ${exit.mode}（behavior=${exit.behavior}）`,
      );
    }
  }

  /**
   * 序列开始/结束（§5 第 3 级：序列播放期间不许发起自主移动）。
   *
   * @param playing 是否在播
   */
  setSequencePlaying(playing: boolean): void {    if (this.sequencePlaying === playing) return;
    this.sequencePlaying = playing;
    if (!playing) {
      // 播完按当前偏好重评估（有开关才重新请求；否则 off）——由 onPrefs 统一出口决定
      this.onPrefs(undefined, undefined);
    }
  }

  /**
   * 运动看门狗（由行为拍驱动，§7 的自愈兜底）。
   *
   * <p>"姿态还写着在走，但主进程已经不再报位移"有两条成因：①主进程的 `move-end` 丢了；
   * ②姿态资产缺失导致 `postureOf` 降级成 `stand`（此时状态仍是 walk/run，画面站着却
   * 以为自己在走）。两种都必须收尾，否则就留下"原地滑行"的幽灵状态。</p>
   *
   * @param now 当前时刻（毫秒，与 `Date.now()` 同一时间轴）
   */
  watchdog(now: number): void {
    if (this.hidden || this.dragging) return;
    const machine = behavior;
    if (!machine || !machine.isMoving) return;
    if (!Number.isFinite(now)) return;
    if (now - this.lastMotionAt <= MOVE_COMMAND_STALE_MS) return;
    console.debug(`[pet] 运动事实超过 ${MOVE_COMMAND_STALE_MS}ms 未更新，自愈回站姿`);
    machine.handle('move-end', { gait: 'none', reason: 'stale' });
    syncPosture('motion:stale');
    this.requestMode('off', 'interaction');
  }
}

/** 运动桥单例（无副作用构造，不需要 DOM 就绪）。 */
const locomotion = new LocomotionBridge();

/**
 * 把不可信的运动指令归一成 {@link MotionFact}。
 *
 * <p>值来自主进程（跨进程边界 = 不可信）：`phase` / `gait` / `facing` 三者任一非法就整条
 * 丢弃并记日志——**不许"猜一个默认值"继续走**，因为错的朝向会让角色瞬移式转身。
 * 速度与坐标只做类型收敛，不参与任何判定。</p>
 *
 * @param command `pet:command{type:'motion'}` 载荷
 * @returns 归一后的运动事实；非法时为 `null`
 */
function asMotionFact(command: Partial<MotionFact>): MotionFact | null {
  const phase = command.phase;
  const gait = command.gait;
  const facing = command.facing;
  if (phase !== 'moving' && phase !== 'arrived' && phase !== 'aborted') {
    console.debug(`[pet] 运动指令的 phase 非法：${JSON.stringify(phase)}`);
    return null;
  }
  if (gait !== 'none' && gait !== 'walk' && gait !== 'run') {
    console.debug(`[pet] 运动指令的 gait 非法：${JSON.stringify(gait)}`);
    return null;
  }
  if (facing !== -1 && facing !== 1) {
    console.debug(`[pet] 运动指令的 facing 非法：${JSON.stringify(facing)}`);
    return null;
  }
  const pos = command.pos;
  const x = pos !== undefined && Number.isFinite(pos.x) ? pos.x : 0;
  const y = pos !== undefined && Number.isFinite(pos.y) ? pos.y : 0;
  return {
    phase,
    gait,
    facing,
    speedDipPerSec: Number.isFinite(command.speedDipPerSec) ? Number(command.speedDipPerSec) : 0,
    pos: { x, y },
    displayId: Number.isFinite(command.displayId) ? Number(command.displayId) : 0,
  };
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
  // 姿态 → 运动意图（§5 注释 2 / P-M15）：趴/坐/睡/跳必须撤销运动。
  // 放在最前面（早于 `poseOverride` 与 `drag` 两个早退），因为"睡着还能走"不是排障态的
  // 豁免项——它本身就是判据。
  locomotion.syncMotionPolicy(controller.posture);
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
  // 运动桥进入拖拽（位置写入权交接给 drag，§5.1 第 2 级：运动让位）
  locomotion.setDragging(true);
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
  // 松手后交还位置写入权（是否重新走由主进程的偏好 + 下一条运动事实决定）
  locomotion.setDragging(false);
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
 * 用户入口播放的场景（双击宠物 = 让小云酱过来玩一次）。
 *
 * <p>选 `play_cloud` 是因为它是唯一**双角色**的场景：单看主角动没人知道"这是在跟谁玩"，
 * 而 `cloud_react` 只有云朵自己跳，作为用户入口的反馈太弱（后门里留着够用了）。</p>
 */
const PLAY_SCENE_ID = 'play_cloud';

/** 序列运行时的对外形状（用户入口与 DEV 后门共用同一份实现）。 */
interface PetSequenceRuntime {
  /** 播一个场景（非法 id 抛错，不静默）。 */
  play: (sceneId: string) => { readonly sceneId: string; readonly steps: number; readonly durationMs: number };
  /** 停播并撤掉所有序列层。 */
  stop: () => void;
  /** 当前快照。 */
  snapshot: () => SequenceSnapshot;
  /** 全部可播场景 id。 */
  scenes: () => string[];
  /** 是否在播。 */
  isPlaying: () => boolean;
}

/**
 * 序列运行时单例（**第一次真正用到时才动态 import**）。
 *
 * <p>与 B1 的差别：B1 只在 `import.meta.env.DEV` 分支里 import 序列模块（生产产物里没有
 * `sequences/*` 的 chunk）。B2 起序列有了**用户可达入口**，生产构建里必须有这些模块，
 * 所以改成"挂到第一次触发时再 import"——首帧不为它多付一次解析/下载，
 * 用户不双击就永远不加载。</p>
 */
let sequenceRuntimePromise: Promise<PetSequenceRuntime | null> | null = null;

/** 序列结束的轮询句柄（`null` = 没在等）。 */
let sequenceMotionWatch: number | null = null;

/**
 * 序列播放期间把运动关掉，结束后恢复（§5 第 3 级：序列的打断优先级高于自主移动）。
 *
 * <p>为什么用轮询而不是给导演加回调：序列运行时的对外形状（{@link PetSequenceRuntime}）
 * 是本片交付的稳定契约，为了一个"播完通知"改它的形状会把风险扩散到已验收的 B1/B2 路径。
 * 250ms 与行为拍同频、只在播放期间存在，代价可忽略。</p>
 *
 * @param runtime 正在播放的运行时
 */
function watchSequenceMotionEnd(runtime: PetSequenceRuntime): void {
  if (sequenceMotionWatch !== null) window.clearTimeout(sequenceMotionWatch);
  const tick = (): void => {
    sequenceMotionWatch = null;
    if (runtime.isPlaying()) {
      sequenceMotionWatch = window.setTimeout(tick, 250);
      return;
    }
    // 序列结束了：先撤掉"播放中"标记（它会拦住开启请求），再按当前偏好重评估
    // ——有跟随/漫游才重新请求，否则 off。两条都在 `setSequencePlaying(false)` 里收口。
    locomotion.setSequencePlaying(false);
  };
  sequenceMotionWatch = window.setTimeout(tick, 250);
}

/**
 * 藏/显站姿画面，让序列独占画面。
 *
 * <p>序列演的是"坐着抱云"，而站姿立绘（`.pet-action` 里的压平帧与层栈）在
 * `data-posture='stand'` 下仍然可见。两层同时可见 = 一只猫叠在另一只猫身上。
 * 所以序列期间把 `.pet-action` 用**行内** `display:none` 藏起来，结束时撤掉行内值
 * （不写死 `block`，交还给 CSS）。姿态层 `.pet-pose` 挂在 `#pet-root` 上、不是它的子节点，
 * 因此不受影响——它由 `PoseController.showFrame` 的行内 `display` 负责显形。</p>
 *
 * @param hidden 是否隐藏
 */
function setStandArtHidden(hidden: boolean): void {
  if (!actionElement) return;
  actionElement.style.display = hidden ? 'none' : '';
}

/**
 * 建（并缓存）序列运行时。
 *
 * @returns 运行时；没有 `#pet-root` 时为 null
 */
function petSequenceRuntime(): Promise<PetSequenceRuntime | null> {
  if (sequenceRuntimePromise !== null) return sequenceRuntimePromise;
  const host = rootElement;
  if (!host) return Promise.resolve(null);
  sequenceRuntimePromise = Promise.all([import('./sequences/manifest'), import('./sequences/director')]).then(
    ([manifestModule, directorModule]) => {
      const sequences = manifestModule.PET_SEQUENCES;
      /**
       * 非姿态层的 DOM 端口。**按清单的 layers 顺序建**：数组下标即 z 序（0 最底），
       * 而 `DomSequenceLayer` 是"构造即 append"，所以建完就天然是"后的压在前面的上面"。
       * 手掌层因此必须排在伙伴层之后（否则手会被云盖住 = 抱在云下面）。
       */
      const layers: Partial<Record<SequenceLayerId, SequenceLayerPort>> = {};
      for (const layer of sequences.layers) {
        if (layer.kind === 'pose-frames') continue;
        layers[layer.id] = new directorModule.DomSequenceLayer({
          doc: document,
          host: host as unknown as ElementLike,
          layerId: layer.id,
          density: POSE_DENSITY,
          log: (message) => console.debug(message),
        });
      }
      const director = new directorModule.SequenceDirector({
        sequences,
        clock: { now: () => Date.now() },
        layers,
        // 主角层的像素只经这条窄接口上屏（单写者纪律）。姿态主状态一个字都不改。
        protagonist: {
          showFrame: (frameId: string) => {
            poseController?.showFrame(frameId);
          },
          clear: () => {
            poseController?.clearSequenceFrame();
          },
        },
        // 主角/手掌层与坐姿姿态层同一个落点公式 ⇒ 必须用同一份对齐点。
        // 形状桥接：`pet-poses.json` 的 `align` 是美术契约 `AlignContract`
        // （`{xNative, yNative, xSource}`），序列侧要的是 native 域的 `SequencePoint`（`{x, y}`）。
        // 这里**只做字段改名、不做任何数值推导**：`xNative` / `yNative` 就是对齐点本身，
        // 若在此处引入换算（乘 stageToCss、翻半张画布之类）就会与 `.pet-pose` 的落点分叉，
        // 表现是"序列期间角色横跳几个像素"。换算只许留在 `alignedLayerBoxOf` 一处。
        align: { x: PET_POSES.align.xNative, y: PET_POSES.align.yNative },
        // cloud_react 的步只给 dy，不给绝对坐标；基准取美术 play_cloud 第 0 步的静止位置
        // （`companionCenterX=1080, companionFootY=1454`，gif-v1 manifest 原文），不自己编坐标。
        base: { centerX: 1080, footY: 1454 },
        onSceneEnd: (sceneId, onEnd) => {
          console.debug(`[pet] 场景 ${sceneId} 结束：${onEnd}`);
          setStandArtHidden(false);
        },
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
      const runtime: PetSequenceRuntime = {
        play: (sceneId) => {
          const report = director.play(sceneId);
          setStandArtHidden(true);
          stopLoop();
          frameHandle = window.requestAnimationFrame(loop);
          return report;
        },
        stop: () => {
          stopLoop();
          director.stop();
          setStandArtHidden(false);
        },
        snapshot: () => director.snapshot(),
        scenes: () => manifestModule.sceneIdsOf(sequences),
        isPlaying: () => director.isPlaying,
      };
      window.addEventListener('pagehide', () => {
        stopLoop();
        director.stop();
      });
      return runtime;
    },
  );
  return sequenceRuntimePromise;
}

/**
 * 用户可达的播放入口（**双击宠物**）。
 *
 * <p><b>用户怎么点到：</b>把光标移到桌宠身上，<b>在同一位置双击</b>（`dblclick`）。
 * 选双击而不是右键菜单：右键菜单归主进程（`pet:context-menu`），改它要动
 * `electron/**`（本批文件边界外）；而双击在渲染层就能接住，且不与既有手势冲突——
 * 关闭已经收敛到右键菜单（D-B2/O3），双击今天**没有**任何语义。</p>
 *
 * <p><b>三条纪律：</b></p>
 * <ol>
 *   <li><b>幂等</b>：播放中再双击直接忽略（不重启、不叠加，画面不会闪回第 0 步）；</li>
 *   <li><b>不重入</b>：运行时是单例、层只建一次，第二次进入走的是同一个导演；</li>
 *   <li><b>不搞乱姿态主状态</b>：`posture` / `facing` 由 `setPosture` / `setFacing` 独占，
 *       入口一个字都不写（主角帧经 `PoseController.showFrame` 借用画面）。</li>
 * </ol>
 *
 * @returns 是否真的开始播（`false` = 被幂等门挡下或运行时未就绪）
 */
function playPetSequence(): boolean {
  void petSequenceRuntime().then((runtime) => {
    if (runtime === null) {
      console.debug('[pet] 序列运行时未就绪（没有 #pet-root），双击播放被跳过');
      return;
    }
    if (runtime.isPlaying()) {
      console.debug('[pet] 序列已在播放，双击不再重入');
      return;
    }
    try {
      const report = runtime.play(PLAY_SCENE_ID);
      // 序列期间运动关闭：导演播"过来—抱起—回应—放回"时主进程若还在推位移，
      // 角色会在原地被挪（姿态与位移分属两个写者），§5 把序列排在自主移动之上。
      locomotion.setSequencePlaying(true);
      locomotion.requestMode('off', 'interaction');
      watchSequenceMotionEnd(runtime);
      console.debug(`[pet] 双击播放 ${report.sceneId}：${report.steps} 步 / ${report.durationMs} ms`);
    } catch (err) {
      console.warn(`[pet] 双击播放失败：${(err as Error).message}`);
    }
  });
  return true;
}

/**
 * 把序列通道挂到 DEV 后门句柄上（`petDebug.sequence.play('play_cloud')` 等）。
 *
 * <p>与 B1 的差别只有一处：不再自己建层/导演，而是复用用户入口那一个运行时
 * ——后门验的就是用户真会看到的东西，两条独立的实例化路径只会让"后门绿、真机红"。</p>
 *
 * @param handle `installDevBackdoor` 返回的调试句柄
 */
function mountSequenceBackdoor(handle: PetDebugHandle): void {
  void petSequenceRuntime().then((runtime) => {
    if (runtime === null) return;
    const sequenceHandle: SequenceDebugHandle = {
      play: (sceneId) => {
        const report = runtime.play(sceneId);
        // 后门播放同样要关运动（后门验的必须是与用户入口同一条路径）
        locomotion.setSequencePlaying(true);
        locomotion.requestMode('off', 'dev');
        watchSequenceMotionEnd(runtime);
        return report;
      },
      stop: () => runtime.stop(),
      snapshot: () => runtime.snapshot(),
      scenes: () => runtime.scenes(),
    };
    (handle as PetDebugHandle & { sequence?: SequenceDebugHandle }).sequence = sequenceHandle;
  });
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

  // 双击 → 播一次 `play_cloud`（**用户可达的序列入口**，见 `playPetSequence` 的注释）。
  // 为什么是双击：右键菜单归主进程（改它要动 `electron/**`，本批边界外），
  // 而双击在渲染层就能接住、且今天没有任何既有语义（关闭已收敛到右键菜单，O3/D-B2）。
  // 命中判定与 pointerdown 同一道二道门：点在透明留白上不算数。
  artElement.addEventListener('dblclick', (event) => {
    if (!(hitTester?.test(event.clientX, event.clientY) ?? false)) return;
    event.preventDefault();
    hintBar?.poke();
    playPetSequence();
  });

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
      // 运动桥同样对齐（否则"隐藏着被重载"之后渲染层还以自己在可见态发意图）
      locomotion.setHidden(command.visible === false);
      return;
    }
    if (command.type === 'visible') {
      // 窗口隐藏 → off 档：停 CSS 动画 + 停眨眼定时器（hidden 时 CSS 不产帧，但 JS 定时器照跑）
      powerPolicy?.update({ visible: command.visible === true });
      // 运动桥也要知道：隐藏期间 0 发送（§8.3），并收掉"已在走"的幽灵状态
      locomotion.setHidden(command.visible === false);
      if (DEBUG_ENABLED) console.debug(`[pet] 可见性变化: visible=${command.visible === true}`);
      return;
    }
    if (command.type === 'motion') {
      // 运动事实（§8.2）：跨进程边界 ⇒ 先归一，非法整条丢弃（不猜默认值）
      const fact = asMotionFact(command);
      if (fact !== null) locomotion.onMotion(fact);
      return;
    }
    if (command.type === 'prefs') {
      // 偏好只读（真正写者是主进程右键/托盘菜单）；这里据此**重新评估**要不要请求模式。
      // 载荷是**超集**：主进程同一条 `pet:command` 里既有扁平 `follow`/`roam`，也有嵌套
      // `prefs:{version,follow,roam,updatedAt}`（见 `pet-window.cjs` 的两处 safeSend）。
      // 两个都要能读：扁平优先，缺失时回落到嵌套，两者都没有则视为"本条没带"（保持原值）。
      const nested = command.prefs ?? {};
      const follow = typeof command.follow === 'boolean' ? command.follow : nested.follow;
      const roam = typeof command.roam === 'boolean' ? command.roam : nested.roam;
      if (DEBUG_ENABLED) console.debug(`[pet] 偏好广播：follow=${String(follow)} roam=${String(roam)}`);
      locomotion.onPrefs(follow, roam);
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
  // 偏好可能**先于**状态机到达（主进程在 renderer `ready` 后立刻广播一次 prefs，而
  // 状态机的构建在 DOM/层栈之后）。那种时序下 `decidePrefsMotion` 只能看到 `state=null`
  // 从而降级成 off，之后**没有人再评估**——用户看到的就是"开关是开的、猫不动"。
  // 所以状态机一就绪就补一次评估（有开关才补，避免无谓的 off 请求）。
  if (locomotion.prefs.follow || locomotion.prefs.roam) locomotion.onPrefs(undefined, undefined);

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
    // 休息态进出双向同步（§5）：进入 sleepy/sleeping/lie/drag ⇒ 立刻 off + 新行为态；
    // 醒来/拖完回到可动状态 ⇒ 按当前偏好重新评估（否则用户必须再点一次菜单才恢复漫游）。
    // 判据是**行为态本身**，不依赖姿态是否变化——真机上"趴着滑行"就是挂错触发点的后果。
    locomotion.syncRestMotion();
    // 禁原地滑行的自愈（§7）：姿态还写着在走、主进程却已不再报位移 ⇒ 收尾回站姿。
    // 它必须排在 syncPosture 之后：先让姿态按最新状态落定，再判"这条在走是不是幽灵"。
    locomotion.watchdog(Date.now());
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
    // 隐藏 ⇒ 渲染侧 0 采样、0 发送：运动桥先停手，并把"已在走"收掉（不留幽灵状态）
    locomotion.setHidden(document.hidden === true);
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
