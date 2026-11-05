/**
 * P2 守卫：renderer 崩溃后三处 `pet:command` 下发不得把 `Render frame was disposed` 抛出来。
 *
 * <p><b>真机现象（主理人实测）：</b>kill 掉桌宠 renderer 进程后主进程日志立刻刷出
 * `Error sending from webContents: Error: Render frame was disposed before WebFrameMain could be accessed`，
 * 同一次崩溃刷两条（`hide()` 内部与 `hide` 事件各一次 `notifyVisibility()`）。</p>
 *
 * <p><b>根因：</b>渲染层崩溃时窗口只是 `hide()`（不 destroy），`win.isDestroyed()` 仍是 false，
 * 但 webContents 的 render frame 已经 disposed ⇒ `send` 抛错。所以守卫必须再往下判一层
 * （`webContents.isDestroyed()` / `isCrashed()`），并用 try/catch 兜住"检查通过但发送瞬间失效"的竞态。</p>
 *
 * <p><b>三条判据（缺一不可）：</b>崩溃态不抛且可见性回调照常；`send` 抛 disposed 时只 warn 一次；
 * 正常态三条消息一条都不能少发（守卫不许把好路径也吞掉）。</p>
 *
 * <p>手法复用 `tests/helpers/petWindowHarness.cjs`（不另起第二套假 electron）：
 * 假窗口的 `webContents` 提供 `isDestroyed()` / `isCrashed()`，`state.sendThrows` 复现真机那条异常。</p>
 *
 * @module tests/petRendererGoneSafeSend
 */

const test = require('node:test');
const assert = require('node:assert');

const { makeStage, withPetWindow } = require('./helpers/petWindowHarness.cjs');

/** 轮询间隔（与主进程常量同值；测试不自行发明参数）。 */
const TICK = 16;

/** 立绘命中区内的一个点（窗口坐标，与 C1 的墨迹点同源）。 */
const INK = { x: 135, y: 200 };

/**
 * 统计某类 `pet:command` 的条数。
 *
 * @param {object} state 舞台状态
 * @param {string} type 指令类型
 * @returns {number} 条数
 */
function countCommands(state, type) {
  return state.sent.filter(
    (entry) => entry.channel === 'pet:command' && entry.payload && entry.payload.type === type,
  ).length;
}

/**
 * 把光标挪到窗口内某个点（屏幕坐标 = 窗口原点 + 窗口内坐标）。
 *
 * @param {{x: number, y: number, width: number, height: number}} bounds 窗口位置
 * @param {{x: number, y: number}} local 窗口内坐标
 * @returns {{x: number, y: number}} 屏幕坐标
 */
function screenPoint(bounds, local) {
  return { x: bounds.x + local.x, y: bounds.y + local.y };
}

/**
 * 捕获一段同步代码里 `console.warn` 的输出。
 *
 * @param {Function} run 待执行回调
 * @returns {string[]} 期间产生的警告（每条形如 `a b c`）
 */
function captureWarnings(run) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map((value) => String(value)).join(' '));
  };
  try {
    run();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

test('E1 renderer 崩溃（isCrashed=true）时：三处下发均不抛，visibilityListeners 仍被调用', () => {
  const stage = makeStage(null);
  try {
    withPetWindow(stage, ({ controller, win, state, clock }) => {
      let visibilityCalls = 0;
      controller.onVisibilityChange(() => {
        visibilityCalls += 1;
      });
      // 崩溃态：窗口还在（isDestroyed === false），但 render frame 已经没了
      win.webContents.crashed = true;
      state.sent.length = 0;
      visibilityCalls = 0;

      // ① visible：show() → notifyVisibility()（show 事件里还会再来一次）
      assert.doesNotThrow(() => controller.show(), 'show() 里的 visible 下发不许抛');

      // ② ready：did-finish-load
      assert.doesNotThrow(() => win.webContentsEmitter.emit('did-finish-load'), 'ready 下发不许抛');

      // ③ hit-state：光标进命中区 ⇒ 轮询器跃迁 ⇒ applyIgnoreMouse(false) 下发回执
      const bounds = win.getBounds();
      state.cursor = screenPoint(bounds, INK);
      assert.doesNotThrow(() => clock.tick(TICK), 'hit-state 下发不许抛');

      assert.deepStrictEqual(state.sent, [], '渲染层不可达时一条都不该真的发出去');
      assert.ok(visibilityCalls >= 1, '托盘等可见性订阅者必须照常收到回调（不许因下发失败而跳过）');
      assert.ok(
        state.ignoreCalls.some((call) => call.ignore === false),
        '穿透状态本身必须照常切换（safeSend 只影响 IPC 下发，不影响窗口行为）',
      );
    });
  } finally {
    stage.cleanup();
  }
});

test('E2 send 抛 Render frame was disposed 时：不抛出、只 warn 一次', () => {
  const stage = makeStage(null);
  try {
    withPetWindow(stage, ({ win, state }) => {
      state.sent.length = 0;
      state.sendThrows = true;
      const warnings = captureWarnings(() => {
        assert.doesNotThrow(() => win.webContentsEmitter.emit('did-finish-load'), 'send 抛错必须被吞掉');
      });
      const skipped = warnings.filter((line) => line.includes('渲染层已不可达'));
      assert.equal(skipped.length, 1, `一次失败只该 warn 一次，实际 ${skipped.length} 条：${warnings.join(' | ')}`);
      assert.ok(skipped[0].includes('ready') || skipped[0].includes('channel=pet:command'), '警告要能定位到通道');
      assert.deepStrictEqual(state.sent, [], '抛错的那条消息不该进入已发送记录');
    });
  } finally {
    stage.cleanup();
  }
});

test('E3 正常态：三处下发一条都不许漏（守卫不能把好路径也吞掉）', () => {
  const stage = makeStage(null);
  try {
    withPetWindow(stage, ({ controller, win, state, clock }) => {
      state.sent.length = 0;

      // ready：加载完成恰好一条
      win.webContentsEmitter.emit('did-finish-load');
      assert.equal(countCommands(state, 'ready'), 1, 'did-finish-load 后必须恰好一条 ready');

      // hit-state：进入命中区恰好一条（同状态再推一拍不许重复）
      const bounds = win.getBounds();
      state.cursor = screenPoint(bounds, INK);
      clock.tick(TICK);
      assert.equal(countCommands(state, 'hit-state'), 1, '进入命中区必须恰好一条 hit-state');
      clock.tick(TICK);
      assert.equal(countCommands(state, 'hit-state'), 1, '状态没变就不许再发（去重权威只在主进程）');

      // visible：hide() 会下发（`hide()` 体内一次 + `hide` 事件一次，这是既有行为，守卫不许改变它）
      const beforeHide = countCommands(state, 'visible');
      controller.hide();
      const afterHide = countCommands(state, 'visible');
      assert.equal(afterHide, beforeHide + 2, 'hide 的两次可见性下发是既有行为，安全网不得少发');
      const lastVisible = state.sent.filter((entry) => entry.payload && entry.payload.type === 'visible').pop();
      assert.equal(lastVisible.payload.visible, false, '隐藏后最后一条 visible 必须是 false');
    });
  } finally {
    stage.cleanup();
  }
});
