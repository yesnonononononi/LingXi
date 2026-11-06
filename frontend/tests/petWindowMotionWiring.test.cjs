#!/usr/bin/env node
/**
 * M3 S4 · `pet-window.cjs` ↔ `MotionController` 的**端到端接线**单测。
 *
 * <p><b>为什么必须真跑窗口：</b>本切片最容易坏的地方不是纯函数，而是接线顺序——
 * "拖拽开始时到底有没有把运动的回调摘掉""隐藏时到底有没有停表""右键菜单的模板到底出自
 * 哪一份"。这些只有把 `registerPetWindow().create()` 真跑起来（假 electron + 手动时钟）
 * 才能断言。</p>
 *
 * <p><b>单写者的两条静态钉子也在这里：</b>①`pet-window.cjs` 里按坐标移动窗口的调用出现
 * **0** 次（位置只能经 `applyPetPosition` → 由运动层独占调用）；②它对 `pet-motion.cjs` 的
 * require 必须在**函数体内**（与 `pet-geometry.json` 同构的打包不变式，H6/G-M11）。</p>
 *
 * @module tests/petWindowMotionWiring
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');

const petWindow = require(path.join(__dirname, '..', 'electron', 'pet-window.cjs'));
const { MENU_LABELS, MENU_IDS } = require(path.join(__dirname, '..', 'electron', 'pet-menu.cjs'));
const { OWNER_TOKENS } = require(path.join(__dirname, '..', 'electron', 'pet-motion.cjs'));
const { makeStage, withPetWindow } = require('./helpers/petWindowHarness.cjs');

const { ART_ORIGIN, ART_WIDTH, ART_HEIGHT } = petWindow;

/** 一拍（毫秒）：手动时钟每次只推一格，才能让每个 tick 都真的触发一次轮询。 */
const TICK = 16;

/**
 * 造一个内存偏好端口（**与 `main.cjs` 注入的端口同形状**）。
 *
 * @param {object} [initial] 初始偏好
 * @returns {object} `{port, set, get}`：端口本体 + 测试用的旁路设置/读取
 */
function makePrefsPort(initial) {
  const listeners = new Set();
  let current = { version: 1, follow: false, roam: true, ...(initial || {}) };
  const notify = () => {
    for (const listener of [...listeners]) listener({ ...current });
  };
  const port = {
    getPrefs: () => ({ ...current }),
    setPrefs: (patch) => {
      const next = { ...current };
      if (patch && typeof patch.follow === 'boolean') next.follow = patch.follow;
      if (patch && typeof patch.roam === 'boolean') next.roam = patch.roam;
      const changed = next.follow !== current.follow || next.roam !== current.roam;
      current = next;
      if (changed) notify();
      return { prefs: { ...current }, ok: true, problems: [], changed };
    },
    onPrefsChange: (listener) => {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    port,
    get: () => ({ ...current }),
    set: (next) => {
      current = { ...current, ...next };
      notify();
    },
    listenerCount: () => listeners.size,
  };
}

/** 宠物中心（窗口坐标 → 屏幕坐标）。 */
function petCenter(win) {
  const bounds = win.getBounds();
  return {
    x: bounds.x + ART_ORIGIN.x + ART_WIDTH / 2,
    y: bounds.y + ART_ORIGIN.y + ART_HEIGHT / 2,
  };
}

/** 把光标放到宠物中心右侧 `distance` DIP。 */
function moveCursorRight(stage, win, distance) {
  const center = petCenter(win);
  stage.state.cursor = { x: center.x + distance, y: center.y };
}

// ---------------------------------------------------------------- 静态钉子（单写者 / H6）

test('单写者（静态）：pet-window.cjs 里按坐标移动窗口的调用必须 0 次', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'pet-window.cjs'), 'utf8');
  const hits = source.split('setPosition').length - 1;
  assert.equal(
    hits,
    0,
    `pet-window.cjs 出现了 ${hits} 次 setPosition：位置写入点必须收敛到 applyPetPosition（唯一写口，由 MotionController 独占调用）`,
  );
});

