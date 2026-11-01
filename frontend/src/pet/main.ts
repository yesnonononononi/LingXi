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
import { PET_GEOMETRY, geometryCssVariables } from './layout';
import { HitPipeline } from './hit/hit-pipeline';
import { RectHitTester } from './hit/rect-hit-tester';
import { DEFAULT_TIMER_PORT, PresentationBus } from './presentation/bus';
import { BlinkDriver } from './presentation/blink-driver';
import { CommandRouter } from './presentation/command-router';
import { DEFAULT_CROSSFADE_EASING, DEFAULT_CROSSFADE_MS } from './presentation/crossfade';
import type { ExpressionUrlMap } from './presentation/sprite-presentation';
import { EXPRESSION_IDS, type ExpressionId, type MotionId, type PresentationOp } from './presentation/types';
import { PetBehaviorStateMachine, type PetBehaviorState } from './behavior/state-machine';
import { PET_BLINK_MAPPING, expressionFrameUrl, expressionFrameUrls } from './assets/manifest';
import { loadArt } from './assets/loader';
import { MOTION_CATALOG } from './layers/motion-catalog';
import { PET_LAYERS, applyLayersQueryOverride, pickLayerDensity, requestedLayerIds } from './layers/manifest';
import { resolveCompositePlan } from './layers/plan';
import type { CompositePlan } from './layers/types';
import type { DocumentLike, ElementLike, LayerView } from './presentation/layered-presentation';
import { selectPresentationWithPlan, type SelectorDeps } from './presentation/select-presentation';
import type { PetPresentation } from './presentation/types';
import { PowerPolicy } from './power-policy';
import { isCalibrationEnabled, mountCalibration } from './visual/calibrate';
import { mountHalo } from './visual/halo';
import { applyMicroMotion, applyMotionDuration, isDebugEnabled, prefersReducedMotion } from './visual/micro-motion';
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
 * <p>默认值来自 `frontend/pet-layers.json` 的 `enabled`，M6 之前它是 `false`：于是
 * {@link resolveCompositePlan} 必然返回 `composite`，渲染路径与分层之前**逐字节等价**。
 * 这也是"零风险前半程"的落点——代码可以先合，开闸留给资产到货之后。</p>
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

/** 表情中文标签（调试提示行用；发布态不显示）。 */
const EXPRESSION_LABELS: Readonly<Record<ExpressionId, string>> = {
  neutral: '默认',
  blink: '眨眼',
  happy: '开心',
  shy: '害羞',
  angry: '生气',
  sad: '委屈',
  surprised: '惊讶',
  sleepy: '困倦',
  yawn: '打哈欠',
};

/** 主进程推来的指令。类型与 `pet-window.cjs` 的 `pet:command` 一一对应。 */
type PetCommand =
  | { type: 'ready'; clickThrough?: boolean; size?: { width: number; height: number } }
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
  startDrag: (payload: PetPoint) => Promise<PetIpcResult>;
  moveDrag: (payload: PetPoint) => void;
  endDrag: () => Promise<PetIpcResult>;
  setHit: (hit: boolean) => void;
  close: () => Promise<PetIpcResult>;
  onCommand: (callback: (command: PetCommand) => void) => () => void;
}

/** 调试句柄（`?debug=1` 或 dev 下才有；发布态整个对象不挂到 window）。 */
interface PetDebugHandle {
  /** 直接投递一条表现层指令（QA 验收/排障用）。 */
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
  /** 当前合成模式（`composite` / `partial` / `layered`；排障用）。 */
  compositeMode: () => string;
  /** 参与本次合成的层 id（`composite` 时为空数组）。 */
  layerIds: () => string[];
}

declare global {
  interface Window {
    petAPI?: PetBridge;
    petDebug?: PetDebugHandle;
  }
}

/** 当前是否处于「可交互」状态（true = 主进程已关掉穿透）。 */
let hit = false;
/** 是否正在拖拽。 */
let dragging = false;

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

/** 关键 DOM 引用（构建时赋值，之后只读）。 */
let artElement: HTMLDivElement | null = null;
let badgeElement: HTMLSpanElement | null = null;
let hintElement: HTMLSpanElement | null = null;

/** 取桥；拿不到时返回 null（纯浏览器里打开 pet.html 也能看见画面，便于排查）。 */
function petBridge(): PetBridge | null {
  return window.petAPI ?? null;
}

