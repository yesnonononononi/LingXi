import { buildPetSvg } from './pet.mjs';
import { CSS_VARS } from './palette.mjs';
import { PetState, ACTION } from './state.mjs';
import { pickBubble, BUBBLE_DURATION_MS } from './bubbles.mjs';
import { shouldStartDrag, isClick } from './drag.mjs';

const TICK_MS = 1_000;
const BLINK_MIN_MS = 2_400;
const BLINK_MAX_MS = 5_800;
const BLINK_HOLD_MS = 140;

const slot = document.getElementById('pet-slot');
const bubbleEl = document.getElementById('bubble');
const bridge = window.deskpet ?? null;

// 配色以 palette.mjs 为唯一真源，运行时写进 CSS 变量
for (const [name, value] of Object.entries(CSS_VARS)) {
  document.documentElement.style.setProperty(name, value);
}

slot.innerHTML = buildPetSvg();
const svg = document.getElementById('pet-svg');

const state = new PetState();

let dragging = false;
let pressAt = 0;
let pressX = 0;
let pressY = 0;
let transientFace = null;
let bubbleTimer = 0;
let bubbleHideTimer = 0;

function renderFace() {
  svg.dataset.face = transientFace ?? state.face;
}

function renderAction() {
  svg.dataset.action = state.action;
}

function render() {
  renderAction();
  renderFace();
}

function say(text) {
  bubbleEl.textContent = text;
  bubbleEl.hidden = false;
  // 先挂到 DOM 再加可见类，保证 opacity 过渡真的跑起来
  requestAnimationFrame(() => bubbleEl.classList.add('is-visible'));

  clearTimeout(bubbleTimer);
  clearTimeout(bubbleHideTimer);
  bubbleTimer = setTimeout(() => {
    bubbleEl.classList.remove('is-visible');
    bubbleHideTimer = setTimeout(() => {
      bubbleEl.hidden = true;
    }, 220);
  }, BUBBLE_DURATION_MS);
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function flashFace(face, holdMs) {
  transientFace = face;
  renderFace();
  setTimeout(() => {
    transientFace = null;
    renderFace();
  }, holdMs);
}

function handleTap() {
  const snapshot = state.tap();
  render();
  say(pickBubble(snapshot.face, randomInt));
}

function startDrag() {
  dragging = true;
  document.body.classList.add('is-dragging');
  state.dragStart();
  render();
  say(pickBubble('shy', randomInt));
  bridge?.dragStart();
}

function endDrag() {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('is-dragging');
  state.dragEnd();
  render();
  bridge?.dragEnd();
}

// ---------- 指针交互 ----------
svg.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  pressAt = performance.now();
  pressX = event.screenX;
  pressY = event.screenY;
});

window.addEventListener('pointermove', (event) => {
  if (pressAt === 0 || dragging) return;
  if (shouldStartDrag(event.screenX - pressX, event.screenY - pressY)) {
    startDrag();
    // 拖动由主进程轮询光标驱动，这里释放指针捕获避免重复处理
    if (svg.hasPointerCapture?.(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId);
    }
  }
});

window.addEventListener('pointerup', (event) => {
  if (pressAt === 0) return;
  const elapsed = performance.now() - pressAt;
  const dx = event.screenX - pressX;
  const dy = event.screenY - pressY;
  pressAt = 0;

  if (dragging) {
    endDrag();
    return;
  }
  if (isClick(elapsed, dx, dy)) {
    handleTap();
  }
});

// 鼠标在窗口外松开 / 窗口失焦时，pointerup 收不到，必须兜底收尾
window.addEventListener('pointercancel', () => {
  pressAt = 0;
  endDrag();
});
window.addEventListener('blur', () => {
  pressAt = 0;
  endDrag();
});

window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  bridge?.openMenu();
});

// ---------- 心跳 ----------
let lastAction = state.action;

setInterval(() => {
  const snapshot = state.tick();
  if (snapshot.action !== lastAction) {
    lastAction = snapshot.action;
    if (snapshot.action === ACTION.SLEEP) {
      say(pickBubble('sleepy', randomInt));
    }
  }
  render();
}, TICK_MS);

// ---------- 眨眼 ----------
function scheduleBlink() {
  const delay = BLINK_MIN_MS + randomInt(BLINK_MAX_MS - BLINK_MIN_MS);
  setTimeout(() => {
    const canBlink = state.face === 'normal' && state.action === ACTION.IDLE && !dragging;
    if (canBlink) {
      flashFace('blink', BLINK_HOLD_MS);
    }
    scheduleBlink();
  }, delay);
}

// ---------- 启动 ----------
async function bootstrap() {
  if (bridge) {
    const config = await bridge.getConfig();
    if (config?.alwaysOnTop === false) {
      document.body.classList.add('is-unpinned');
    }
  }
  render();
  scheduleBlink();
}

bootstrap();
