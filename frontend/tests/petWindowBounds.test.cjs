/**
 * 窗口位置解算单测（node:test，不启动 Electron）：`migrateSavedBounds` / `clampIntoWorkArea`。
 *
 * <p><b>守的是什么（QA D-02 + 盲区 B-3）：</b>`electron/pet-window.cjs` 里的位置解算曾经
 * 一个函数干两件事——"跨版本布局迁移"与"夹回可见区"。`reclampIntoDisplays` 把实时 bounds
 * 当存档喂进同一个函数，于是每次 `display-metrics-changed` / `display-removed` 都按
 * `LEGACY_ART_ORIGIN` 补偿 `(−40, −8)` 并**累积**（QA 实测 5 次 −200/−40）。拆开之后本文件
 * 同时钉住三件事：</p>
 *
 * <ol>
 *   <li><b>迁移只补一次</b>：老存档（无 `artOrigin`）补一次就落盘新 `artOrigin`，
 *       第二次启动补偿量必须为 0（否则单次迁移会退化成持续漂移）；</li>
 *   <li><b>夹取幂等</b>：`reclampIntoDisplays` 连调 5 次位置逐次相等（旧实现必然累积，这条先红后绿）；</li>
 *   <li><b>职责不混用</b>：`reclampIntoDisplays` 只许调 `clampIntoWorkArea` + `flushSave`，
 *       源码里出现 `resolveInitialBounds(` 就是回归。</li>
 * </ol>
 *
 * <p><b>怎么在没有 Electron 的情况下真跑 `reclampIntoDisplays`：</b>`electron()` 是懒加载的
 * （`require('electron')` 写在函数内），所以测试里临时改写 `Module._load` 就能给它一个假 electron
 * （假 `BrowserWindow` + 假 `screen`），把 `registerPetWindow` 真跑起来。于是判据 1 是**运行时**
 * 验证：连触 5 次显示器事件，`win.getBounds()` 逐次相等；旧实现（把实时 bounds 当存档喂给迁移）
 * 在这里会得到 `920,484 / 880,476 / …` 的阶梯。源码形态断言只作为第二道闸（守调用点）。</p>
 *
 * <p>运行：`npm run test:pet`（node 直接跑，不需要 tsx / Electron）。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { readFileSync, mkdtempSync, readdirSync, rmSync, existsSync } = require('node:fs');

const petWindow = require(path.join(__dirname, '..', 'electron', 'pet-window.cjs'));

const {
  ART_ORIGIN,
  LEGACY_ART_ORIGIN,
  PET_WIDTH,
  PET_HEIGHT,
  MIN_VISIBLE_RATIO,
  EDGE_MARGIN,
  migrateSavedBounds,
  clampIntoWorkArea,
  resolveInitialBounds,
} = petWindow;

/** 主屏工作区（1920×1080 减去任务栏：常见 Windows 桌面）。 */
const PRIMARY_AREA = { x: 0, y: 0, width: 1920, height: 1040 };

/** 默认落点（右下角内缩 `EDGE_MARGIN`），从真源算出来而不是抄数字。 */
const DEFAULT_POINT = {
  x: PRIMARY_AREA.width - PET_WIDTH - EDGE_MARGIN,
  y: PRIMARY_AREA.height - PET_HEIGHT - EDGE_MARGIN,
};

/**
 * 造一条显示器信息（只填 `pickDisplay` 读的字段）。
 *
 * @param {object} workArea 工作区
 * @returns {{workArea: object}} 显示器
 */
function makeDisplay(workArea) {
  return { workArea };
}

/** 单屏环境。 */
const ONE_SCREEN = [makeDisplay(PRIMARY_AREA)];

/** 窗口尺寸（与真实窗口一致，避免用假尺寸掩盖缩放问题）。 */
const SIZE = { width: PET_WIDTH, height: PET_HEIGHT };

