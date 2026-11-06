/**
 * 运动门禁（`scripts/check-pet-motion.mjs`）的**判别力**用例。
 *
 * <p><b>为什么门禁自己也要被测：</b>一个只会打印 ✅ 的门禁比没有门禁更危险——它会让人
 * 以为结构约束被守住了。所以这里喂给门禁两样东西：①一份**干净样本**（11 条判据全绿，
 * 证明它不会误报）；②**逐条坏样本**（每条判据各造一处破坏，门禁必须点名到
 * "哪条判据 + 哪个文件 + 哪一行"）。少一条，就是少一条判别力。</p>
 *
 * <p>干净样本是**合成的最小仓库**（不是真仓库）：真仓库在 S4 落地前 G-M5 / G-M6 / G-M8
 * 本来就是红的（`pet-window.cjs` 还在自己写位置、`applyPosition` 还没落地），
 * 拿它当"干净样本"会让本文件变成"永远红"，也就失去判别力。</p>
 *
 * <p>门禁是 ESM，本文件是 CJS（`test:pet` 用它跑 `node --test`），所以用动态 `import()`
 * 载入，只在进程内载一次。</p>
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/** 门禁模块的载入 Promise（进程内只载一次）。 */
const gatePromise = import('../scripts/check-pet-motion.mjs');

/** 干净样本：`scripts/pet-motion-probe.cjs`（守卫必须覆盖 hidden/suspended/gateOpen/睡姿）。 */
const CLEAN_PROBE = [
  "'use strict';",
  "const { MOTION } = require('../electron/pet-motion.cjs');",
  '',
  'function shouldSample(state) {',
  '  if (state === null || typeof state !== "object") return false;',
  '  if (state.hidden === true) return false;',
  '  if (state.suspended === true) return false;',
  '  if (state.gateOpen !== true) return false;',
  '  const posture = typeof state.posture === "string" ? state.posture : "";',
  '  if (posture === "sleep" || posture === "lie" || posture === "sleeping") return false;',
  '  return true;',
  '}',
  '',
  'function sampleOnce(deps) {',
  '  const state = deps.readState();',
  '  if (!shouldSample(state)) return null;',
  '  const snapshot = deps.readSnapshot();',
  '  return { t: deps.now(), x: snapshot.x, y: snapshot.y };',
  '}',
  '',
  'module.exports = { shouldSample, sampleOnce };',
  '',
].join('\n');

/** 干净样本：`electron/pet-motion.cjs`（无定时器；applyPosition 定义唯一、写入点唯一）。 */
const CLEAN_MOTION = [
  "'use strict';",
  '',
  'const MOTION = Object.freeze({',
  '  tickMs: 16,',
  '  followStartRadiusDip: 220,',
  '});',
  '',
  'function applyPosition(deps, point) {',
  '  const x = Math.round(point.x);',
  '  const y = Math.round(point.y);',
  '  if (deps.lastX === x && deps.lastY === y) return false;',
  '  deps.win.setPosition(x, y, false);',
  '  deps.lastX = x;',
  '  deps.lastY = y;',
  '  return true;',
  '}',
  '',
  'module.exports = { MOTION, applyPosition };',
  '',
].join('\n');

/** 干净样本：`electron/pet-window.cjs`（条件 require 运动真源；自己一次都不写位置）。 */
const CLEAN_WINDOW = [
  "'use strict';",
  '',
  'function createMotionBridge(win) {',
  "  const { createMotionController } = require('../pet-motion.cjs');",
  '  return createMotionController({ win, apply: (point) => point });',
  '}',
  '',
  'module.exports = { registerPetWindow() { return { createMotionBridge }; } };',
  '',
].join('\n');

/** 干净样本：`electron/pet-hit-poller.cjs`（只有暗示词注释，不许有手感字面量）。 */
const CLEAN_POLLER = [
  "'use strict';",
  '',
  'class HitPoller {',
  '  constructor(clock) {',
  '    this.clock = clock;',
  '  }',
  '',
  '  poll() {',
  '    if (this.suspended) {',
  '      return false;',
  '    }',
  '    return true;',
  '  }',
  '}',
  '',
  'module.exports = { HitPoller };',
  '',
].join('\n');

/** 干净样本：`electron/main.cjs`（H6：pet-window 只在条件路径上被 require）。 */
const CLEAN_MAIN = [
  "'use strict';",
  '',
  'function boot(options) {',
  '  const petWindow = options.petEnabled',
  "    ? require('./pet-window.cjs').registerPetWindow({})",
  '    : null;',
  '  return petWindow;',
  '}',
  '',
  'module.exports = { boot };',
  '',
].join('\n');

