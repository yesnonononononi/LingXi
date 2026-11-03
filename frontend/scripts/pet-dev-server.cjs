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

// ---------------------------------------------------------------- 互斥锁（K3）

/**
 * 默认锁文件路径。
 *
 * <p>放系统临时目录：锁是运行时产物，绝不能落进仓库源码树；同一用户下两次
 * `--ensure` 看到的是同一个路径，跨进程才互斥。</p>
 *
 * @returns {string} 锁文件绝对路径
 */
function defaultLockPath() {
  return path.join(os.tmpdir(), 'lx-pet-dev-ensure.lock');
}

/** 锁超过这个时长没有心跳刷新 → 视为失效（持锁进程可能卡死/被强杀）。 */
const LOCK_STALE_MS = 30000;
/** 心跳间隔：持锁期间定期刷新 mtime，证明"我还活着"。 */
const LOCK_HEARTBEAT_MS = 5000;
/** 等锁轮询间隔。 */
const LOCK_POLL_MS = 250;
/** 抢不到锁且等待超时的退出码。 */
const EXIT_LOCK_TIMEOUT = 7;

/**
 * 睡眠若干毫秒。
 *
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 定时结束即 resolve
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 判断进程是否活着。
 *
 * @param {number} pid 进程号
 * @returns {boolean} 是否存活（EPERM 视为存活：进程在，只是没权限）
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * 读取锁文件内容与时间戳。
 *
 * @param {string} lockPath 锁文件路径
 * @returns {{info: object|null, mtimeMs: number, empty: boolean}|null} 快照；文件不存在返回 null
 */
function readLockSnapshot(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return { info: null, mtimeMs: Number.POSITIVE_INFINITY, empty: true };
  }
  let mtimeMs = Date.now();
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
  }
  if (raw.trim() === '') {
    // 刚被创建、内容还没写完：不算失效（用 mtime 兜底判定过期）
    return { info: null, mtimeMs, empty: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { info: null, mtimeMs, empty: true };
    return { info: parsed, mtimeMs, empty: false };
  } catch {
    // 内容损坏：当作半写状态，交给 mtime 判定
    return { info: null, mtimeMs, empty: true };
  }
}

/**
 * 尝试原子创建锁文件（`wx`：已存在即失败，不会覆盖别人的锁）。
 *
 * @param {string} lockPath 锁文件路径
 * @param {number} startedAtMs 持锁开始时间（必须由调用方传入并与句柄保持一致，
 *   否则 {@link releaseLock} 会认为"这把锁不是我写的"而不敢删除）
 * @returns {boolean} 是否创建成功（即拿到锁）
 * @throws {Error} 非 EEXIST 的 IO 错误向上抛
 */
function tryCreateLock(lockPath, startedAtMs) {
  const payload = JSON.stringify({
    pid: process.pid,
    startedAtMs,
    createdAt: new Date(startedAtMs).toISOString(),
    host: os.hostname(),
    purpose: 'pet-dev-server --ensure',
  });
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(descriptor, payload);
  } finally {
    fs.closeSync(descriptor);
  }
  return true;
}

/**
 * 检查现存锁是否失效（可抢占）。
 *
 * @param {string} lockPath 锁文件路径
 * @param {number} staleMs 判定过期的时长（毫秒）
 * @returns {{exists: boolean, stale: boolean, holder: object|null, ageMs: number, reason: string}} 判定结果
 */
