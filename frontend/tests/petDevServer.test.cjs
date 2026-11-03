/**
 * `scripts/pet-dev-server.cjs` 单测（node:test，真实文件系统，不启动 npm / Vite）。
 *
 * <p><b>守的是什么：</b>仓外 `pet-up.cmd` 的决策全部由这个模块做，所以它的安全阀必须被钉死：</p>
 * <ol>
 *   <li>端口无服务 → 允许拉起 dev server 并等到就绪；</li>
 *   <li>端口上的服务不是桌宠（主应用占用）→ <b>拒绝拉起</b>，直接以非 0 退出。
 *       这一条正是原始缺陷的形态：以前无论如何都会硬起 Electron，于是窗口显示主应用；</li>
 *   <li>拉起后仍不就绪 → 非 0 退出，不谎报成功。</li>
 * </ol>
 *
 * <p>运行：`npm run test:pet`。</p>
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FRONTEND_ROOT = path.join(__dirname, '..');
const {
  PROBE_REASON,
  PROBE_EXIT_CODE,
} = require(path.join(FRONTEND_ROOT, 'electron', 'pet-dev-probe.cjs'));
const {
  FRONTEND_ROOT: RESOLVED_ROOT,
  startPetDevServer,
  ensurePetDevServer,
  devServerCommand,
  acquireEnsureLock,
  releaseLock,
  inspectLock,
  isProcessAlive,
  defaultLockPath,
  EXIT_LOCK_TIMEOUT,
  LOCK_STALE_MS,
  parseArgs,
} = require(path.join(FRONTEND_ROOT, 'scripts', 'pet-dev-server.cjs'));

/** 收集日志，避免测试输出噪音。 */
function collector() {
  const lines = [];
  return { lines, write: (message) => lines.push(message) };
}

/**
 * 测试用临时目录（每个测试进程一个）。
 *
 * <p>落系统临时目录：单测不得在仓库源码树里留下任何运行产物；每个进程独立子目录，
 * 文件跑完由 {@link test.after} 整体删除。</p>
 */
const TEST_TMP_DIR = path.join(os.tmpdir(), 'lx-pet-dev-test', String(process.pid));

/**
 * 测试用文件路径。
 *
 * @param {string} name 文件名
 * @returns {string} 绝对路径
 */
function testLogPath(name) {
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
  return path.join(TEST_TMP_DIR, name);
}

test.after(() => {
  fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
});

/**
 * 构造一个按序返回结论的假探活。
 *
 * @param {object[]} results 依次返回的结论
 * @returns {{calls: number, probe: Function}} 假探活
 */
function queuedProbe(results) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    probe: async () => {
      const result = results[Math.min(calls, results.length - 1)];
      calls += 1;
      return result;
    },
  };
}

/** 一个"就绪"的探活结论。 */
const OK_RESULT = Object.freeze({
  ok: true,
  reason: PROBE_REASON.OK,
  exitCode: 0,
  status: 200,
  url: 'http://127.0.0.1/pet.html',
  message: '桌宠 dev server 就绪',
  hint: '',
  missingMarkers: [],
});

/** 一个"端口无服务"的结论。 */
const NO_SERVICE_RESULT = Object.freeze({
  ok: false,
  reason: PROBE_REASON.NO_SERVICE,
  exitCode: PROBE_EXIT_CODE['no-service'],
  status: null,
  url: 'http://127.0.0.1/pet.html',
  message: '端口无服务',
  hint: '用 npm run dev:pet 启动',
  missingMarkers: [],
});

/** 一个"端口上的服务不是桌宠"的结论（主应用占用）。 */
const WRONG_APP_RESULT = Object.freeze({
  ok: false,
  reason: PROBE_REASON.WRONG_APP,
  exitCode: PROBE_EXIT_CODE['wrong-app'],
  status: 200,
  url: 'http://127.0.0.1/pet.html',
  message: '端口上的服务不是桌宠（疑似被主应用占用）',
  hint: '用 npm run dev:pet 启动',
  missingMarkers: ['<div id="pet-root"'],
});