test('D-02：ART_ORIGIN 与 LEGACY_ART_ORIGIN 的差值就是那份累积漂移 (−40, −8)', () => {
  // 金丝雀：这两个常量是判据的锚。它们一变，下面所有期望值都必须跟着复核，
  // 所以先把它俩逐值钉死（D-01 把 effectMargin.left 从 20 改到 56 才放大到 −40）。
  assert.deepEqual(ART_ORIGIN, { x: 56, y: 96 }, '当前布局的立绘原点（effectMargin.left / top+bubbleHeight）');
  assert.deepEqual(LEGACY_ART_ORIGIN, { x: 16, y: 88 }, '196 宽时期的立绘原点（glowPad / glowPad+bubble）');
  assert.equal(ART_ORIGIN.x - LEGACY_ART_ORIGIN.x, 40, 'D-01 之后的 X 补偿量');
  assert.equal(ART_ORIGIN.y - LEGACY_ART_ORIGIN.y, 8, 'Y 补偿量');
  assert.equal(PET_WIDTH, 268);
  assert.equal(PET_HEIGHT, 348);
});

test('migrateSavedBounds：脏存档返回 null（由调用方决定默认落点，不在这里偷偷夹取）', () => {
  assert.equal(migrateSavedBounds(null, SIZE), null);
  assert.equal(migrateSavedBounds(undefined, SIZE), null);
  assert.equal(migrateSavedBounds({}, SIZE), null);
  assert.equal(migrateSavedBounds({ x: 'oops', y: 500 }, SIZE), null);
  assert.equal(migrateSavedBounds({ x: Number.NaN, y: 500 }, SIZE), null);
});

test('migrateSavedBounds：老存档（无 artOrigin）只按 LEGACY 补偿一次，且补偿方向不许反', () => {
  const migrated = migrateSavedBounds({ x: 1000, y: 500 }, SIZE);
  assert.deepEqual(migrated, { x: 960, y: 492, width: 268, height: 348 });
  // 方向断言（变异点：把 `savedOrigin.x - ART_ORIGIN.x` 翻成 `ART_ORIGIN.x - savedOrigin.x`）：
  // 立绘在原布局里占窗口的 [16, 16+156]，现在占 [56, 56+156] ⇒ 窗口必须**左移** 40 才能不动。
  assert.ok(migrated.x < 1000, '老存档必须把窗口往左挪（立绘原点右移了 40）');
  assert.equal(1000 - migrated.x, 40);
  assert.ok(migrated.y < 500, 'Y 方向同理（96 − 88 = 8）');
  assert.equal(500 - migrated.y, 8);
});

test('migrateSavedBounds：带 artOrigin 的存档只补差值（不等于零补偿）', () => {
  // 196 宽时期**新格式**存档：artOrigin 已写 20/96（effectMargin.left 当年是 20）
  const migrated = migrateSavedBounds({ x: 1000, y: 500, artOrigin: { x: 20, y: 96 } }, SIZE);
  assert.deepEqual(migrated, { x: 964, y: 500, width: 268, height: 348 });
  assert.equal(1000 - migrated.x, 36);
  assert.equal(500 - migrated.y, 0);
  // 当前布局自己的存档 ⇒ 补偿量必须是 0（这是 reclamp 误用老实现时会炸的那条路径）
  const current = migrateSavedBounds({ x: 1000, y: 500, artOrigin: { ...ART_ORIGIN } }, SIZE);
  assert.deepEqual(current, { x: 1000, y: 500, width: 268, height: 348 }, '当前布局的存档不许被补偿');
});