function inspectLock(lockPath, staleMs) {
  const snapshot = readLockSnapshot(lockPath);
  if (!snapshot) return { exists: false, stale: false, holder: null, ageMs: 0, reason: '' };
  const ageMs = Date.now() - snapshot.mtimeMs;
  if (ageMs > staleMs) {
    return {
      exists: true,
      stale: true,
      holder: snapshot.info,
      ageMs,
      reason: `锁 ${Math.round(ageMs / 1000)}s 没有心跳（阈值 ${Math.round(staleMs / 1000)}s）`,
    };
  }
  const pid = snapshot.info && Number.isInteger(snapshot.info.pid) ? snapshot.info.pid : null;
  if (pid !== null && !isProcessAlive(pid)) {
    return { exists: true, stale: true, holder: snapshot.info, ageMs, reason: `持锁进程 pid=${pid} 已不存在` };
  }
  return {
    exists: true,
    stale: false,
    holder: snapshot.info,
    ageMs,
    reason: pid === null ? '锁内容暂时不可读（可能正在写入）' : `锁被 pid=${pid} 持有`,
  };
}

/**
 * 释放锁。
 *
 * <p>只删"自己那把"：如果等待期间锁被别人抢占/重写（pid 变了），删掉会误伤后来者。</p>
 *
 * @param {object} handle {@link acquireEnsureLock} 返回的句柄
 * @returns {boolean} 是否真的删除了锁文件
 */
function releaseLock(handle) {
  if (!handle || handle.acquired !== true) return false;
  if (handle.heartbeat) {
    clearInterval(handle.heartbeat);
    handle.heartbeat = null;
  }
  const snapshot = readLockSnapshot(handle.lockPath);
  if (!snapshot) return true;
  const holderPid = snapshot.info && Number.isInteger(snapshot.info.pid) ? snapshot.info.pid : null;
  const holderStartedAt = snapshot.info && Number.isInteger(snapshot.info.startedAtMs) ? snapshot.info.startedAtMs : null;
  if (holderPid !== null && (holderPid !== handle.pid || holderStartedAt !== handle.startedAtMs)) {
    return false;
  }
  try {
    fs.unlinkSync(handle.lockPath);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'ENOENT');
  }
}

/**
 * 抢锁（不等待）。抢不到时若发现锁已失效则抢占后重试。
 *
 * @param {object} [options] 选项
 * @param {string} [options.lockPath] 锁文件路径
 * @param {number} [options.staleMs] 过期阈值（毫秒）
 * @param {number} [options.heartbeatMs] 心跳间隔（毫秒）
 * @param {(message: string) => void} [options.log] 日志
 * @returns {{acquired: boolean, lockPath: string, pid: number, startedAtMs: number, heartbeat: NodeJS.Timeout|null, holder: object|null, reason: string}} 结果
 */
function acquireEnsureLock(options = {}) {
  const {
    lockPath = defaultLockPath(),
    staleMs = LOCK_STALE_MS,
    heartbeatMs = LOCK_HEARTBEAT_MS,
    log = (message) => console.log(`[pet-dev] ${message}`),
  } = options;
  if (typeof lockPath !== 'string' || lockPath.trim() === '') {
    throw new TypeError('lockPath 必须是非空字符串');
  }
  if (!Number.isFinite(staleMs) || staleMs <= 0) {
    throw new TypeError(`staleMs 必须是正数，收到 ${JSON.stringify(staleMs)}`);
  }

  const startedAtMs = Date.now();
  // 最多三轮：1) 直接抢 2) 抢占失效锁后重抢 3) 别人刚释放后重抢
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (tryCreateLock(lockPath, startedAtMs)) {
      const heartbeat = setInterval(() => {
        try {
          const now = new Date();
          fs.utimesSync(lockPath, now, now);
        } catch {
          // 锁被删/被别人抢占：心跳失败不影响持有者继续干活
        }
      }, heartbeatMs);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
      return { acquired: true, lockPath, pid: process.pid, startedAtMs, heartbeat, holder: null, reason: '' };
    }
    const state = inspectLock(lockPath, staleMs);
    if (!state.exists) continue;
    if (state.stale) {
      log(`发现失效锁（${state.reason}），抢占：${lockPath}`);
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') log(`抢占失效锁失败（忽略并重试）：${(err && err.message) || err}`);
      }
      continue;
    }
    return { acquired: false, lockPath, pid: process.pid, startedAtMs, heartbeat: null, holder: state.holder, reason: state.reason };
  }
  const finalState = inspectLock(lockPath, staleMs);
  return {
    acquired: false,
    lockPath,
    pid: process.pid,
    startedAtMs,
    heartbeat: null,
    holder: finalState.holder,
    reason: finalState.reason || '抢锁重试后仍被占用',
  };
}

