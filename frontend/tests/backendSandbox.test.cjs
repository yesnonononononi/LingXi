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
    fs: { existsSync: () => true, readFileSync: () => JSON.stringify({ schemaVersion: 1, backend: 'bubblewrap', sdkVersion: '1.0.0', distribution: 'Ubuntu', nodeExecutable: '/opt/node/bin/node', sdkDirectory: '/opt/mxc/node_modules/@microsoft/mxc-sdk' }), mkdirSync() {}, createWriteStream: () => ({ write() {} }) },
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
  test(`${platform} 启动器传递 Linux 运行资源，状态目录保持可写`, async () => {
    const { invocation, userDataDir, paths } = await launch({ platform });
    assert.ok(invocation.args.includes(`--lingxi.sandbox.application-directory=${paths.join(userDataDir, 'sandbox')}`));
    assert.equal(invocation.options.cwd, userDataDir);
    assert.ok(invocation.args.includes('--lingxi.sandbox.node-executable=/opt/node/bin/node'));
    assert.ok(invocation.args.includes('--lingxi.sandbox.sdk-directory=/opt/mxc/node_modules/@microsoft/mxc-sdk'));
    assert.ok(invocation.args.includes('--lingxi.sandbox.distribution=Ubuntu'));
    assert.ok(invocation.args.every(arg => !arg.includes('srt-cli=') && !arg.includes('node-exe=') && !arg.includes('state-directory=')));
  });
}
test('部署环境覆盖说明文件，Linux 路径不加入 Windows PATH', async () => {
  const env = { LINGXI_SANDBOX_APPLICATION_DIRECTORY: 'E:/Writable State',
    LINGXI_SANDBOX_NODE_EXECUTABLE: '/opt/custom node/bin/node', LINGXI_SANDBOX_SDK_DIRECTORY: '/opt/custom sdk/node_modules/@microsoft/mxc-sdk',
    LINGXI_SANDBOX_DISTRIBUTION: 'Custom-Ubuntu', PATH: 'C:/Windows' };
  const { invocation } = await launch({ env });
  assert.ok(invocation.args.includes('--lingxi.sandbox.application-directory=E:/Writable State'));
  assert.ok(invocation.args.includes('--lingxi.sandbox.node-executable=/opt/custom node/bin/node'));
  assert.ok(invocation.args.includes('--lingxi.sandbox.distribution=Custom-Ubuntu'));
  assert.equal(invocation.options.env.PATH, env.PATH);
});
