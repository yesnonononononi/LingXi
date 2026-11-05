/**
 * 命中所有权集成用例（C7–C16 + U3）：真跑 `registerPetWindow().create()`。
 *
 * <p><b>怎么做到"真跑"：</b>复用 `tests/helpers/petWindowHarness.cjs` 的假 electron（`Module._load`
 * 临时改写，`electron()` 是懒加载所以来得及）+ 手动时钟。于是 16ms 轮询变成 `clock.tick(16)`，
 * 断言全是确定值，没有睡眠也没有 flake。</p>
 *
 * <p><b>守的是什么：</b>命中所有权归主进程之后，"进入 / 离开 / 去重 / 三个例外 / 停表 / 回执条数"
 * 这些行为全在这一个闭包里。本文件逐条钉死，其中三条是主理人点名的硬性变异点：
 * C2 的运行时镜像（C10 透明带离开）、C11（拖拽例外）、C3 的滞回（C8/C9 的相邻拍）。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');

const {
  makeStage,
  withPetWindow,
  PRIMARY_AREA,
} = require('./helpers/petWindowHarness.cjs');

const petWindow = require(path.join(__dirname, '..', 'electron', 'pet-window.cjs'));
const GEOMETRY = require(path.join(__dirname, '..', 'pet-geometry.json'));
const region = require(path.join(__dirname, '..', 'electron', 'pet-hit-region.cjs'));

const { PET_WIDTH, PET_HEIGHT, ART_ORIGIN } = petWindow;
const HIT_RECT = region.deriveHitRect(GEOMETRY);

/** 轮询间隔（与主进程常量同值的"输入"，测试不自行发明参数）。 */
const TICK = 16;

/**
 * 取某点是否落在当前窗口的命中矩形里（窗口坐标 → 屏幕坐标）。
 *
 * @param {{x: number, y: number}} bounds 窗口位置
 * @param {number} localX 窗口内 x
 * @param {number} localY 窗口内 y
 * @returns {{x: number, y: number}} 屏幕坐标点
 */
function screenPoint(bounds, localX, localY) {
  return { x: bounds.x + localX, y: bounds.y + localY };
}

/**
 * 统计某类指令的条数。
 *
 * @param {object} state 舞台状态
 * @param {string} type 指令类型
 * @returns {number} 条数
 */
function countCommands(state, type) {
  return state.sent.filter((entry) => entry.channel === 'pet:command' && entry.payload && entry.payload.type === type).length;
}

/**
 * 取一串穿透调用里"切回穿透"的条数。
 *
 * @param {object[]} calls `state.ignoreCalls`
 * @returns {number} 其中 ignore === true 的条数
 */
function passThroughCount(calls) {
  return calls.filter((call) => call.ignore === true).length;
}

/** 一个新舞台（默认不预置状态文件：走"默认落点"分支）。 */
function freshStage() {
  return makeStage(null);
}

test('C7 首帧穿透：create() 完成后窗口是穿透态，且一条 hit-state 都还没发', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ win, state }) => {
      assert.equal(state.ignoreCalls.length, 1, 'create() 只该下发一次初始穿透');
      assert.equal(state.ignoreCalls[0].ignore, true, '初始必须是穿透（空白区域绝不吃鼠标）');
      assert.equal(state.ignoreCalls[0].forward, true, 'HIT_FORWARD 常量默认 true（回退开关，不影响正确性）');
      assert.equal(countCommands(state, 'hit-state'), 0, '还没采样过，不许先发回执');
      assert.deepEqual(win.getBounds().width, PET_WIDTH);
      assert.deepEqual(win.getBounds().height, PET_HEIGHT);
    });
  } finally {
    stage.cleanup();
  }
});

test('C8 进入即切可交互：光标移到立绘上并 tick 一拍，恰好一次 setIgnoreMouseEvents(false) + 一条 hit-state', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ win, state, clock }) => {
      const bounds = win.getBounds();
      state.cursor = screenPoint(bounds, 135, 200);
      clock.tick(TICK);

      assert.equal(state.ignoreCalls.length, 2, '进入只需一次跃迁');
      assert.equal(state.ignoreCalls[1].ignore, false, '进入必须切到可交互');
      const hitStates = state.sent.filter((entry) => entry.payload && entry.payload.type === 'hit-state');
      assert.equal(hitStates.length, 1, '一次跃迁恰好一条回执');
      assert.equal(hitStates[0].payload.hit, true, '回执值必须是 hit=true');
    });
  } finally {
    stage.cleanup();
  }
});

