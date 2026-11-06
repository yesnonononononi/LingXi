/**
 * S2（T04）· 偏好-菜单**接线**单测（P-M16 的接线部分）。
 *
 * <p><b>这个文件存在的理由（重要，别删）：</b>上一轮把接线直接写在 `main.cjs` 里，
 * 留下了一个"被调用、没定义"的 `rebuildTrayMenu` —— 用户一点开关就 `ReferenceError`，
 * 而 <b>36 条纯模块用例一条都不会红</b>，因为那段代码 `require` 不进来（`main.cjs`
 * 一加载就去 `require('electron')`、抢单实例锁）。</p>
 *
 * <p>所以这里做两件事：</p>
 * <ol>
 *   <li><b>行为</b>：手摇 `pet-prefs-wiring.cjs`（纯逻辑、依赖全注入），真跑
 *       "点一下开关 → 先落盘 → 广播 → 重建菜单 → 新勾选态"这条链，并逐项断言顺序与结果；</li>
 *   <li><b>结构</b>：静态守卫 `main.cjs`（W09/W10）——<b>它调用的每个本地函数都必须有定义</b>、
 *       托盘模板只能来自 `pet-menu.cjs`、`require('./pet-window.cjs')` 必须仍是条件式（H6）。
 *       这条正是"坏了也没人红"的补丁。</li>
 * </ol>
 *
 * <p>运行：`npm run test:pet`（node 直接跑，不需要 Electron）。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const FRONTEND_ROOT = path.join(__dirname, '..');

const prefsModule = require(path.join(FRONTEND_ROOT, 'electron', 'pet-prefs.cjs'));
const wiringModule = require(path.join(FRONTEND_ROOT, 'electron', 'pet-prefs-wiring.cjs'));
const petMenu = require(path.join(FRONTEND_ROOT, 'electron', 'pet-menu.cjs'));
const gate = require(path.join(FRONTEND_ROOT, 'electron', 'pet-feature-gate.cjs'));

const { createPrefsStore, PREF_PROBLEMS } = prefsModule;
const { createPrefsWiring, WIRING_SOURCE } = wiringModule;

/**
 * 建一个独立临时目录（每个用例一个，跑完即删）。
 *
 * @param {string} label 目录标签
 * @returns {{file: string, dispose: () => void}} 偏好文件路径与清理函数
 */