/**
 * 等锁（有上限）：抢不到就等，等待期间顺手探活。
 *
 * <p>等待期间探活是关键：另一个 `--ensure` 大概正在拉起 dev server，我只要等它把服务
 * 拉起来就行，根本不需要拿锁、更不需要再 spawn 一个。</p>
 *
 * @param {object} options 选项
 * @param {string} [options.lockPath] 锁文件路径
 * @param {number} [options.waitMs] 等待上限（毫秒）
 * @param {number} [options.staleMs] 过期阈值（毫秒）
 * @param {number} [options.pollMs] 轮询间隔（毫秒）
 * @param {Function} [options.probe] 探活实现（等待期间观察服务是否已就绪）
 * @param {(message: string) => void} [options.log] 日志
 * @param {(message: string) => void} [options.errorLog] 错误日志
 * @returns {Promise<{acquired: boolean, lock?: object, ready?: object, holder?: object|null, reason: string}>} 结果
 */
async function waitForEnsureLock(options = {}) {
  const {
    lockPath = defaultLockPath(),
    waitMs = DEFAULT_WAIT_MS,
    staleMs = LOCK_STALE_MS,
    heartbeatMs = LOCK_HEARTBEAT_MS,
    pollMs = LOCK_POLL_MS,
    probe = null,
    log = (message) => console.log(`[pet-dev] ${message}`),
    errorLog = (message) => console.error(`[pet-dev] ${message}`),
  } = options;

  const deadline = Date.now() + waitMs;
  for (;;) {
    const claim = acquireEnsureLock({ lockPath, staleMs, heartbeatMs, log });
    if (claim.acquired) return { acquired: true, lock: claim, reason: '' };

    log(`另一个 ensure 正在处理（${claim.reason}），等待它完成…`);
    if (typeof probe === 'function') {
      const observed = await probe();
      if (observed.ok) {
        // 它已经把 dev server 拉起来了：我不需要锁，也不需要 spawn
        return { acquired: false, ready: observed, holder: claim.holder, reason: claim.reason };
      }
    }
    if (Date.now() + pollMs > deadline) {
      errorLog(`等待锁超时（上限 ${Math.round(waitMs / 1000)}s，${claim.reason}）：为避免开出第二个 dev server，本次不拉起。`);
      return { acquired: false, holder: claim.holder, reason: claim.reason };
    }
    await sleep(pollMs);
  }
}

/**
 * 确保 dev server 就绪：探活 → 需要时拉起 → 等到就绪。/**
 * 确保 dev server 就绪：探活 → （需要时）抢锁 → 拉起 → 等到就绪。
 *
 * <p><b>K3 并发互斥：</b>两个 `pet-up.cmd`（或两个 `--ensure`）同时跑时，两个进程都会探到
 * `no-service`，然后各自 spawn 一个 vite——第二个靠 `strictPort` 在 ~400ms 后失败退出，
 * 看起来"没出事"，但那是运气（谁先 bind 谁赢），而且日志里会留下一条莫名其妙的启动失败。
 * 所以"判 no-service → spawn"这一段必须串行：用锁文件把整段包起来，只有拿到锁的进程
 * 才有资格 spawn。</p>
 *
 * @param {object} [options] 选项
 * @param {number} [options.waitMs] 拉起后的最长等待（毫秒）
 * @param {string} [options.logPath] 日志路径
 * @param {string} [options.lockPath] 互斥锁路径（默认系统临时目录）
 * @param {number} [options.lockWaitMs] 等锁上限（毫秒），默认等于 `waitMs`
 * @param {number} [options.lockStaleMs] 锁过期阈值（毫秒）
 * @param {number} [options.lockPollMs] 等锁轮询间隔（毫秒）
 * @param {typeof probePetDevServer} [options.probe] 探活实现（测试注入）
 * @param {Function} [options.startImpl] 拉起实现（测试注入）
 * @param {(message: string) => void} [options.log] 普通日志
 * @param {(message: string) => void} [options.errorLog] 错误日志
 * @returns {Promise<{code: number, started: boolean, probe: object, pid?: number, logPath?: string, locked?: boolean}>} 结论
 */
