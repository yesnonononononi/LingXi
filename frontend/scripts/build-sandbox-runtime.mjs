import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 随包发布的沙箱运行资源：把发行包整棵拷进 `build/runtime`，
 * 由 electron-builder 的 extraResources 落到安装目录的 `resources/runtime`。
 *
 * 部署说明里写的是**包内相对路径**，启动器再按安装目录拼成宿主绝对路径 ——
 * 因此安装包与安装位置无关，换机器/换盘符都不用重新打包。
 */

/**
 * 随包组件在 `resources/runtime` 内的相对位置；部署说明与启动器必须一致。
 *
 * ⚠️ MXC SDK 放在 `mxc/node_modules/` 而不是资源根目录的 `node_modules/`：
 * electron-builder 的 fileMatcher 会对 extraResources 源目录根部的 node_modules
 * 自动追加一条取反模式（见 app-builder-lib/out/fileMatcher.js），根部放 SDK 会被静默丢包；
 * 嵌套一层、与 `srt/` 同构即不受影响。
 */
export const RUNTIME_LAYOUT = Object.freeze({
  node: 'node',
  git: 'git',
  srt: 'srt',
  mxc: 'mxc',
  mxcSdk: 'mxc/node_modules/@microsoft/mxc-sdk',
});

export const SUPPORTED_SDK_VERSION = '1.0.0';
/** 下界：MXC 要求 Node ≥24；Windows 上 native stdio 传输按 SDK README 还需 ≥24.21.0。 */
export const MIN_NODE_MAJOR = 24;
export const MIN_NODE_MINOR_ON_WINDOWS = 21;
/** 兜底：发行包不入库（见 frontend/.gitignore 的 /vendor/runtime/），由构建方解压提供。 */
export const RUNTIME_SOURCE_ENV = 'LINGXI_RUNTIME_SOURCE';

function nodeRelativePath(platform) {
  return platform === 'win32' ? `${RUNTIME_LAYOUT.node}/node.exe` : `${RUNTIME_LAYOUT.node}/node`;
}

/** 发行包目录里必须已经有的组件（MXC SDK 可按锁文件安装，故不在此列）。 */
export function vendoredEntries(platform = process.platform) {
  const entries = [['Node 可执行文件', nodeRelativePath(platform)]];
  if (platform === 'win32') {
    // Git Bash 当前不被 MXC 链路使用，但仍随包发布，故一并校验。
    entries.push(['Git Bash', 'git/bin/bash.exe'], ['SRT CLI', 'srt/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js']);
  }
  return entries;
}

/** 打包产物里必须同时存在的组件（即随包发布的全集）。 */
export function requiredEntries(platform = process.platform) {
  return [...vendoredEntries(platform), ['MXC SDK', `${RUNTIME_LAYOUT.mxcSdk}/package.json`]];
}

export function runtimeSourceDirectory(frontendRoot, platform = process.platform) {
  return path.join(frontendRoot, 'vendor', 'runtime', `${platform}-${process.arch}`);
}

/** 部署说明里只接受包内相对路径，禁止宿主绝对路径与目录穿越。 */
function assertPackagedPath(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`MXC ${name} 缺失`);
  if (/^[A-Za-z]:/.test(value) || value.startsWith('/') || value.includes('\\') || /[\r\n\0]/.test(value)) {
    throw new Error(`MXC ${name} 必须是包内相对路径（形如 node/node.exe）`);
  }
  if (value.split('/').includes('..')) throw new Error(`MXC ${name} 不得跳出运行资源目录`);
}

function missingEntries(directory, entries) {
  return entries.filter(([, relative]) => !fs.existsSync(path.join(directory, ...relative.split('/'))));
}

function describe(missing) {
  return missing.map(([label, relative]) => `${label}(${relative})`).join('、');
}

function nodeExecutableIn(directory, platform) {
  return path.join(directory, ...nodeRelativePath(platform).split('/'));
}

/**
 * 纯函数：随包 Node 是否达标。
 * Windows 上 SDK 的 native stdio 传输要求 24.21.0 及以上，只判主版本会放进 24.20.0 这类不达标版本。
 */
