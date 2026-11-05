/**
 * QA 对抗测试（未登记进 test:pet，独立运行）：
 *   `node --test tests/qa-hit-poller-adversarial.test.cjs`
 *
 * <p><b>守的是什么：</b>`HitPoller` 的定时器生命周期与去重语义。
 * 仓库现有 C9/C11/C14/C15/C16b 覆盖了"功能正确"，但**没有一条**断言
 * 「停表之后系统里还有几个定时器」「start/stop/setSuspended 任意组合下会不会叠加」，
 * 也没有覆盖「隐藏→显示时去重基准是否会让该发的回执被吞」。</p>
 *
 * <p><b>为什么必须用自己写的假时钟：</b>要数"当前存活几个定时器"，就得自己持有登记表；
 * 复用 harness 的 `makeManualClock` 会让"时钟怎么数"和"测试怎么断言"变成同一份实现。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createHitPoller } = require(path.join(__dirname, '..', 'electron', 'pet-hit-poller.cjs'));

/** 最小手摇时钟：记录存活定时器、fire 一个周期、统计累计 setInterval 次数。 */
function makeClock() {
  let nextId = 1;
  let now = 0;
  const timers = new Map();
  const stat = { setIntervalCalls: 0, clearIntervalCalls: 0 };
  return {
    stat,
    get alive() {
      return timers.size;
    },
    get setIntervalCalls() {
      return stat.setIntervalCalls;
    },
    get clearIntervalCalls() {
      return stat.clearIntervalCalls;
    },
    setInterval(fn, ms) {
      stat.setIntervalCalls += 1;
      const id = nextId++;
      timers.set(id, { fn, ms });
      return { id, unref() {} };
    },
    clearInterval(handle) {
      stat.clearIntervalCalls += 1;
      if (handle && typeof handle === 'object') timers.delete(handle.id);
      else timers.delete(handle);
    },
    /** 推进一个周期：只按"最长周期"跑一轮，够用且确定。 */
    fireOnce() {
      const snapshot = [...timers.values()];
      now += snapshot.length > 0 ? snapshot[0].ms : 0;
      for (const timer of snapshot) timer.fn();
      return now;
    },
  };
}

/** 造一个"矩形内/外"可切换的判定器，并记录每次调用的 prevInside。 */
function makeTester() {
  const calls = [];
  return {
    calls,
    inside: false,
    fn(point, bounds, prevInside) {
      calls.push({ point, bounds, prevInside });
      return insideState;
    },
  };
  // 用闭包变量以便逐个用例切换
}

let insideState = false;

/** 统一工厂：返回 { poller, clock, tester, emissions, cursor }。 */
function makePoller(overrides = {}) {
  const clock = overrides.clock ?? makeClock();
  const emissions = [];
  const cursor = { x: 0, y: 0 };
  const testCalls = [];
  let inside = false;
  const poller = createHitPoller({
    intervalMs: 16,
    clock,
    getCursorPoint: () => cursor,
    testPoint: (point, bounds, prevInside) => {
      testCalls.push({ point, bounds, prevInside });
      return inside;
    },
    onHitChange: (hit) => emissions.push(hit),
  });
  poller.setWindowBounds({ x: 100, y: 100, width: 268, height: 348 });
  return {
    poller,
    clock,
    emissions,
    cursor,
    testCalls,
    setInside(value) {
      inside = value;
    },
  };
}

// ---------------------------------------------------------------- B6 定时器

test('B6-1 start 幂等：连调 3 次只允许 1 个定时器', () => {
  const h = makePoller();
  h.poller.start();
  h.poller.start();
  h.poller.start();
  assert.equal(h.clock.alive, 1, `存活定时器应为 1，实际 ${h.clock.alive}`);
  assert.equal(h.clock.setIntervalCalls, 1, 'setInterval 只允许被调用一次');
});

test('B6-2 stop 幂等：连调 3 次后 0 个定时器', () => {
  const h = makePoller();
  h.poller.start();
  h.poller.stop();
  h.poller.stop();
  h.poller.stop();
  assert.equal(h.clock.alive, 0);
  assert.equal(h.clock.clearIntervalCalls, 1, '重复 stop 不许重复 clearInterval');
});

test('B6-3 停表/续表：suspend 后存活 0，resume 后恰好 1（不叠加）', () => {
  const h = makePoller();
  h.poller.start();
  assert.equal(h.clock.alive, 1);
  h.poller.setSuspended('hidden', true);
  assert.equal(h.clock.alive, 0, '隐藏后必须一个定时器都不剩');
  h.poller.setSuspended('hidden', false);
  assert.equal(h.clock.alive, 1, '显示后必须有且仅有 1 个定时器');
  assert.equal(h.clock.setIntervalCalls, 2, 'setInterval 总次数应为 2（首启 + 续表）');
});

test('B6-4 同一停表原因重复置上、只解除一次：仍不许叠加定时器', () => {
  const h = makePoller();
  h.poller.start();
  h.poller.setSuspended('hidden', true);
  h.poller.setSuspended('hidden', true);
  assert.equal(h.clock.alive, 0);
  h.poller.setSuspended('hidden', false);
  assert.equal(h.clock.alive, 1, 'Set 语义：解除一次就该续表，且只有一个定时器');
});

test('B6-5 挂起期间 start：不许起表；解除挂起后才起表', () => {
  const h = makePoller();
  h.poller.setSuspended('hidden', true);
  h.poller.start();
  assert.equal(h.clock.alive, 0, '挂起期间 start 不许偷偷起表');
  h.poller.setSuspended('hidden', false);
  assert.equal(h.clock.alive, 1, '解除挂起后必须续表');
});