test('H6/G-M11（静态）：对 pet-motion.cjs 的 require 必须在函数体内（门禁关闭时不加载）', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'pet-window.cjs'), 'utf8');
  const lines = source.split(/\r?\n/);
  const matches = lines.filter((line) => line.includes("require('./pet-motion.cjs')"));
  assert.equal(matches.length, 1, `必须恰好一处（实际 ${matches.length}）`);
  const line = matches[0];
  assert.ok(
    /^\s+/.test(line),
    `require('./pet-motion.cjs') 不许写在顶层（当前行：${line.trim()}）——打包版桌宠恒关，靠"条件路径上才加载"才不崩`,
  );
  const indexOfLine = lines.indexOf(line);
  const before = lines.slice(Math.max(0, indexOfLine - 8), indexOfLine).join('\n');
  assert.match(before, /function motionApi\(/, '必须包在 motionApi() 函数体内（与 pet-geometry 的条件 require 同构）');
});

test('G-M9（静态）：pet-window.cjs 不许再出现任何菜单文案字面量', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'pet-window.cjs'), 'utf8');
  for (const label of Object.values(MENU_LABELS)) {
    assert.equal(
      source.includes(label),
      false,
      `pet-window.cjs 出现了菜单文案「${label}」：文案的唯一真源是 pet-menu.cjs（第二份真源早晚漂移）`,
    );
  }
});

// ---------------------------------------------------------------- 跟随接线（IPC → 运动层 → 窗口）

test('跟随接线（真跑）：pet:motion-intent 受理后按拍移动窗口，快照与下发都对', () => {
  const stage = makeStage(null);
  const prefs = makePrefsPort({ follow: true });
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc, clock, state }) => {
        const event = ipc.eventFor(win);
        assert.deepEqual(ipc.invoke('pet:motion-intent', { mode: 'follow', reason: 'dev' }, event), { ok: true });
        assert.equal(controller.motionSnapshot().mode, 'follow');
        assert.equal(controller.motionSnapshot().owner, OWNER_TOKENS.LOCOMOTION);

        moveCursorRight(stage, win, 300);
        const startX = win.getBounds().x;
        const movesBefore = state.moves.length;
        for (let index = 0; index < 20; index += 1) clock.tick(TICK);

        assert.ok(state.moves.length > movesBefore, '跟随必须真的移动窗口');
        const snapshot = controller.motionSnapshot();
        assert.equal(snapshot.owner, 'locomotion');
        assert.ok(snapshot.samples >= 20, `每拍都要采样（实际 ${snapshot.samples}）`);
        assert.ok(win.getBounds().x > startX, '光标在右侧 ⇒ 窗口必须向右走');

        const facts = state.sent.filter((entry) => entry.payload && entry.payload.type === 'motion').map((entry) => entry.payload);
        assert.ok(facts.length > 0, '运动事实必须下发给渲染层（否则姿态不会切 walk）');
        assert.ok(facts.some((fact) => fact.phase === 'moving' && fact.gait !== 'none'));
      },
      { prefs: prefs.port },
    );
  } finally {
    stage.cleanup();
  }
});

test('拖拽抢占（真跑）：drag-start 之后运动 0 采样 0 写入，drag-move 才动，drag-end 交还写入权', () => {
  const stage = makeStage(null);
  const prefs = makePrefsPort({ follow: true });
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc, clock, state }) => {
        const event = ipc.eventFor(win);
        ipc.invoke('pet:motion-intent', { mode: 'follow', reason: 'dev' }, event);
        moveCursorRight(stage, win, 300);
        for (let index = 0; index < 10; index += 1) clock.tick(TICK);
        const beforeDrag = controller.motionSnapshot();
        assert.ok(beforeDrag.samples > 0);

        const bounds = win.getBounds();
        assert.deepEqual(
          ipc.invoke('pet:drag-start', { cursorX: bounds.x + 40, cursorY: bounds.y + 40 }, event),
          { ok: true },
        );
        const dragging = controller.motionSnapshot();
        assert.equal(dragging.owner, OWNER_TOKENS.DRAG, '拖拽期间写入权必须归拖拽');

        const movesAtDrag = state.moves.length;
        moveCursorRight(stage, win, 900);
        for (let index = 0; index < 30; index += 1) clock.tick(TICK);
        assert.equal(controller.motionSnapshot().samples, dragging.samples, '拖拽期间运动 0 采样');
        assert.equal(controller.motionSnapshot().ticks, dragging.ticks, '拖拽期间连受理的拍都不许涨');
        assert.equal(state.moves.length, movesAtDrag, '拖拽期间运动 0 写入（回调已被摘掉）');

        // 拖拽自己的移动不受影响
        ipc.send('pet:drag-move', { cursorX: bounds.x + 400, cursorY: bounds.y + 120 }, event);
        assert.equal(state.moves.length, movesAtDrag + 1, 'drag-move 必须真的移动窗口');
        assert.notEqual(win.getBounds().x, bounds.x);

        ipc.invoke('pet:drag-end', undefined, event);
        const after = controller.motionSnapshot();
        assert.equal(after.owner, OWNER_TOKENS.LOCOMOTION, '松手后写入权必须还给运动');
        const ticksAtRelease = after.ticks;
        clock.tick(TICK);
        assert.ok(controller.motionSnapshot().ticks > ticksAtRelease, '松手后必须重新开始受理拍');
      },
      { prefs: prefs.port },
    );
  } finally {
    stage.cleanup();
  }
});

