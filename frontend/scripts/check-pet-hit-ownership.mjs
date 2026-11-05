#!/usr/bin/env node
/**
 * 桌宠命中所有权门禁：`npm run gate:pet` 的第四段。
 *
 * <p><b>为什么需要它：</b>"命中归主进程"是一组**结构约束**，不是一团逻辑。逻辑有单测兜底，
 * 但结构约束（谁许 require 谁、哪个 IPC 通道不许存在、哪句注释不许复活、30ms 合并器不许回来）
 * 没有任何运行时测试能表达——它们只在"有人改回去"的那一刻才成为缺陷，而那一刻通常已经是
 * "桌宠又开始闪烁了"。所以这里用最笨也最稳的文本断言逐条钉死。</p>
 *
 * <p>逐条断言（编号与设计 §10 对应）：</p>
 * <ol>
 *   <li>主进程必须 `require('./pet-hit-poller.cjs')`（命中真源在轮询器里）；</li>
 *   <li>`pet-window.cjs` 不得出现 `ipcMain.on('pet:set-hit'`（渲染层不再有命中话语权）；</li>
 *   <li>`applyIgnoreMouse` 函数体内不得出现 `setTimeout`（30ms 合并窗口不许复活）；</li>
 *   <li>三个例外必须接线：`setForced('drag'` / `setForced('menu'` / `setSuspended('hidden'`；</li>
 *   <li>`pet-preload.cjs` 不得再暴露 `'pet:set-hit'`；</li>
 *   <li>`src/pet/main.ts` 不得出现 `setHit(` / `reportHit(`；</li>
 *   <li>`pet-window.cjs` 顶部注释不得再出现"forward: true 是必需的"；</li>
 *   <li>`pet-hit-region.cjs` / `pet-hit-poller.cjs` 不得出现 `scaleFactor` / `devicePixelRatio` /
 *       `zoomFactor`（两个坐标系同为 DIP，任何缩放换算都是错的）；</li>
 *   <li><b>U3 结构不变式</b>：当 `build.files` 不含 `pet-geometry.json` 时，`electron/main.cjs`
 *       对 `./pet-window.cjs` 的 require **不得是顶层裸 require**——打包版桌宠恒关，靠"条件
 *       require 不执行"才不崩；一旦有人改成顶层 require，打包版会在启动阶段直接抛
 *       `Cannot find module '../pet-geometry.json'`。</li>
 *   <li><b>⑩ 即时触发器</b>：轮询间隔必须是 16ms 单档（一帧；产品裁定不追求 0ms 命中），
 *       `pet:hover-hint` 必须存在且**当场 `poll()`**、不许定时器、**不许读载荷**
 *       （读了就是把判定权还给渲染层，回声会顺着这条新通道回来），preload 必须用 `send`。</li>
 * </ol>
 *
 * 用法：
 * <pre>
 *   node scripts/check-pet-hit-ownership.mjs            # 门禁
 *   node scripts/check-pet-hit-ownership.mjs --verbose # 打印每条断言的检查对象
 * </pre>
 *
 * @module scripts/check-pet-hit-ownership
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRONTEND_ROOT, readJsonFile } from './build-pet-geometry.mjs';
import { stripComments } from './check-pet-geometry.mjs';

/** 主进程窗口模块。 */
const WINDOW_FILE = 'electron/pet-window.cjs';
/** 渲染层桥。 */
const PRELOAD_FILE = 'electron/pet-preload.cjs';
/** 主进程入口（U3 断言用）。 */
const MAIN_FILE = 'electron/main.cjs';
/** 命中几何。 */
const REGION_FILE = 'electron/pet-hit-region.cjs';
/** 命中轮询器。 */
const POLLER_FILE = 'electron/pet-hit-poller.cjs';
/** 渲染层入口。 */
const RENDER_FILE = 'src/pet/main.ts';
/** 打包配置。 */
const PACKAGE_FILE = 'package.json';

/** 命中的几何真源（不在 `build.files` 里，是 U3 断言的前提）。 */
const GEOMETRY_FILE = 'pet-geometry.json';

/**
 * 读一个前端文件。
 *
 * @param {string} relative 相对 `frontend/` 的路径
 * @returns {string} 文件内容
 */
function readSource(relative) {
  return readFileSync(resolve(FRONTEND_ROOT, relative), 'utf8');
}

/**
 * 截取一个具名函数的函数体（从 `function name(` 到下一个顶格/两格缩进收尾）。
 *
 * <p>不用 AST：门禁只需要"这一小段里有没有某个字符串"，用最笨的截取反而不会被格式化风格带偏。</p>
 *
 * @param {string} source 源码
 * @param {string} signature 形如 `function applyIgnoreMouse(`
 * @returns {string} 函数体（找不到时返回空串）
 */