export function nodeVersionMeetsRequirement(version, platform = process.platform) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < MIN_NODE_MAJOR) return false;
  if (platform === 'win32' && major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR_ON_WINDOWS) return false;
  return true;
}

function assertNodeVersion(version, platform) {
  if (nodeVersionMeetsRequirement(version, platform)) return;
  const floor = platform === 'win32' ? `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR_ON_WINDOWS}.0` : `${MIN_NODE_MAJOR}.0.0`;
  throw new Error(`随包 Node 需要 ${floor} 及以上（Windows 的 native stdio 下限），当前为 ${version}`);
}

/** 校验发行包目录：组件齐全、目录名与目标平台架构一致、Node 版本满足要求。 */
export function verifySource(directory, platform = process.platform, options = {}) {
  const expectedName = `${platform}-${process.arch}`;
  if (!['linux', 'win32'].includes(platform)) throw new Error('当前平台尚未支持 MXC');
  if (!fs.existsSync(directory)) {
    throw new Error(`缺少运行资源目录: ${directory}；请运行 npm run sandbox:fetch 按锁文件准备，或用 ${RUNTIME_SOURCE_ENV} 指定`);
  }
  if (path.basename(directory) !== expectedName) {
    throw new Error(`运行资源目录名必须为 ${expectedName}（当前 ${path.basename(directory)}）`);
  }
  const missing = missingEntries(directory, vendoredEntries(platform));
  if (missing.length > 0) throw new Error(`运行资源不完整，缺少 ${describe(missing)}`);

  const node = nodeExecutableIn(directory, platform);
  const version = options.nodeVersion ?? probeNodeVersion(node);
  assertNodeVersion(version, platform);
  return { node, version };
}