test('隐藏停表（真跑）：hide() 后 100 拍 0 采样 0 写入，show() 后一拍收敛', () => {
  const stage = makeStage(null);
  const prefs = makePrefsPort({ follow: true });
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc, clock, state }) => {
        const event = ipc.eventFor(win);
        ipc.invoke('pet:motion-intent', { mode: 'follow', reason: 'dev' }, event);
        moveCursorRight(stage, win, 300);
        for (let index = 0; index < 5; index += 1) clock.tick(TICK);
        const before = controller.motionSnapshot();
        assert.ok(before.ticks > 0);

        controller.hide();
        const hidden = controller.motionSnapshot();
        assert.match(hidden.suspendReason, /hidden/, '运动层必须知道自己被挂起了');
        const movesAtHide = state.moves.length;
        for (let index = 0; index < 100; index += 1) clock.tick(TICK);
        const during = controller.motionSnapshot();
        assert.equal(during.ticks, hidden.ticks, '隐藏期间 ticks 不许涨');
        assert.equal(during.samples, hidden.samples, '隐藏期间 samples 不许涨');
        assert.equal(state.moves.length, movesAtHide, '隐藏期间一次都不许写位置');

        controller.show();
        moveCursorRight(stage, win, 300);
        clock.tick(TICK);
        assert.ok(controller.motionSnapshot().ticks > during.ticks, '显示后一拍就收敛');
      },
      { prefs: prefs.port },
    );
  } finally {
    stage.cleanup();
  }
});

test('reduced-motion（真跑）：系统关闭动画效果 ⇒ 拒绝开启跟随，且一条订阅都没有', () => {
  const stage = makeStage(null);
  const prefs = makePrefsPort({ follow: true });
  stage.state.shouldRenderRichAnimation = false;
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc, clock, state }) => {
        const event = ipc.eventFor(win);
        const result = ipc.invoke('pet:motion-intent', { mode: 'follow', reason: 'dev' }, event);
        assert.equal(result.ok, false);
        assert.match(result.error, /减少动态/);
        assert.equal(controller.motionSnapshot().mode, 'off');
        const movesBefore = state.moves.length;
        moveCursorRight(stage, win, 600);
        for (let index = 0; index < 20; index += 1) clock.tick(TICK);
        assert.equal(state.moves.length, movesBefore, '被拒之后一拍都不许动');
      },
      { prefs: prefs.port },
    );
  } finally {
    stage.cleanup();
  }
});

// ---------------------------------------------------------------- 右键菜单（同源 + 例外②）

test('右键菜单（真跑）：模板出自 pet-menu，勾选态来自偏好，点击走偏好端口', () => {
  const stage = makeStage(null);
  const prefs = makePrefsPort({ follow: true, roam: false });
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc, state }) => {
        const event = ipc.eventFor(win);
        ipc.send('pet:context-menu', undefined, event);

        const template = state.menuTemplate;
        assert.ok(Array.isArray(template), '必须真的调 Menu.buildFromTemplate');
        assert.deepEqual(
          template.filter((item) => item && item.id).map((item) => item.id),
          [MENU_IDS.TOGGLE_VISIBLE, MENU_IDS.FOLLOW, MENU_IDS.ROAM, MENU_IDS.CLOSE_PET, MENU_IDS.QUIT_APP],
          '右键菜单的结构与 id 必须与 pet-menu 的定义一致（不许另写模板）',
        );
        const followItem = template.find((item) => item.id === MENU_IDS.FOLLOW);
        const roamItem = template.find((item) => item.id === MENU_IDS.ROAM);
        assert.equal(followItem.checked, true, '勾选态必须来自偏好（follow=true）');
        assert.equal(roamItem.checked, false, '勾选态必须来自偏好（roam=false）');
        assert.equal(followItem.label, MENU_LABELS.follow, '文案必须来自 pet-menu 的常量');

        // 菜单打开期间：例外② 强制可交互 + 运动停住
        assert.equal(state.menuPopups.length, 1, '必须真的 popup 一次');
        assert.ok(
          state.ignoreCalls.some((call) => call.ignore === false),
          '菜单打开期间必须强制可交互（否则菜单项点不到）',
        );
        assert.match(controller.motionSnapshot().suspendReason, /menu/);

        // 点一下「跟随」：走偏好端口（**唯一写入路径**），勾选态立刻取反
        followItem.click();
        assert.equal(prefs.get().follow, false, '菜单点击必须走到偏好端口');

        // 菜单关闭（callback）→ 解除例外②
        state.menuPopups[0].callback();
        assert.equal(controller.motionSnapshot().suspendReason.includes('menu'), false, '菜单关闭后必须解除挂起');
      },
      { prefs: prefs.port },
    );
  } finally {
    stage.cleanup();
  }
});

