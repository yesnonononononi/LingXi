'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

/** 替换进程和端口，只检查真实启动器交给 JVM 的参数。 */
async function launch({ platform = 'win32', packaged = true, env = {}, root: customRoot } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const root = customRoot ?? (platform === 'win32' ? 'D:\\Custom Apps\\LX' : '/opt/custom apps/LX');
  const userDataDir = paths.join(root, 'user data');
  const frontendRoot = paths.join(root, 'source', 'frontend');
  let invocation;
  let checks = 0;
  const child = new EventEmitter();
  child.stdout = child.stderr = { pipe() {} };
  child.exitCode = null;
  const dependencies = {
    child_process: { spawn(file, args, options) { invocation = { file, args, options }; return child; } },
    fs: { existsSync: () => true, readFileSync() { throw new Error('启动器不应读取组件部署说明'); },
      mkdirSync() {}, accessSync() {}, constants: { W_OK: 2 }, createWriteStream: () => ({ write() {} }) },
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
  test(`${platform} 启动器只传安装根目录和独立状态目录，组件路径留给后端解析`, async () => {
    const { invocation, root, userDataDir, paths } = await launch({ platform });
    assert.ok(invocation.args.includes(`--lingxi.sandbox.application-directory=${root}`));
    assert.ok(invocation.args.includes(`--lingxi.sandbox.state-directory=${paths.join(userDataDir, 'sandbox')}`));
    assert.equal(invocation.options.cwd, userDataDir);
    const isComponentArgument = argument => /--lingxi\.sandbox\.(node-executable|sdk-directory|git-executable|bash-executable)=/.test(argument);
    assert.equal(isComponentArgument('--lingxi.sandbox.node-executable=canary'), true);
    assert.equal(invocation.args.some(isComponentArgument), false);
  });
}

test('开发态传仓库根目录，移动 checkout 后仍不注入组件路径', async () => {
  const { invocation, frontendRoot, paths } = await launch({ packaged: false, root: 'E:\\Moved Checkout' });
  assert.ok(invocation.args.includes(`--lingxi.sandbox.application-directory=${paths.dirname(frontendRoot)}`));
});

test('安装目录与状态目录可分别覆盖，宿主 PATH 保持原值', async () => {
  const env = { LINGXI_SANDBOX_APPLICATION_DIRECTORY: 'E:/Installed LX',
    LINGXI_SANDBOX_STATE_DIRECTORY: 'F:/Writable State', PATH: 'C:/Windows' };
  const { invocation } = await launch({ env });
  assert.ok(invocation.args.includes('--lingxi.sandbox.application-directory=E:/Installed LX'));
  assert.ok(invocation.args.includes('--lingxi.sandbox.state-directory=F:/Writable State'));
  assert.equal(invocation.options.env.PATH, env.PATH);
});
