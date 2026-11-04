'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
// 路径比较的唯一口径：fixture 目录一律基于规范成长名的 TMP_ROOT 创建（见 tests/support/tmp-paths.cjs）。
// 直接用 os.tmpdir() 的拼写在 Windows 上可能是 8.3 短名，与子进程回报的长名假不等。
const { TMP_ROOT } = require('./support/tmp-paths.cjs');

function createFixture(t, scriptOnly, options = {}) {
  const temporaryRoot = TMP_ROOT;
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
  const mavenArgs = Array.isArray(options.mavenArgs) ? options.mavenArgs : ['-o', '-DskipTests', 'package'];
  const scriptPath = path.join(scriptsDir, 'probe-maven.mjs');
  fs.writeFileSync(scriptPath, `import { resolveMaven, runMaven } from ${JSON.stringify(pathToFileURL(runtimePath).href)};
try { runMaven(resolveMaven(${JSON.stringify(repoRoot)}), ${JSON.stringify(mavenArgs)}, ${JSON.stringify(repoRoot)}); }
catch (error) { console.error(error.message); process.exitCode = 1; }`);
  fs.writeFileSync(path.join(wrapperDir, 'maven-wrapper.properties'),
    scriptOnly ? 'distributionType=only-script\n' : 'distributionType=bin\n');
  if (!scriptOnly) fs.writeFileSync(path.join(wrapperDir, 'maven-wrapper.jar'), 'wrapper fixture');

  // 包装器主动失败，确保测试只验证 Maven 调用，不会打包或下载依赖。
  // 除了 args / cwd，还要把 **子进程看到的 MAVEN_REPO_LOCAL** 写下来：它是
  // `scripts/Migrate-SqliteToH2.ps1` / `scripts/Initialize-Development.ps1` 解析 jar 的依据，
  // 只传 CLI 参数的话 surefire fork 与它拉起的子进程都看不到，CI 上就会找不到 h2（真红过）。
  const probePath = path.join(repoRoot, 'probe.cjs');
  const markerPath = path.join(repoRoot, 'maven-invocation.json');
  fs.writeFileSync(probePath,
    "require('node:fs').writeFileSync(process.env.LX_MAVEN_PROBE, "
      + 'JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), '
      + 'mavenRepoLocal: process.env.MAVEN_REPO_LOCAL ?? null }));\n'
      + 'process.exit(47);\n');
  const wrapperPath = path.join(repoRoot, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
  fs.writeFileSync(wrapperPath, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${probePath}" %*\r\nexit /b %errorlevel%\r\n`
    : `#!/bin/sh\n"${process.execPath}" "${probePath}" "$@"\n`, { mode: 0o755 });

  return { repoRoot, scriptPath, markerPath, mavenArgs };
}

/**
 * 跑一次探针（= 模拟"调用方进程"调 `runMaven`），返回子进程实际看到的环境。
 *
 * @param {{repoRoot: string, scriptPath: string, markerPath: string}} fixture fixture
 * @param {NodeJS.ProcessEnv} [envOverride] 覆盖/删除调用方进程的环境变量
 *   （值为 `undefined` 表示删除，用来模拟"宿主没有这个变量"）
 * @returns {{status: number|null, output: string, invocation: {args: string[], cwd: string, mavenRepoLocal: string|null}}}
 *   退出码、输出与包装器写下的调用记录
 */
function runFixtureProbe(fixture, envOverride = {}) {
  const env = { ...process.env, LX_MAVEN_PROBE: fixture.markerPath };
  for (const [key, value] of Object.entries(envOverride)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  fs.rmSync(fixture.markerPath, { force: true });
  const result = spawnSync(process.execPath, [fixture.scriptPath, '--offline'], {
    cwd: fixture.repoRoot,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.ifError(result.error);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.ok(fs.existsSync(fixture.markerPath), `必须实际调用仓库 wrapper：\n${output}`);
  return {
    status: result.status,
    output,
    invocation: JSON.parse(fs.readFileSync(fixture.markerPath, 'utf8')),
  };
}

/**
 * 包装器调用断言（既有用例的断言原样保留，只把"调用并读回"抽到 {@link runFixtureProbe}）。
 *
 * @param {{repoRoot: string, scriptPath: string, markerPath: string}} fixture fixture
 */
function assertWrapperInvocation(fixture) {
  // 显式删掉宿主的 MAVEN_REPO_LOCAL：这两条老用例验的是"参数透传"，与宿主仓库无关
  const { status, output, invocation } = runFixtureProbe(fixture, { MAVEN_REPO_LOCAL: undefined });
  assert.deepEqual(invocation.args, ['-o', '-DskipTests', 'package']);
  assert.equal(fs.realpathSync(invocation.cwd), fs.realpathSync(fixture.repoRoot));
  assert.equal(status, 1);
  assert.match(output, /退出码 47/);
}

test('only-script wrapper 没有 jar 时仍实际调用 Maven，并传递打包参数', (t) => {
  assertWrapperInvocation(createFixture(t, true));
});

test('带 wrapper jar 的传统模式仍实际调用 Maven，并传播失败', (t) => {
  assertWrapperInvocation(createFixture(t, false));
});

// ------------------------------------------------------------------ 隔离仓库位置必须进子进程 env

/** 相对于仓库根的隔离仓库（用相对路径，顺带锁住"按 repoRoot 解析成绝对路径"这条语义）。 */
const RELATIVE_REPOSITORY = path.join('.run', 'maven', 'probe-repo');

test('调用方传 -Dmaven.repo.local 时，子进程 env 里必须是同一个解析后路径', (t) => {
  const fixture = createFixture(t, false, {
    mavenArgs: ['-o', '-DskipTests', `-Dmaven.repo.local=${RELATIVE_REPOSITORY}`, 'package'],
  });
  const expected = path.resolve(fixture.repoRoot, RELATIVE_REPOSITORY);
  const { status, output, invocation } = runFixtureProbe(fixture, { MAVEN_REPO_LOCAL: undefined });
  assert.equal(status, 1);
  assert.match(output, /退出码 47/);
  assert.ok(invocation.args.includes(`-Dmaven.repo.local=${RELATIVE_REPOSITORY}`), 'wrapper 必须真的收到仓库参数');
  assert.notEqual(invocation.mavenRepoLocal, null,
    '调用方传了 -Dmaven.repo.local，子进程 env 里必须有 MAVEN_REPO_LOCAL：'
    + '否则 surefire fork 与它拉起的 PowerShell 迁移脚本看不到隔离仓库，CI 上会报"缺 h2 jar"');
  // 比路径而不是比裸字符串：mvn 参数里可能是相对路径或正/反斜杠混写
  assert.equal(path.resolve(invocation.mavenRepoLocal), expected,
    `MAVEN_REPO_LOCAL 必须解析成 ${expected}，实际 ${invocation.mavenRepoLocal}`);
});

test('没传 -Dmaven.repo.local 时不得凭空注入 MAVEN_REPO_LOCAL', (t) => {
  const fixture = createFixture(t, false);
  const { status, output, invocation } = runFixtureProbe(fixture, { MAVEN_REPO_LOCAL: undefined });
  assert.equal(status, 1);
  assert.match(output, /退出码 47/);
  assert.equal(invocation.mavenRepoLocal, null,
    '没有 -Dmaven.repo.local 时调用方不该凭空塞 MAVEN_REPO_LOCAL：'
    + '那会让迁移脚本去一个 mvn 根本没用的仓库找 jar');
});

test('没传 -Dmaven.repo.local 时不得继承宿主的 MAVEN_REPO_LOCAL（脏值必须被移除）', (t) => {
  const fixture = createFixture(t, false);
  // 宿主环境带脏值：如果它被透传下去，模拟"mvn 用 settings.xml/~/.m2 的仓库、脚本去另一个仓库找 jar"
  // 这种两个仓库且现场无报错的事故（不变量：脚本看到的仓库 == mvn 实际用的仓库）。
  const dirty = path.join(TMP_ROOT, 'lx-dirty-repository-must-not-be-inherited');
  const { status, output, invocation } = runFixtureProbe(fixture, { MAVEN_REPO_LOCAL: dirty });
  assert.equal(status, 1);
  assert.match(output, /退出码 47/);
  assert.equal(invocation.mavenRepoLocal, null,
    `宿主脏值 ${dirty} 不得透传：没有 -Dmaven.repo.local 时子进程 env 里必须没有 MAVEN_REPO_LOCAL，`
    + '否则 mvn 与迁移脚本会用两个不同的仓库，且现场无任何报错');
});

test('参数优先：宿主 env 有脏值也以 -Dmaven.repo.local 为准', (t) => {
  const fixture = createFixture(t, false, {
    mavenArgs: ['-o', '-DskipTests', `-Dmaven.repo.local=${RELATIVE_REPOSITORY}`, 'package'],
  });
  const dirty = path.join(TMP_ROOT, 'lx-dirty-repository-should-lose');
  const expected = path.resolve(fixture.repoRoot, RELATIVE_REPOSITORY);
  const { status, invocation } = runFixtureProbe(fixture, { MAVEN_REPO_LOCAL: dirty });
  assert.equal(status, 1);
  assert.equal(path.resolve(invocation.mavenRepoLocal), expected,
    `参数必须赢：存在 ${expected} 时不能用宿主脏值 ${dirty}`);
  assert.notEqual(path.resolve(invocation.mavenRepoLocal), path.resolve(dirty));
});

test('发布先启动随包 JRE 与后端，再生成安装包', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/release.yml'), 'utf8');
  const build = workflow.indexOf('run: npm run backend:runtime');
  const startup = workflow.indexOf('run: node scripts/check-backend-startup.mjs');
  const installer = workflow.indexOf('run: npx electron-builder');
  assert.ok(build >= 0 && startup > build && installer > startup, '实际启动闸门必须在运行产物就绪后、生成安装包前执行');
});