/** 实际执行一次随包 Node，确认它在宿主上可运行且版本达标。 */
function probeNodeVersion(node) {
  try {
    return execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch (error) {
    throw new Error(`随包 Node 无法执行: ${error.message}`);
  }
}

/**
 * 确保发行包目录里有 MXC SDK：缺失时按 vendor/mxc-dev 的锁文件安装，
 * 与 sandbox:dev 使用同一份清单，避免依赖漂移。
 */
export function ensureMxcSdk(source, frontendRoot, platform = process.platform) {
  const sdkDirectory = path.join(source, ...RUNTIME_LAYOUT.mxcSdk.split('/'));
  if (fs.existsSync(path.join(sdkDirectory, 'package.json'))) {
    console.log(`复用随包 MXC SDK: directory=${sdkDirectory}`);
    return sdkDirectory;
  }

  // npm 把依赖装到 <prefix>/node_modules，因此 prefix 取 mxc 子目录（见 RUNTIME_LAYOUT 说明）。
  const prefix = path.join(source, RUNTIME_LAYOUT.mxc);
  fs.mkdirSync(prefix, { recursive: true });
  const manifest = path.join(frontendRoot, 'vendor', 'mxc-dev');
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(manifest, name);
    if (!fs.existsSync(file)) throw new Error(`缺少 MXC 依赖清单: ${file}`);
    fs.copyFileSync(file, path.join(prefix, name));
  }
  const node = nodeExecutableIn(source, platform);
  const npmCli = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) throw new Error(`随包 Node 缺少 npm，无法准备 MXC SDK: ${npmCli}`);

  const env = { ...process.env, PATH: path.dirname(node) + path.delimiter + (process.env.PATH ?? '') };
  // npm 11 会把配置文件策略重复导出后又当成非法命令行策略；子进程直接读取原配置文件。
  for (const key of Object.keys(env)) {
    if (/^npm_config_allow[_-]scripts$/i.test(key)) delete env[key];
  }
  console.log(`安装随包 MXC SDK: node=${node}, prefix=${prefix}`);
  const result = spawnSync(node, [npmCli, 'ci', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund'],
    { stdio: 'inherit', env, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`MXC SDK 安装失败: status=${result.status}, signal=${result.signal}, error=${result.error?.message ?? ''}`);
  if (!fs.existsSync(path.join(sdkDirectory, 'package.json'))) throw new Error('MXC SDK 安装后仍缺失');
  return sdkDirectory;
}

/** 运行目录最终采用的部署说明：包内相对路径，由启动器按安装目录解析。 */
export function deploymentDescriptor(platform = process.platform) {
  return {
    schemaVersion: 1,
    backend: platform === 'win32' ? 'processcontainer' : 'bubblewrap',
    sdkVersion: SUPPORTED_SDK_VERSION,
    nodeExecutable: nodeRelativePath(platform),
    sdkDirectory: RUNTIME_LAYOUT.mxcSdk,
  };
}

/** 校验打包产物：部署说明合法且随包组件齐全。beforePack 复用这一处，避免快速构建静默漏包。 */
export function verifyRuntime(directory, platform = process.platform, options = {}) {
  const file = path.join(directory, 'mxc-deployment.json');
  if (!fs.existsSync(file)) throw new Error(`缺少 MXC 部署说明: ${file}`);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const backend = platform === 'win32' ? 'processcontainer' : 'bubblewrap';
  if (value.schemaVersion !== 1 || value.backend !== backend || value.sdkVersion !== SUPPORTED_SDK_VERSION
    || 'distribution' in value) {
    throw new Error('MXC 部署说明的版本或后端不正确');
  }
  if (!['linux', 'win32'].includes(platform)) throw new Error('当前平台尚未支持 MXC');
  for (const name of ['nodeExecutable', 'sdkDirectory']) assertPackagedPath(value[name], name);

  const missing = missingEntries(directory, requiredEntries(platform));
  if (missing.length > 0) throw new Error(`随包运行资源缺失，缺少 ${describe(missing)}`);

  assertNodeVersion(options.nodeVersion ?? probeNodeVersion(nodeExecutableIn(directory, platform)), platform);
  return value;
}

/**
 * 把发行包目录整棵暂存到 `build/runtime`，并写入相对路径的部署说明。
 * 先校验源目录再清理目标目录，校验失败不会破坏上一次的有效产物。
 */
export function buildSandboxRuntime(frontendRoot, sourceDirectory, options = {}) {
  const platform = options.platform ?? process.platform;
  const source = path.resolve(sourceDirectory ?? process.env[RUNTIME_SOURCE_ENV] ?? runtimeSourceDirectory(frontendRoot, platform));
  console.log(`校验随包运行资源: source=${source}, hostNode=${process.version}`);
  verifySource(source, platform, options);
  ensureMxcSdk(source, frontendRoot, platform);

  const buildRoot = path.resolve(frontendRoot, 'build');
  const destination = path.join(buildRoot, 'runtime');
  fs.mkdirSync(buildRoot, { recursive: true });
  const relative = path.relative(fs.realpathSync(buildRoot), fs.realpathSync(source));
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('运行资源源目录不能位于 build 内');

  if (fs.existsSync(destination)) {
    const existing = fs.realpathSync(destination);
    if (path.dirname(existing) !== fs.realpathSync(buildRoot)) throw new Error('运行资源清理路径超出 build');
    fs.rmSync(existing, { recursive: true, force: true });
  }
  fs.mkdirSync(destination);
  console.log(`暂存随包运行资源: destination=${destination}`);

  // 暂存清单来自 node/srt/git 的安装过程，不属于随包资源。
  const transient = new Set(['package.json', 'package-lock.json', 'mxc-deployment.json']);
  for (const entry of fs.readdirSync(source)) {
    if (transient.has(entry)) continue;
    console.log(`复制随包运行组件: name=${entry}`);
    // filter 让 Node 绕过遇到文件系统错误会崩溃的原生复制路径（nodejs/node#63970）。
    fs.cpSync(path.join(source, entry), path.join(destination, entry),
      { recursive: true, force: true, filter: () => true });
    console.log(`复制随包运行组件完成: name=${entry}`);
  }
  fs.writeFileSync(path.join(destination, 'mxc-deployment.json'),
    JSON.stringify(deploymentDescriptor(platform), null, 2) + '\n');
  verifyRuntime(destination, platform, options);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = process.argv.slice(2).find(arg => arg.startsWith('--source='))?.slice(9);
    console.log(`随包运行资源已暂存: ${buildSandboxRuntime(frontendRoot, source)}`);
  } catch (error) {
    // Windows 子进程退出前同步写出异常，避免管道缓冲丢失构建失败原因。
    fs.writeSync(2, `${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
