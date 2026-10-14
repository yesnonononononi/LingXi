'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// 执行真实启动逻辑，替换进程和端口，避免测试占用用户后端。
async function launch({ platform = 'win32', packaged = true, env = {} } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const root = platform === 'win32' ? 'D:\\Custom Apps\\LX' : '/opt/custom apps/LX';
  const userDataDir = paths.join(root, 'user data');
  const frontendRoot = paths.join(root, 'source', 'frontend');
  let invocation;
  let checks = 0;
  const child = new EventEmitter();
  child.stdout = child.stderr = { pipe() {} };
  child.exitCode = null;
  const dependencies = {
    child_process: { spawn(file, args, options) { invocation = { file, args, options }; return child; } },
    fs: { existsSync: () => true, mkdirSync() {}, createWriteStream: () => ({ write() {} }) },
    path: paths,
    net: { connect() {
      const socket = new EventEmitter();
      socket.destroy = socket.setTimeout = () => {};
      queueMicrotask(() => socket.emit(checks++ === 0 ? 'error' : 'connect'));
      return socket;
    } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/backend.cjs'), 'utf8'), {
    module, require: name => dependencies[name], process: { platform, env }, console: { log() {} }, setTimeout,
  });
  await module.exports.start({ frontendRoot, isPackaged: packaged,
    executablePath: paths.join(root, 'LX.exe'), resourcesPath: paths.join(root, 'resources'),
    userDataDir, logPath: paths.join(userDataDir, 'backend.log'), isDev: !packaged });
  return { invocation, root, userDataDir, frontendRoot, paths };
}

for (const platform of ['win32', 'linux']) {
  test(`${platform} 安装路径含空格时原样传递给 Java，状态目录使用用户数据目录`, async () => {
    const { invocation, root, userDataDir, paths } = await launch({ platform });
    assert.ok(invocation.args.includes(`--lingxi.sandbox.application-directory=${root}`));
    assert.ok(invocation.args.includes(`--lingxi.sandbox.state-directory=${paths.join(userDataDir, 'sandbox-state')}`));
    assert.equal(invocation.options.cwd, userDataDir);
    assert.notEqual(root, invocation.options.cwd);
  });
}

test('开发态使用项目目录，不使用 Electron 开发运行时所在目录', async () => {
  const { invocation, frontendRoot, paths } = await launch({ packaged: false });
  assert.ok(invocation.args.includes(`--lingxi.sandbox.application-directory=${paths.resolve(frontendRoot, '..')}`));
});

test('显式部署环境变量覆盖自动目录，Node 和 SRT 配置随进程继承', async () => {
  const env = { LINGXI_SANDBOX_APPLICATION_DIRECTORY: 'E:\\Deployment',
    LINGXI_SANDBOX_STATE_DIRECTORY: 'E:\\Writable State',
    LINGXI_SANDBOX_NODE_EXE: 'E:\\Tools\\node.exe', LINGXI_SANDBOX_SRT_CLI: 'E:\\Tools\\dist\\cli.js' };
  const { invocation } = await launch({ env });
  assert.ok(invocation.args.includes('--lingxi.sandbox.application-directory=E:\\Deployment'));
  assert.ok(invocation.args.includes('--lingxi.sandbox.state-directory=E:\\Writable State'));
  assert.equal(invocation.options.env.LINGXI_SANDBOX_NODE_EXE, env.LINGXI_SANDBOX_NODE_EXE);
  assert.equal(invocation.options.env.LINGXI_SANDBOX_SRT_CLI, env.LINGXI_SANDBOX_SRT_CLI);
});
