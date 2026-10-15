import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 描述目标 Linux 运行资源，不能把 Windows npm 原生模块当作 WSL SDK。 */
export function verifyRuntime(directory, platform = process.platform) {
  const file = path.join(directory, 'mxc-deployment.json');
  if (!fs.existsSync(file)) throw new Error(`缺少 MXC 部署说明: ${file}`);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.schemaVersion !== 1 || value.backend !== 'bubblewrap' || value.sdkVersion !== '1.0.0') {
    throw new Error('MXC 部署说明的版本或后端不正确');
  }
  if (!['linux', 'win32'].includes(platform)) throw new Error('当前平台尚未支持 MXC');
  for (const name of ['nodeExecutable', 'sdkDirectory']) {
    if (typeof value[name] !== 'string' || !value[name].startsWith('/') || /[\\\r\n\0]/.test(value[name])) {
      throw new Error(`MXC ${name} 必须是 Linux 绝对路径`);
    }
  }
  if (platform === 'win32' && !/^[A-Za-z0-9_.-]+$/.test(value.distribution ?? '')) throw new Error('Windows MXC 需要明确的 WSL 发行版');
  return value;
}

/** 只暂存部署说明；目标机器上的依赖就绪由后端真实检查确认。 */
export function buildSandboxRuntime(frontendRoot, sourceDirectory, options = {}) {
  const source = path.resolve(sourceDirectory ?? path.join(frontendRoot, 'vendor', 'mxc'));
  const metadata = verifyRuntime(source, options.platform ?? process.platform);
  const buildRoot = path.resolve(frontendRoot, 'build');
  const destination = path.join(buildRoot, 'runtime');
  fs.mkdirSync(buildRoot, { recursive: true });
  const relative = path.relative(fs.realpathSync(buildRoot), fs.realpathSync(source));
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('部署说明源目录不能位于 build 内');
  if (fs.existsSync(destination)) {
    const existing = fs.realpathSync(destination);
    if (path.dirname(existing) !== fs.realpathSync(buildRoot)) throw new Error('运行资源清理路径超出 build');
    fs.rmSync(existing, { recursive: true, force: true });
  }
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'mxc-deployment.json'), JSON.stringify(metadata, null, 2) + '\n');
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const source = process.argv.slice(2).find(arg => arg.startsWith('--source='))?.slice(9) ?? process.env.LINGXI_RUNTIME_SOURCE;
    console.log(`MXC 部署说明已准备: ${buildSandboxRuntime(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), source)}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