test('迁移只补一次：落盘新 artOrigin 后第二次启动补偿量为 0（否则单次迁移变成持续漂移）', () => {
  const legacyState = { x: 1000, y: 500 }; // M3 之前的老状态文件：没有 artOrigin
  const boot1 = migrateSavedBounds(legacyState, SIZE);
  assert.deepEqual(boot1, { x: 960, y: 492, width: 268, height: 348 });

  // 启动路径（create()）会把迁移结果连同当前 ART_ORIGIN 落盘，模拟这一步：
  const persisted = {
    x: boot1.x,
    y: boot1.y,
    width: boot1.width,
    height: boot1.height,
    artOrigin: { ...ART_ORIGIN },
  };

  const boot2 = migrateSavedBounds(persisted, SIZE);
  assert.deepEqual(boot2, boot1, '第二次启动不许再补一次：迁移必须是一次性的');
  const boot3 = migrateSavedBounds({ ...persisted, ...boot2, artOrigin: { ...ART_ORIGIN } }, SIZE);
  assert.deepEqual(boot3, boot1, '第三次同样不许漂移');
});

test('屏幕空间守恒（B-3 组合不变量）：迁移前后"立绘在屏幕上的位置"逐值不变', () => {
  /** 立绘在屏幕上的横坐标。 */
  const artScreenX = (rect) => rect.x + ART_ORIGIN.x;

  // 老存档：当年立绘原点 16 ⇒ 屏幕位置 1000 + 16
  const legacy = { x: 1000, y: 500 };
  const legacyBefore = legacy.x + LEGACY_ART_ORIGIN.x;
  const legacyAfter = artScreenX(migrateSavedBounds(legacy, SIZE));
  assert.equal(legacyAfter, legacyBefore, '老存档升级后立绘不许横移');

  // 196 宽新存档：立绘原点 20
  const shifted = { x: 1000, y: 500, artOrigin: { x: 20, y: 96 } };
  assert.equal(artScreenX(migrateSavedBounds(shifted, SIZE)), 1000 + 20);

  // 当前布局：恒等
  const current = { x: 1000, y: 500, artOrigin: { ...ART_ORIGIN } };
  assert.equal(artScreenX(migrateSavedBounds(current, SIZE)), 1000 + ART_ORIGIN.x);
});

test('D-02 幂等性：clampIntoWorkArea 连调 5 次位置逐次相等（旧实现每次 −40/−8 累积）', () => {
  let rect = { x: 1000, y: 500, width: PET_WIDTH, height: PET_HEIGHT };
  const seen = [];
  for (let index = 0; index < 5; index += 1) {
    // 与 reclampIntoDisplays 完全同形：输入是**实时 bounds**（无 artOrigin），输出再喂回去
    rect = clampIntoWorkArea(rect, ONE_SCREEN, PRIMARY_AREA);
    seen.push({ x: rect.x, y: rect.y });
  }
  assert.deepEqual(seen, [
    { x: 1000, y: 500 },
    { x: 1000, y: 500 },
    { x: 1000, y: 500 },
    { x: 1000, y: 500 },
    { x: 1000, y: 500 },
  ], '夹取是纯函数：位置不变时 5 次事件必须逐次相等（旧实现 5 次共漂 −200/−40）');
  assert.equal(rect.width, PET_WIDTH);
  assert.equal(rect.height, PET_HEIGHT);
});

test('D-02 幂等性：已经贴边的窗口连夹 5 次也稳定（夹取结果是稳定点）', () => {
  // 用户把桌宠拖到屏幕外（拔掉显示器后原位置彻底消失），然后插拔显示器 5 次
  let rect = { x: -5000, y: -5000, width: PET_WIDTH, height: PET_HEIGHT };
  const first = clampIntoWorkArea(rect, ONE_SCREEN, PRIMARY_AREA);
  assert.deepEqual({ x: first.x, y: first.y }, DEFAULT_POINT, '完全不可见 ⇒ 回默认角落');
  const seen = [];
  rect = first;
  for (let index = 0; index < 5; index += 1) {
    rect = clampIntoWorkArea(rect, ONE_SCREEN, PRIMARY_AREA);
    seen.push(`${rect.x},${rect.y}`);
  }
  assert.equal(new Set(seen).size, 1, `夹取结果必须是稳定点，实际 ${seen.join(' → ')}`);
});