test('ensure：端口无服务 → 抢锁后二次确认仍无服务 → 拉起并等到就绪，返回 0', async () => {
  // 三次探活：①初次判定 no-service ②拿到锁后二次确认 ③拉起后等待就绪
  const queued = queuedProbe([NO_SERVICE_RESULT, NO_SERVICE_RESULT, OK_RESULT]);
  const started = [];
  const outcome = await ensurePetDevServer({
    waitMs: 1000,
    logPath: testLogPath('pet-vite.log'),
    lockPath: testLogPath('lock-spawn-ok.lock'),
    probe: queued.probe,
    startImpl: (options) => {
      started.push(options.logPath);
      return { pid: 4242, command: 'npm.cmd run dev:pet', cwd: FRONTEND_ROOT, logPath: options.logPath };
    },
    log: collector().write,
    errorLog: collector().write,
  });
  assert.equal(outcome.code, 0, `应就绪，实际 ${JSON.stringify(outcome.probe)}`);
  assert.equal(outcome.started, true);
  assert.equal(outcome.pid, 4242);
  assert.equal(started.length, 1);
  assert.equal(fs.existsSync(testLogPath('lock-spawn-ok.lock')), false, '正常结束后必须删锁');
});

test('ensure：端口被非桌宠服务占用 → 拒绝拉起，以 2 退出', async () => {
  const queued = queuedProbe([WRONG_APP_RESULT]);
  const started = [];
  const errors = collector();
  const outcome = await ensurePetDevServer({
    waitMs: 1000,
    lockPath: testLogPath('lock-wrong-app.lock'),
    probe: queued.probe,
    startImpl: (options) => {
      started.push(options);
      return { pid: 1, command: 'x', cwd: FRONTEND_ROOT, logPath: 'x' };
    },
    log: collector().write,
    errorLog: errors.write,
  });
  assert.equal(started.length, 0, '端口被占用时绝不允许再拉起一个 dev server');
  assert.equal(outcome.started, false);
  assert.equal(outcome.code, PROBE_EXIT_CODE['wrong-app']);
  assert.equal(outcome.locked, false, '端口被占用时不该白抢一次锁（应就地失败）');
  assert.equal(errors.lines.some((line) => line.includes('拒绝拉起')), true);
  assert.equal(queued.calls, 1, '占用场景不该再等待重试');
});

test('ensure：已就绪 → 不拉起，返回 0', async () => {
  const outcome = await ensurePetDevServer({
    lockPath: testLogPath('lock-ready.lock'),
    probe: queuedProbe([OK_RESULT]).probe,
    startImpl: () => {
      throw new Error('不应该被调用');
    },
    log: collector().write,
    errorLog: collector().write,
  });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.started, false);
});

test('ensure：拉起后仍不就绪 → 以非 0 退出，不谎报成功', async () => {
  const queued = queuedProbe([NO_SERVICE_RESULT, NO_SERVICE_RESULT]);
  const outcome = await ensurePetDevServer({
    waitMs: 100,
    lockPath: testLogPath('lock-not-ready.lock'),
    probe: queued.probe,
    startImpl: (options) => ({ pid: 7, command: 'npm.cmd run dev:pet', cwd: FRONTEND_ROOT, logPath: options.logPath }),
    log: collector().write,
    errorLog: collector().write,
  });
  assert.equal(outcome.code, PROBE_EXIT_CODE['no-service']);
  assert.equal(outcome.started, true);
  assert.equal(fs.existsSync(testLogPath('lock-not-ready.lock')), false, '失败路径也必须删锁');
});

test('ensure：拉起失败（spawn 抛错）→ 返回 1，不抛给调用方，且删锁', async () => {
  const outcome = await ensurePetDevServer({
    waitMs: 100,
    lockPath: testLogPath('lock-spawn-throw.lock'),
    probe: queuedProbe([NO_SERVICE_RESULT]).probe,
    startImpl: () => {
      throw new Error('spawn ENOENT');
    },
    log: collector().write,
    errorLog: collector().write,
  });
  assert.equal(outcome.code, 1);
  assert.equal(outcome.started, false);
  assert.equal(fs.existsSync(testLogPath('lock-spawn-throw.lock')), false, '抛错路径也必须删锁（否则以后永远起不来）');
});

test('startPetDevServer：spawn 参数正确（detached + 日志落盘 + npm run dev:pet）', () => {
  const logPath = testLogPath('spawn-check.log');
  const calls = [];
  const started = startPetDevServer({
    logPath,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { pid: 9001, unref: () => {} };
    },
  });
  assert.equal(started.pid, 9001);
  assert.equal(calls.length, 1);
  // 启动方式必须来自 package.json 的 dev:pet 脚本，不要在脚本里重复 vite 参数
  assert.equal(calls[0].args.join(' ').endsWith('run dev:pet'), true, `实际参数：${JSON.stringify(calls[0].args)}`);
  if (process.platform === 'win32') {
    // .cmd / .bat 不能直接 spawn（EINVAL），必须经 cmd.exe
    assert.match(calls[0].command, /cmd\.exe$/i);
    assert.equal(calls[0].args[0], '/d');
    assert.equal(calls[0].args[1], '/c');
  }
  assert.equal(calls[0].options.detached, true, 'detached：pet-up.cmd 退出后 dev server 必须继续活着');
  assert.equal(calls[0].options.cwd, FRONTEND_ROOT);
  assert.equal(calls[0].options.stdio[0], 'ignore');
  assert.equal(typeof calls[0].options.stdio[1], 'number', 'stdout 必须重定向到日志文件描述符');
});

