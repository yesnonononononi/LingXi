/**
 * 桌宠窗口渲染入口（渲染层 v0：静态立绘 + CSS 缓动，不接 Live2D）。
 *
 * <p>不引 Vue：窗口常驻但内容只有一张立绘，装框架只会拖慢首帧、白占内存。</p>
 *
 * <p><b>资源只走 `lxa://`：</b>页面是 `loadFile`/Vite 打开的，`file://` 下 `fetch` 会被 Chromium
 * 拒绝；`lxa://` 协议（`electron/lx-protocol.cjs`）把 `public/live2d` 与 `dist/live2d` 映射成
 * 可 fetch 的 URL，开发态与打包态同一路径。渲染层**不拼绝对路径**。</p>
 *
 * <p><b>命中区当前是矩形兜底：</b>用立绘的可见包围盒做鼠标命中/穿透判断。真正的 alpha 掩码
 * （1/8 降采样网格 + 膨胀滞回）在 T02 接，届时只换 {@link isInsideHitRect} 的实现，
 * {@link applyHitState} 这条链路不动。</p>
 */
import './pet.css';

/** 立绘资源（旋转成竖构图的全身立绘）。 */
const ART_URL = 'lxa://pet-v1/front-master.png';
/** 六格表情图（3 列 × 2 行，每格 512×512，透明底）。 */
const EXPRESSION_SHEET_URL = 'lxa://pet-v1/expressions.png';

/** 六种表情。排列顺序与表情图网格的阅读顺序一致（左→右、上→下）。 */
type ExpressionName = 'default' | 'blink' | 'happy' | 'surprised' | 'sleepy' | 'sad';

/** 表情清单：名字 → 中文标签（标签显示在提示行，手动验收时能确认切到哪一格）。 */
const EXPRESSIONS: readonly { name: ExpressionName; label: string }[] = [
  { name: 'default', label: '默认' },
  { name: 'blink', label: '眨眼' },
  { name: 'happy', label: '开心' },
  { name: 'surprised', label: '惊讶' },
  { name: 'sleepy', label: '困倦' },
  { name: 'sad', label: '委屈' },
];

/** 主进程推来的指令。类型与 `pet-window.cjs` 的 `pet:command` 一一对应。 */
type PetCommand =
  | { type: 'ready'; clickThrough?: boolean; size?: { width: number; height: number } }
  | { type: 'hit-state'; hit?: boolean }
  | { type: 'visible'; visible?: boolean }
  | { type: 'ping'; at?: number };

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

/** 给「后续调度」用的调试句柄（本轮不接调度，只手动验收）。 */
interface PetDebugHandle {
  setExpression: (name: string) => boolean;
  getExpression: () => ExpressionName;
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
/** 当前表情。 */
let currentExpression: ExpressionName = 'default';

/** 每帧最多上报一次命中状态，避免鼠标移动把 IPC 打满。 */
let hitFrame = 0;
let pendingHitPoint: { x: number; y: number } | null = null;

/** 拖拽时同样按帧节流位置上报。 */
let moveFrame = 0;
let pendingMovePoint: PetPoint | null = null;

/** 关键 DOM 引用（构建时赋值，之后只读）。 */
let artElement: HTMLDivElement | null = null;
let faceElement: HTMLDivElement | null = null;
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
 * 更新提示行（显示当前表情，手动验收时能直接看出切到哪一格）。
 *
 * @param name 表情名
 */
function renderHint(name: ExpressionName): void {
  if (!hintElement) return;
  const label = EXPRESSIONS.find((item) => item.name === name)?.label ?? '默认';
  hintElement.textContent = `拖动移动 · 双击隐藏 · 表情：${label}`;
}

/**
 * 切换表情（供后续调度用的公开接口）。
 *
 * <p>本轮不接任何调度逻辑：谁触发、什么时候触发都在下一阶段决定。这里只保证
 * 「合法名字一定切换成功、非法名字一律忽略并返回 false」，避免调用方拿到静默的假成功。</p>
 *
 * @param name 表情名（六档之一）
 * @returns 是否切换成功
 */
export function setExpression(name: string): boolean {
  const matched = EXPRESSIONS.find((item) => item.name === name);
  if (!matched) {
    console.warn(`[pet] 未知表情，已忽略: name=${name}`);
    return false;
  }
  currentExpression = matched.name;
  if (faceElement) {
    // 一次只挂一个状态类，避免多个 is-* 同时存在时背景位置互相覆盖
    for (const item of EXPRESSIONS) {
      faceElement.classList.toggle(`is-${item.name}`, item.name === matched.name);
    }
  }
  renderHint(matched.name);
  return true;
}

/** 读当前表情（调试/验收用）。 */
export function getExpression(): ExpressionName {
  return currentExpression;
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
  image.addEventListener('load', () => {
    // 图片解码完成后再挂表情层：先挂会出现「脸先出来、身体还没出来」的闪动
    if (faceElement) faceElement.hidden = false;
  });
  image.addEventListener('error', () => {
    renderArtError('lxa:// 资源读取失败或文件缺失');
  });
  image.src = ART_URL;

  faceElement = document.createElement('div');
  faceElement.className = 'pet-face is-default';
  faceElement.style.backgroundImage = `url("${EXPRESSION_SHEET_URL}")`;
  // 立绘没加载出来之前不显示表情层，避免叠在错误提示上
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
  badgeElement.title = '点击切换表情（手动验收用）';
  badgeElement.addEventListener('click', (event) => {
    // 点调试标记循环切表情：本轮没有调度逻辑，这是唯一的手动验收入口
    event.stopPropagation();
    const index = EXPRESSIONS.findIndex((item) => item.name === currentExpression);
    const next = EXPRESSIONS[(index + 1) % EXPRESSIONS.length];
    setExpression(next.name);
  });

  hintElement = document.createElement('span');
  hintElement.className = 'pet-hint';

  artElement.append(image, faceElement, close, badgeElement, hintElement);
  sway.appendChild(artElement);
  motion.appendChild(sway);
  stage.appendChild(motion);
  root.replaceChildren(stage);

  // 表情层挂好后立刻按默认档渲染一次，保证「默认显示第 1 格」
  setExpression('default');
}

/** 绑定鼠标与指针事件。 */
function wireEvents(): void {
  if (!artElement) return;

  window.addEventListener('mousemove', (event) => {
    scheduleHitCheck(event.clientX, event.clientY);
  }, { passive: true });

  // 光标离开窗口时没有 mousemove 了，必须主动回到穿透态，否则窗口会一直「可交互」
  document.addEventListener('mouseleave', () => reportHit(false), { passive: true });

  artElement.addEventListener('pointerdown', beginDrag);
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
    }
  });
}

/** 入口。 */
function boot(): void {
  buildDom();
  wireEvents();
  subscribeCommands();
  // 初始一律按穿透渲染：主进程的窗口也是穿透态，两边从第 0 帧就一致
  applyHitState(false);
  // 调试句柄：本轮不接调度，仅便于手动验收与后续对接
  window.petDebug = {
    setExpression,
    getExpression,
    list: () => EXPRESSIONS.map((item) => item.name),
  };
}

boot();
