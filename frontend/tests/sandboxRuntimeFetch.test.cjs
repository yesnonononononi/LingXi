const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fetchRuntime = import('../scripts/fetch-sandbox-runtime.mjs');

function fixture(t, lock) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-runtime-lock-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
  const file = path.join(root, 'vendor', 'runtime.lock.json');
  if (lock !== undefined) fs.writeFileSync(file, typeof lock === 'string' ? lock : JSON.stringify(lock));
  return { root, file };
}

const LOCK = { 'win32-x64': { node: '24.22.0', portableGit: '2.45.1', srt: '0.0.79' } };

test('按锁文件解析固定版本与来源 URL', async t => {
  const { root } = fixture(t, LOCK);
  const { readRuntimeLock, runtimePlan } = await fetchRuntime;
  const entry = readRuntimeLock(root, 'win32', 'x64');
  assert.equal(entry.node, '24.22.0');
  const plan = runtimePlan(entry, 'x64');
  assert.equal(plan.node.url, 'https://nodejs.org/dist/v24.22.0/node-v24.22.0-win-x64.zip');
  assert.equal(plan.node.extractedRoot, 'node-v24.22.0-win-x64');
  assert.equal(plan.portableGit.url,
    'https://github.com/git-for-windows/git/releases/download/v2.45.1.windows.1/PortableGit-2.45.1-64-bit.7z.exe');
  assert.equal(plan.srt.version, '0.0.79');
});

test('锁文件缺失、缺平台条目或版本为空都要报错', async t => {
  const { readRuntimeLock } = await fetchRuntime;
  const missing = fixture(t, undefined).root;
  assert.throws(() => readRuntimeLock(missing, 'win32', 'x64'), /缺少运行资源锁文件/);

  const otherPlatform = fixture(t, LOCK).root;
  assert.throws(() => readRuntimeLock(otherPlatform, 'linux', 'x64'), /缺少 linux-x64 条目/);

  const emptyVersion = fixture(t, { 'win32-x64': { node: '', portableGit: '2.45.1', srt: '0.0.79' } }).root;
  assert.throws(() => readRuntimeLock(emptyVersion, 'win32', 'x64'), /node 必须是非空版本号/);
});

test('未提供来源的平台明确报错，不静默产出半成品', async t => {
  const { fetchSandboxRuntime } = await fetchRuntime;
  const { root } = fixture(t, LOCK);
  await assert.rejects(fetchSandboxRuntime(root, { platform: 'linux', arch: 'x64' }), /尚未提供 linux-x64/);
});