test('devServerCommand：跨平台命令形态（Windows 走 cmd.exe）', () => {
  const { command, args } = devServerCommand();
  assert.equal(typeof command, 'string');
  assert.equal(args.join(' ').endsWith('run dev:pet'), true, `实际参数：${JSON.stringify(args)}`);
  if (process.platform === 'win32') {
    assert.match(command, /cmd\.exe$/i);
  }
});

test('startPetDevServer：参数校验（缺日志路径 / cwd 不是前端根目录）', () => {
  assert.throws(() => startPetDevServer({ logPath: '' }), TypeError);
  assert.throws(() => startPetDevServer({ logPath: path.join(testLogPath('x.log')), cwd: FRONTEND_ROOT, spawnImpl: 'nope' }), TypeError);
  assert.throws(() => startPetDevServer({ logPath: 'x.log', cwd: path.join(FRONTEND_ROOT, 'src') }), TypeError);
});

test('模块自述：前端根目录解析正确（脚本位于 frontend/scripts/）', () => {
  // 只断言"解析到本脚本所属的 frontend/"，不再断言它的父目录叫 desktop-pet-visual：
  // 那条断言把"必须跑在 worktree 里"写进了测试，M1 合并到 main 后（dev 链改在 main 上跑）
  // 会无条件变红，属于布局假设而不是能力断言。
  assert.equal(path.basename(RESOLVED_ROOT), 'frontend');
  assert.equal(RESOLVED_ROOT, path.resolve(__dirname, '..'));
  assert.equal(fs.existsSync(path.join(RESOLVED_ROOT, 'package.json')), true, '前端根目录里必须有 package.json');
});

test('CLI 参数：未知参数与非法 --wait 都被拒绝', () => {
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
  assert.throws(() => parseArgs(['--wait', 'abc']), /非负整数毫秒/);
  assert.throws(() => parseArgs(['--log']), /非空路径/);
  const parsed = parseArgs(['--status', '--wait', '1234', '--log', 'C:/tmp/x.log']);
  assert.equal(parsed.mode, 'status');
  assert.equal(parsed.waitMs, 1234);
  assert.equal(parsed.logPath, 'C:/tmp/x.log');
});

// ---------------------------------------------------------------- K3 互斥

/**
 * 造一个"别人持有"的锁文件。
 *
 * @param {number} pid 持有者 pid
 * @param {object} [options] 选项
 * @param {number} [options.ageMs] 让 mtime 往前推多少毫秒（模拟心跳停止）
 * @returns {string} 锁文件路径
 */
function writeForeignLock(pid, options = {}) {
  const { ageMs = 0 } = options;
  const lockPath = testLogPath(`lock-foreign-${pid}-${Date.now()}-${Math.floor(Math.random() * 1000)}.lock`);
  fs.writeFileSync(lockPath, JSON.stringify({ pid, startedAtMs: Date.now() - ageMs, createdAt: new Date().toISOString(), host: os.hostname() }), 'utf8');
  if (ageMs > 0) {
    const stamp = new Date(Date.now() - ageMs);
    fs.utimesSync(lockPath, stamp, stamp);
  }
  return lockPath;
}

/**
 * 取一个"已经死掉"的进程 pid。
 *
 * @returns {number} 已退出的子进程 pid
 */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return child.pid;
}

/**
 * 睡眠（测试内用）。
 *
 * @param {number} ms 毫秒
 * @returns {Promise<void>} 定时结束即 resolve
 */
