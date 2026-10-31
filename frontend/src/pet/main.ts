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
import { DEFAULT_TIMER_PORT, PresentationBus } from './presentation/bus';
import { BlinkDriver } from './presentation/blink-driver';
import { CommandRouter } from './presentation/command-router';
import { SpritePresentation, type ExpressionUrlMap } from './presentation/sprite-presentation';
import { EXPRESSION_IDS, type ExpressionId, type PresentationOp } from './presentation/types';

/** 立绘资源：v2 正立图（1024×1536 母版 → 320×480 @2x WebP，等比 contain 显示到 156×234 立绘箱）。 */
const ART_URL = 'lxa://pet-v2/front-standing@2x.webp';

/**
 * 表情贴片 URL 表（与立绘同画布同位置）。
 *
 * <p>本批美术侧未交付 8 格同画布贴片，故表为空：表现层会把表情降级成"只改状态、
 * 保持立绘自带脸"，并在 `?debug=1` 下打日志。T05 的资产清单落地后由 `assets/manifest.ts` 填充。</p>
 */
const EXPRESSION_URLS: ExpressionUrlMap = {};

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

/** 表现层：指令 → 界面写入。 */
let presentation: SpritePresentation | null = null;
/** 调度总线：打断判定 + 层 TTL。 */
let bus: PresentationBus | null = null;
/** 指令路由：`pet:command` → op。 */
let router: CommandRouter | null = null;
/** 眨眼调度器（发布态也开，它是"活"感的主要来源）。 */
let blinkDriver: BlinkDriver | null = null;

/** 每帧最多上报一次命中状态，避免鼠标移动把 IPC 打满。 */
let hitFrame = 0;
let pendingHitPoint: { x: number; y: number } | null = null;

/** 拖拽时同样按帧节流位置上报。 */
let moveFrame = 0;
let pendingMovePoint: PetPoint | null = null;

/** 关键 DOM 引用（构建时赋值，之后只读）。 */
let artElement: HTMLDivElement | null = null;
let faceElement: HTMLImageElement | null = null;
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
  return bus.dispatch(op);
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
 * 判断光标是否落在立绘的可见包围盒（矩形）内。
 *
 * <p>这是 T02 之前的兜底：矩形比真实轮廓大，圆角与尾巴的空隙也会被判成命中。
 * 换成 alpha 掩码后这里改查网格即可，调用方不用动。</p>
 *
 * @param clientX 视口坐标
 * @param clientY 视口坐标
 * @returns 是否命中
 */
