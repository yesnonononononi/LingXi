'use strict';

/**
 * 确保桌宠 dev server 就绪（拉起 + 等待），供仓外 `pet-up.cmd` 调用。
 *
 * <p><b>为什么这部分逻辑在仓内而不是批处理里：</b>旧 `pet-up.cmd` 用
 * `Invoke-WebRequest ... | Out-Null` 探活 + `start cmd /c "cd ... &gt; log"` 拉起，
 * 两个坑同时存在：①只判状态码（缺陷本体）；②`cmd` 嵌套引号 + 重定向写在 `start` 行上
 * 会丢日志。把"探活判定 + 拉起 + 等待"搬进 Node，两件事都变成可测代码：
 * 探活走 {@link require('./pet-dev-probe.cjs')} 的内容指纹，拉起走
 * `spawn(detached)` 并把 stdio 直接接到日志文件。</p>
 *
 * <p><b>关键安全阀：</b>只有"端口无服务"才允许拉起 dev server。
 * 如果是"端口上的服务不是桌宠"（主应用占用）或非 200，**一律拒绝拉起**——
 * 硬起只会让 Electron 窗口再次加载错误页面，这正是原始缺陷的形态。</p>
 *
 * <p>CLI：</p>
 * <pre>
 *   node scripts/pet-dev-server.cjs --ensure [--wait 30000] [--log 路径]
 *   node scripts/pet-dev-server.cjs --status         # 只探活，不拉起
 *   node scripts/pet-dev-server.cjs --start          # 强制拉起（排障用）
 * </pre>
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');

const { DEV_ENDPOINT, buildEntryUrl } = require('../electron/pet-dev-endpoint.cjs');
const {
  PROBE_REASON,
  PROBE_EXIT_CODE,
  probePetDevServer,
  formatResult,
} = require('../electron/pet-dev-probe.cjs');

/** 前端根目录（本脚本位于 `frontend/scripts/`）。 */
const FRONTEND_ROOT = path.resolve(__dirname, '..');

/** 等 dev server 起来的默认时长（毫秒）。首次启动要跑依赖预构建，给足 30 秒。 */
const DEFAULT_WAIT_MS = 30000;

/** 参数错误退出码。 */
const EXIT_USAGE = 64;

/**
 * 平台对应的 npm 可执行文件名（仅用于人类可读的日志）。
 *
 * @returns {string} npm 命令名
 */
function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * 真正用于 spawn 的命令行。
 *
 * <p><b>为什么 Windows 上要走 cmd.exe：</b>`.cmd` / `.bat` 不是可执行镜像，
 * 直接 `spawn('npm.cmd', ...)` 会抛 `EINVAL`（实测：本脚本第一版就踩了）。
 * 用 `cmd.exe /d /c npm run dev:pet` 是唯一既确定又能保持
 * "npm 脚本（package.json → dev:pet）是启动方式唯一真源"的写法。</p>
 *
 * @returns {{command: string, args: string[]}} 命令与参数
 */
function devServerCommand() {
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', 'npm', 'run', 'dev:pet'] };
  }
  return { command: 'npm', args: ['run', 'dev:pet'] };
}

/**
 * 日志默认路径：落在系统临时目录，绝不放仓库源码树。
 *
 * @returns {string} 日志绝对路径
 */
function defaultLogPath() {
  return path.join(os.tmpdir(), 'lx-pet-vite.log');
}

/**
 * 以 detached 方式拉起桌宠 dev server（`npm run dev:pet`）。
 *
 * <p>detached + unref：调用方（`pet-up.cmd`）退出后 dev server 必须继续活着，
 * 否则 Electron 窗口会加载到一个正在关闭的服务。</p>
 *
 * @param {object} [options] 选项
 * @param {string} [options.cwd] 工作目录，默认前端根目录
 * @param {string} [options.logPath] 日志文件路径
 * @param {Function} [options.spawnImpl] spawn 实现（测试注入）
 * @returns {{pid: number|undefined, command: string, cwd: string, logPath: string}} 拉起结果
 * @throws {TypeError} 参数非法时抛出
 */
function startPetDevServer(options = {}) {
  const { cwd = FRONTEND_ROOT, logPath = defaultLogPath(), spawnImpl = defaultSpawn } = options;
  if (typeof logPath !== 'string' || logPath.trim() === '') {
    throw new TypeError('logPath 必须是非空字符串（dev server 的 stdout/stderr 需要落盘）');
  }
  if (typeof spawnImpl !== 'function') {
    throw new TypeError('spawnImpl 必须是函数');
  }
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    throw new TypeError(`cwd 不是前端根目录（找不到 package.json）：${cwd}`);
  }

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const descriptor = fs.openSync(logPath, 'a');
  const { command, args } = devServerCommand();
  let child;
  try {
    child = spawnImpl(command, args, {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', descriptor, descriptor],
    });
    child.unref();
  } finally {
    // 父进程不再持有该句柄；子进程已复制一份，日志继续写
    fs.closeSync(descriptor);
  }
  return { pid: child.pid, command: `${npmCommand()} run dev:pet`, cwd, logPath };
}