function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('K3：锁判定——无锁 / 活锁 / 死锁 / 过期锁', () => {
  const missing = testLogPath(`lock-missing-${Date.now()}.lock`);
  assert.equal(inspectLock(missing, LOCK_STALE_MS).exists, false);

  const alive = writeForeignLock(process.pid);
  const aliveState = inspectLock(alive, LOCK_STALE_MS);
  assert.equal(aliveState.exists, true);
  assert.equal(aliveState.stale, false, '活着的持锁者不能被当成失效锁');
  assert.equal(fs.existsSync(alive), true);
  fs.unlinkSync(alive);

  const dead = writeForeignLock(deadPid());
  const deadState = inspectLock(dead, LOCK_STALE_MS);
  assert.equal(deadState.stale, true, '持锁进程已死 → 必须判为失效锁（否则永久卡死）');
  assert.match(deadState.reason, /已不存在/);
  fs.unlinkSync(dead);

  const expired = writeForeignLock(process.pid, { ageMs: LOCK_STALE_MS + 5000 });
  const expiredState = inspectLock(expired, LOCK_STALE_MS);
  assert.equal(expiredState.stale, true, '心跳停止超过阈值 → 必须判为过期可抢占');
  assert.match(expiredState.reason, /没有心跳/);
  fs.unlinkSync(expired);

  // 内容损坏（半写）不能把锁判成永久有效
  const broken = testLogPath(`lock-broken-${Date.now()}.lock`);
  fs.writeFileSync(broken, '{"pid":', 'utf8');
  assert.equal(inspectLock(broken, LOCK_STALE_MS).stale, false, '刚写入的损坏内容不算过期，交给 mtime 判定');
  const old = new Date(Date.now() - LOCK_STALE_MS - 5000);
  fs.utimesSync(broken, old, old);
  assert.equal(inspectLock(broken, LOCK_STALE_MS).stale, true);
  fs.unlinkSync(broken);

  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(deadPid()), false);
  assert.equal(isProcessAlive(0), false);
});

test('K3：抢到锁后正常执行，释放后锁文件消失', () => {
  const lockPath = testLogPath(`lock-acquire-${Date.now()}.lock`);
  const claim = acquireEnsureLock({ lockPath, log: collector().write });
  assert.equal(claim.acquired, true);
  assert.equal(fs.existsSync(lockPath), true, '拿到锁后必须落盘（别的进程才看得见）');
  const written = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(written.pid, process.pid, '锁内容必须含 pid');
  assert.equal(Number.isInteger(written.startedAtMs), true, '锁内容必须含创建时间');
  assert.equal(releaseLock(claim), true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('K3：releaseLock 只删自己的锁，不会误删被抢占后的新锁', () => {
  const lockPath = testLogPath(`lock-foreign-release-${Date.now()}.lock`);
  const claim = acquireEnsureLock({ lockPath, log: collector().write });
  assert.equal(claim.acquired, true);
  // 模拟"等待期间锁被别人抢占/重写"
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAtMs: Date.now() }), 'utf8');
  assert.equal(releaseLock(claim), false, '不是自己的锁不能删');
  assert.equal(fs.existsSync(lockPath), true);
  fs.unlinkSync(lockPath);
});

test('K3：持锁者活着 → 不拉起第二个 dev server，以 7 退出并说明原因', async () => {
  const lockPath = writeForeignLock(process.pid);
  const queued = queuedProbe([NO_SERVICE_RESULT]);
  const started = [];
  const errors = collector();
  try {
    const outcome = await ensurePetDevServer({
      waitMs: 1000,
      lockPath,
      lockWaitMs: 150,
      lockPollMs: 50,
      probe: queued.probe,
      startImpl: (options) => {
        started.push(options);
        return { pid: 1, command: 'x', cwd: FRONTEND_ROOT, logPath: 'x' };
      },
      log: collector().write,
      errorLog: errors.write,
    });
    assert.equal(started.length, 0, '拿不到锁时绝不允许 spawn 第二个 dev server');
    assert.equal(outcome.started, false);
    assert.equal(outcome.code, EXIT_LOCK_TIMEOUT, `等锁超时必须是非 0（实际 ${outcome.code}）`);
    assert.equal(errors.lines.some((line) => line.includes('等待锁超时')), true);
  } finally {
    fs.unlinkSync(lockPath);
  }
  assert.equal(fs.existsSync(lockPath), false);
});

test('K3：等待期间对方把服务拉起来 → 返回 0，既不抢锁也不拉起', async () => {
  const lockPath = writeForeignLock(process.pid);
  // 首次探活 no-service（进入等锁），等锁期间探活返回 ok（对方已拉起）
  const queued = queuedProbe([NO_SERVICE_RESULT, OK_RESULT]);
  const started = [];
  try {
    const outcome = await ensurePetDevServer({
      waitMs: 1000,
      lockPath,
      lockWaitMs: 2000,
      lockPollMs: 50,
      probe: queued.probe,
      startImpl: (options) => {
        started.push(options);
        return { pid: 1, command: 'x', cwd: FRONTEND_ROOT, logPath: 'x' };
      },
      log: collector().write,
      errorLog: collector().write,
    });
    assert.equal(outcome.code, 0, '对方已就绪，本次应当成功返回');
    assert.equal(outcome.started, false);
    assert.equal(started.length, 0, '服务已就绪时不该再 spawn');
  } finally {
    fs.unlinkSync(lockPath);
  }
});

