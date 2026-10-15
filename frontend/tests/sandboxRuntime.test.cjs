const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const runtime = import('../scripts/build-sandbox-runtime.mjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-mxc-deployment-'));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, 'vendor'); fs.mkdirSync(source);
  const value = { schemaVersion: 1, backend: process.platform === 'win32' ? 'processcontainer' : 'bubblewrap', sdkVersion: '1.0.0',
    nodeExecutable: process.platform === 'win32' ? 'D:/node/node.exe' : '/opt/node/bin/node', sdkDirectory: process.platform === 'win32' ? 'D:/mxc/node_modules/@microsoft/mxc-sdk' : '/opt/mxc/node_modules/@microsoft/mxc-sdk' };
  const write = () => fs.writeFileSync(path.join(source, 'mxc-deployment.json'), JSON.stringify(value));
  write(); return { root, source, value, write };
}
test('暂存 MXC 部署说明，不携带旧 Windows 沙箱组件', async t => {
  const { buildSandboxRuntime } = await runtime;
  const f = fixture(t); const destination = buildSandboxRuntime(f.root, f.source);
  assert.deepEqual(fs.readdirSync(destination), ['mxc-deployment.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'mxc-deployment.json'))).sdkVersion, '1.0.0');
});
test('Windows 与 Linux 只能选择各自原生后端和路径', async t => {
  const { verifyRuntime } = await runtime; const f = fixture(t);
  f.value.backend = 'processcontainer'; f.value.nodeExecutable = 'D:/node/node.exe'; f.value.sdkDirectory = 'D:/mxc/sdk'; f.write();
  assert.equal(verifyRuntime(f.source, 'win32').backend, 'processcontainer');
  assert.throws(() => verifyRuntime(f.source, 'linux'), /版本/);
  f.value.nodeExecutable = '/opt/node/bin/node'; f.write(); assert.throws(() => verifyRuntime(f.source, 'win32'), /宿主绝对路径/);
  f.value.backend = 'bubblewrap'; f.value.sdkDirectory = '/opt/mxc/sdk'; f.write(); assert.equal(verifyRuntime(f.source, 'linux').backend, 'bubblewrap');
  f.value.distribution = 'Ubuntu'; f.write(); assert.throws(() => verifyRuntime(f.source, 'linux'), /版本/);
  delete f.value.distribution; f.value.sdkVersion = '2.0.0'; f.write(); assert.throws(() => verifyRuntime(f.source, 'linux'), /版本/);
});

test('先校验再替换，错误输入不会删除上次有效部署说明', async t => {
  const { buildSandboxRuntime } = await runtime; const f = fixture(t);
  const destination = buildSandboxRuntime(f.root, f.source);
  f.value.backend = 'invalid'; f.write(); assert.throws(() => buildSandboxRuntime(f.root, f.source));
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'mxc-deployment.json'))).backend, process.platform === 'win32' ? 'processcontainer' : 'bubblewrap');
});