test('clampIntoWorkArea：只夹取，不迁移（把"当前布局的窗口"原样返回）', () => {
  const bounds = { x: 500, y: 300, width: PET_WIDTH, height: PET_HEIGHT };
  assert.deepEqual(clampIntoWorkArea(bounds, ONE_SCREEN, PRIMARY_AREA), bounds, '在屏内且有余量时不得移动');
  // 部分可见（越过右边缘，可见**面积**占比 44.8% ≥ MIN_VISIBLE_RATIO）⇒ 贴右边缘，尺寸不变。
  // 注意判据是面积比不是单轴比例：x 露 120/268 且高度全在屏内 ⇒ 0.4478
  const rightOverflow = clampIntoWorkArea(
    { x: 1800, y: 500, width: PET_WIDTH, height: PET_HEIGHT },
    ONE_SCREEN,
    PRIMARY_AREA,
  );
  assert.equal(rightOverflow.x, PRIMARY_AREA.width - PET_WIDTH, '贴右边缘');
  assert.equal(rightOverflow.y, 500, 'y 本来就在屏内，不许被顺手挪动');
  // 越过下边缘（可见面积 240/348 = 69% ≥ 阈值）⇒ 贴下边缘
  const bottomOverflow = clampIntoWorkArea(
    { x: 500, y: 800, width: PET_WIDTH, height: PET_HEIGHT },
    ONE_SCREEN,
    PRIMARY_AREA,
  );
  assert.equal(bottomOverflow.y, PRIMARY_AREA.height - PET_HEIGHT, '贴下边缘');
  assert.equal(bottomOverflow.x, 500);
  assert.equal(bottomOverflow.width, PET_WIDTH, '夹取不许改尺寸');
  // 显示器被拔掉（坐标落在不存在的屏上）⇒ 可见比例不足 ⇒ 默认角落
  const gone = clampIntoWorkArea({ x: 3000, y: 200, width: PET_WIDTH, height: PET_HEIGHT }, ONE_SCREEN, PRIMARY_AREA);
  assert.deepEqual({ x: gone.x, y: gone.y }, DEFAULT_POINT, '默认落点 = 右下角内缩 EDGE_MARGIN');
  assert.ok(MIN_VISIBLE_RATIO > 0 && MIN_VISIBLE_RATIO < 1, '可见比例阈值必须介于 0/1 之间，否则判据退化成恒真恒假');
});

test('clampIntoWorkArea：脏输入退化为默认落点（不可信输入不许抛）', () => {
  for (const bad of [null, undefined, {}, { x: 'a', y: 'b' }]) {
    const rect = clampIntoWorkArea(bad, ONE_SCREEN, PRIMARY_AREA);
    assert.equal(rect.width, PET_WIDTH, `输入 ${JSON.stringify(bad)} 的宽度应回默认值`);
    assert.equal(rect.height, PET_HEIGHT);
    assert.ok(rect.x >= PRIMARY_AREA.x && rect.x <= PRIMARY_AREA.width - PET_WIDTH);
  }
  // displays 不是数组 / primaryArea 缺失 ⇒ 仍不抛
  assert.doesNotThrow(() => clampIntoWorkArea({ x: 10, y: 10, width: 268, height: 348 }, null, PRIMARY_AREA));
});

