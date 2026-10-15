'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

/**
 * 执行真实启动逻辑，替换进程和端口，避免测试占用用户后端。
 * 部署说明按新约定写**包内相对路径**，由启动器按安装目录拼成宿主绝对路径。
 */
async function launch({ platform = 'win32', packaged = true, env = {}, deployment } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const root = platform === 'win32' ? 'D:\\Custom Apps\\LX' : '/opt/custom apps/LX';
  const userDataDir = paths.join(root, 'user data');
  const frontendRoot = paths.join(root, 'source', 'frontend');
  const descriptor = deployment ?? {
    schemaVersion: 1,
    backend: platform === 'win32' ? 'processcontainer' : 'bubblewrap',
    sdkVersion: '1.0.0',
    nodeExecutable: platform === 'win32' ? 'node/node.exe' : 'node/node',
    sdkDirectory: 'mxc/node_modules/@microsoft/mxc-sdk',
  };
  let invocation;
  let checks = 0;
  const child = new EventEmitter();
  child.stdout = child.stderr = { pipe() {} };
  child.exitCode = null;
  const dependencies = {
    child_process: { spawn(file, args, options) { invocation = { file, args, options }; return child; } },
    fs: { existsSync: () => true, readFileSync: () => JSON.stringify(descriptor), mkdirSync() {}, createWriteStream: () => ({ write() {} }) },
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
  return { invocation, root, userDataDir, frontendRoot, paths,
    runtime: packaged ? paths.join(root, 'resources', 'runtime') : paths.join(frontendRoot, 'build', 'runtime') };
}

for (const platform of ['win32', 'linux']) {
  test(`${platform} 启动器把包内相对路径解析成安装目录下的宿主绝对路径`, async () => {
    const { invocation, userDataDir, paths, runtime } = await launch({ platform });
    assert.ok(invocation.args.includes(`--lingxi.sandbox.application-directory=${paths.join(userDataDir, 'sandbox')}`));
    assert.equal(invocation.options.cwd, userDataDir);
    assert.ok(invocation.args.includes('--lingxi.sandbox.node-executable='
      + paths.join(runtime, 'node', platform === 'win32' ? 'node.exe' : 'node')));
    assert.ok(invocation.args.includes('--lingxi.sandbox.sdk-directory='
      + paths.join(runtime, 'mxc', 'node_modules', '@microsoft', 'mxc-sdk')));
    assert.ok(invocation.args.every(arg => !arg.includes('distribution=')));
    assert.ok(invocation.args.every(arg => !arg.includes('srt-cli=') && !arg.includes('node-exe=') && !arg.includes('state-directory=')));
  });
}

test('开发态从未打包的 build/runtime 解析，不指向 resources', async () => {
  const { invocation, frontendRoot, paths } = await launch({ packaged: false });
  assert.ok(invocation.args.includes('--lingxi.sandbox.node-executable='
    + paths.join(frontendRoot, 'build', 'runtime', 'node', 'node.exe')));
});

test('部署说明已是绝对路径时原样使用', async () => {
  const { invocation } = await launch({ deployment: { schemaVersion: 1, backend: 'processcontainer', sdkVersion: '1.0.0',
    nodeExecutable: 'D:/tools/node/node.exe', sdkDirectory: 'D:/tools/mxc/node_modules/@microsoft/mxc-sdk' } });
  assert.ok(invocation.args.includes('--lingxi.sandbox.node-executable=D:\\tools\\node\\node.exe'));
  assert.ok(invocation.args.includes('--lingxi.sandbox.sdk-directory='
    + path.win32.join('D:\\tools\\mxc', 'node_modules', '@microsoft', 'mxc-sdk')));
});

test('部署环境覆盖说明文件，宿主 PATH 不被改写', async () => {
  const env = { LINGXI_SANDBOX_APPLICATION_DIRECTORY: 'E:/Writable State',
    LINGXI_SANDBOX_NODE_EXECUTABLE: 'E:/custom node/node.exe', LINGXI_SANDBOX_SDK_DIRECTORY: 'E:/custom sdk/node_modules/@microsoft/mxc-sdk',
    PATH: 'C:/Windows' };
  const { invocation } = await launch({ env });
  assert.ok(invocation.args.includes('--lingxi.sandbox.application-directory=E:/Writable State'));
  assert.ok(invocation.args.includes('--lingxi.sandbox.node-executable=E:/custom node/node.exe'));
  assert.ok(invocation.args.every(arg => !arg.includes('distribution=')));
  assert.equal(invocation.options.env.PATH, env.PATH);
});