async function ensurePetDevServer(options = {}) {
  const {
    waitMs = DEFAULT_WAIT_MS,
    logPath = defaultLogPath(),
    lockPath = defaultLockPath(),
    lockWaitMs = waitMs,
    lockStaleMs = LOCK_STALE_MS,
    lockPollMs = LOCK_POLL_MS,
    probe = probePetDevServer,
    startImpl = startPetDevServer,
    log = (message) => console.log(`[pet-dev] ${message}`),
    errorLog = (message) => console.error(`[pet-dev] ${message}`),
  } = options;

  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new TypeError(`waitMs 必须是非负数，收到 ${JSON.stringify(waitMs)}`);
  }
  if (!Number.isFinite(lockWaitMs) || lockWaitMs < 0) {
    throw new TypeError(`lockWaitMs 必须是非负数，收到 ${JSON.stringify(lockWaitMs)}`);
  }

  const first = await probe();
  if (first.ok) {
    log(`dev server 已就绪，无需启动：${first.message}`);
    return { code: PROBE_EXIT_CODE.ok, started: false, probe: first, locked: false };
  }
  if (first.reason !== PROBE_REASON.NO_SERVICE) {
    // 端口上有服务但不是桌宠：硬起第二个 vite 只会让窗口继续加载错页面
    errorLog(formatResult(first));
    errorLog('拒绝拉起 dev server：该端口已被别的服务占用，先处理那个服务，不要绕过探活。');
    return { code: first.exitCode, started: false, probe: first, locked: false };
  }

  // K3：从这里开始必须串行——"探到 no-service"和"spawn"之间不能被另一个进程插进来
  const claim = await waitForEnsureLock({
    lockPath,
    waitMs: lockWaitMs,
    staleMs: lockStaleMs,
    pollMs: lockPollMs,
    probe,
    log,
    errorLog,
  });

  if (!claim.acquired) {
    if (claim.ready) {
      log(`另一个 ensure 已经把 dev server 拉起来了：${claim.ready.message}`);
      return { code: PROBE_EXIT_CODE.ok, started: false, probe: claim.ready, locked: false };
    }
    errorLog('本次没有拿到互斥锁，也没有可用的 dev server：按"不静默拉起第二个 dev server"处理，直接失败。');
    return { code: EXIT_LOCK_TIMEOUT, started: false, probe: first, locked: false };
  }

  try {
    // 拿到锁后必须二次确认：等锁期间对方可能已经把服务拉起来并释放了锁
    const second = await probe();
    if (second.ok) {
      log(`dev server 已由其他进程拉起：${second.message}`);
      return { code: PROBE_EXIT_CODE.ok, started: false, probe: second, locked: true };
    }
    if (second.reason !== PROBE_REASON.NO_SERVICE) {
      errorLog(formatResult(second));
      errorLog('拒绝拉起 dev server：该端口已被别的服务占用，先处理那个服务，不要绕过探活。');
      return { code: second.exitCode, started: false, probe: second, locked: true };
    }

    let started;
    try {
      started = startImpl({ logPath });
    } catch (err) {
      errorLog(`拉起 dev server 失败：${(err && err.message) || err}`);
      return { code: 1, started: false, probe: second, locked: true };
    }
    log(`dev server 未运行，已拉起：${started.command}（pid=${started.pid}，日志=${started.logPath}）`);

    const ready = await probe({ waitMs });
    if (!ready.ok) {
      errorLog(formatResult(ready));
      errorLog(`等待 ${waitMs}ms 仍未就绪，日志在 ${started.logPath}`);
      return { code: ready.exitCode || 1, started: true, probe: ready, pid: started.pid, logPath: started.logPath, locked: true };
    }
    log(ready.message);
    return { code: PROBE_EXIT_CODE.ok, started: true, probe: ready, pid: started.pid, logPath: started.logPath, locked: true };
  } finally {
    // 无论成功、失败还是抛错，必须把锁删掉：留下永久锁会让以后永远"抢不到锁"
    const released = releaseLock(claim.lock);
    if (!released) log(`锁未删除（可能已被抢占）：${claim.lock.lockPath}`);
  }
}