function isInsideHitRect(clientX: number, clientY: number): boolean {
  if (!artElement) return false;
  const rect = artElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

/**
 * 按帧调度一次命中判定。
 *
 * @param clientX 视口坐标
 * @param clientY 视口坐标
 */
function scheduleHitCheck(clientX: number, clientY: number): void {
  pendingHitPoint = { x: clientX, y: clientY };
  if (hitFrame) return;
  hitFrame = requestAnimationFrame(() => {
    hitFrame = 0;
    const point = pendingHitPoint;
    pendingHitPoint = null;
    if (!point) return;
    reportHit(isInsideHitRect(point.x, point.y));
  });
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
  artElement?.classList.add('is-dragging');
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
  artElement?.classList.remove('is-dragging');
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
  console.warn(`[pet] 立绘加载失败: url=${ART_URL}, detail=${detail}`);
}

/** 构建画面（立绘 + 表情层 + 关闭按钮 + 调试标记）。 */
function buildDom(): void {
  const root = document.getElementById('pet-root');
  if (!root) return;

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

  const image = document.createElement('img');
  image.className = 'pet-art-image';
  image.alt = '';
  image.decoding = 'async';
  image.draggable = false;
  image.addEventListener('error', () => {
    renderArtError('lxa:// 资源读取失败或文件缺失');
  });
  image.src = ART_URL;

  // 表情差分贴片层：与立绘**同画布同位置**，天然对齐（美术贴片未交付前恒 hidden）
  faceElement = document.createElement('img');
  faceElement.className = 'pet-face';
  faceElement.alt = '';
  faceElement.decoding = 'async';
  faceElement.draggable = false;
  // 立绘没加载出来、或没有对应贴片时不显示，避免叠在错误提示上
  faceElement.hidden = true;

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

  badgeElement = document.createElement('span');
  badgeElement.className = 'pet-badge';
  badgeElement.textContent = '穿透中';
  badgeElement.title = '点击循环切表情（手动验收用）';
  badgeElement.addEventListener('click', (event) => {
    // 点调试标记循环切表情：没有行为状态机，这是唯一的手动验收入口
    event.stopPropagation();
    const index = EXPRESSION_IDS.findIndex((item) => item === getExpression());
    const next = EXPRESSION_IDS[(index + 1) % EXPRESSION_IDS.length];
    setExpression(next);
  });

  hintElement = document.createElement('span');
  hintElement.className = 'pet-hint';

  artElement.append(image, faceElement, close, badgeElement, hintElement);
  sway.appendChild(artElement);
  motion.appendChild(sway);
  stage.appendChild(motion);
  root.replaceChildren(stage);

  // 表现层挂好后立刻按基底层渲染一次默认档，保证首帧就是"睁眼默认脸"
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
    scheduleHitCheck(event.clientX, event.clientY);
  }, { passive: true });

  // 光标离开窗口时没有 mousemove 了，必须主动回到穿透态，否则窗口会一直「可交互」
  document.addEventListener('mouseleave', () => reportHit(false), { passive: true });

  artElement.addEventListener('pointerdown', (event) => {
    // 点一下 = 互动（规格书 P1 的简化版：整图一弹 + happy 表情），先派指令再起拖拽
    if (event.button === 0) {
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
      // 主进程回执：以主进程的真实状态为准，避免两边显示不一致
      applyHitState(command.hit === true);
      return;
    }
    if (command.type === 'ready') {
      applyHitState(command.clickThrough !== true);
      return;
    }
    if (command.type === 'visible') {
      console.info(`[pet] 可见性变化: visible=${command.visible === true}`);
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
 * <p>这里也是方案B 的唯一改动点：把 `SpritePresentation` 换成 `Live2DPresentation`，
 * 调度器、指令 id、命中、拖拽、位置持久化全部不动（设计文档 §8.3）。</p>
 */
function createPresentation(): void {
  const root = document.getElementById('pet-root');
  if (!root || !faceElement) return;
  presentation = new SpritePresentation(
    {
      expressionHost: faceElement,
      layerHosts: { root },
      geometry: PET_GEOMETRY,
    },
    {
      expressionUrls: EXPRESSION_URLS,
      log: (message) => console.debug(message),
    },
  );
  bus = new PresentationBus(presentation, {
    log: (message) => console.debug(message),
    isSleeping: () => {
      const expression = presentation?.state.expression ?? 'neutral';
      return expression === 'sleepy' || expression === 'yawn';
    },
  });
  router = new CommandRouter({ log: (message) => console.debug(message) });
  blinkDriver = new BlinkDriver(
    (op) => dispatchOp(op),
    // 随机源显式注入（设计文档 §9.4 纪律 9）：测试里换成固定序列即可断言分布
    () => Math.random(),
    () => {
      const expression = presentation?.state.expression ?? 'neutral';
      return expression === 'sleepy' || expression === 'yawn';
    },
    DEFAULT_TIMER_PORT,
  );
  blinkDriver.start();
}

/** 入口。 */
function boot(): void {
  injectGeometryVariables();
  createPresentation();
  buildDom();
  wireEvents();
  subscribeCommands();
  // 初始一律按穿透渲染：主进程的窗口也是穿透态，两边从第 0 帧就一致
  applyHitState(false);
  // 调试句柄（`?debug=1` 或 dev 才有；发布态不挂 window.petDebug）
  window.petDebug = {
    dispatch: dispatchOp,
    setExpression,
    getExpression,
    list: () => [...EXPRESSION_IDS],
  };
}

boot();
