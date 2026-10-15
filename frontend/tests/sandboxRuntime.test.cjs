const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const runtime = import('../scripts/build-sandbox-runtime.mjs');

const ARCH = process.arch;
const NODE_VERSION = 'v24.22.0';

function writeFile(root, relative, content = 'stub') {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** 造一份「发行包目录」，默认组件齐全；可删掉某一项以验证报错。 */
function fixture(t, platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-sandbox-runtime-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'vendor', `${platform}-${ARCH}`);
  writeFile(source, 'node/node.exe');
  writeFile(source, 'node/node');
  writeFile(source, 'srt/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js');
  writeFile(source, 'git/bin/bash.exe');
  writeFile(source, 'mxc/node_modules/@microsoft/mxc-sdk/package.json',
    JSON.stringify({ name: '@microsoft/mxc-sdk', version: '1.0.0' }));
  const stage = async (sourceOverride = source) => {
    const { buildSandboxRuntime } = await runtime;
    return buildSandboxRuntime(root, sourceOverride, { platform, nodeVersion: NODE_VERSION });
  };
  return { root, source, stage };
}

test('随包发布：node、Git Bash、SRT 与 MXC SDK 全量落进 build/runtime', async t => {
  const destination = await fixture(t, 'win32').stage();
  for (const relative of ['node/node.exe', 'git/bin/bash.exe',
    'srt/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js', 'mxc/node_modules/@microsoft/mxc-sdk/package.json']) {
    assert.ok(fs.existsSync(path.join(destination, ...relative.split('/'))), `缺少 ${relative}`);
  }
  // SDK 不能放在资源根部的 node_modules：electron-builder 会静默排除根部 node_modules。
  assert.ok(!fs.existsSync(path.join(destination, 'node_modules')), '根部不应出现 node_modules');
});

test('部署说明只写包内相对路径，安装位置变化无需重新打包', async t => {
  const destination = await fixture(t, 'win32').stage();
  const value = JSON.parse(fs.readFileSync(path.join(destination, 'mxc-deployment.json'), 'utf8'));
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.backend, 'processcontainer');
  assert.equal(value.nodeExecutable, 'node/node.exe');
  assert.equal(value.sdkDirectory, 'mxc/node_modules/@microsoft/mxc-sdk');
  assert.ok(!path.isAbsolute(value.nodeExecutable) && !/^[A-Za-z]:/.test(value.nodeExecutable));
});

test('Linux 使用 bubblewrap，Node 相对路径不带 .exe', async t => {
  const destination = await fixture(t, 'linux').stage();
  const value = JSON.parse(fs.readFileSync(path.join(destination, 'mxc-deployment.json'), 'utf8'));
  assert.equal(value.backend, 'bubblewrap');
  assert.equal(value.nodeExecutable, 'node/node');
  assert.ok(fs.existsSync(path.join(destination, 'node', 'node')));
});

test('发行包缺组件时拒绝打包，且不破坏上一次的有效产物', async t => {
  const f = fixture(t, 'win32');
  const destination = await f.stage();
  fs.rmSync(path.join(f.source, 'git'), { recursive: true, force: true });
  await assert.rejects(f.stage(), /运行资源不完整/);
  assert.ok(fs.existsSync(path.join(destination, 'git', 'bin', 'bash.exe')), '上一次产物应保持可用');
});

test('发行包目录名必须与目标平台架构一致', async t => {
  const f = fixture(t, 'win32');
  const renamed = path.join(f.root, 'vendor', `win32-${ARCH === 'x64' ? 'arm64' : 'x64'}`);
  fs.renameSync(f.source, renamed);
  await assert.rejects(f.stage(renamed), /目录名必须为/);
});

test('随包 Node 低于 24 时拒绝打包', async t => {
  const f = fixture(t, 'win32');
  const { buildSandboxRuntime } = await runtime;
  await assert.rejects(
    Promise.resolve().then(() => buildSandboxRuntime(f.root, f.source, { platform: 'win32', nodeVersion: 'v20.11.0' })),
    /随包 Node 需要 24/);
});

test('Windows 上 24.21.0 以下的 24.x 不达标，Linux 只看主版本', async t => {
  const { nodeVersionMeetsRequirement } = await runtime;
  assert.equal(nodeVersionMeetsRequirement('v24.22.0', 'win32'), true);
  assert.equal(nodeVersionMeetsRequirement('v24.21.0', 'win32'), true);
  assert.equal(nodeVersionMeetsRequirement('v24.20.0', 'win32'), false);
  assert.equal(nodeVersionMeetsRequirement('v24.20.0', 'linux'), true);
  assert.equal(nodeVersionMeetsRequirement('v26.0.0', 'win32'), true);
  assert.equal(nodeVersionMeetsRequirement('v23.11.0', 'win32'), false);
  assert.equal(nodeVersionMeetsRequirement('not-a-version', 'win32'), false);

  const f = fixture(t, 'win32');
  const { buildSandboxRuntime } = await runtime;
  await assert.rejects(
    Promise.resolve().then(() => buildSandboxRuntime(f.root, f.source, { platform: 'win32', nodeVersion: 'v24.20.0' })),
    /24\.21\.0/);
});

test('打包校验拦下缺组件的运行目录', async t => {
  const destination = await fixture(t, 'win32').stage();
  const { verifyRuntime } = await runtime;
  assert.equal(verifyRuntime(destination, 'win32', { nodeVersion: NODE_VERSION }).sdkVersion, '1.0.0');
  fs.rmSync(path.join(destination, 'srt'), { recursive: true, force: true });
  assert.throws(() => verifyRuntime(destination, 'win32', { nodeVersion: NODE_VERSION }),
    /随包运行资源缺失.*SRT CLI/);
});

test('部署说明写宿主绝对路径时被拒绝', async t => {
  const destination = await fixture(t, 'win32').stage();
  const file = path.join(destination, 'mxc-deployment.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.nodeExecutable = 'D:/tools/node/node.exe';
  fs.writeFileSync(file, JSON.stringify(value));
  const { verifyRuntime } = await runtime;
  assert.throws(() => verifyRuntime(destination, 'win32', { nodeVersion: NODE_VERSION }), /必须是包内相对路径/);
});