test('C9 去重以主进程为准：同一点连续 20 拍，穿透调用不再增长', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ win, state, clock }) => {
      const bounds = win.getBounds();
      state.cursor = screenPoint(bounds, 135, 200);
      clock.tick(TICK);
      const afterEnter = state.ignoreCalls.length;
      for (let index = 0; index < 20; index += 1) clock.tick(TICK);

      assert.equal(state.ignoreCalls.length, afterEnter, '状态没变就不许再调 setIgnoreMouseEvents（指针会抖）');
      assert.equal(countCommands(state, 'hit-state'), 1, '回执也只许一条');
    });
  } finally {
    stage.cleanup();
  }
});

test('C10 离开即回穿透：光标移到窗口内透明带（2,2）→ 恰好一次 ignore:true（C2 的运行时镜像）', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ win, state, clock }) => {
      const bounds = win.getBounds();
      state.cursor = screenPoint(bounds, 135, 200);
      clock.tick(TICK);
      const beforeLeave = state.ignoreCalls.length;

      // (2,2) 在窗口内、但在左上留白里：命中矩形退化成整窗时这条会红
      state.cursor = screenPoint(bounds, 2, 2);
      clock.tick(TICK);

      assert.equal(state.ignoreCalls.length, beforeLeave + 1, '离开必须恰好一次跃迁');
      assert.equal(state.ignoreCalls.at(-1).ignore, true, '透明带必须切回穿透（否则整窗吃鼠标）');
      const hitStates = state.sent.filter((entry) => entry.payload && entry.payload.type === 'hit-state');
      assert.equal(hitStates.at(-1).payload.hit, false, '最后一条回执必须是 hit=false');
    });
  } finally {
    stage.cleanup();
  }
});

test('C11 拖拽例外：拖拽中光标移到窗外 10 拍不得出现 ignore:true；drag-end 后立即收敛为一条 ignore:true', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ win, state, clock, ipc }) => {
      const bounds = win.getBounds();
      const event = ipc.eventFor(win);
      const started = ipc.invoke('pet:drag-start', screenPoint(bounds, 135, 200), event);
      assert.deepEqual(started, { ok: true }, 'drag-start 必须成功');
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '拖拽一开始就必须可交互（不等下一拍）');

      const dragPhaseStart = state.ignoreCalls.length;
      // 拖拽时用户常把指针甩到窗口外：轮询器必须整体让位
      state.cursor = { x: bounds.x - 500, y: bounds.y - 500 };
      for (let index = 0; index < 10; index += 1) clock.tick(TICK);

      const dragPhaseCalls = state.ignoreCalls.slice(dragPhaseStart);
      assert.deepEqual(
        dragPhaseCalls.filter((call) => call.ignore === true),
        [],
        '拖拽期间不得被切回穿透（否则 pointerup 到不了渲染层，拖拽中断）',
      );

      ipc.invoke('pet:drag-end', undefined, event);
      const afterEnd = state.ignoreCalls.slice(dragPhaseStart);
      assert.equal(passThroughCount(afterEnd), 1, 'drag-end 后必须立即收敛为一条 ignore:true');
      assert.equal(state.ignoreCalls.at(-1).ignore, true, '光标在窗外 ⇒ 松手后应回到穿透');
    });
  } finally {
    stage.cleanup();
  }
});

test('C12 拖拽中窗口移动跟随：bounds 变了命中矩形必须跟着变（旧位置判 false）', () => {
  const stage = makeStage({ x: 1000, y: 500, width: PET_WIDTH, height: PET_HEIGHT, artOrigin: { ...ART_ORIGIN } });
  try {
    withPetWindow(stage, ({ win, state, clock, ipc }) => {
      const event = ipc.eventFor(win);
      assert.deepEqual({ x: win.getBounds().x, y: win.getBounds().y }, { x: 1000, y: 500 }, '起点');

      ipc.invoke('pet:drag-start', { cursorX: 1000 + 135, cursorY: 500 + 200 }, event);
      // 拖到 (400,200)：dragOffset 是 (135,200)，所以光标要跟着到 (535,400)
      ipc.send('pet:drag-move', { cursorX: 400 + 135, cursorY: 200 + 200 }, event);
      assert.deepEqual({ x: win.getBounds().x, y: win.getBounds().y }, { x: 400, y: 200 }, '窗口必须跟着指针走');

      // 拖拽期间强制可交互，这里只验证"松手后判定用的是新位置"
      ipc.invoke('pet:drag-end', undefined, event);

      // 旧位置（1000+135, 500+200）现在在窗口外 ⇒ 必须判 false
      state.cursor = { x: 1000 + 135, y: 500 + 200 };
      clock.tick(TICK);
      assert.equal(state.ignoreCalls.at(-1).ignore, true, '旧位置必须判不命中（矩形没跟窗口走就会误判命中）');

      // 新位置里的墨迹点必须命中
      state.cursor = { x: 400 + 135, y: 200 + 200 };
      clock.tick(TICK);
      const before = state.ignoreCalls.length;
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '新位置必须命中');
      assert.equal(state.ignoreCalls.length, before, '稳定态不许重复下发');
    });
  } finally {
    stage.cleanup();
  }
});