/** 干净样本：`electron/pet-menu.cjs`（菜单文案单一真源，本门禁只查数字）。 */
const CLEAN_MENU = [
  "'use strict';",
  '',
  'const ITEMS = Object.freeze([{ id: "follow", label: "跟随鼠标" }]);',
  '',
  'module.exports = { ITEMS };',
  '',
].join('\n');

/** 干净样本：`src/pet/main.ts`（朝向来自 IPC；通道名恰好一次；意图无坐标）。 */
const CLEAN_RENDER = [
  "const MOTION_INTENT_CHANNEL = 'pet:motion-intent';",
  '',
  'interface MotionIntent {',
  '  mode: MotionMode;',
  '  reason: MotionIntentReason;',
  '}',
  '',
  'function onMotion(fact: MotionFact): void {',
  '  locomotion.applyFacingIfMoving(fact.facing);',
  '}',
  '',
  'const DENSITY: string = window.devicePixelRatio >= 2 ? "2x" : "1x";',
  '',
].join('\n');

/** 干净样本：`src/pet/behavior/state-machine.ts`。 */
const CLEAN_STATE_MACHINE = [
  'export const IDLE_CHAIN_STATES: readonly string[] = Object.freeze(["idle", "walk", "run"]);',
  '',
  'export function applyFacingIfMoving(posture: PostureId, facing: Facing, setFacing: (n: Facing) => void): boolean {',
  "  if (posture !== 'walk' && posture !== 'run') return false;",
  '  setFacing(facing);',
  '  return true;',
  '}',
  '',
].join('\n');

/**
 * 造一份干净样本的源码表（每次调用都是全新的 Map，坏样本不会互相污染）。
 *
 * @returns {Map<string, string>} 路径 → 内容
 */
function makeCleanSources() {
  return new Map([
    ['electron/pet-motion.cjs', CLEAN_MOTION],
    ['electron/pet-window.cjs', CLEAN_WINDOW],
    ['electron/pet-hit-poller.cjs', CLEAN_POLLER],
    ['electron/main.cjs', CLEAN_MAIN],
    ['electron/pet-menu.cjs', CLEAN_MENU],
    ['src/pet/main.ts', CLEAN_RENDER],
    ['src/pet/behavior/state-machine.ts', CLEAN_STATE_MACHINE],
    ['scripts/pet-motion-probe.cjs', CLEAN_PROBE],
  ]);
}

/**
 * 跑一次门禁并取某条判据的结果。
 *
 * @param {Map<string, string>} sources 源码表
 * @param {string} id 判据 id
 * @returns {Promise<{ok: boolean, problems: string[]}>} 判据结果
 */
async function criterionOf(sources, id) {
  const gate = await gatePromise;
  const result = gate.runMotionGate({ sources });
  const criterion = result.criteria.find((item) => item.id === id);
  assert.ok(criterion, `门禁里没有判据 ${id}（判据被改名或删除了）`);
  return criterion;
}

/**
 * 在源码表里对某个文件做一次字符串替换（模拟"有人改坏了一处"）。
 *
 * @param {Map<string, string>} sources 源码表
 * @param {string} path 文件路径
 * @param {string} from 被替换的片段（必须存在）
 * @param {string} to 替换成的片段
 * @returns {Map<string, string>} 同一张表（就地修改）
 */
function patch(sources, path, from, to) {
  const source = sources.get(path);
  assert.equal(typeof source, 'string', `样本里没有 ${path}`);
  assert.ok(source.includes(from), `样本里找不到要被改坏的片段：${JSON.stringify(from)}`);
  sources.set(path, source.replace(from, to));
  return sources;
}

test('干净样本：11 条判据全绿（门禁不会误报）', async () => {
  const gate = await gatePromise;
  const result = gate.runMotionGate({ sources: makeCleanSources() });
  assert.equal(
    result.ok,
    true,
    `干净样本被误报：\n${result.problems.join('\n')}`,
  );
  assert.deepEqual(
    result.criteria.map((item) => item.id),
    ['G-M1', 'G-M2', 'G-M3', 'G-M4', 'G-M5', 'G-M6', 'G-M7', 'G-M8', 'G-M9', 'G-M10', 'G-M11'],
  );
});