test('resolveInitialBounds = 迁移 + 夹取（启动路径组合，语义与拆分前逐值一致）', () => {
  // 老存档（无 artOrigin）在屏内 ⇒ 迁移后的位置
  const legacy = resolveInitialBounds({
    saved: { x: 1000, y: 500 },
    size: SIZE,
    displays: ONE_SCREEN,
    primaryArea: PRIMARY_AREA,
  });
  assert.deepEqual(legacy, { x: 960, y: 492, width: 268, height: 348 });

  // 完全越界（屏幕被拔掉）⇒ 默认角落
  const offscreen = resolveInitialBounds({
    saved: { x: 5000, y: 5000, artOrigin: { ...ART_ORIGIN } },
    size: SIZE,
    displays: ONE_SCREEN,
    primaryArea: PRIMARY_AREA,
  });
  assert.deepEqual({ x: offscreen.x, y: offscreen.y }, DEFAULT_POINT);

  // 没存过 ⇒ 默认角落
  const fresh = resolveInitialBounds({ saved: null, size: SIZE, displays: ONE_SCREEN, primaryArea: PRIMARY_AREA });
  assert.deepEqual({ x: fresh.x, y: fresh.y }, DEFAULT_POINT);

  // 组合关系：resolveInitialBounds 必须恰好等于 clampIntoWorkArea(migrateSavedBounds(...))
  const saved = { x: 1000, y: 500 };
  assert.deepEqual(
    legacy,
    clampIntoWorkArea(migrateSavedBounds(saved, SIZE), ONE_SCREEN, PRIMARY_AREA),
    '启动路径必须就是"先迁移再夹取"，两步顺序不许颠倒',
  );
});

test('D-02 反证金丝雀：把实时 bounds 喂给"迁移"函数，5 次必累积 −200/−40（这就是缺陷的数值指纹）', () => {
  // 这条断言守的是"为什么不能混用"：一旦有人把 reclamp 改回
  // `resolveInitialBounds({ saved: bounds, size: bounds })`，运行时就是这个轨迹。
  // 它本身**不是**通过条件（我们不许这么调用），而是把缺陷的指纹钉死在测试里，
  // 让下一个人一眼看懂"−40/−8 × 5"从哪来。
  let bounds = { x: 1000, y: 500, width: PET_WIDTH, height: PET_HEIGHT };
  const trail = [];
  for (let index = 0; index < 5; index += 1) {
    bounds = resolveInitialBounds({ saved: bounds, size: bounds, displays: ONE_SCREEN, primaryArea: PRIMARY_AREA });
    trail.push(`${bounds.x},${bounds.y}`);
  }
  assert.deepEqual(
    trail,
    ['960,492', '920,484', '880,476', '840,468', '800,460'],
    '混用路径的位移必须正是每次 (−40, −8)：这条金丝雀红了说明补偿量变了（D-01 改了边距？）',
  );
  assert.equal(1000 - bounds.x, 200, '5 次累计 X 漂移 −200');
  assert.equal(500 - bounds.y, 40, '5 次累计 Y 漂移 −40');

  // 对照：正确路径（纯夹取）5 次纹丝不动
  let clamped = { x: 1000, y: 500, width: PET_WIDTH, height: PET_HEIGHT };
  for (let index = 0; index < 5; index += 1) {
    clamped = clampIntoWorkArea(clamped, ONE_SCREEN, PRIMARY_AREA);
  }
  assert.deepEqual({ x: clamped.x, y: clamped.y }, { x: 1000, y: 500 }, '正确路径必须零漂移');
});

