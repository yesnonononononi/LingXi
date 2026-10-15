import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 按 `vendor/runtime.lock.json` 的固定版本准备随包沙箱运行资源。
 *
 * 为什么需要这个脚本：`frontend/vendor/runtime/` 不入 Git（见 frontend/.gitignore），
 * 而 CI 的干净 runner 上没有这棵目录 —— 没有它 `sandbox:runtime` 只能报「缺少运行资源目录」，
 * 直接卡住发版。这里把「发行包从哪来」变成可复现的一步：版本号在锁文件里，来源是公开的固定 URL。
 *
 * Node 与 Git 是完整发行包（保留 DLL、工具与许可证）；SRT 与 MXC SDK 用 npm 按锁安装。
 * MXC SDK 不在这里装：`build-sandbox-runtime.mjs` 会按 vendor/mxc-dev 的锁补上。
 */

export const RUNTIME_LOCK_FILE = 'vendor/runtime.lock.json';
export const PORTABLE_GIT_TAG_SUFFIX = '.windows.1';

/** 读取固定版本。缺条目或版本号为空即报错，避免静默用一个漂移的版本出包。 */
export function readRuntimeLock(frontendRoot, platform = process.platform, arch = process.arch) {
  const file = path.join(frontendRoot, RUNTIME_LOCK_FILE);
  if (!fs.existsSync(file)) throw new Error(`缺少运行资源锁文件: ${file}`);
  const key = `${platform}-${arch}`;
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'))[key];
  if (!entry) throw new Error(`运行资源锁文件缺少 ${key} 条目: ${file}`);
  for (const name of ['node', 'portableGit', 'srt']) {
    if (typeof entry[name] !== 'string' || entry[name].length === 0) {
      throw new Error(`运行资源锁文件的 ${name} 必须是非空版本号`);
    }
  }
  return entry;
}

/** 纯函数：把版本号翻成下载计划，便于单测。 */
export function runtimePlan(entry, arch = process.arch) {
  const nodeDist = `node-v${entry.node}-${arch === 'x64' ? 'win-x64' : `win-${arch}`}`;
  const gitTag = `v${entry.portableGit}${PORTABLE_GIT_TAG_SUFFIX}`;
  return {
    node: {
      url: `https://nodejs.org/dist/v${entry.node}/${nodeDist}.zip`,
      archive: `${nodeDist}.zip`,
      extractedRoot: nodeDist,
    },
    portableGit: {
      url: `https://github.com/git-for-windows/git/releases/download/${gitTag}/PortableGit-${entry.portableGit}-64-bit.7z.exe`,
      archive: `PortableGit-${entry.portableGit}-64-bit.7z.exe`,
    },
    srt: { version: entry.srt },
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw new Error(`${command} 执行失败: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status}`);
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status} ${response.statusText}: ${url}`);
  await fs.promises.writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

/** 解压 zip：Windows 用 PowerShell（保证可用），其它平台优先 unzip/tar。 */
function extractZip(archive, destination, platform = process.platform) {
  fs.mkdirSync(destination, { recursive: true });
  if (platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`]);
    return;
  }
  const unzip = spawnSync('unzip', ['-q', '-o', archive, '-d', destination], { stdio: 'inherit' });
  if (unzip.error) run('tar', ['-xf', archive, '-C', destination]);
}

function moveDirectory(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
}

/**
 * 准备 `frontend/vendor/runtime/<platform>-<arch>/`。
 * 已存在的组件默认保留（`--force` 才重下），便于离线补装缺失项。
 */
export async function fetchSandboxRuntime(frontendRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`尚未提供 ${platform}-${arch} 的随包运行资源来源；请在 vendor/runtime/${platform}-${arch}/ 手工放入 node 与 srt（Linux 走 Bubblewrap + 系统 bash）`);
  }
  const entry = readRuntimeLock(frontendRoot, platform, arch);
  const plan = runtimePlan(entry, arch);
  const target = path.join(frontendRoot, 'vendor', 'runtime', `${platform}-${arch}`);
  const staging = path.join(frontendRoot, 'build', 'runtime-fetch');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(path.join(target, 'mxc'), { recursive: true });

  const nodeExecutable = path.join(target, 'node', platform === 'win32' ? 'node.exe' : 'node');
  if (options.force || !fs.existsSync(nodeExecutable)) {
    console.log(`[sandbox:fetch] 下载 Node v${entry.node}`);
    const archive = path.join(staging, plan.node.archive);
    await download(plan.node.url, archive);
    extractZip(archive, staging, platform);
    moveDirectory(path.join(staging, plan.node.extractedRoot), path.join(target, 'node'));
    console.log(`[sandbox:fetch]     Node → vendor/runtime/${platform}-${arch}/node`);
  } else {
    console.log('[sandbox:fetch] Node 已存在，跳过');
  }

  const bashExecutable = path.join(target, 'git', 'bin', 'bash.exe');
  if (options.force || !fs.existsSync(bashExecutable)) {
    console.log(`[sandbox:fetch] 下载 PortableGit ${entry.portableGit}`);
    const archive = path.join(staging, plan.portableGit.archive);
    await download(plan.portableGit.url, archive);
    // PortableGit 是 7-Zip 自解压包：直接带 -y -o 运行即可静默解出，无需另装 7z。
    run(archive, ['-y', `-o${path.join(target, 'git')}`], { cwd: staging });
    console.log(`[sandbox:fetch]     Git → vendor/runtime/${platform}-${arch}/git`);
  } else {
    console.log('[sandbox:fetch] PortableGit 已存在，跳过');
  }

  const node = path.join(target, 'node', platform === 'win32' ? 'node.exe' : 'node');
  const npmCli = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) throw new Error(`随包 Node 缺少 npm，无法准备 SRT: ${npmCli}`);
  const srtCli = path.join(target, 'srt', 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'cli.js');
  if (options.force || !fs.existsSync(srtCli)) {
    console.log(`[sandbox:fetch] 安装 SRT ${entry.srt}`);
    const prefix = path.join(target, 'srt');
    fs.mkdirSync(prefix, { recursive: true });
    const env = { ...process.env, PATH: path.dirname(node) + path.delimiter + (process.env.PATH ?? '') };
    for (const key of Object.keys(env)) {
      if (/^npm_config_allow[_-]scripts$/i.test(key)) delete env[key];
    }
    run(node, [npmCli, 'install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', '--save-exact',
      `@anthropic-ai/sandbox-runtime@${entry.srt}`], { env });
  } else {
    console.log('[sandbox:fetch] SRT 已存在，跳过');
  }

  fs.rmSync(staging, { recursive: true, force: true });
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const force = process.argv.includes('--force');
    const target = await fetchSandboxRuntime(frontendRoot, { force });
    const { verifySource } = await import('./build-sandbox-runtime.mjs');
    verifySource(target);
    console.log(`随包运行资源已就绪: ${target}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