test('C13 转发失效也必须能用：删掉 pet:hover-hint 监听，只靠 16ms 轮询推进假时钟即可命中', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ win, state, clock, ipc }) => {
      // 通道必须物理消失（不是"没人调"，而是"没有这个处理器"）
      assert.equal(ipc.listeners.has('pet:set-hit'), false, 'pet:set-hit 处理器必须不存在');
      assert.equal(ipc.handlers.has('pet:set-hit'), false, 'pet:set-hit 不许以 invoke 形式残留');

      // 真的把提示通道关掉：主进程侧删掉 hover-hint 监听（等价于"转发在真机上不工作"）。
      // 不这么做的话，本用例只是"渲染层懒得发事件"，测不出转发失效时的兜底能力。
      assert.equal(ipc.listeners.delete('pet:hover-hint'), true, 'hover-hint 监听必须存在（否则本用例空转）');

      const bounds = win.getBounds();
      state.cursor = screenPoint(bounds, 135, 200);
      // 渲染层仍然拼命发提示：一条都进不来
      for (let index = 0; index < 5; index += 1) ipc.send('pet:hover-hint', { x: 0, y: 0 }, ipc.eventFor(win));
      assert.equal(state.ignoreCalls.at(-1).ignore, true, '通道没了又还没到采样点 ⇒ 必须仍是穿透');

      clock.tick(TICK);
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '只靠 16ms 轮询也必须切到可交互');
      assert.equal(countCommands(state, 'hit-state'), 1, '回执恰好一条（由主进程自己发）');
    });
  } finally {
    stage.cleanup();
  }
});

test('C20 靠提示不当：伪造一条 hover-hint（坐标指向立绘中心）但真实光标在窗外 ⇒ 状态必须不变', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ win, state, clock, ipc }) => {
      const bounds = win.getBounds();
      const before = state.ignoreCalls.length;
      // 真实光标：窗口外很远。载荷：立绘正中心 —— 主进程若信载荷就会翻错
      state.cursor = { x: bounds.x - 900, y: bounds.y - 900 };
      state.cursorThrows = false;
      const forged = screenPoint(bounds, 135, 200);
      for (let index = 0; index < 5; index += 1) ipc.send('pet:hover-hint', forged, ipc.eventFor(win));

      assert.equal(state.ignoreCalls.length, before, '伪造提示不许产生任何穿透跃迁');
      assert.equal(state.ignoreCalls.at(-1).ignore, true, '必须仍然是穿透');
      assert.equal(countCommands(state, 'hit-state'), 0, '不许发回执（状态没变）');
      assert.equal(state.cursorReads > 0, true, '提示必须真的触发过一次系统光标读取（权威在主进程）');

      // 反向对照：真实光标移进立绘后，同样的提示立刻生效 —— 证明"提示确实在叫醒"
      state.cursor = forged;
      ipc.send('pet:hover-hint', { x: 0, y: 0 }, ipc.eventFor(win));
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '真实光标在里面时提示必须立刻生效');

      void clock;
    });
  } finally {
    stage.cleanup();
  }
});

test('C21 提示即时应答：一次 IPC 处理栈内完成 setIgnoreMouseEvents(false)，不经任何定时器', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ win, state, ipc }) => {
      const bounds = win.getBounds();
      state.cursor = screenPoint(bounds, 135, 200);
      // 时钟一拍都不推：若实现里还有 setTimeout/setImmediate 合并，这里必然仍是穿透
      ipc.send('pet:hover-hint', screenPoint(bounds, 135, 200), ipc.eventFor(win));
      assert.equal(state.ignoreCalls.at(-1).ignore, false, 'hint 必须在同一次调用栈内 apply（不许定时器）');
      assert.equal(countCommands(state, 'hit-state'), 1, '并且恰好一条回执');

      // 反向：光标移动到窗外，提示同样要同步收敛回穿透
      state.cursor = screenPoint(bounds, 2, 2);
      ipc.send('pet:hover-hint', screenPoint(bounds, 2, 2), ipc.eventFor(win));
      assert.equal(state.ignoreCalls.at(-1).ignore, true, '提示也是离开方向的即时通道');
    });
  } finally {
    stage.cleanup();
  }
});