/**
 * 确保 dev server 就绪：探活 → 需要时拉起 → 等到就绪。
 *
 * @param {object} [options] 选项
 * @param {number} [options.waitMs] 拉起后的最长等待（毫秒）
 * @param {string} [options.logPath] 日志路径
 * @param {typeof probePetDevServer} [options.probe] 探活实现（测试注入）
 * @param {Function} [options.startImpl] 拉起实现（测试注入）
 * @param {(message: string) => void} [options.log] 普通日志
 * @param {(message: string) => void} [options.errorLog] 错误日志
 * @returns {Promise<{code: number, started: boolean, probe: object, pid?: number, logPath?: string}>} 结论
 */
async function ensurePetDevServer(options = {}) {
  const {
    waitMs = DEFAULT_WAIT_MS,
    logPath = defaultLogPath(),
    probe = probePetDevServer,
    startImpl = startPetDevServer,
    log = (message) => console.log(`[pet-dev] ${message}`),
    errorLog = (message) => console.error(`[pet-dev] ${message}`),
  } = options;

  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new TypeError(`waitMs 必须是非负数，收到 ${JSON.stringify(waitMs)}`);
  }

  const first = await probe();
  if (first.ok) {
    log(`dev server 已就绪，无需启动：${first.message}`);
    return { code: PROBE_EXIT_CODE.ok, started: false, probe: first };
  }
  if (first.reason !== PROBE_REASON.NO_SERVICE) {
    // 端口上有服务但不是桌宠：硬起第二个 vite 只会让窗口继续加载错页面
    errorLog(formatResult(first));
    errorLog('拒绝拉起 dev server：该端口已被别的服务占用，先处理那个服务，不要绕过探活。');
    return { code: first.exitCode, started: false, probe: first };
  }

  let started;
  try {
    started = startImpl({ logPath });
  } catch (err) {
    errorLog(`拉起 dev server 失败：${(err && err.message) || err}`);
    return { code: 1, started: false, probe: first };
  }
  log(`dev server 未运行，已拉起：${started.command}（pid=${started.pid}，日志=${started.logPath}）`);

  const ready = await probe({ waitMs });
  if (!ready.ok) {
    errorLog(formatResult(ready));
    errorLog(`等待 ${waitMs}ms 仍未就绪，日志在 ${started.logPath}`);
    return { code: ready.exitCode || 1, started: true, probe: ready, pid: started.pid, logPath: started.logPath };
  }
  log(ready.message);
  return { code: PROBE_EXIT_CODE.ok, started: true, probe: ready, pid: started.pid, logPath: started.logPath };
}

/**
 * 解析 CLI 参数。
 *
 * @param {string[]} argv 参数
 * @returns {{mode: string, waitMs: number, logPath: string}} 解析结果
 * @throws {Error} 参数非法时抛出
 */
function parseArgs(argv) {
  const options = { mode: 'ensure', waitMs: DEFAULT_WAIT_MS, logPath: defaultLogPath() };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--ensure') options.mode = 'ensure';
    else if (token === '--status') options.mode = 'status';
    else if (token === '--start') options.mode = 'start';
    else if (token === '--wait') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`--wait 需要非负整数毫秒，收到 ${JSON.stringify(argv[index + 1])}`);
      options.waitMs = value;
      index += 1;
    } else if (token === '--log') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '') throw new Error('--log 需要非空路径');
      options.logPath = value;
      index += 1;
    } else {
      throw new Error(`未知参数：${token}`);
    }
  }
  return options;
}

/** CLI 入口。 */
async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`[pet-dev] ${(err && err.message) || err}`);
    console.error('用法：node scripts/pet-dev-server.cjs [--ensure|--status|--start] [--wait ms] [--log 路径]');
    return EXIT_USAGE;
  }

  if (options.mode === 'status') {
    const result = await probePetDevServer();
    console.log(result.ok ? result.message : formatResult(result));
    return result.exitCode;
  }
  if (options.mode === 'start') {
    try {
      const started = startPetDevServer({ logPath: options.logPath });
      console.log(`[pet-dev] 已拉起：${started.command}（pid=${started.pid}，日志=${started.logPath}）`);
      return 0;
    } catch (err) {
      console.error(`[pet-dev] 拉起失败：${(err && err.message) || err}`);
      return 1;
    }
  }
  const outcome = await ensurePetDevServer({ waitMs: options.waitMs, logPath: options.logPath });
  return outcome.code;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`[pet-dev] 未捕获异常：${err && err.stack ? err.stack : String(err)}`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  FRONTEND_ROOT,
  DEFAULT_WAIT_MS,
  EXIT_USAGE,
  npmCommand,
  devServerCommand,
  defaultLogPath,
  startPetDevServer,
  ensurePetDevServer,
  parseArgs,
  main,
  DEV_ENDPOINT,
  buildEntryUrl,
};