test('B6-6 stop 之后 resume 不许复活定时器（销毁后仍在收 resume 的路径）', () => {
  const h = makePoller();
  h.poller.start();
  h.poller.stop();
  h.poller.setSuspended('hidden', true);
  h.poller.setSuspended('hidden', false);
  assert.equal(h.clock.alive, 0, 'stop() 之后任何 setSuspended 都不许把表重新点起来');
  h.poller.start();
  assert.equal(h.clock.alive, 1, '显式 start() 才允许重新起表');
});

test('B6-7 停表后推进时钟：一次采样都不许发生', () => {
  const h = makePoller();
  h.poller.start();
  h.setInside(true);
  h.clock.fireOnce();
  const samplesAfterFirstTick = h.poller.samples;
  h.poller.setSuspended('hidden', true);
  for (let index = 0; index < 100; index += 1) h.clock.fireOnce();
  assert.equal(h.poller.samples, samplesAfterFirstTick, '停表期间 samples 不许增长');
});

// ---------------------------------------------------------------- B7 去重

test('B7-1 隐藏→显示、光标在立绘上：必须重新回执 true（不许因去重漏判）', () => {
  const h = makePoller();
  h.poller.start();
  h.setInside(true);
  h.clock.fireOnce(); // 进入
  assert.deepEqual(h.emissions, [true], '首次进入必须回执 true');

  h.poller.setSuspended('hidden', true); // 隐藏：收敛到未命中
  assert.deepEqual(h.emissions, [true, false], '隐藏必须回执 false（否则显示后可能整窗可交互）');

  h.poller.setSuspended('hidden', false); // 显示
  h.poller.poll(); // win.on('show') 里就是这么做的
  assert.deepEqual(h.emissions, [true, false, true], '显示后光标仍在立绘上 ⇒ 必须重新回执 true');
});

test('B7-2 隐藏→显示、光标在窗外：不许产生任何多余回执', () => {
  const h = makePoller();
  h.poller.start();
  h.setInside(false);
  h.clock.fireOnce();
  assert.deepEqual(h.emissions, [], '初始就在窗外 ⇒ 没有跃迁，不许回执');

  h.poller.setSuspended('hidden', true);
  h.poller.setSuspended('hidden', false);
  h.poller.poll();
  assert.deepEqual(h.emissions, [], '窗外状态前后一致 ⇒ 不许发回执');
});

test('B7-3 隐藏时正在拖拽：强制原因被清掉后，显示时按真实光标收敛（记录当前语义）', () => {
  const h = makePoller();
  h.poller.start();
  h.setInside(false);
  h.poller.setForced('drag', true); // 拖拽开始：强制可交互
  assert.deepEqual(h.emissions, [true], '拖拽开始必须立刻可交互');

  h.poller.setSuspended('hidden', true); // 拖拽中窗口被隐藏
  assert.equal(h.poller.forcedReasons.size, 0, '隐藏时强制原因必须被清空（当前实现语义）');
  assert.deepEqual(h.emissions, [true, false]);

  h.poller.setSuspended('hidden', false);
  h.poller.poll();
  // 真实光标已在窗外 ⇒ 收敛为穿透；但渲染层可能仍认为"正在拖拽"，这是一条未覆盖的路径（见 QA 报告 B5-1）
  assert.equal(h.poller.hit, false, '隐藏+显示后按真实光标判定（不再强制可交互）');
  assert.equal(h.clock.alive, 1, '这条路径不许泄漏定时器');
});

test('B7-4 拖拽与菜单同时强制：解除其中一个不许把另一个抹掉（Set 语义）', () => {
  const h = makePoller();
  h.poller.start();
  h.setInside(false);
  h.poller.setForced('drag', true);
  h.poller.setForced('menu', true);
  assert.equal(h.poller.hit, true);
  h.poller.setForced('menu', false);
  assert.equal(h.poller.hit, true, '菜单关了但拖拽还没结束 ⇒ 必须仍然可交互');
  h.poller.setForced('drag', false);
  assert.equal(h.poller.hit, false, '两个例外都解除后才许按真实光标判');
  assert.deepEqual(h.emissions, [true, false], '中间那次解除不许产生多余回执');
});

test('B6-8 重复 show（未经 hide）不许叠加定时器：startTimer 的同柄保护是承重的', () => {
  // 可达路径：`win.on('show')` 每次都调 `setSuspended('hidden', false)`，
  // 而窗口"先 create 后 show"、"重复 showWindow()" 都可能在没有 hide 的情况下触发它。
  const h = makePoller();
  h.poller.start();
  assert.equal(h.clock.alive, 1);
  h.poller.setSuspended('hidden', false); // 没有前置 suspend 的 resume
  assert.equal(h.clock.alive, 1, '未经 hide 的 resume 不许把定时器叠成 2 个');
  h.poller.setSuspended('hidden', false);
  assert.equal(h.clock.alive, 1, '连续多次 resume 仍只允许 1 个定时器');
  assert.equal(h.clock.setIntervalCalls, 1, 'setInterval 只允许被调用一次（同柄保护必须承重）');
});

test('B6-9 停表后 resume + 再 start：总计仍只一个定时器', () => {
  const h = makePoller();
  h.poller.start();
  h.poller.setSuspended('hidden', true);
  h.poller.setSuspended('hidden', false);
  h.poller.start();
  assert.equal(h.clock.alive, 1);
});

test('B7-5 强制期间不读光标：省一次系统调用这条承诺必须成立', () => {
  const h = makePoller();
  h.poller.start();
  h.setInside(false);
  h.poller.setForced('drag', true);
  const before = h.poller.samples;
  for (let index = 0; index < 10; index += 1) h.clock.fireOnce();
  assert.equal(h.poller.samples, before, '强制期间 poll() 不许读光标');
});
