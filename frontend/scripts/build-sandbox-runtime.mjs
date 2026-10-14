import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`运行资源检查失败: ${file}: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function requireFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`内置运行资源缺失: ${file}`);
}

/** 保留完整 npm 安装和 Git 目录，避免只带入口文件却依赖宿主环境。 */
function verifyLayout(directory, platform, arch) {
  const windows = platform === 'win32';
  const node = path.join(directory, 'node', ...(windows ? ['node.exe'] : ['bin', 'node']));
  const bash = path.join(directory, 'git', 'bin', windows ? 'bash.exe' : 'bash');
  const git = path.join(directory, 'git', windows ? 'cmd' : 'bin', windows ? 'git.exe' : 'git');
  const packageRoot = path.join(directory, 'srt', 'node_modules', '@anthropic-ai', 'sandbox-runtime');
  const cli = path.join(packageRoot, 'dist', 'cli.js');
  for (const file of [node, bash, git, cli, path.join(packageRoot, 'package.json')]) requireFile(file);
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (metadata.name !== '@anthropic-ai/sandbox-runtime') throw new Error('内置 SRT 包名称不正确');
  const resolve = createRequire(path.join(packageRoot, 'package.json'));
  for (const dependency of Object.keys(metadata.dependencies ?? {})) {
    let resolved;
    try {
      resolved = resolve.resolve(dependency);
    } catch {
      throw new Error(`SRT 依赖未随包提供: ${dependency}`);
    }
    const relative = path.relative(path.join(directory, 'srt'), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`SRT 依赖未随包提供: ${dependency}`);
  }
  if (windows) {
    requireFile(path.join(packageRoot, 'vendor', 'srt-win', arch, 'srt-win.exe'));
    requireFile(path.join(directory, 'git', 'usr', 'bin', 'msys-2.0.dll'));
    requireFile(path.join(directory, 'git', 'usr', 'bin', 'bash.exe'));
  }
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('运行资源必须在目标平台和架构上执行检查，不能仅凭文件名跨平台打包');
  }
  return { node, bash, git, cli, srtVersion: metadata.version };
}

export function verifyRuntime(directory, platform = process.platform, arch = process.arch, execute = run) {
  const { node, bash, git, cli, srtVersion } = verifyLayout(directory, platform, arch);
  const nodeInfo = JSON.parse(execute(node, ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})']));
  const [major, minor] = nodeInfo.version.split('.').map(Number);
  if (nodeInfo.platform !== platform || nodeInfo.arch !== arch || major < 22 || (major === 22 && minor < 12)) {
    throw new Error('内置 Node 的平台、架构或版本不满足 SRT 要求（至少 22.12）');
  }
  execute(node, [cli, '--version']);
  const gitVersion = execute(git, ['--version']);
  if (execute(bash, ['-c', "printf '%s' bundled-bash-ready"]) !== 'bundled-bash-ready') {
    throw new Error('内置 Git Bash 无法正常执行命令');
  }
  return { node: nodeInfo.version, srt: srtVersion, git: gitVersion, platform, arch };
}

function removeBuildDirectory(directory, buildRoot) {
  const relative = path.relative(fs.realpathSync(buildRoot), fs.realpathSync(directory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('构建清理目录超出暂存范围');
  fs.rmSync(directory, { recursive: true, force: true });
}

/** 发行包由构建输入提供；缺包时失败，不扫描全局 npm、Git 或 PATH。 */
export function buildSandboxRuntime(frontendRoot, sourceDirectory, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const source = path.resolve(sourceDirectory ?? path.join(frontendRoot, 'vendor', 'runtime', `${platform}-${arch}`));
  const buildRoot = path.resolve(frontendRoot, 'build');
  const destination = path.join(buildRoot, 'runtime');
  if (!fs.existsSync(source)) throw new Error(`请先准备完整的 node、srt、git 发行包目录: ${source}`);
  const sourceRoot = fs.realpathSync(source);
  fs.mkdirSync(buildRoot, { recursive: true });
  const relativeSource = path.relative(fs.realpathSync(buildRoot), sourceRoot);
  if (!relativeSource.startsWith('..') && !path.isAbsolute(relativeSource)) throw new Error('发行包源目录不能放在 build 暂存区内');
  const versions = verifyRuntime(sourceRoot, platform, arch, options.execute);
  const incoming = fs.mkdtempSync(path.join(buildRoot, 'runtime-'));
  try {
    for (const name of ['node', 'srt', 'git']) {
      fs.cpSync(path.join(sourceRoot, name), path.join(incoming, name), { recursive: true, verbatimSymlinks: true });
    }
    // 运行过的 exe 可能仍被系统持有；临时目录不执行程序，最终目录由打包闸门执行检查。
    verifyLayout(incoming, platform, arch);
    fs.writeFileSync(path.join(incoming, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
    if (fs.existsSync(destination)) removeBuildDirectory(destination, buildRoot);
    fs.renameSync(incoming, destination);
    return destination;
  } finally {
    if (fs.existsSync(incoming)) removeBuildDirectory(incoming, buildRoot);
  }
}

/** 从本次后端产物提取 helper，安装到只读目录后无需首次运行再写安装位置。 */
export function extractSandboxHelpers(backendJar, frontendRoot, jarExecutable = 'jar') {
  const buildRoot = path.resolve(frontendRoot, 'build');
  fs.mkdirSync(buildRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(buildRoot, 'helpers-'));
  try {
    const entry = run(jarExecutable, ['--list', '--file', backendJar]).split(/\r?\n/)
      .find(name => /^BOOT-INF\/lib\/harness-local-sandbox-[^/]+\.jar$/.test(name));
    if (!entry) throw new Error('后端 jar 未包含 harness-local-sandbox，请使用当前框架重新构建');
    run(jarExecutable, ['--extract', '--file', path.resolve(backendJar), entry], { cwd: temporary });
    const helperJar = path.join(temporary, entry);
    const helpers = run(jarExecutable, ['--list', '--file', helperJar]).split(/\r?\n/)
      .filter(name => /^[A-Za-z0-9_-]+\.mjs$/.test(name));
    if (!helpers.includes('executeCommand.mjs') || !helpers.includes('probe.mjs')) throw new Error('框架 helper 包不完整');
    const extracted = path.join(temporary, 'extracted');
    fs.mkdirSync(extracted);
    run(jarExecutable, ['--extract', '--file', helperJar, ...helpers], { cwd: extracted });
    const destination = path.join(buildRoot, 'sandbox-helpers');
    if (fs.existsSync(destination)) removeBuildDirectory(destination, buildRoot);
    fs.renameSync(extracted, destination);
    return destination;
  } finally {
    removeBuildDirectory(temporary, buildRoot);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const source = process.argv.slice(2).find(arg => arg.startsWith('--source='))?.slice('--source='.length)
      ?? process.env.LINGXI_RUNTIME_SOURCE;
    const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    console.log(`内置运行资源已准备: ${buildSandboxRuntime(frontendRoot, source)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