test('偏好广播（真跑）：变更时下发 pet:command{type:prefs}，且关掉跟随立刻收回运动', () => {
  const stage = makeStage(null);
  const prefs = makePrefsPort({ follow: true });
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc, clock, state }) => {
        const event = ipc.eventFor(win);
        ipc.invoke('pet:motion-intent', { mode: 'follow', reason: 'dev' }, event);
        moveCursorRight(stage, win, 300);
        for (let index = 0; index < 5; index += 1) clock.tick(TICK);
        assert.equal(controller.motionSnapshot().mode, 'follow');

        state.sent.length = 0;
        prefs.set({ follow: false });

        const broadcast = state.sent.filter((entry) => entry.payload && entry.payload.type === 'prefs').pop().payload;
        assert.ok(broadcast, '偏好变更必须广播到渲染层（否则渲染层还按旧偏好请求运动）');
        assert.equal(broadcast.follow, false);
        assert.equal(broadcast.roam, true);
        assert.deepEqual(broadcast.prefs, { follow: false, roam: true }, '设计 §8.2 的载荷形状必须也在');
        assert.equal(controller.motionSnapshot().mode, 'off', '偏好关掉后必须立刻收回运动（不许"猫还在跑"）');
      },
      { prefs: prefs.port },
    );
  } finally {
    stage.cleanup();
  }
});

// ---------------------------------------------------------------- 其余 IPC（§8.1）

test('pet:prefs-set / pet:motion-snapshot / 未授权来源', () => {
  const stage = makeStage(null);
  const prefs = makePrefsPort({ follow: false });
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc }) => {
        const event = ipc.eventFor(win);
        const written = ipc.invoke('pet:prefs-set', { follow: true, roar: 'x' }, event);
        assert.equal(written.ok, true);
        assert.equal(written.prefs.follow, true, '必须转发到偏好端口（类型过滤在端口里）');

        const snapshot = ipc.invoke('pet:motion-snapshot', undefined, event);
        assert.equal(snapshot.mode, 'off');
        assert.equal(snapshot.owner, OWNER_TOKENS.NONE);

        const stranger = { sender: {} };
        assert.equal(ipc.invoke('pet:motion-intent', { mode: 'follow', reason: 'dev' }, stranger).ok, false);
        assert.equal(ipc.invoke('pet:motion-snapshot', undefined, stranger).ok, false);
        assert.equal(ipc.invoke('pet:prefs-set', { follow: true }, stranger).ok, false);
        assert.equal(controller.motionSnapshot().mode, 'off', '非法来源不许改变任何状态');
      },
      { prefs: prefs.port },
    );
  } finally {
    stage.cleanup();
  }
});

test('加载完成：ready 之后补一条偏好（否则重载后渲染层以为开关都关着）', () => {
  const stage = makeStage(null);
  const prefs = makePrefsPort({ follow: true });
  try {
    withPetWindow(
      stage,
      ({ win, state }) => {
        state.sent.length = 0;
        win.webContentsEmitter.emit('did-finish-load');
        const types = state.sent.map((entry) => entry.payload && entry.payload.type);
        assert.deepEqual(types, ['ready', 'prefs'], `实际下发顺序：${types.join(' → ')}`);
        const prefsCommand = state.sent[1].payload;
        assert.equal(prefsCommand.follow, true);
        assert.equal(prefsCommand.roam, true);
      },
      { prefs: prefs.port },
    );
  } finally {
    stage.cleanup();
  }
});