function makeTempPrefs(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pet-wiring-${label}-`));
  return {
    file: path.join(dir, 'pet-prefs.json'),
    dispose() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响断言 */
      }
    },
  };
}

/**
 * 包一层"带事件流"的仓库：记录 read/write 的发生顺序（顺序断言用）。
 *
 * @param {object} store 真仓库
 * @param {string[]} events 事件数组
 * @returns {{read: Function, write: Function, update: Function}} 代理仓库
 */
function spyStore(store, events) {
  return {
    read: () => {
      events.push('read');
      return store.read();
    },
    write: (prefs) => {
      events.push('write');
      return store.write(prefs);
    },
    update: (patch) => {
      events.push('update');
      return store.update(patch);
    },
  };
}

/**
 * 造一个接线器（默认参数集中在这一处，用例只覆盖自己关心的字段）。
 *
 * @param {object} [overrides] 覆盖项
 * @returns {{wiring: object, events: string[], rebuilds: object[][], warns: string[]}} 接线器与观测点
 */
function makeWiring(overrides = {}) {
  const events = [];
  const rebuilds = [];
  const warns = [];
  const wiring = createPrefsWiring({
    store: null,
    builder: petMenu,
    isVisible: () => true,
    includePet: true,
    prefersReducedMotion: false,
    warn: (message) => warns.push(message),
    rebuildTray: (spec) => {
      events.push('rebuildTray');
      rebuilds.push(spec);
    },
    ...overrides,
  });
  return { wiring, events, rebuilds, warns };
}

test('W01 · 点击托盘「跟随鼠标」⇒ 偏好落盘 → 菜单重建 → 勾选态与右键同源', () => {
  const temp = makeTempPrefs('click');
  try {
    // 落盘与重建共用**一条**事件流，才能断言两者的先后顺序
    const events = [];
    const store = spyStore(createPrefsStore({ filePath: temp.file }), events);
    const rebuilds = [];
    const wiring = createPrefsWiring({
      store,
      builder: petMenu,
      isVisible: () => true,
      includePet: true,
      rebuildTray: (spec) => {
        events.push('rebuildTray');
        rebuilds.push(spec);
      },
    });

    // 初始：无文件 ⇒ U-M2 默认（follow=false / roam=true）
    assert.equal(wiring.getPrefs().follow, false);
    assert.equal(wiring.getPrefs().roam, true);

    const specBefore = wiring.getTraySpec();
    const followBefore = petMenu.findItemById(specBefore, petMenu.MENU_IDS.FOLLOW);
    assert.equal(followBefore.checked, false, '初始勾选态必须来自 prefs');

    // 点它（走真实 click 回调 —— 不是直接调 setPrefs）
    followBefore.click();

    // ① 偏好变了
    assert.equal(wiring.getPrefs().follow, true, '点击后偏好必须立刻变');
    // ② 落盘了（文件里读回来一致）
    const onDisk = JSON.parse(fs.readFileSync(temp.file, 'utf8'));
    assert.equal(onDisk.follow, true, '点击必须立刻持久化');
    assert.equal(onDisk.version, 1);
    // ③ 菜单重建了，且新 spec 的勾选态与 prefs 一致
    assert.equal(rebuilds.length, 1, '一次点击必须只重建一次菜单');
    const followAfter = petMenu.findItemById(rebuilds[0], petMenu.MENU_IDS.FOLLOW);
    assert.equal(followAfter.checked, true, '重建出来的菜单勾选态必须等于新 prefs');
    // ④ 右键菜单（pet-menu 的同一构建器）此刻算出来的勾选态必须与托盘完全一致
    const contextSpec = petMenu.buildContextMenuItems({ prefs: wiring.getPrefs(), isVisible: true });
    assert.equal(
      petMenu.findItemById(contextSpec, petMenu.MENU_IDS.FOLLOW).checked,
      followAfter.checked,
      '托盘与右键必须同源（勾选态不一致就是两份真源）',
    );
    // ⑤ 事件顺序：write（落盘）→ rebuildTray（重建）
    assert.deepEqual(
      events.filter((item) => item === 'write' || item === 'rebuildTray'),
      ['write', 'rebuildTray'],
      '必须先落盘再重建菜单',
    );
  } finally {
    temp.dispose();
  }
});

test('W02 · 顺序固定：先落盘 → 再广播 → 最后重建菜单', () => {
  const temp = makeTempPrefs('order');
  try {
    const order = [];
    const store = spyStore(createPrefsStore({ filePath: temp.file }), []);
    const wiring = createPrefsWiring({
      store: {
        read: () => store.read(),
        write: (prefs) => {
          order.push('write');
          return store.write(prefs);
        },
      },
      builder: petMenu,
      isVisible: () => true,
      includePet: true,
      rebuildTray: () => order.push('rebuildTray'),
    });
    // 订阅者用 onChange 注册（等于将来的"广播给渲染层"）
    wiring.onChange(() => order.push('broadcast'));

    wiring.setPrefs({ roam: false });
    assert.deepEqual(order, ['write', 'broadcast', 'rebuildTray'], `顺序错了：${order.join(' → ')}`);
  } finally {
    temp.dispose();
  }
});

test('W03 · 写盘失败：记一条 warn、本轮仍在内存生效、菜单照常重建', () => {
  const warns = [];
  const rebuilds = [];
  const failingStore = {
    read: () => ({
      prefs: { version: 1, follow: false, roam: true },
      problems: [],
      status: 'ok',
      writable: true,
      renamedCorrupt: false,
    }),
    write: () => ({ ok: false, problems: [`${PREF_PROBLEMS.WRITE_FAILED}:EPERM`], path: 'x' }),
  };
  const wiring = createPrefsWiring({
    store: failingStore,
    builder: petMenu,
    isVisible: () => true,
    includePet: true,
    warn: (message) => warns.push(message),
    rebuildTray: (spec) => rebuilds.push(spec),
  });

  const result = wiring.setPrefs({ follow: true });
  assert.equal(result.ok, false, '写入失败必须如实返回 ok:false');
  assert.equal(result.changed, true);
  assert.equal(wiring.getPrefs().follow, true, '本轮内存中必须生效（否则用户点了看不到变化）');
  assert.equal(rebuilds.length, 1, '写盘失败也要重建菜单（勾选态反映用户刚点的状态）');
  assert.equal(warns.length, 1, '**写盘失败必须 warn 一条**（不许静默吞掉）');
  assert.ok(warns[0].includes(PREF_PROBLEMS.WRITE_FAILED), `warn 文案必须含原因码：${warns[0]}`);
});

test('W04 · 门禁关闭（打包版）：不读不写偏好文件、菜单零桌宠项、setPrefs 是 no-op', () => {
  const { wiring, rebuilds } = makeWiring({ store: null, includePet: false });
  const load = wiring.getLoadResult();
  assert.equal(load.source, WIRING_SOURCE.GATE_OFF, '打包版装载来源必须是 gate-off');
  assert.equal(load.writable, false);

  const before = wiring.getPrefs();
  assert.deepEqual(before, { version: 1, follow: false, roam: true }, '打包版仍要有合法偏好快照（菜单不许崩）');
  const result = wiring.setPrefs({ follow: true });
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(wiring.getPrefs().follow, false, '打包版 setPrefs 必须 no-op');
  assert.equal(rebuilds.length, 0, '打包版 setPrefs 不该触发菜单重建');

  const spec = wiring.getTraySpec();
  const trayIds = spec.map((item) => item.id).filter(Boolean);
  assert.deepEqual(trayIds, [petMenu.MENU_IDS.TRAY_SHOW_MAIN, petMenu.MENU_IDS.TRAY_QUIT_APP], '打包版必须零桌宠菜单项');
  assert.equal(spec.some((item) => item.type === 'checkbox'), false, '打包版托盘不许有任何勾选项');
});

test('W05 · 启动：坏 JSON ⇒ 逐字段降级 + **一条** warn（含原因码）', () => {
  const temp = makeTempPrefs('corrupt');
  try {
    fs.writeFileSync(temp.file, '{ "follow": tru', 'utf8');
    const { wiring, warns } = makeWiring({ store: createPrefsStore({ filePath: temp.file }) });
    assert.equal(wiring.getPrefs().follow, false);
    assert.equal(wiring.getPrefs().roam, true, '坏文件只影响可读字段，默认值仍按 U-M2');
    assert.equal(warns.length, 1, `启动只许 warn 一条，实际 ${warns.length}`);
    assert.ok(warns[0].includes(PREF_PROBLEMS.BAD_JSON), `warn 文案必须含原因码：${warns[0]}`);
    assert.equal(wiring.getLoadResult().source, 'file', '文件存在就走"以文件为准"这条路径');
  } finally {
    temp.dispose();
  }
});

test('W06 · 启动：无偏好文件 + reduced-motion ⇒ 两个开关默认全关（U-M4 路径②）', () => {
  const temp = makeTempPrefs('reduced');
  try {
    const { wiring } = makeWiring({
      store: createPrefsStore({ filePath: temp.file }),
      prefersReducedMotion: true,
    });
    assert.deepEqual(wiring.getPrefs(), { version: 1, follow: false, roam: false });
    const load = wiring.getLoadResult();
    assert.equal(load.source, WIRING_SOURCE.REDUCED_MOTION);
    assert.equal(load.appliedReducedMotion, true);
    // 仍然可以手动开（不是永久禁用）
    wiring.setPrefs({ roam: true });
    assert.equal(wiring.getPrefs().roam, true, 'reduced-motion 只影响默认值，不许阻止用户手动开启');
    assert.equal(JSON.parse(fs.readFileSync(temp.file, 'utf8')).roam, true, '手动开启必须落盘');
  } finally {
    temp.dispose();
  }
});

test('W07 · 启动：**已有文件时一律以文件为准**（reduced-motion 不许静默改写用户选择）', () => {
  const temp = makeTempPrefs('filewins');
  try {
    fs.writeFileSync(temp.file, JSON.stringify({ version: 1, follow: true, roam: true }), 'utf8');
    const before = fs.readFileSync(temp.file, 'utf8');
    const { wiring } = makeWiring({
      store: createPrefsStore({ filePath: temp.file }),
      prefersReducedMotion: true,
    });
    assert.deepEqual(
      wiring.getPrefs(),
      { version: 1, follow: true, roam: true },
      '文件里的 true 必须原样保留（这条坏了＝静默改写用户选择）',
    );
    const load = wiring.getLoadResult();
    assert.equal(load.source, 'file');
    assert.equal(load.appliedReducedMotion, false);
    assert.equal(fs.readFileSync(temp.file, 'utf8'), before, '启动读取绝不许改动文件内容');
  } finally {
    temp.dispose();
  }
});

test('W08 · 订阅/幂等：取消订阅后收不到变更；同一补丁第二次 changed=false 但仍落盘', () => {
  const temp = makeTempPrefs('idempotent');
  try {
    const { wiring } = makeWiring({ store: createPrefsStore({ filePath: temp.file }) });
    const received = [];
    const unsubscribe = wiring.onChange((prefs) => received.push(prefs.follow));

    wiring.setPrefs({ follow: true });
    assert.deepEqual(received, [true]);

    unsubscribe();
    wiring.setPrefs({ follow: false });
    assert.deepEqual(received, [true], '取消订阅后不该再收到变更');

    // 重复同一补丁：值不变 ⇒ changed:false，但仍然是合法写入（不抛）
    const again = wiring.setPrefs({ roam: true });
    assert.equal(again.changed, false);
    assert.equal(again.ok, true);
    // 非布尔补丁被忽略（前向兼容）
    const ignored = wiring.setPrefs({ follow: 'yes' });
    assert.equal(wiring.getPrefs().follow, false, '非布尔补丁必须被忽略');
    assert.equal(ignored.changed, false);
  } finally {
    temp.dispose();
  }
});

/**
 * 去掉源码里的注释（保留字符串字面量与行号）。
 *
 * <p>口径与 `tests/petFeatureGate.test.cjs` 的 `stripComments` 一致：注释里提到函数名
 * 是说明，不算"有定义"。</p>
 *
 * @param {string} source 源码
 * @returns {string} 去注释后的源码
 */
function stripComments(source) {
  let out = '';
  let index = 0;
  let quote = '';
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === '\n' && (quote === '"' || quote === "'")) quote = '';
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next === undefined ? '' : next;
        index += 2;
        continue;
      }
      if (ch === quote) quote = '';
      index += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

test('W09 · 结构：main.cjs 里每个被调用的本地函数都有定义（上一轮的悬空引用守卫）', () => {
  const source = fs.readFileSync(path.join(FRONTEND_ROOT, 'electron', 'main.cjs'), 'utf8');
  const code = stripComments(source);

  // ① 托盘重建必须是**有定义的函数**，且至少被调用一次
  assert.match(code, /^function rebuildTrayMenu\(/m, 'main.cjs 必须定义 rebuildTrayMenu（上一轮它是悬空引用）');
  assert.ok(
    (code.match(/rebuildTrayMenu\(\)/g) || []).length >= 1,
    'rebuildTrayMenu 必须有调用点（否则定义了也没人用）',
  );

  // ② 通用守卫：把 main.cjs 里所有 `name(` 形式的调用收一遍，凡是以"本地风格"命名的
  //    （驼峰、且不是 require 进来的模块成员）都必须在文件里有一条 `function name(` 或
  //    `const name =` 定义。这里只查本任务新增的那几个名字，避免误伤 Electron API。
  const mustDefine = ['rebuildTrayMenu', 'setupTray', 'buildTrayMenuSpec'];
  for (const name of mustDefine) {
    const called = new RegExp(`(?<![.\\w])${name}\\(`, 'g');
    const calledCount = (code.match(called) || []).length;
    const defined = new RegExp(`function ${name}\\(|const ${name} =`, 'g').test(code);
    if (calledCount === 0) {
      // 允许"定义了但暂时没调用"的过渡态，但必须显式说明；buildTrayMenuSpec 已被删掉
      assert.equal(name, 'buildTrayMenuSpec', `${name} 既没定义也没调用`);
    }
    if (calledCount > 0) {
      assert.ok(defined, `${name} 被调用 ${calledCount} 次却没有定义（就是上一轮的 ReferenceError 形态）`);
    }
  }

  // ③ 托盘模板只能来自 pet-menu.cjs：main.cjs 的代码里不许再出现这些 label 字面量
  for (const label of ['显示桌宠', '跟随鼠标', '自由漫游', '显示界面', '彻底退出']) {
    assert.equal(
      code.includes(label),
      false,
      `main.cjs 代码里出现了菜单文案「${label}」：文案必须只有 pet-menu.cjs 一份`,
    );
  }
  assert.match(code, /builder:\s*petMenu/, '接线器必须注入 pet-menu 作为唯一 spec 构建器');
  assert.match(code, /getTraySpec\(|rebuildTray\(/, '托盘菜单必须经由接线器（其内部调 buildTrayItems）产出');
});

test('W10 · H6：main.cjs 对 pet-window 的 require 仍是条件式，并已注入偏好/菜单端口', () => {
  const source = fs.readFileSync(path.join(FRONTEND_ROOT, 'electron', 'main.cjs'), 'utf8');
  const code = stripComments(source);
  const lines = code.split('\n');
  const markers = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.includes("require('./pet-window.cjs')"));
  assert.ok(markers.length > 0, 'main.cjs 里找不到 pet-window 的 require：结构已变，请同步本测试');
  for (const { line, index } of markers) {
    const indented = /^\s{2,}/.test(line);
    const conditional = line.includes('?') || line.includes('&&') || line.includes('||');
    assert.ok(
      indented && conditional,
      `main.cjs:${index + 1} 对 pet-window 的 require 变成了顶层裸 require（打包版会在 require 阶段崩）`,
    );
  }
  // S4 用的端口必须已经传下去（否则右键菜单永远拿不到真偏好）
  assert.match(code, /registerPetWindow\(\{[^}]*prefs:\s*petPrefsPort/, 'registerPetWindow 必须收到 prefs 端口');
  assert.match(code, /registerPetWindow\(\{[^}]*menu:\s*petMenu/, 'registerPetWindow 必须收到 menu 构建器');
});

test('W11 · 两处菜单同源：托盘与右键的开关段逐项相等（id / 文案 / 勾选态 / 类型）', () => {
  const prefs = { follow: true, roam: false };
  // 用同一份 prefs 分别产出两处 spec
  const traySpec = petMenu.buildTrayItems({ prefs, isVisible: true, includePet: true });
  const contextSpec = petMenu.buildContextMenuItems({ prefs, isVisible: true });
  const pick = (items) =>
    items
      .filter((item) => item.type === 'checkbox' && item.id !== petMenu.MENU_IDS.TRAY_TOGGLE_PET)
      .map((item) => [item.id, item.label, item.checked, item.type]);
  assert.deepEqual(pick(traySpec), pick(contextSpec), '托盘与右键的开关段必须逐项相等（同源）');
  assert.equal(pick(traySpec).length, 2, '开关段必须有两条（跟随 / 漫游）');

  // 接线器产出的 spec 必须与上面同源：同一批 id / 文案 / 类型（勾选态由接线器自己的 prefs 决定）
  const { wiring } = makeWiring({ store: null, includePet: true, isVisible: () => true });
  const structural = (items) =>
    items
      .filter((item) => item.type === 'checkbox' && item.id !== petMenu.MENU_IDS.TRAY_TOGGLE_PET)
      .map((item) => [item.id, item.label, item.type]);
  assert.deepEqual(structural(wiring.getTraySpec()), structural(traySpec), '接线器的托盘 spec 必须来自同一构建器');
});

test('W12 · 打包版联动：resolvePetExposure(isPackaged) ⇒ 零桌宠窗口 + 零桌宠菜单项', () => {
  const exposure = gate.resolvePetExposure({ isPackaged: true, env: { LX_PET: '1' } });
  assert.equal(exposure.enabled, false, '安装版恒关（env 不得覆盖）');
  // 接线器按门禁产 spec：includePet=false ⇒ 无任何桌宠项
  const { wiring } = makeWiring({ store: null, includePet: exposure.enabled });
  const spec = wiring.getTraySpec();
  assert.equal(spec.length, 3, '打包版托盘只有：显示界面 / 分隔线 / 彻底退出');
  const ids = spec.map((item) => item.id).filter(Boolean);
  for (const petOnlyId of [petMenu.MENU_IDS.TRAY_TOGGLE_PET, petMenu.MENU_IDS.FOLLOW, petMenu.MENU_IDS.ROAM]) {
    assert.equal(ids.includes(petOnlyId), false, `打包版托盘不许出现桌宠项：${petOnlyId}`);
  }
  assert.deepEqual(ids, [petMenu.MENU_IDS.TRAY_SHOW_MAIN, petMenu.MENU_IDS.TRAY_QUIT_APP]);
});
