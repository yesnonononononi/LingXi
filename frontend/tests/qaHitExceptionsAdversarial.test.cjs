/**
 * QA 对抗测试（未登记进 test:pet，独立运行）：
 * `node --test tests/qa-hit-exceptions-adversarial.test.cjs`
 *
 * <p><b>守的是什么：</b>命中重构里"三例外 + 生命周期"的**交叉路径**——仓库现有
 * C11（拖拽）/ C14（菜单）/ C15（隐藏）/ C16b（销毁）各自单测，但没有一条覆盖：</p>
 * <ul>
 *   <li>拖拽进行中窗口被隐藏（隐藏会清空强制原因，渲染层的拖拽状态却还在）；</li>
 *   <li>菜单没关就去拖拽（两个强制原因并存，解除其一不许抹掉另一个）；</li>
 *   <li>渲染进程崩溃（`render-process-gone` → hide → 停表）之后定时器是否泄漏；</li>
 *   <li>菜单兜底的 `blur` 在 `focusable: false` 的窗口上到底可不可靠（C14b 只是让假窗口 emit 一次）。</li>
 * </ul>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const harness = require(path.join(__dirname, 'helpers', 'petWindowHarness.cjs'));

const { makeStage, withPetWindow } = harness;
const TICK = 16;

/** 把窗口坐标换成屏幕坐标（与主进程同一口径：只平移，不缩放）。 */
function screenPoint(bounds, x, y) {
  return { x: bounds.x + x, y: bounds.y + y };
}

test('B5-1 拖拽中窗口被隐藏：强制原因被清空（当前语义），且不许泄漏定时器', () => {
  const stage = makeStage();
  try {
    withPetWindow(stage, ({ controller, win, ipc, clock, state }) => {
      const bounds = win.getBounds();
      ipc.invoke('pet:drag-start', screenPoint(bounds, 135, 200), ipc.eventFor(win));
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '拖拽开始必须可交互');

      state.cursor = { x: bounds.x - 500, y: bounds.y - 500 };
      controller.hide(); // 拖拽进行中隐藏
      assert.equal(clock.pending(), 0, '隐藏必须停表（0 个定时器）');

      const ignoreAfterHide = state.ignoreCalls.at(-1).ignore;
      assert.equal(ignoreAfterHide, true, '隐藏时必须收敛到穿透（否则显示后可能整窗吃鼠标）');

      // 记录：隐藏会清空 drag 强制 ⇒ 显示后按真实光标判定，而渲染层可能仍认为"正在拖拽"
      controller.show();
      for (let index = 0; index < 3; index += 1) clock.tick(TICK);
      assert.equal(state.ignoreCalls.at(-1).ignore, true, '显示后光标在窗外 ⇒ 必须仍是穿透（拖拽例外不再成立）');
      assert.equal(clock.pending(), 1, '显示后只允许 1 个定时器（不许因隐藏/显示叠加）');
    });
  } finally {
    stage.cleanup();
  }
});

test('B5-2 菜单未关就拖拽：两个强制原因并存，解除其一不许抹掉另一个', () => {
  const stage = makeStage();
  try {
    withPetWindow(stage, ({ win, ipc, clock, state }) => {
      const bounds = win.getBounds();
      const event = ipc.eventFor(win);
      state.cursor = { x: bounds.x - 500, y: bounds.y - 500 };

      // 通道登记为 ipcMain.on（pet-window.cjs:1059），必须用 send 而非 invoke，
      // 否则处理器根本不会被调用，用例会退化成空转
      ipc.send('pet:context-menu', undefined, event);
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '菜单打开必须可交互');

      ipc.invoke('pet:drag-start', screenPoint(bounds, 135, 200), event);
      for (let index = 0; index < 5; index += 1) clock.tick(TICK);
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '拖拽中仍必须可交互');

      // 菜单收起（模拟 popup callback）：拖拽还在，不许因此切回穿透
      win.emit('blur');
      for (let index = 0; index < 5; index += 1) clock.tick(TICK);
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '菜单关了但拖拽没结束 ⇒ 必须仍然可交互');

      // 拖拽结束且光标在窗外 ⇒ 这时才允许回穿透
      ipc.invoke('pet:drag-end', screenPoint(bounds, 135, 200), event);
      for (let index = 0; index < 3; index += 1) clock.tick(TICK);
      assert.equal(state.ignoreCalls.at(-1).ignore, true, '两个例外都解除且光标在窗外 ⇒ 必须回穿透');
    });
  } finally {
    stage.cleanup();
  }
});

test('B5-3 render-process-gone：不许抛错、必须停表、此后不再读光标', () => {
  const stage = makeStage();
  try {
    withPetWindow(stage, ({ win, clock, state }) => {
      const readsBefore = state.cursorReads;
      for (let index = 0; index < 3; index += 1) clock.tick(TICK);
      assert.equal(state.cursorReads > readsBefore, true, '活跃期必须真的在读光标（否则本用例空转）');

      assert.doesNotThrow(() => {
        // harness 的假 webContents 把事件挂在 webContentsEmitter 上（harness :153-162），
        // 直接 win.webContents.emit(...) 不存在
        win.webContentsEmitter.emit('render-process-gone', {}, { reason: 'crashed' });
      }, '渲染进程崩溃回调里不许抛错（webContents 已不可用）');

      assert.equal(clock.pending(), 0, '崩溃后视为隐藏 ⇒ 必须停表，不许泄漏定时器');

      const readsAfterCrash = state.cursorReads;
      for (let index = 0; index < 20; index += 1) clock.tick(TICK);
      assert.equal(state.cursorReads, readsAfterCrash, '崩溃后不许再读光标');
    });
  } finally {
    stage.cleanup();
  }
});

test('B5-4 菜单兜底靠 blur，而窗口是 focusable:false —— 记录平台风险（不是断言兜底有效）', () => {
  const stage = makeStage();
  try {
    withPetWindow(stage, ({ win, ipc, clock, state }) => {
      const bounds = win.getBounds();
      ipc.send('pet:context-menu', undefined, ipc.eventFor(win));
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '菜单打开必须可交互');

      // 仓库 C14b 的写法：直接让假窗口 emit('blur')。这只能证明"处理器存在"，
      // 证明不了"focusable:false 的窗口在原生菜单收起时真的会收到 blur"。
      state.cursor = { x: bounds.x - 500, y: bounds.y - 500 };
      win.emit('blur');
      for (let index = 0; index < 3; index += 1) clock.tick(TICK);
      assert.equal(state.ignoreCalls.at(-1).ignore, true, 'blur 一旦真到达，确实能解除强制（处理器正确）');
    });
  } finally {
    stage.cleanup();
  }
});