test('窗口销毁后：运动控制器置空（motionSnapshot 返回 null，不再有订阅者）', () => {
  const stage = makeStage(null);
  const prefs = makePrefsPort({ follow: true });
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc }) => {
        const event = ipc.eventFor(win);
        ipc.invoke('pet:motion-intent', { mode: 'follow', reason: 'dev' }, event);
        assert.ok(controller.motionSnapshot());
        win.destroy();
        assert.equal(controller.motionSnapshot(), null, '窗口没了就不该再有运动快照（更不该再有写入点）');
      },
      { prefs: prefs.port },
    );
  } finally {
    stage.cleanup();
  }
});

// ---------------------------------------------------------------- 行为状态闸门（端到端，S4.1）

test('行为闸门（真跑）：载荷里上报 sleeping 后，同一次 invoke 的 roam 请求被主进程拒绝', () => {
  const stage = makeStage(null);
  const prefs = makePrefsPort({ roam: true, follow: true });
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc, clock, state }) => {
        const event = ipc.eventFor(win);
        const refused = ipc.invoke(
          'pet:motion-intent',
          { mode: 'roam', reason: 'dev', behavior: 'sleeping' },
          event,
        );
        assert.equal(refused.ok, false, '主进程必须自己拒绝：渲染层说睡着了就不许开漫游');
        assert.equal(refused.reason, 'behavior-blocked');

        const snapshot = controller.motionSnapshot();
        assert.equal(snapshot.behavior, 'sleeping', '上报必须被记住（快照可查）');
        assert.equal(snapshot.behaviorBlocked, true);
        assert.equal(snapshot.mode, 'off');
        assert.equal(snapshot.refusals, 1, '拒绝必须计入 refusals');

        const movesBefore = state.moves.length;
        for (let index = 0; index < 20; index += 1) clock.tick(TICK);
        assert.equal(state.moves.length, movesBefore, '被闸住期间一拍都不许写位置');
      },
      { prefs: prefs.port },
    );
  } finally {
    stage.cleanup();
  }
});

test('行为闸门（真跑）：上报 drag 后开漫游同样被拒；回到 idle 才放行', () => {
  const stage = makeStage(null);
  const prefs = makePrefsPort({ roam: true });
  try {
    withPetWindow(
      stage,
      ({ controller, win, ipc }) => {
        const event = ipc.eventFor(win);
        const whileDragging = ipc.invoke(
          'pet:motion-intent',
          { mode: 'roam', reason: 'dev', behavior: 'drag' },
          event,
        );
        assert.equal(whileDragging.ok, false);
        assert.equal(whileDragging.reason, 'behavior-blocked');

        const wake = ipc.invoke('pet:motion-intent', { mode: 'roam', reason: 'dev', behavior: 'idle' }, event);
        assert.deepEqual(wake, { ok: true }, '醒来后必须能再次开启（闸门不是永久封印）');
        assert.equal(controller.motionSnapshot().mode, 'roam');
      },
      { prefs: prefs.port },
    );
  } finally {
    stage.cleanup();
  }
});

test('preload 白名单必须透传 behavior（跨进程边界丢掉它 = 主进程行为闸门空转）', () => {
  // 缺陷形态：`motionIntent` 在 preload 里**重建**了 payload 白名单，只放了 mode/reason。
  // 渲染层再怎么老实上报 behavior，过不了这条边界，主进程 handler 的
  // `typeof safePayload.behavior === 'string'` 就永远为假 —— 睡觉的猫照样被推着走。
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'pet-preload.cjs'), 'utf8');
  assert.match(
    source,
    /payload\.behavior\s*=\s*source\.behavior/,
    'pet-preload.cjs 的 motionIntent 必须把 behavior 透传进 payload（否则跨进程边界会把它丢掉）',
  );
  // 顺带钉死 order：三个字段都在 invoke 之前
  const invokeAt = source.indexOf("ipcRenderer.invoke('pet:motion-intent'");
  assert.ok(invokeAt > 0, '找不到 pet:motion-intent 的 invoke 点：结构已变，请同步本测试');
  for (const key of ['payload.mode', 'payload.reason', 'payload.behavior']) {
    const at = source.indexOf(key);
    assert.ok(at > 0 && at < invokeAt, `${key} 必须在 invoke 之前赋值`);
  }
});