test('D-02 职责分离（源码形态）：reclampIntoDisplays 只许夹取 + flushSave，不许碰迁移', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'pet-window.cjs'), 'utf8');
  const start = source.indexOf('function reclampIntoDisplays(');
  assert.ok(start > 0, '找不到 reclampIntoDisplays：函数被改名/删除时这条守卫必须立刻报出来');
  const end = source.indexOf('\n  }', start);
  assert.ok(end > start, 'reclampIntoDisplays 的函数体解析失败');
  const body = source.slice(start, end);

  assert.ok(body.includes('clampIntoWorkArea('), 'reclamp 必须走纯夹取函数');
  assert.equal(
    body.includes('resolveInitialBounds('),
    false,
    'reclamp 里出现 resolveInitialBounds = 把实时 bounds 当存档再补偿一次（D-02 回归）',
  );
  assert.ok(body.includes('flushSave()'), '夹完必须落盘，否则下次启动又按旧位置算（验收判据 4）');
  assert.equal(body.includes('artOrigin'), false, 'reclamp 里不该出现任何 artOrigin 补偿字样');

  // 全局只许两处调用解析函数：启动 create() 与 resolveInitialBounds 自身的组合
  const callSites = source.match(/resolveInitialBounds\(/g) || [];
  assert.equal(callSites.length, 2, `resolveInitialBounds 的调用点应只有"定义里的递归组合 + create()"两处，实际 ${callSites.length}`);

  // 启动路径必须把迁移结果**立刻落盘并带上 artOrigin**：
  // 不落盘 ⇒ 老状态文件每次启动都被补一次（单次迁移退化成持续漂移）。
  const createStart = source.indexOf('function create()');
  assert.ok(createStart > 0, '找不到 create()');
  const createBody = source.slice(createStart, source.indexOf('\n  }', createStart));
  assert.ok(createBody.includes('resolveInitialBounds('), 'create() 必须用启动解算（迁移 + 夹取）');
  assert.ok(createBody.includes('writeState('), 'create() 必须在启动时把解算结果落盘');
  assert.ok(/writeState\([\s\S]*artOrigin:\s*ART_ORIGIN/.test(createBody), '落盘必须带 artOrigin: ART_ORIGIN（迁移只补一次的凭据）');
});

// ---------------------------------------------------------------- 真跑窗口管理器
//
// 上面那条"源码形态"断言只是权宜：它认得调用点，认不出运行时数值。这里用**假 electron 模块**
// 把 `registerPetWindow` 真跑起来（不启动 Electron），于是"reclampIntoDisplays 连调 5 次位置
// 逐次相等"可以被逐值验证——这正是 QA 判据 1 的原话。做法：临时替换 `Module._load`，
// 让 pet-window.cjs 内部的 `require('electron')` 拿到桩件（它是懒加载的，所以来得及）。

/**
 * 造一套假 electron（`BrowserWindow` / `screen` / `app`），只实现 `create()` 真正会调的方法。
 *
 * @param {object} state 共享状态：`moves` 记录 setPosition、`sent` 记录下发消息
 * @returns {{fake: object, screenHandlers: Map<string, Function[]>}} 假模块与 screen 事件表
 */
function makeFakeElectron(state) {
  const screenHandlers = new Map();
  /**
   * 假 BrowserWindow：位置存在 `bounds` 里，`setPosition` 同步更新并记账。
   */
  class FakeBrowserWindow {
    constructor(options) {
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.destroyed = false;
      this.visible = false;
      this.webContents = {
        send(channel, payload) {
          state.sent.push({ channel, payload });
        },
        on() {},
        once() {},
        setWindowOpenHandler() {},
      };
    }

    getBounds() {
      return { ...this.bounds };
    }

    setPosition(x, y) {
      this.bounds.x = x;
      this.bounds.y = y;
      state.moves.push({ x, y });
    }

    isDestroyed() {
      return this.destroyed;
    }

    setAlwaysOnTop() {}
    setIgnoreMouseEvents() {}
    loadURL(target) {
      state.loaded = target;
    }

    loadFile(target) {
      state.loaded = target;
    }

    showInactive() {
      this.visible = true;
    }

    isVisible() {
      return this.visible;
    }

    hide() {
      this.visible = false;
    }

    destroy() {
      this.destroyed = true;
    }

    once() {}
    on() {}
  }

  const fake = {
    BrowserWindow: FakeBrowserWindow,
    app: { getPath: () => state.userData },
    screen: {
      getAllDisplays: () => [{ workArea: { ...PRIMARY_AREA } }],
      getPrimaryDisplay: () => ({ workArea: { ...PRIMARY_AREA } }),
      getDisplayNearestPoint: () => ({ workArea: { ...PRIMARY_AREA } }),
      on(name, handler) {
        const list = screenHandlers.get(name) || [];
        list.push(handler);
        screenHandlers.set(name, list);
      },
    },
  };
  return { fake, screenHandlers };
}

