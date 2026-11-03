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
const os = require('node:os');
const path = require('node:path');

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
  parseArgs,
} = require(path.join(FRONTEND_ROOT, 'scripts', 'pet-dev-server.cjs'));

/** 收集日志，避免测试输出噪音。 */
function collector() {
  const lines = [];
  return { lines, write: (message) => lines.push(message) };
}

/**
 * 测试用日志路径。
 *
 * <p>落系统临时目录：单测不得在仓库源码树里留下任何运行产物。</p>
 *
 * @param {string} name 文件名
 * @returns {string} 绝对路径
 */
function testLogPath(name) {
  return path.join(os.tmpdir(), 'lx-pet-dev-test', name);
}

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

test('ensure：端口无服务 → 拉起并等到就绪，返回 0', async () => {
  const queued = queuedProbe([NO_SERVICE_RESULT, OK_RESULT]);
  const started = [];
  const outcome = await ensurePetDevServer({
    waitMs: 1000,
    logPath: testLogPath('pet-vite.log'),
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
});

test('ensure：端口被非桌宠服务占用 → 拒绝拉起，以 2 退出', async () => {
  const queued = queuedProbe([WRONG_APP_RESULT]);
  const started = [];
  const errors = collector();
  const outcome = await ensurePetDevServer({
    waitMs: 1000,
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
  assert.equal(errors.lines.some((line) => line.includes('拒绝拉起')), true);
  assert.equal(queued.calls, 1, '占用场景不该再等待重试');
});

test('ensure：已就绪 → 不拉起，返回 0', async () => {
  const outcome = await ensurePetDevServer({
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
    probe: queued.probe,
    startImpl: (options) => ({ pid: 7, command: 'npm.cmd run dev:pet', cwd: FRONTEND_ROOT, logPath: options.logPath }),
    log: collector().write,
    errorLog: collector().write,
  });
  assert.equal(outcome.code, PROBE_EXIT_CODE['no-service']);
  assert.equal(outcome.started, true);
});

test('ensure：拉起失败（spawn 抛错）→ 返回 1，不抛给调用方', async () => {
  const outcome = await ensurePetDevServer({
    waitMs: 100,
    probe: queuedProbe([NO_SERVICE_RESULT]).probe,
    startImpl: () => {
      throw new Error('spawn ENOENT');
    },
    log: collector().write,
    errorLog: collector().write,
  });
  assert.equal(outcome.code, 1);
  assert.equal(outcome.started, false);
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
  assert.equal(path.basename(RESOLVED_ROOT), 'frontend');
  assert.equal(path.basename(path.dirname(RESOLVED_ROOT)), 'desktop-pet-visual');
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