/**
 * 把命中状态应用到界面。
 *
 * <p>这是命中的唯一收口：无论状态来自本地判定还是主进程回执，都从这里进。</p>
 *
 * @param next 是否可交互
 */
function applyHitState(next: boolean): void {
  hit = next;
  if (artElement) {
    artElement.classList.toggle('is-hit', next);
  }
  if (badgeElement) {
    badgeElement.textContent = next ? '可交互' : '穿透中';
    badgeElement.classList.toggle('is-hit', next);
  }
}

/**
 * 上报命中状态（变化时才发 IPC，避免每帧重复调用 setIgnoreMouseEvents）。
 *
 * @param next 是否可交互
 */
function reportHit(next: boolean): void {
  if (next === hit) return;
  applyHitState(next);
  petBridge()?.setHit(next);
}

/**
 * 更新提示行（显示当前表情，手动验收时能直接看出切到哪一档）。
 *
 * @param expression 表情 id
 */
function renderHint(expression: ExpressionId): void {
  if (!hintElement) return;
  const label = EXPRESSION_LABELS[expression] ?? '默认';
  hintElement.textContent = `拖动移动 · 双击隐藏 · 表情：${label}`;
}

/**
 * 直接投递一条表现层指令。
 *
 * @param op 指令
 * @returns 调度结果（`applied` / `queued` / `rejected`；没有总线时返回 `rejected`）
 */
export function dispatchOp(op: PresentationOp): string {
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
function dispatchOps(ops: readonly PresentationOp[]): string[] {
  const results: string[] = [];
  for (const op of ops) {
    void presentation?.prepare(op);
    results.push(dispatchOp(op));
  }
  return results;
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
    priority: 1,
    fadeMs: 0,
    reason: 'api:setExpression',
  });
  renderHint(candidate);
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
 * 开始拖拽。
 *
 * @param event 指针事件
 */
function beginDrag(event: PointerEvent): void {
  if (event.button !== 0 || dragging) return;
  const bridge = petBridge();
  dragging = true;
  powerPolicy?.update({ dragging: true });
  artElement?.classList.add('is-dragging');
  // 行为层同步进入 drag：拖拽期间不该触发睡眠（也不该被眨眼打断）
  if (behavior) dispatchOps(behavior.handle('drag-start'));
  // 指针捕获：光标移动快于窗口时事件也不会丢，否则会出现「甩一下就掉」。
  // 捕获失败（指针 id 已失效等）不能中断拖拽本身，故吞掉异常。
  try {
    artElement?.setPointerCapture(event.pointerId);
  } catch {
    // 忽略：拿不到捕获时仍能靠 window 上的 pointermove 拖动
  }
  void bridge?.startDrag({ cursorX: Math.round(event.screenX), cursorY: Math.round(event.screenY) });
}

/**
 * 拖拽中上报位置。
 *
 * <p>抬起按键但没收到 pointerup（例如在窗口外松开）时，靠 `buttons === 0` 兜底结束，
 * 否则会卡在「一直跟着鼠标走」的状态。</p>
 *
 * @param event 指针事件
 */
function trackDrag(event: PointerEvent): void {
  if (!dragging) return;
  if (event.buttons === 0) {
    endDrag(event.pointerId);
    return;
  }
  scheduleMoveReport({ cursorX: Math.round(event.screenX), cursorY: Math.round(event.screenY) });
}

/**
 * 结束拖拽。
 *
 * @param pointerId 需要释放捕获的指针 id
 */
function endDrag(pointerId: number): void {
  if (!dragging) return;
  dragging = false;
  powerPolicy?.update({ dragging: false });
  artElement?.classList.remove('is-dragging');
  // 行为层回到 idle（先落桥接 idle，等 drag 的高优先级记录过期再落到常驻 idle）
  if (behavior) dispatchOps(behavior.handle('drag-end'));
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
 * @param detail 失败原因
 */
function renderArtError(detail: string): void {
  if (!artElement) return;
  const box = document.createElement('div');
  box.className = 'pet-art-error';
  box.textContent = `立绘加载失败：${detail}`;
  artElement.replaceChildren(box);
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

  const close = document.createElement('button');
  close.className = 'pet-close';
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭桌宠');
  close.addEventListener('click', (event) => {
    // 关闭按钮不能顺带触发拖拽
    event.stopPropagation();
    void petBridge()?.close();
  });

  // 调试标记与提示行**只在调试态创建**：发布态零调试元素（用户明确要求"别再露调试标记"）
  artElement.append(front, back, close);
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

    const hint = document.createElement('span');
    hint.className = 'pet-hint';
    hintElement = hint;

    artElement.append(badge, hint);
  }

  sway.appendChild(artElement);
  motion.appendChild(sway);
  stage.appendChild(motion);
  root.replaceChildren(stage);

  // 立绘解码完成后再上屏（失败/超时换档降级，最终失败才显示错误提示）
  void startArtLoad();
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
  renderHint('neutral');
}