export function sliceFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const end = source.indexOf('\n  }', start);
  return end > start ? source.slice(start, end) : source.slice(start);
}

/**
 * 断言主进程侧的结构约束（①~④、⑦、⑧）。
 *
 * @returns {string[]} 问题列表
 */
export function checkMainProcess() {
  const problems = [];
  const windowSource = readSource(WINDOW_FILE);
  const preloadSource = readSource(PRELOAD_FILE);
  // 代码断言一律先去掉注释：注释里提到历史缺陷名（'pet:set-hit' / scaleFactor）是**有价值**的，
  // 真正要守的是"代码里不许再有"。唯一的例外是第 ⑦ 条，它守的就是注释本身。
  const windowCode = stripComments(windowSource);
  const preloadCode = stripComments(preloadSource);
  const regionCode = stripComments(readSource(REGION_FILE));
  const pollerCode = stripComments(readSource(POLLER_FILE));

  // ① 命中真源必须在轮询器里，且真被窗口模块用起来
  if (!windowCode.includes("require('./pet-hit-poller.cjs')")) {
    problems.push(`${WINDOW_FILE} 必须 require('./pet-hit-poller.cjs')（命中归主进程的前提）`);
  }
  if (!windowCode.includes("require('./pet-hit-region.cjs')")) {
    problems.push(`${WINDOW_FILE} 必须 require('./pet-hit-region.cjs')（命中矩形必须由几何真源派生）`);
  }
  if (!/createHitPoller\s*\(/.test(windowCode)) {
    problems.push(`${WINDOW_FILE} 没有调用 createHitPoller(（轮询器没接线）`);
  }

  // ② 渲染层不再有命中话语权：通道必须彻底不存在（代码里）
  if (/ipcMain\.on\(\s*'pet:set-hit'/.test(windowCode) || windowCode.includes("'pet:set-hit'")) {
    problems.push(`${WINDOW_FILE} 仍存在 'pet:set-hit'（渲染层不得再上报命中）`);
  }

  // ③ 30ms 合并窗口不许复活
  const applyBody = sliceFunctionBody(windowCode, 'function applyIgnoreMouse(');
  if (applyBody === '') {
    problems.push(`${WINDOW_FILE} 找不到 applyIgnoreMouse(（去重权威所在函数）`);
  } else if (applyBody.includes('setTimeout')) {
    problems.push(`${WINDOW_FILE} 的 applyIgnoreMouse 里出现 setTimeout（30ms 合并 = 点击相位损失，已删除不许复活）`);
  }
  if (windowCode.includes('HIT_APPLY_DELAY_MS')) {
    problems.push(`${WINDOW_FILE} 仍存在 HIT_APPLY_DELAY_MS（该常量已删除）`);
  }

  // ④ 三个例外必须接线
  const exceptionWiring = [
    ["setForced('drag'", '例外①拖拽期间强制可交互'],
    ["setForced('menu'", '例外②右键菜单打开期间强制可交互'],
    ["setSuspended('hidden'", '例外③隐藏停表 / 显示续表'],
  ];
  for (const [needle, label] of exceptionWiring) {
    if (!windowCode.includes(needle)) {
      problems.push(`${WINDOW_FILE} 缺少 ${needle}（${label}）`);
    }
  }
  // 拖拽例外的三条解除路径都要在：drag-end / closed / render-process-gone
  const dragReleaseCount = (windowCode.match(/setForced\('drag',\s*false\)/g) || []).length;
  if (dragReleaseCount < 3) {
    problems.push(
      `${WINDOW_FILE} 只有 ${dragReleaseCount} 处 setForced('drag', false)，必须 ≥3（drag-end / closed / render-process-gone 三路解除）`,
    );
  }
  // 菜单例外的兜底：blur
  if (!/win\.on\('blur',\s*\(\)\s*=>\s*poller\?\.setForced\('menu',\s*false\)\)/.test(windowCode)) {
    problems.push(`${WINDOW_FILE} 缺少 win.on('blur') 兜底解除 setForced('menu', false)（菜单不回调时防整窗吃鼠标）`);
  }

  // ⑤ preload 不得再暴露上报通道（代码里）
  if (preloadCode.includes("'pet:set-hit'")) {
    problems.push(`${PRELOAD_FILE} 仍暴露 'pet:set-hit'（渲染层上报通道必须彻底消失）`);
  }

  // ⑦ 顶部注释里的错误结论必须改掉：允许"引用历史 + 标注它是错的"，不允许直接断言
  const wrongClaimLines = windowSource
    .split('\n')
    .filter((line) => /forward`?\s*(:)?\s*true`?\s*是必需的/.test(line) || line.includes('是必需的，否则渲染层'));
  for (const line of wrongClaimLines) {
    const markedAsWrong = /错|证伪|历史|别再/.test(line);
    if (!markedAsWrong) {
      problems.push(
        `${WINDOW_FILE} 顶部注释断言"forward: true 是必需的"（已证伪，会误导后来者把命中接回渲染层）：${line.trim()}`,
      );
    }
  }

  // ⑧ 两个坐标系同为 DIP：任何缩放换算都是错的
  for (const [relative, source] of [
    [REGION_FILE, regionCode],
    [POLLER_FILE, pollerCode],
  ]) {
    for (const forbidden of ['scaleFactor', 'devicePixelRatio', 'zoomFactor']) {
      if (source.includes(forbidden)) {
        problems.push(`${relative} 出现 ${forbidden}（getBounds 与 getCursorScreenPoint 同为 DIP，不许换算）`);
      }
    }
  }

  return problems;
}

/**
 * 断言渲染层不再上报命中（⑥）。
 *
 * @returns {string[]} 问题列表
 */
export function checkRenderSide() {
  const problems = [];
  // 与 checkMainProcess 同一口径：代码断言一律先去掉注释。这里有一条**必须**如此的实证——
  // 本次重构的注释里就要写"曾经那条上报函数是回声源"作为历史证据，若不剥注释，
  // 光是把教训写进文件就足够让门禁变红，逼着后来者删掉解释。
  // 剥注释不削弱守卫：真要复活回声，必须在**代码**里写 `reportHit(` 或 `setHit(`，
  // 那样剥完仍在（设计 §9.4 的第四例变异就是这么验的）。
  const renderSource = stripComments(readSource(RENDER_FILE));
  if (/\bsetHit\s*\(/.test(renderSource)) {
    problems.push(`${RENDER_FILE} 出现 setHit(（渲染层上报命中的入口，已删除不许复活）`);
  }
  if (/\breportHit\s*\(/.test(renderSource)) {
    problems.push(`${RENDER_FILE} 出现 reportHit(（回声源，已删除不许复活）`);
  }
  if (!renderSource.includes('applyHitView')) {
    problems.push(`${RENDER_FILE} 未使用 applyHitView（命中 UI 必须走唯一的纯函数收口）`);
  }
  return problems;
}

/**
 * 断言即时触发器（⑩）：16ms 单档轮询 + `pet:hover-hint` 只叫醒不判定。
 *
 * <p><b>为什么这条必须进步门禁：</b>hint 是这次新增的**唯一一条**渲染层 → 主进程通道，
 * 也就是说它是回声回归最可能的入口。三个约束都是结构性的，任何一条被改回去，
 * 单测（C20/C21/C23）会红，但门禁也必须能独立发现——门禁读的是文本，抓的就是"有人
 * 顺手加了 `payload.x` 或包了个 setTimeout"。</p>
 *
 * @returns {string[]} 问题列表
 */
export function checkInstantTrigger() {
  const problems = [];
  const windowCode = stripComments(readSource(WINDOW_FILE));
  const preloadCode = stripComments(readSource(PRELOAD_FILE));

  // ① 轮询间隔：16ms 单档（一帧）。40ms 会把延迟洞换大，8ms 是没必要的空转。
  if (!/const\s+HIT_POLL_INTERVAL_MS\s*=\s*16\s*;/.test(windowCode)) {
    problems.push(`${WINDOW_FILE} 的 HIT_POLL_INTERVAL_MS 必须是 16（一帧，单档）`);
  }
  // ② 滞回常量必须是 6px，且只作用于离开方向由单测 C3/C22 守
  if (!/const\s+HIT_HYSTERESIS_PX\s*=\s*6\s*;/.test(windowCode)) {
    problems.push(`${WINDOW_FILE} 的 HIT_HYSTERESIS_PX 必须是 6`);
  }
  // ③ hint 通道必须注册，且处理器当场 poll()、无定时器、不读载荷
  const hintIndex = windowCode.indexOf("ipcMain.on('pet:hover-hint'");
  if (hintIndex < 0) {
    problems.push(`${WINDOW_FILE} 缺少 'pet:hover-hint' 处理器（手型会迟到一拍）`);
  } else {
    const end = windowCode.indexOf('\n  });', hintIndex);
    const body = windowCode.slice(hintIndex, end > hintIndex ? end : hintIndex + 400);
    if (!body.includes('poll()')) {
      problems.push(`${WINDOW_FILE} 的 'pet:hover-hint' 处理器必须当场 poll()（同步 apply）`);
    }
    for (const forbidden of ['setTimeout', 'setImmediate', 'setInterval']) {
      if (body.includes(forbidden)) {
        problems.push(`${WINDOW_FILE} 的 'pet:hover-hint' 处理器出现 ${forbidden}（合并延迟就是首击丢失的成因）`);
      }
    }
    if (body.includes('payload')) {
      problems.push(`${WINDOW_FILE} 的 'pet:hover-hint' 处理器读取了载荷（判定权必须留在主进程自己的光标读数上）`);
    }
  }
  // ④ preload：只 send，不许 invoke
  if (!preloadCode.includes("ipcRenderer.send('pet:hover-hint'")) {
    problems.push(`${PRELOAD_FILE} 必须用 ipcRenderer.send 暴露 'pet:hover-hint'（单向、不等回执）`);
  }
  if (preloadCode.includes("invoke('pet:hover-hint'")) {
    problems.push(`${PRELOAD_FILE} 的 'pet:hover-hint' 不许用 invoke（同步等待会加延迟）`);
  }
  return problems;
}

/**
 * U3 结构不变式：打包配置不含几何真源时，`pet-window.cjs` 的 require 不许是顶层裸 require。
 *
 * @returns {string[]} 问题列表
 */
export function checkPackagingInvariant() {
  const problems = [];
  const pkg = readJsonFile(resolve(FRONTEND_ROOT, PACKAGE_FILE));
  const files = Array.isArray(pkg?.build?.files) ? pkg.build.files.map((item) => String(item)) : [];
  const shipsGeometry = files.some((pattern) => pattern.includes(GEOMETRY_FILE));
  if (shipsGeometry) {
    // 打包已带上几何真源：条件 require 不再是正确性的必要条件，无需断言
    return problems;
  }
  const mainSource = readSource(MAIN_FILE);
  const lines = mainSource.split('\n');
  const markers = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.includes("require('./pet-window.cjs')"));
  if (markers.length === 0) {
    problems.push(`${MAIN_FILE} 找不到 require('./pet-window.cjs')（门禁失效：改名后请同步本脚本）`);
    return problems;
  }
  for (const { line, index } of markers) {
    // 顶层裸 require = 行首无缩进且不带条件运算符 ⇒ 打包版（无 pet-geometry.json）会在启动即抛
    const indented = /^\s{2,}/.test(line);
    const conditional = line.includes('?') || line.includes('&&') || line.includes('||');
    if (!indented || !conditional) {
      problems.push(
        `${MAIN_FILE}:${index + 1} 对 './pet-window.cjs' 是顶层裸 require，而 build.files 不含 ${GEOMETRY_FILE}` +
          '（打包版会在 require 阶段抛 Cannot find module；必须保持条件 require，或同批把几何加进 build.files）',
      );
    }
  }
  return problems;
}

/**
 * 跑完整门禁。
 *
 * @param {{verbose?: boolean}} [options] 运行选项
 * @returns {{ok: boolean, problems: string[]}} 结果
 */
export function runHitOwnershipGate(options = {}) {
  const verbose = options.verbose === true;
  const problems = [];
  problems.push(...checkMainProcess());
  problems.push(...checkRenderSide());
  problems.push(...checkInstantTrigger());
  problems.push(...checkPackagingInvariant());
  if (verbose) {
    console.log(`[hit-ownership] 已检查 ${WINDOW_FILE} / ${PRELOAD_FILE} / ${MAIN_FILE} / ${RENDER_FILE} / ${REGION_FILE} / ${POLLER_FILE}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * CLI 入口。
 *
 * @returns {number} 进程退出码（0 = 通过）
 */
export function main() {
  const verbose = process.argv.slice(2).includes('--verbose');
  const result = runHitOwnershipGate({ verbose });
  if (result.ok) {
    console.log(
      '✅ gate:pet:hit 通过：命中归主进程（无 pet:set-hit、无 30ms 合并、三个例外接线齐、' +
        '16ms 单档轮询 + hover-hint 只叫醒不判定、U3 条件 require 保持）',
    );
    return 0;
  }
  console.error('❌ gate:pet:hit 失败：');
  for (const problem of result.problems) console.error(`   - ${problem}`);
  return 1;
}

// 仅被直接执行时跑 CLI（被测试 import 时保持静默）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