test('G-M1：pet-motion.cjs 自己起定时器（连注释里出现也算）必须点名', async () => {
  const sources = patch(
    makeCleanSources(),
    'electron/pet-motion.cjs',
    'function applyPosition(deps, point) {',
    '// 顺手起个拍：setInterval(() => {}, 16)\nfunction applyPosition(deps, point) {',
  );
  const criterion = await criterionOf(sources, 'G-M1');
  assert.equal(criterion.ok, false);
  assert.match(criterion.problems.join('\n'), /pet-motion\.cjs:\d+/);
  assert.match(criterion.problems.join('\n'), /定时器/);
});

test('G-M2：主进程里出现 scaleFactor 必须点名（DIP 纯度）', async () => {
  const sources = patch(
    makeCleanSources(),
    'electron/pet-window.cjs',
    'function createMotionBridge(win) {',
    'function createMotionBridge(win) {\n  const ratio = screen.getPrimaryDisplay().scaleFactor;',
  );
  const criterion = await criterionOf(sources, 'G-M2');
  assert.equal(criterion.ok, false);
  assert.match(criterion.problems.join('\n'), /pet-window\.cjs:\d+/);
  assert.match(criterion.problems.join('\n'), /scaleFactor/);
});

test('G-M3：渲染层用 devicePixelRatio 推坐标、或镜像，必须分别点名', async () => {
  const drpSources = patch(
    makeCleanSources(),
    'src/pet/main.ts',
    'const DENSITY: string',
    'const offset = Math.round(window.devicePixelRatio * 100);\nconst DENSITY: string',
  );
  const drp = await criterionOf(drpSources, 'G-M3');
  assert.equal(drp.ok, false);
  assert.match(drp.problems.join('\n'), /main\.ts:\d+/);
  assert.match(drp.problems.join('\n'), /选密度档/);

  const mirrorSources = patch(
    makeCleanSources(),
    'src/pet/main.ts',
    'function onMotion(fact: MotionFact): void {',
    'function onMotion(fact: MotionFact): void {\n  root.style.transform = "scaleX(-1)";',
  );
  const mirror = await criterionOf(mirrorSources, 'G-M3');
  assert.equal(mirror.ok, false);
  assert.match(mirror.problems.join('\n'), /scaleX/);
});

test('G-M4：把 MOTION 的阈值抄成字面量必须点名（第二份真源）', async () => {
  const sources = patch(
    makeCleanSources(),
    'electron/pet-window.cjs',
    '  return createMotionController({ win, apply: (point) => point });',
    '  const followStartRadiusDip = 220;\n  return createMotionController({ win, apply: (point) => point, followStartRadiusDip });',
  );
  const criterion = await criterionOf(sources, 'G-M4');
  assert.equal(criterion.ok, false);
  const text = criterion.problems.join('\n');
  assert.match(text, /pet-window\.cjs:\d+/);
  assert.match(text, /followStartRadiusDip|220/);
});

test('G-M5：pet-window.cjs 自己写位置必须点名（唯一写者）', async () => {
  const sources = patch(
    makeCleanSources(),
    'electron/pet-window.cjs',
    '  return createMotionController({ win, apply: (point) => point });',
    '  win.setPosition(10, 20, false);\n  return createMotionController({ win, apply: (point) => point });',
  );
  const criterion = await criterionOf(sources, 'G-M5');
  assert.equal(criterion.ok, false);
  assert.match(criterion.problems.join('\n'), /pet-window\.cjs:5/);
  assert.match(criterion.problems.join('\n'), /setPosition/);
});

test('G-M6：对 pet-motion 的 require 被改成顶层裸 require、或整个消失，都必须点名', async () => {
  const bare = patch(
    makeCleanSources(),
    'electron/pet-window.cjs',
    "  const { createMotionController } = require('../pet-motion.cjs');",
    "const { createMotionController } = require('../pet-motion.cjs');",
  );
  const bareCriterion = await criterionOf(bare, 'G-M6');
  assert.equal(bareCriterion.ok, false);
  assert.match(bareCriterion.problems.join('\n'), /顶层裸 require/);

  const missing = patch(
    makeCleanSources(),
    'electron/pet-window.cjs',
    "  const { createMotionController } = require('../pet-motion.cjs');",
    "  const { createMotionController } = require('./nowhere.cjs');",
  );
  const missingCriterion = await criterionOf(missing, 'G-M6');
  assert.equal(missingCriterion.ok, false);
  assert.match(missingCriterion.problems.join('\n'), /尚未 require/);
});

