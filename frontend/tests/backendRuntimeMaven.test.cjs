'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function createFixture(t, scriptOnly) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const repoRoot = fs.mkdtempSync(path.join(temporaryRoot, 'lingxi-maven-'));
  t.after(() => {
    const relativePath = path.relative(temporaryRoot, repoRoot);
    assert.ok(relativePath.startsWith('lingxi-maven-') && !relativePath.includes(path.sep));
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  const scriptsDir = path.join(repoRoot, 'frontend', 'scripts');
  const wrapperDir = path.join(repoRoot, '.mvn', 'wrapper');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(wrapperDir, { recursive: true });
  const runtimePath = path.join(scriptsDir, 'maven-runtime.mjs');
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'maven-runtime.mjs'), runtimePath);
  const scriptPath = path.join(scriptsDir, 'probe-maven.mjs');
  fs.writeFileSync(scriptPath, `import { resolveMaven, runMaven } from ${JSON.stringify(pathToFileURL(runtimePath).href)};
try { runMaven(resolveMaven(${JSON.stringify(repoRoot)}), ['-o', '-DskipTests', 'package'], ${JSON.stringify(repoRoot)}); }
catch (error) { console.error(error.message); process.exitCode = 1; }`);
  fs.writeFileSync(path.join(wrapperDir, 'maven-wrapper.properties'),
    scriptOnly ? 'distributionType=only-script\n' : 'distributionType=bin\n');
  if (!scriptOnly) fs.writeFileSync(path.join(wrapperDir, 'maven-wrapper.jar'), 'wrapper fixture');

  // 包装器主动失败，确保测试只验证 Maven 调用，不会打包或下载依赖。
  const probePath = path.join(repoRoot, 'probe.cjs');
  const markerPath = path.join(repoRoot, 'maven-invocation.json');
  fs.writeFileSync(probePath,
    "require('node:fs').writeFileSync(process.env.LX_MAVEN_PROBE, "
      + 'JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n'
      + 'process.exit(47);\n');
  const wrapperPath = path.join(repoRoot, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
  fs.writeFileSync(wrapperPath, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${probePath}" %*\r\nexit /b %errorlevel%\r\n`
    : `#!/bin/sh\n"${process.execPath}" "${probePath}" "$@"\n`, { mode: 0o755 });

  return { repoRoot, scriptPath, markerPath };
}

function assertWrapperInvocation(fixture) {
  const result = spawnSync(process.execPath, [fixture.scriptPath, '--offline'], {
    cwd: fixture.repoRoot,
    env: { ...process.env, LX_MAVEN_PROBE: fixture.markerPath },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.ifError(result.error);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.ok(fs.existsSync(fixture.markerPath), `必须实际调用仓库 wrapper：\n${output}`);
  const invocation = JSON.parse(fs.readFileSync(fixture.markerPath, 'utf8'));
  assert.deepEqual(invocation.args, ['-o', '-DskipTests', 'package']);
  assert.equal(fs.realpathSync(invocation.cwd), fs.realpathSync(fixture.repoRoot));
  assert.equal(result.status, 1);
  assert.match(output, /退出码 47/);
}

test('only-script wrapper 没有 jar 时仍实际调用 Maven，并传递打包参数', (t) => {
  assertWrapperInvocation(createFixture(t, true));
});

test('带 wrapper jar 的传统模式仍实际调用 Maven，并传播失败', (t) => {
  assertWrapperInvocation(createFixture(t, false));
});