/** 绑定鼠标与指针事件。 */
function wireEvents(): void {
  if (!artElement) return;

  window.addEventListener('mousemove', (event) => {
    hitPipeline?.schedule(event.clientX, event.clientY);
  }, { passive: true });

  // 光标离开窗口时没有 mousemove 了，必须主动回到穿透态，否则窗口会一直「可交互」
  document.addEventListener('mouseleave', () => hitPipeline?.reset(), { passive: true });

  artElement.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    // 二道门：DOM 事件已经落在立绘箱上，但立绘箱比可见轮廓大一圈（透明留白），
    // 再用命中实现判一次，避免"点在猫旁边的空气里也能把窗口拖走"
    if (!(hitTester?.test(event.clientX, event.clientY) ?? false)) return;
    // 点一下 = 一次行为事件。由状态机决定是"开心一弹"还是"连点生气"还是"惊醒"，
    // 这里不再直接拼表现层指令——否则连点计数只能散在事件回调里。
    if (behavior) {
      for (const op of behavior.handle('tap')) {
        void presentation?.prepare(op);
        dispatchOp(op);
      }
    } else {
      for (const op of router?.route({ type: 'play', motion: 'tap', reason: 'pointer:tap' }) ?? []) {
        dispatchOp(op);
      }
    }
    beginDrag(event);
  });
  window.addEventListener('pointermove', trackDrag, { passive: true });
  window.addEventListener('pointerup', (event) => endDrag(event.pointerId));
  window.addEventListener('pointercancel', (event) => endDrag(event.pointerId));

  // 双击隐藏：验证「能关掉」的最短路径（托盘菜单可以再打开）
  artElement.addEventListener('dblclick', () => {
    void petBridge()?.close();
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
    // 层挂到 `.pet-art` 上：它与压平帧同框，分层件的整画布坐标才对得上（零标定）
    layerHost: (artElement as unknown as ElementLike | null) ?? undefined,
    frames,
    geometry: PET_GEOMETRY,
    catalog: MOTION_CATALOG,
    expressionUrls: EXPRESSION_URLS,
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

  // 睡眠判定同时看"表情"与"行为状态"：行为层睡着时表情可能还没切过去，
  // 只靠表情会让眨眼在入睡那一瞬间继续闪一下。
  const sleepingNow = (): boolean => {
    if (behavior?.isSleeping === true) return true;
    const expression = presentation?.state.expression ?? 'neutral';
    return expression === PET_BLINK_MAPPING.half || expression === 'yawn';
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

  // 行为推进：250ms 一拍足够（最短的状态时长是 250ms 的桥接），
  // 比起每条转移各挂一个定时器，单拍轮询更好测也更好停。
  behaviorTimer = window.setInterval(() => {
    if (!behavior) return;
    for (const op of behavior.tick()) {
      void presentation?.prepare(op);
      dispatchOp(op);
    }
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
  // 命中先建：它不依赖 DOM，几何一注入就能判
  hitTester = new RectHitTester(PET_GEOMETRY);
  hitPipeline = new HitPipeline(hitTester, { onHitChange: reportHit });
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
  });
  if (DEBUG_ENABLED) {
    window.petDebug = {
      dispatch: dispatchOp,
      setExpression,
      getExpression,
      list: () => [...EXPRESSION_IDS],
      behaviorState: () => behavior?.state ?? 'idle',
      tap: () => (behavior ? dispatchOps(behavior.handle('tap')) : []),
      compositeMode: () => compositePlan?.mode ?? 'composite',
      layerIds: () => [...layerViews.keys()],
    };
  }
}

boot();
