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
  const value = { schemaVersion: 1, backend: 'bubblewrap', sdkVersion: '1.0.0', distribution: 'Ubuntu',
    nodeExecutable: '/opt/node/bin/node', sdkDirectory: '/opt/mxc/node_modules/@microsoft/mxc-sdk' };
  const write = () => fs.writeFileSync(path.join(source, 'mxc-deployment.json'), JSON.stringify(value));
  write(); return { root, source, value, write };
}
test('暂存 MXC 部署说明，不携带旧 Windows 沙箱组件', async t => {
  const { buildSandboxRuntime } = await runtime;
  const f = fixture(t); const destination = buildSandboxRuntime(f.root, f.source);
  assert.deepEqual(fs.readdirSync(destination), ['mxc-deployment.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'mxc-deployment.json'))).sdkVersion, '1.0.0');
});
test('错误版本、Windows Node 路径或缺少 WSL 发行版不能通过检查', async t => {
  const { verifyRuntime } = await runtime; const f = fixture(t);
  f.value.nodeExecutable = 'D:/node.exe'; f.write(); assert.throws(() => verifyRuntime(f.source), /Linux/);
  f.value.nodeExecutable = '/opt/node/bin/node'; f.value.sdkVersion = '2.0.0'; f.write(); assert.throws(() => verifyRuntime(f.source), /版本/);
  f.value.sdkVersion = '1.0.0'; delete f.value.distribution; f.write(); assert.throws(() => verifyRuntime(f.source, 'win32'), /发行版/);
});
test('先校验再替换，错误输入不会删除上次有效部署说明', async t => {
  const { buildSandboxRuntime } = await runtime; const f = fixture(t);
  const destination = buildSandboxRuntime(f.root, f.source);
  f.value.backend = 'processcontainer'; f.write(); assert.throws(() => buildSandboxRuntime(f.root, f.source));
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'mxc-deployment.json'))).backend, 'bubblewrap');
});