test('C22 轮询 16ms 安全网 + 滞回只作用于离开方向：贴边 2px 不翻，10px 才翻', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ win, state, clock }) => {
      const bounds = win.getBounds();
      const rect = region.deriveHitRect(GEOMETRY);
      state.cursor = screenPoint(bounds, 135, 200);
      clock.tick(TICK);
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '先进入可交互');
      const entered = state.ignoreCalls.length;

      // 右边界外 2px：落在 6px 滞回带内 ⇒ 不许翻（否则贴边抖动就会闪）
      const rightEdge = rect.x + rect.width;
      state.cursor = screenPoint(bounds, rightEdge + 2, 200);
      clock.tick(TICK);
      assert.equal(state.ignoreCalls.length, entered, '滞回带内（+2px）不得切回穿透');

      // 右边界外 10px：越过滞回带 ⇒ 必须翻回穿透
      state.cursor = screenPoint(bounds, rightEdge + 10, 200);
      clock.tick(TICK);
      assert.equal(state.ignoreCalls.at(-1).ignore, true, '越过滞回带（+10px）必须切回穿透');

      // 主进程常量必须是 16ms（一帧）：读源码钉死，防止有人又改回 40/8
      const windowSource = readFileSync(path.join(__dirname, '..', 'electron', 'pet-window.cjs'), 'utf8');
      assert.equal(/const HIT_POLL_INTERVAL_MS = 16;/.test(windowSource), true, '轮询间隔必须是 16ms 单档');
      assert.equal(/const HIT_HYSTERESIS_PX = 6;/.test(windowSource), true, '滞回必须是 6px');
    });
  } finally {
    stage.cleanup();
  }
});

test('C14 右键菜单例外：popup 期间光标在窗外 10 拍不得切穿透；callback 后恰好一条 ignore:true', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ win, state, clock, ipc }) => {
      const bounds = win.getBounds();
      ipc.send('pet:context-menu', undefined, ipc.eventFor(win));

      assert.equal(state.menuPopups.length, 1, 'Menu.popup 必须被调用一次');
      assert.equal(Array.isArray(state.menuTemplate), true, '菜单模板必须交给 buildFromTemplate');
      assert.equal(typeof state.menuPopups[0].callback, 'function', 'popup 必须带 callback（唯一解除点）');
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '菜单打开即强制可交互（先置强制再弹）');

      const menuPhaseStart = state.ignoreCalls.length;
      state.cursor = { x: bounds.x - 800, y: bounds.y - 800 };
      for (let index = 0; index < 10; index += 1) clock.tick(TICK);
      assert.deepEqual(
        state.ignoreCalls.slice(menuPhaseStart).filter((call) => call.ignore === true),
        [],
        '菜单打开期间不得被切回穿透（菜单会跟着失去宿主）',
      );

      state.menuPopups[0].callback();
      assert.equal(passThroughCount(state.ignoreCalls.slice(menuPhaseStart)), 1, '菜单关闭后必须立即收敛为一条 ignore:true');
      assert.equal(state.ignoreCalls.at(-1).ignore, true, '光标在窗外 ⇒ 关闭菜单后穿透');
    });
  } finally {
    stage.cleanup();
  }
});

test('C14b 菜单兜底：blur 也能解除强制（某些 Windows 版本 popup 不回调）', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ win, state, ipc }) => {
      ipc.send('pet:context-menu', undefined, ipc.eventFor(win));
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '菜单打开期间可交互');
      // 不调 callback，直接让窗口失焦（原生菜单会夺焦）
      state.cursor = { x: -500, y: -500 };
      win.emit('blur');
      assert.equal(state.ignoreCalls.at(-1).ignore, true, 'blur 兜底必须解除 setForced(menu) 并收敛为穿透');
    });
  } finally {
    stage.cleanup();
  }
});