test('K3：持锁进程已死 → 抢占失效锁后正常拉起', async () => {
  const lockPath = writeForeignLock(deadPid());
  const queued = queuedProbe([NO_SERVICE_RESULT, NO_SERVICE_RESULT, OK_RESULT]);
  const started = [];
  const outcome = await ensurePetDevServer({
    waitMs: 1000,
    logPath: testLogPath('pet-vite-deadlock.log'),
    lockPath,
    lockWaitMs: 1000,
    lockPollMs: 50,
    probe: queued.probe,
    startImpl: (options) => {
      started.push(options);
      return { pid: 123, command: 'x', cwd: FRONTEND_ROOT, logPath: options.logPath };
    },
    log: collector().write,
    errorLog: collector().write,
  });
  assert.equal(outcome.code, 0);
  assert.equal(outcome.started, true);
  assert.equal(started.length, 1);
  assert.equal(fs.existsSync(lockPath), false, '自己拿的锁结束后必须删掉');
});

test('K3：锁过期（心跳停止）→ 可抢占并正常拉起', async () => {
  const lockPath = writeForeignLock(process.pid, { ageMs: LOCK_STALE_MS + 10000 });
  const queued = queuedProbe([NO_SERVICE_RESULT, NO_SERVICE_RESULT, OK_RESULT]);
  const started = [];
  const outcome = await ensurePetDevServer({
    waitMs: 1000,
    logPath: testLogPath('pet-vite-expired.log'),
    lockPath,
    lockWaitMs: 1000,
    lockPollMs: 50,
    probe: queued.probe,
    startImpl: (options) => {
      started.push(options);
      return { pid: 456, command: 'x', cwd: FRONTEND_ROOT, logPath: options.logPath };
    },
    log: collector().write,
    errorLog: collector().write,
  });
  assert.equal(outcome.code, 0);
  assert.equal(started.length, 1, '过期锁必须能被抢占');
  assert.equal(fs.existsSync(lockPath), false);
});

test('K3：两个 ensure 并发 → 只 spawn 一次（等锁的那个直接复用结果）', async () => {
  const lockPath = testLogPath(`lock-concurrent-${Date.now()}.lock`);
  /** 模拟 dev server 是否已就绪。 */
  let serverUp = false;
  /**
   * 假探活：和真实 `probePetDevServer` 一样，给 waitMs 就在期限内轮询到就绪。
   *
   * @param {object} [options] 探活选项
   * @returns {Promise<object>} 探活结论
   */
  const probe = async (options = {}) => {
    const waitMs = Number(options.waitMs) || 0;
    const deadline = Date.now() + waitMs;
    while (!serverUp && Date.now() < deadline) await sleepFor(20);
    return serverUp ? OK_RESULT : NO_SERVICE_RESULT;
  };
  const spawns = [];
  // 真实行为：spawn 立即返回，vite 在稍后把端口带起来
  const startImpl = (options) => {
    spawns.push(options);
    setTimeout(() => {
      serverUp = true;
    }, 60);
    return { pid: 8888, command: 'npm.cmd run dev:pet', cwd: FRONTEND_ROOT, logPath: options.logPath };
  };

  const makeOptions = () => ({
    waitMs: 3000,
    logPath: testLogPath('pet-vite-concurrent.log'),
    lockPath,
    lockWaitMs: 3000,
    lockPollMs: 20,
    probe,
    startImpl,
    log: collector().write,
    errorLog: collector().write,
  });

  try {
    const [first, second] = await Promise.all([ensurePetDevServer(makeOptions()), ensurePetDevServer(makeOptions())]);
    assert.equal(spawns.length, 1, `并发 ensure 只允许 spawn 一次，实际 ${spawns.length} 次`);
    assert.equal(first.code, 0);
    assert.equal(second.code, 0);
    assert.equal([first, second].filter((item) => item.started === true).length, 1, '只允许一个进程真正拉起 dev server');
  } finally {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  }
});

test('K3：默认锁路径在系统临时目录（不落仓库源码树）', () => {
  const lockPath = defaultLockPath();
  assert.equal(path.isAbsolute(lockPath), true);
  assert.equal(lockPath.startsWith(FRONTEND_ROOT), false, '锁不能写进仓库');
  assert.equal(path.dirname(lockPath), os.tmpdir());
});
