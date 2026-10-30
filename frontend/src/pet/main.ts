/**
 * 桌宠窗口的渲染入口（阶段一：假宠物占位，验证手感）。
 *
 * <p>刻意不引 Vue，理由与通知窗口相同：这个窗口常驻但内容极少，装一整套框架只会让
 * 首帧更慢、内存更高。它也不做任何业务请求，只做三件事：报告鼠标命中、发起拖拽、显示状态。</p>
 *
 * <p><b>命中区为什么按几何圆形算而不用 `elementFromPoint`：</b>Live2D 模型将来的命中区是
 * 模型轮廓/包围盒，几何判定与它同构；用 `elementFromPoint` 会把圆外的透明像素所含元素也算成可点，
 * 而且窗口一旦处于穿透态就拿不到真实 DOM 命中，行为会随状态漂移。</p>
 *
 * <p><b>拖拽为什么不用 `-webkit-app-region: drag`：</b>透明窗口上的 app-region 拖拽在 Windows 上
 * 会连带吃掉鼠标事件，导致命中区判定与「拖到边缘夹紧」都无法实现；而且拖拽期间拿不到位置回执，
 * 也就没法按屏幕边界夹紧。自定义拖拽（渲染层上报光标 → 主进程 setPosition）才是可控的。</p>
 */
import './pet.css';

/** 主进程推来的指令。类型与 `pet-window.cjs` 的 `pet:command` 一一对应。 */
type PetCommand =
  | { type: 'ready'; clickThrough?: boolean; size?: { width: number; height: number } }
  | { type: 'hit-state'; hit?: boolean }
  | { type: 'visible'; visible?: boolean }
  | { type: 'ping'; at?: number };

/** 拖拽上报的坐标（屏幕坐标，单位与窗口位置一致）。 */
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

declare global {
  interface Window {
    petAPI?: PetBridge;
  }
}

/** 当前是否处于「可交互」状态（true = 主进程已关掉穿透）。 */
let hit = false;
/** 是否正在拖拽。 */
let dragging = false;

/** 每帧最多上报一次命中状态，避免鼠标移动把 IPC 打满。 */
let hitFrame = 0;
let pendingHitPoint: { x: number; y: number } | null = null;

/** 拖拽时同样按帧节流位置上报。 */
let moveFrame = 0;
let pendingMovePoint: PetPoint | null = null;

/** 关键 DOM 引用（构建时赋值，之后只读）。 */
let petElement: HTMLDivElement | null = null;
let badgeElement: HTMLSpanElement | null = null;

/** 取桥；拿不到时返回 null（纯浏览器里打开 pet.html 也能看见画面，便于排查）。 */
function petBridge(): PetBridge | null {
  return window.petAPI ?? null;
}

/**
 * 更新界面上的调试标记。
 *
 * <p>这个标记是「手感验收」的主要依据：鼠标移到宠物上，它必须从「穿透中」变成「可交互」，
 * 移开又变回去。没有它就只能靠「点一下有没有反应」猜。</p>
 *
 * @param next 是否可交互
 */
function renderHitState(next: boolean): void {
  hit = next;
  if (petElement) {
    petElement.classList.toggle('is-hit', next);
  }
  if (badgeElement) {
    badgeElement.textContent = next ? '可交互' : '穿透中';
    badgeElement.classList.toggle('is-hit', next);
  }
}

/**
 * 上报命中状态（去重后才发 IPC）。
 *
 * @param next 是否可交互
 */
function reportHit(next: boolean): void {
  if (next === hit) return;
  const bridge = petBridge();
  if (!bridge) {
    renderHitState(next);
    return;
  }
  renderHitState(next);
  bridge.setHit(next);
}

/**
 * 判断光标是否落在假宠物本体（圆形）内。
 *
 * @param clientX 视口坐标
 * @param clientY 视口坐标
 * @returns 是否命中
 */
function isInsidePet(clientX: number, clientY: number): boolean {
  if (!petElement) return false;
  const rect = petElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const radius = Math.min(rect.width, rect.height) / 2;
  const dx = clientX - centerX;
  const dy = clientY - centerY;
  return dx * dx + dy * dy <= radius * radius;
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
    reportHit(isInsidePet(point.x, point.y));
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

/** 开始拖拽。 */
function beginDrag(event: PointerEvent): void {
  if (event.button !== 0 || dragging) return;
  const bridge = petBridge();
  dragging = true;
  petElement?.classList.add('is-dragging');
  // 指针捕获：光标移动快于窗口时事件也不会丢，否则会出现「甩一下就掉」。
  // 捕获失败（指针 id 已失效等）不能中断拖拽本身，故吞掉异常。
  try {
    petElement?.setPointerCapture(event.pointerId);
  } catch {
    // 忽略：拿不到捕获时仍能靠 window 上的 pointermove 拖动
  }
  // 命中区已经确认（否则这个 pointerdown 根本到不了），这里不必再报一次
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
  petElement?.classList.remove('is-dragging');
  try {
    if (petElement?.hasPointerCapture(pointerId)) {
      petElement.releasePointerCapture(pointerId);
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

/** 构建占位画面（假宠物 + 调试标记）。 */
function buildDom(): void {
  const root = document.getElementById('pet-root');
  if (!root) return;

  const stage = document.createElement('div');
  stage.className = 'pet-stage';

  petElement = document.createElement('div');
  petElement.className = 'pet';
  petElement.setAttribute('role', 'img');
  petElement.setAttribute('aria-label', 'LX 桌宠');

  const face = document.createElement('div');
  face.className = 'pet-face';
  const leftEye = document.createElement('span');
  leftEye.className = 'eye left';
  const rightEye = document.createElement('span');
  rightEye.className = 'eye right';
  const mouth = document.createElement('span');
  mouth.className = 'mouth';
  face.append(leftEye, rightEye, mouth);

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

  const hint = document.createElement('span');
  hint.className = 'pet-hint';
  hint.textContent = '拖动移动 · 双击隐藏';

  petElement.append(face, close, badgeElement, hint);
  stage.appendChild(petElement);
  root.replaceChildren(stage);
}

/** 绑定鼠标与指针事件。 */
function wireEvents(): void {
  if (!petElement) return;

  window.addEventListener('mousemove', (event) => {
    scheduleHitCheck(event.clientX, event.clientY);
  }, { passive: true });

  // 光标离开窗口时没有 mousemove 了，必须主动回到穿透态，否则窗口会一直「可交互」
  document.addEventListener('mouseleave', () => reportHit(false), { passive: true });

  petElement.addEventListener('pointerdown', beginDrag);
  window.addEventListener('pointermove', trackDrag, { passive: true });
  window.addEventListener('pointerup', (event) => endDrag(event.pointerId));
  window.addEventListener('pointercancel', (event) => endDrag(event.pointerId));

  // 双击隐藏：验证「能关掉」的最短路径（托盘菜单可以再打开）
  petElement.addEventListener('dblclick', () => {
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
      renderHitState(command.hit === true);
      return;
    }
    if (command.type === 'ready') {
      renderHitState(command.clickThrough !== true);
      return;
    }
    if (command.type === 'visible') {
      console.info(`[pet] 可见性变化: visible=${command.visible === true}`);
    }
  });
}

/** 入口。 */
function boot(): void {
  buildDom();
  wireEvents();
  subscribeCommands();
  // 初始一律按穿透渲染：主进程的窗口也是穿透态，两边从第 0 帧就一致
  renderHitState(false);
}

boot();