test('C15 隐藏停表 / 显示续表：隐藏后 tick 100 拍不读光标不发红偏；显示后一拍即收敛', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ controller, win, state, clock }) => {
      const bounds = win.getBounds();
      state.cursor = screenPoint(bounds, 135, 200);
      clock.tick(TICK);
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '先进入可交互');

      controller.hide();
      const readsAfterHide = state.cursorReads;
      const callsAfterHide = state.ignoreCalls.length;
      assert.equal(state.ignoreCalls.at(-1).ignore, true, '隐藏前必须先把穿透置回 true');

      state.cursor = { x: bounds.x - 400, y: bounds.y - 400 };
      for (let index = 0; index < 100; index += 1) clock.tick(TICK);
      assert.equal(state.cursorReads, readsAfterHide, '隐藏期间一次都不许读光标（停表 = CPU 归零）');
      assert.equal(state.ignoreCalls.length, callsAfterHide, '隐藏期间不许再有跃迁');

      // 显示：续表并立即采样一次
      state.cursor = screenPoint(bounds, 135, 200);
      controller.show();
      assert.equal(state.cursorReads > readsAfterHide, true, '恢复显示后必须重新读光标');
      assert.equal(state.ignoreCalls.at(-1).ignore, false, '显示后一拍内必须收敛到正确状态');
    });
  } finally {
    stage.cleanup();
  }
});

test('C16 一次跃迁恰好一条回执：enter → leave → enter 共 3 条 hit-state（不是实测 B 的 8 条）', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ win, state, clock }) => {
      const bounds = win.getBounds();
      state.cursor = screenPoint(bounds, 135, 200);
      clock.tick(TICK);
      state.cursor = screenPoint(bounds, 2, 2);
      clock.tick(TICK);
      state.cursor = screenPoint(bounds, 135, 200);
      clock.tick(TICK);

      assert.equal(countCommands(state, 'hit-state'), 3, '三次跃迁恰好三条回执（多一条就是回声回来了）');
      const values = state.sent
        .filter((entry) => entry.payload && entry.payload.type === 'hit-state')
        .map((entry) => entry.payload.hit);
      assert.deepEqual(values, [true, false, true], '回执序列必须是 enter/leave/enter');
    });
  } finally {
    stage.cleanup();
  }
});

test('C16b 销毁即停表：destroy() 之后 tick 不再读光标，也不再有跃迁', () => {
  const stage = freshStage();
  try {
    withPetWindow(stage, ({ controller, state, clock }) => {
      const readsBefore = state.cursorReads;
      const callsBefore = state.ignoreCalls.length;
      controller.destroy();
      for (let index = 0; index < 50; index += 1) clock.tick(TICK);
      assert.equal(state.cursorReads, readsBefore, '销毁后不许再读光标');
      assert.equal(state.ignoreCalls.length, callsBefore, '销毁后不许再有穿透跃迁');
    });
  } finally {
    stage.cleanup();
  }
});

test('U3 结构不变式：build.files 不含 pet-geometry.json 时，main.cjs 对 pet-window 的 require 不得是顶层裸 require', async () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = Array.isArray(pkg.build && pkg.build.files) ? pkg.build.files : [];
  const shipsGeometry = files.some((pattern) => String(pattern).includes('pet-geometry.json'));

  const mainSource = readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
  const requireLines = mainSource.split('\n').filter((line) => line.includes("require('./pet-window.cjs')"));
  assert.ok(requireLines.length > 0, "main.cjs 必须 require('./pet-window.cjs')（找不到说明改名了，本用例需同步）");

  if (!shipsGeometry) {
    for (const line of requireLines) {
      assert.equal(/^\s{2,}/.test(line), true, `必须是缩进的（嵌套在条件里）：${line.trim()}`);
      assert.equal(/[?]|&&|\|\|/.test(line), true, `必须带条件运算符（打包版桌宠恒关 ⇒ 不执行）：${line.trim()}`);
    }
  }

  // 与门禁脚本同一套判据（防止测试与门禁各写一份、结论不一致）
  const { pathToFileURL } = require('node:url');
  const gate = await import(pathToFileURL(path.join(root, 'scripts', 'check-pet-hit-ownership.mjs')).href);
  assert.deepEqual(gate.checkPackagingInvariant(), [], '门禁的 U3 断言必须无问题');
  assert.deepEqual(gate.checkMainProcess(), [], '门禁的主进程结构断言必须无问题');
  assert.deepEqual(gate.checkRenderSide(), [], '门禁的渲染层结构断言必须无问题');
  assert.deepEqual(gate.checkInstantTrigger(), [], '门禁的即时触发器断言必须无问题');
});