/**
 * 解析 CLI 参数。
 *
 * @param {string[]} argv 参数
 * @returns {{mode: string, waitMs: number, logPath: string, lockPath: string, lockWaitMs: number|null}} 解析结果
 * @throws {Error} 参数非法时抛出
 */
function parseArgs(argv) {
  const options = {
    mode: 'ensure',
    waitMs: DEFAULT_WAIT_MS,
    logPath: defaultLogPath(),
    lockPath: defaultLockPath(),
    lockWaitMs: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--ensure') options.mode = 'ensure';
    else if (token === '--status') options.mode = 'status';
    else if (token === '--start') options.mode = 'start';
    else if (token === '--help' || token === '-h') options.mode = 'help';
    else if (token === '--wait') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`--wait 需要非负整数毫秒，收到 ${JSON.stringify(argv[index + 1])}`);
      options.waitMs = value;
      index += 1;
    } else if (token === '--lock-wait') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`--lock-wait 需要非负整数毫秒，收到 ${JSON.stringify(argv[index + 1])}`);
      options.lockWaitMs = value;
      index += 1;
    } else if (token === '--lock') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '') throw new Error('--lock 需要非空路径');
      options.lockPath = value;
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

/** 用法说明。 */
const USAGE = [
  '桌宠 dev server 拉起/就绪检查',
  '',
  '用法：node scripts/pet-dev-server.cjs [--ensure|--status|--start] [选项]',
  '',
  '  --ensure        探活→（仅 no-service 时）拉起→等到就绪（默认）',
  '  --status        只探活，不拉起',
  '  --start         无条件拉起（排障用）',
  '  --wait <ms>     拉起后的等待上限（默认 30000）',
  `  --lock <path>   互斥锁路径（默认 ${'<系统临时目录>/lx-pet-dev-ensure.lock'}）`,
  '  --lock-wait <ms> 等锁上限（默认等于 --wait）',
  '  --log <path>    dev server 日志路径',
  '',
  `退出码：0 就绪；1 拉起失败/未就绪；${EXIT_LOCK_TIMEOUT} 等锁超时（不会静默拉起第二个 dev server）；${EXIT_USAGE} 参数错误；其余沿用探活的 2/3/4/5/6`,
].join('\n');

/** CLI 入口。 */
async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`[pet-dev] ${(err && err.message) || err}`);
    console.error(USAGE);
    return EXIT_USAGE;
  }

  if (options.mode === 'help') {
    console.log(USAGE);
    return 0;
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
  const outcome = await ensurePetDevServer({
    waitMs: options.waitMs,
    logPath: options.logPath,
    lockPath: options.lockPath,
    lockWaitMs: options.lockWaitMs === null ? options.waitMs : options.lockWaitMs,
  });
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
  EXIT_LOCK_TIMEOUT,
  LOCK_STALE_MS,
  LOCK_HEARTBEAT_MS,
  LOCK_POLL_MS,
  npmCommand,
  devServerCommand,
  defaultLogPath,
  defaultLockPath,
  isProcessAlive,
  inspectLock,
  acquireEnsureLock,
  releaseLock,
  waitForEnsureLock,
  startPetDevServer,
  ensurePetDevServer,
  parseArgs,
  main,
  DEV_ENDPOINT,
  buildEntryUrl,
};