/**
 * 在假 electron 模块下执行一段同步代码（`Module._load` 临时改写，`finally` 必还原）。
 *
 * @param {object} fakeElectron 假 electron 模块
 * @param {Function} run 待执行的回调
 * @returns {*} 回调返回值
 */
function withFakeElectron(fakeElectron, run) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return run();
  } finally {
    Module._load = originalLoad;
  }
}

/**
 * 一个临时状态文件目录 + 假 electron 的完整舞台（跑完必须 `cleanup()`）。
 *
 * @param {object} savedState 预置的状态文件内容（`null` 表示不预置）
 * @returns {{statePath: string, state: object, cleanup: Function}} 舞台
 */
function makeStage(savedState) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pet-bounds-'));
  const statePath = path.join(dir, 'pet-window-state.json');
  if (savedState) {
    petWindow.writeState(statePath, savedState);
  }
  const state = { userData: dir, moves: [], sent: [], loaded: null };
  return {
    statePath,
    state,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 假 ipcMain：`create()` 之前会用 registerPetWindow 挂 IPC，这里全部吞掉。 */
const FAKE_IPC_MAIN = { on() {}, handle() {}, removeHandler() {}, removeAllListeners() {} };

test('D-02 幂等性（真跑 reclampIntoDisplays）：连触 5 次显示器事件，窗口位置逐次相等', () => {
  const stage = makeStage({ x: 1000, y: 500, width: PET_WIDTH, height: PET_HEIGHT });
  try {
    const { fake, screenHandlers } = makeFakeElectron(stage.state);
    withFakeElectron(fake, () => {
      const controller = petWindow.registerPetWindow({
        ipcMain: FAKE_IPC_MAIN,
        isDev: false,
        frontendRoot: path.join(__dirname, '..'),
        statePath: stage.statePath,
      });
      const win = controller.create();
      // 老存档（无 artOrigin）→ 启动迁移一次：(1000,500) − (40,8) = (960,492)
      assert.deepEqual({ x: win.getBounds().x, y: win.getBounds().y }, { x: 960, y: 492 }, '启动迁移结果');

      const handlers = [
        ...(screenHandlers.get('display-metrics-changed') || []),
        ...(screenHandlers.get('display-removed') || []),
      ];
      assert.equal(handlers.length, 2, 'display-metrics-changed 与 display-removed 都必须挂上（QA D-02 的触发条件）');

      const trail = [];
      for (let index = 0; index < 5; index += 1) {
        for (const handler of handlers) handler();
        trail.push(`${win.getBounds().x},${win.getBounds().y}`);
      }
      // 逐次相等：旧实现（把实时 bounds 当存档喂给迁移）在这里会得到
      // 920,484 / 880,476 / …（每次 −40,−8，10 次事件后共 −400,−80）
      assert.deepEqual(
        trail,
        ['960,492', '960,492', '960,492', '960,492', '960,492'],
        'reclamp 每次都必须夹到同一个稳定点（D-02 回归会立刻把这条打成阶梯）',
      );
      assert.equal(stage.state.moves.length, 0, '位置没变就不该调 setPosition（白调会触发多余的合成器工作）');
    });
  } finally {
    stage.cleanup();
  }
});

test('D-02 落盘（真跑）：reclamp 之后状态文件立刻是"当前位置 + 当前 artOrigin"，重启补偿量为 0', () => {
  const stage = makeStage({ x: 1000, y: 500, width: PET_WIDTH, height: PET_HEIGHT });
  try {
    const { fake, screenHandlers } = makeFakeElectron(stage.state);
    let firstPosition = null;
    withFakeElectron(fake, () => {
      const controller = petWindow.registerPetWindow({
        ipcMain: FAKE_IPC_MAIN,
        isDev: false,
        frontendRoot: path.join(__dirname, '..'),
        statePath: stage.statePath,
      });
      const win = controller.create();
      firstPosition = win.getBounds();
      for (const handler of screenHandlers.get('display-metrics-changed') || []) handler();
    });

    // 验收判据 4：夹完必须 flushSave，且写回去的必须带 artOrigin（迁移只补一次的凭据）
    const persisted = JSON.parse(readFileSync(stage.statePath, 'utf8'));
    assert.deepEqual(
      { x: persisted.x, y: persisted.y },
      { x: firstPosition.x, y: firstPosition.y },
      '状态文件必须与窗口实际位置一致（不落盘 = 下次启动按旧位置算）',
    );
    assert.deepEqual(persisted.artOrigin, ART_ORIGIN, '落盘必须带当前 artOrigin，否则下次启动又被当老存档补偿一次');

    // 第二次启动（新控制器读同一个状态文件）：补偿量必须为 0，位置纹丝不动
    const second = makeFakeElectron(stage.state);
    withFakeElectron(second.fake, () => {
      const controller = petWindow.registerPetWindow({
        ipcMain: FAKE_IPC_MAIN,
        isDev: false,
        frontendRoot: path.join(__dirname, '..'),
        statePath: stage.statePath,
      });
      const win = controller.create();
      assert.deepEqual(
        { x: win.getBounds().x, y: win.getBounds().y },
        { x: firstPosition.x, y: firstPosition.y },
        '迁移只许发生一次：第二次启动还偏移就是"每次启动都补一次"（D-02 的另一半）',
      );
    });
  } finally {
    stage.cleanup();
  }
});

test('B-3 反向守（真跑）：当前布局存档 + 一次显示器事件，位置与状态文件都不许动', () => {
  const current = { x: 1234, y: 567, width: PET_WIDTH, height: PET_HEIGHT, artOrigin: { ...ART_ORIGIN } };
  const stage = makeStage(current);
  try {
    const { fake, screenHandlers } = makeFakeElectron(stage.state);
    withFakeElectron(fake, () => {
      const controller = petWindow.registerPetWindow({
        ipcMain: FAKE_IPC_MAIN,
        isDev: false,
        frontendRoot: path.join(__dirname, '..'),
        statePath: stage.statePath,
      });
      const win = controller.create();
      assert.deepEqual({ x: win.getBounds().x, y: win.getBounds().y }, { x: 1234, y: 567 }, '带 artOrigin 的存档零补偿');
      for (const handler of screenHandlers.get('display-removed') || []) handler();
      assert.deepEqual({ x: win.getBounds().x, y: win.getBounds().y }, { x: 1234, y: 567 }, 'reclamp 不许挪一个像素');
    });
    const persisted = JSON.parse(readFileSync(stage.statePath, 'utf8'));
    assert.deepEqual({ x: persisted.x, y: persisted.y }, { x: 1234, y: 567 }, '状态文件同样不许漂');
  } finally {
    stage.cleanup();
  }
});

test('B-3 反向守（真跑）：临时目录里不许留下中间文件（舞台自清理，避免污染仓库）', () => {
  const stage = makeStage(null);
  try {
    const { fake } = makeFakeElectron(stage.state);
    withFakeElectron(fake, () => {
      const controller = petWindow.registerPetWindow({
        ipcMain: FAKE_IPC_MAIN,
        isDev: false,
        frontendRoot: path.join(__dirname, '..'),
        statePath: stage.statePath,
      });
      controller.create();
    });
    // 清空前：目录里只有我们预置/写出的状态文件本体
    assert.deepEqual(readdirSync(path.dirname(stage.statePath)), ['pet-window-state.json'], '状态目录只该有状态文件');
  } finally {
    stage.cleanup();
  }
  assert.equal(existsSync(path.dirname(stage.statePath)), false, '舞台必须清理干净（否则临时文件会堆在 tmp 里）');
});