test('G-M7：渲染层抄了 facing 滞回数值 / 自己从光标推朝向 / 镜像，都必须点名', async () => {
  const hysteresis = patch(
    makeCleanSources(),
    'src/pet/behavior/state-machine.ts',
    '  setFacing(facing);',
    '  if (hysteresisDip > 24) setFacing(facing);',
  );
  const hysteresisCriterion = await criterionOf(hysteresis, 'G-M7');
  assert.equal(hysteresisCriterion.ok, false);
  assert.match(hysteresisCriterion.problems.join('\n'), /滞回数值/);

  const fromCursor = patch(
    makeCleanSources(),
    'src/pet/main.ts',
    '  locomotion.applyFacingIfMoving(fact.facing);',
    '  const facing = event.clientX > 0 ? 1 : -1;\n  locomotion.applyFacingIfMoving(facing);',
  );
  const fromCursorCriterion = await criterionOf(fromCursor, 'G-M7');
  assert.equal(fromCursorCriterion.ok, false);
  assert.match(fromCursorCriterion.problems.join('\n'), /朝向/);
});

test('G-M8：applyPosition 出现第二个定义、或第二个写入点，都必须点名', async () => {
  const secondWrite = patch(
    makeCleanSources(),
    'electron/pet-motion.cjs',
    '  return true;\n}',
    '  deps.win.setPosition(x, y + 1, false);\n  return true;\n}',
  );
  const secondWriteCriterion = await criterionOf(secondWrite, 'G-M8');
  assert.equal(secondWriteCriterion.ok, false);
  assert.match(secondWriteCriterion.problems.join('\n'), /applyPosition 体内有 2 处位置写入/);

  const secondDefinition = patch(
    makeCleanSources(),
    'electron/pet-motion.cjs',
    'module.exports = { MOTION, applyPosition };',
    'function applyPosition(deps, point) {\n  deps.win.setPosition(0, 0, false);\n}\n\nmodule.exports = { MOTION, applyPosition };',
  );
  const secondDefinitionCriterion = await criterionOf(secondDefinition, 'G-M8');
  assert.equal(secondDefinitionCriterion.ok, false);
  assert.match(secondDefinitionCriterion.problems.join('\n'), /applyPosition 定义/);
});

test('G-M8：applyPosition 写成 class 方法（S4 的真实形态）也必须被认出来，且写入点计数正确', async () => {
  const classForm = makeCleanSources();
  classForm.set(
    'electron/pet-motion.cjs',
    [
      "'use strict';",
      '',
      'const MOTION = Object.freeze({ tickMs: 16 });',
      '',
      'class MotionController {',
      '  constructor(win) {',
      '    this.win = win;',
      '    this.written = { x: 0, y: 0 };',
      '  }',
      '',
      '  applyPosition(token, x, y) {',
      '    if (token !== this.owner) return false;',
      '    const nx = Math.round(Number(x));',
      '    const ny = Math.round(Number(y));',
      '    if (nx === this.written.x && ny === this.written.y) return false;',
      '    this.written = { x: nx, y: ny };',
      '    this.setWindowPosition(nx, ny);',
      '    return true;',
      '  }',
      '}',
      '',
      'module.exports = { MOTION, MotionController };',
      '',
    ].join('\n'),
  );
  const criterion = await criterionOf(classForm, 'G-M8');
  assert.equal(
    criterion.ok,
    true,
    `class 方法形态的 applyPosition 被判红（判据只认 function 声明？）：\n${criterion.problems.join('\n')}`,
  );

  // 在类方法的**体内**再补一处写入 ⇒ 必须点名"体内有 2 处"
  const classFormTwoWrites = makeCleanSources();
  classFormTwoWrites.set('electron/pet-motion.cjs', classForm.get('electron/pet-motion.cjs'));
  patch(
    classFormTwoWrites,
    'electron/pet-motion.cjs',
    '    return true;\n  }\n}',
    '    this.setWindowPosition(nx, ny + 1);\n    return true;\n  }\n}',
  );
  const twoWrites = await criterionOf(classFormTwoWrites, 'G-M8');
  assert.equal(twoWrites.ok, false);
  assert.match(twoWrites.problems.join('\n'), /体内有 2 处位置写入/);
});

test('G-M9：探针先读快照后判守卫、或守卫漏掉门禁关闭，都必须点名', async () => {
  const orderSwapped = patch(
    makeCleanSources(),
    'scripts/pet-motion-probe.cjs',
    '  if (!shouldSample(state)) return null;\n  const snapshot = deps.readSnapshot();',
    '  const snapshot = deps.readSnapshot();\n  if (!shouldSample(state)) return null;',
  );
  const orderCriterion = await criterionOf(orderSwapped, 'G-M9');
  assert.equal(orderCriterion.ok, false);
  assert.match(orderCriterion.problems.join('\n'), /顺序必须反过来/);

  const gateMissing = patch(
    makeCleanSources(),
    'scripts/pet-motion-probe.cjs',
    '  if (state.gateOpen !== true) return false;',
    '',
  );
  const gateCriterion = await criterionOf(gateMissing, 'G-M9');
  assert.equal(gateCriterion.ok, false);
  assert.match(gateCriterion.problems.join('\n'), /运动门禁关闭/);
});

