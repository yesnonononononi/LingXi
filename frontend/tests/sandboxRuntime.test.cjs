const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const packageConfig = require('../package.json');
const runtime = import('../scripts/build-sandbox-runtime.mjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-runtime-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('lingxi-runtime-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'vendor');
  const windows = process.platform === 'win32';
  const write = (relative, content = 'distribution fixture') => {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write(windows ? 'node/node.exe' : 'node/bin/node');
  write(windows ? 'git/bin/bash.exe' : 'git/bin/bash');
  write(windows ? 'git/cmd/git.exe' : 'git/bin/git');
  if (windows) {
    write('git/usr/bin/msys-2.0.dll');
    write('git/usr/bin/bash.exe');
    write(`srt/node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/${process.arch}/srt-win.exe`);
  }
  write('git/LICENSE', 'git license');
  write('node/LICENSE', 'node license');
  write('srt/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js');
  write('srt/node_modules/@anthropic-ai/sandbox-runtime/package.json', JSON.stringify({
    name: '@anthropic-ai/sandbox-runtime', version: '0.0.79', dependencies: { 'fixture-dependency': '1.0.0' },
  }));
  write('srt/node_modules/fixture-dependency/package.json', JSON.stringify({ name: 'fixture-dependency', main: 'index.js' }));
  write('srt/node_modules/fixture-dependency/index.js');
  const execute = (_file, args) => args[0] === '-p'
    ? JSON.stringify({ version: '22.12.0', platform: process.platform, arch: process.arch })
    : args[0] === '-c' ? 'bundled-bash-ready' : 'fixture version';
  return { root, source, write, execute };
}

test('完整发行目录复制到 build，许可证和 npm 依赖保留，版本元数据来自执行检查', async t => {
  const { buildSandboxRuntime } = await runtime;
  const f = fixture(t);
  const destination = buildSandboxRuntime(f.root, f.source, { execute: f.execute });
  assert.equal(fs.readFileSync(path.join(destination, 'node/LICENSE'), 'utf8'), 'node license');
  assert.equal(fs.readFileSync(path.join(destination, 'git/LICENSE'), 'utf8'), 'git license');
  assert.ok(fs.existsSync(path.join(destination, 'srt/node_modules/fixture-dependency/index.js')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'versions.json'), 'utf8')).node, '22.12.0');
});

test('缺少 SRT 依赖或只有 Bash 启动器时拒绝发布，保留上次完整产物', async t => {
  const { buildSandboxRuntime } = await runtime;
  const f = fixture(t);
  const destination = buildSandboxRuntime(f.root, f.source, { execute: f.execute });
  fs.unlinkSync(path.join(f.source, 'srt/node_modules/fixture-dependency/index.js'));
  assert.throws(() => buildSandboxRuntime(f.root, f.source, { execute: f.execute }), /SRT 依赖未随包提供/);
  assert.ok(fs.existsSync(path.join(destination, 'srt/node_modules/fixture-dependency/index.js')));
  if (process.platform === 'win32') {
    f.write('srt/node_modules/fixture-dependency/index.js');
    fs.unlinkSync(path.join(f.source, 'git/usr/bin/msys-2.0.dll'));
    assert.throws(() => buildSandboxRuntime(f.root, f.source, { execute: f.execute }), /msys-2.0.dll/);
  }
});

test('错误 Node 架构和版本不会变成可打包产物', async t => {
  const { buildSandboxRuntime } = await runtime;
  const f = fixture(t);
  for (const info of [{ version: '22.11.0', platform: process.platform, arch: process.arch },
    { version: '24.0.0', platform: process.platform, arch: 'different' }]) {
    assert.throws(() => buildSandboxRuntime(f.root, f.source, { execute: () => JSON.stringify(info) }), /Node/);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'build/runtime')), false);
});

test('helper 从本次 Boot jar 内嵌框架 jar 提取，字节和目录不依赖安装账户写权限', async t => {
  const { extractSandboxHelpers } = await runtime;
  const f = fixture(t);
  const contents = path.join(f.root, 'contents');
  const boot = path.join(f.root, 'boot');
  fs.mkdirSync(contents);
  fs.mkdirSync(path.join(boot, 'BOOT-INF/lib'), { recursive: true });
  for (const name of ['executeCommand.mjs', 'probe.mjs', 'request.mjs']) fs.writeFileSync(path.join(contents, name), `// ${name}\n`);
  const frameworkJar = path.join(boot, 'BOOT-INF/lib/harness-local-sandbox-1.1.6.jar');
  execFileSync('jar', ['--create', '--file', frameworkJar, '-C', contents, '.'], { windowsHide: true });
  const backendJar = path.join(f.root, 'app.jar');
  execFileSync('jar', ['--create', '--file', backendJar, '-C', boot, '.'], { windowsHide: true });
  const destination = extractSandboxHelpers(backendJar, f.root);
  assert.equal(fs.readFileSync(path.join(destination, 'probe.mjs'), 'utf8'), '// probe.mjs\n');
  assert.deepEqual(fs.readdirSync(destination).sort(), ['executeCommand.mjs', 'probe.mjs', 'request.mjs']);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'build')), ['sandbox-helpers']);
});

test('所有打包入口经过资源检查，运行资源和 helper 放在 ASAR 外', () => {
  assert.equal(packageConfig.build.beforePack, 'scripts/verify-sandbox-bundle.cjs');
  for (const name of ['runtime', 'sandbox-helpers']) {
    assert.ok(packageConfig.build.extraResources.some(entry => entry.from === `build/${name}` && entry.to === name));
  }
  assert.match(packageConfig.scripts['backend:runtime'], /build-sandbox-runtime/);
});