test('G-M10：通道名重复 / 意图带坐标 / 主进程自造通道，都必须点名', async () => {
  const duplicated = patch(
    makeCleanSources(),
    'src/pet/main.ts',
    'function onMotion(fact: MotionFact): void {',
    "function resend(): void {\n  void bridge.invoke('pet:motion-intent', {});\n}\n\nfunction onMotion(fact: MotionFact): void {",
  );
  const duplicatedCriterion = await criterionOf(duplicated, 'G-M10');
  assert.equal(duplicatedCriterion.ok, false);
  assert.match(duplicatedCriterion.problems.join('\n'), /出现 2 次/);

  const withCoordinates = patch(
    makeCleanSources(),
    'src/pet/main.ts',
    '  reason: MotionIntentReason;',
    '  reason: MotionIntentReason;\n  x: number;',
  );
  const coordinateCriterion = await criterionOf(withCoordinates, 'G-M10');
  assert.equal(coordinateCriterion.ok, false);
  assert.match(coordinateCriterion.problems.join('\n'), /坐标字段/);

  const forgedChannel = patch(
    makeCleanSources(),
    'electron/pet-window.cjs',
    'function createMotionBridge(win) {',
    "function createMotionBridge(win) {\n  ipcMain.handle('pet:motion-tick', () => {});",
  );
  const forgedCriterion = await criterionOf(forgedChannel, 'G-M10');
  assert.equal(forgedCriterion.ok, false);
  assert.match(forgedCriterion.problems.join('\n'), /pet:motion-tick/);
});

test('G-M11：main.cjs 顶层裸 require pet-window / 或 require pet-motion，都必须点名', async () => {
  const bare = patch(
    makeCleanSources(),
    'electron/main.cjs',
    "  const petWindow = options.petEnabled\n    ? require('./pet-window.cjs').registerPetWindow({})\n    : null;",
    "  const petWindow = require('./pet-window.cjs').registerPetWindow({});",
  );
  const bareCriterion = await criterionOf(bare, 'G-M11');
  assert.equal(bareCriterion.ok, false);
  assert.match(bareCriterion.problems.join('\n'), /顶层裸 require/);

  const motionInMain = patch(
    makeCleanSources(),
    'electron/main.cjs',
    'function boot(options) {',
    "function boot(options) {\n  require('./pet-motion.cjs');",
  );
  const motionCriterion = await criterionOf(motionInMain, 'G-M11');
  assert.equal(motionCriterion.ok, false);
  assert.match(motionCriterion.problems.join('\n'), /pet-motion\.cjs/);
});

test('判据自身抛错不会吞掉其他判据（判据异常必须显式红）', async () => {
  const gate = await gatePromise;
  // 把源码表换成"什么都没有"：每条判据都要自己报"缺少文件"，而不是让门禁崩
  const result = gate.runMotionGate({ sources: new Map() });
  assert.equal(result.ok, false);
  assert.equal(result.criteria.length, 11);
  for (const criterion of result.criteria) {
    assert.equal(criterion.ok, false, `${criterion.id} 在空样本上不该是绿的`);
  }
});

test('真仓库快照：loadSources() 能装到运动真源、窗口、渲染层与探针', async () => {
  const gate = await gatePromise;
  const sources = gate.loadSources();
  for (const path of [
    'electron/pet-motion.cjs',
    'electron/pet-window.cjs',
    'electron/pet-hit-poller.cjs',
    'electron/main.cjs',
    'src/pet/main.ts',
    'src/pet/behavior/state-machine.ts',
    'scripts/pet-motion-probe.cjs',
  ]) {
    assert.equal(typeof sources.get(path), 'string', `真仓库里缺 ${path}（门禁扫描范围失效）`);
  }
  // 真仓库现在的红绿不由本用例断言（S4 落地前后会变），只断言"门禁跑得通且逐条给结论"
  const result = gate.runMotionGate({ sources });
  assert.equal(result.criteria.length, 11);
  for (const criterion of result.criteria) {
    assert.equal(typeof criterion.ok, 'boolean');
  }
});
