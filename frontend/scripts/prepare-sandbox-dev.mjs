import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 开发资源与旧目录并存，避免准备 SDK 时清空 Node、Git 等本机工具。 */
export function prepareDevelopmentRuntime(frontendRoot) {
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('开发沙箱只支持 Windows 和 Linux');
  const directory = path.resolve(frontendRoot, 'build/runtime');
  const node = path.join(directory, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  const source = fs.existsSync(node) ? node : process.execPath;
  const version = execFileSync(source, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!/^v(?:2[4-9]|[3-9]\d)\./.test(version)) throw new Error(`开发沙箱需要 Node 24 及以上，当前为 ${version}`);
  const npmCli = [process.env.npm_execpath,
    path.join(path.dirname(source), 'node_modules/npm/bin/npm-cli.js')].find(file => file && fs.existsSync(file));
  if (!npmCli) throw new Error('找不到 npm，请通过 npm run sandbox:dev 准备开发资源');
  fs.mkdirSync(path.dirname(node), { recursive: true });
  if (!fs.existsSync(node)) fs.copyFileSync(source, node);
  const manifest = path.join(frontendRoot, 'vendor/mxc-dev');
  for (const name of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(manifest, name), path.join(directory, name));
  }
  const installEnvironment = { ...process.env, PATH: path.dirname(node) + path.delimiter + (process.env.PATH ?? '') };
  // npm 11 将配置文件策略重复导出后又当成非法命令行策略；子进程直接读取原配置文件。
  for (const name of Object.keys(installEnvironment)) {
    if (/^npm_config_allow[_-]scripts$/i.test(name)) delete installEnvironment[name];
  }
  execFileSync(node, [npmCli, 'ci', '--prefix', directory, '--omit=dev', '--no-audit', '--no-fund'], {
    stdio: 'inherit', windowsHide: true,
    env: installEnvironment,
  });
  const sdkDirectory = path.join(directory, 'node_modules/@microsoft/mxc-sdk');
  // 仅加载原生库和查询宿主能力，不创建沙箱或探测项目目录。
  const check = `import {pathToFileURL} from 'node:url';
    const sdk = await import(pathToFileURL(process.argv[1] + '/dist/v1/index.js').href);
    const result = process.platform === 'win32' ? sdk.probe() : sdk.getAvailableBackends();
    console.log(JSON.stringify(result));
    if (process.platform === 'win32' ? result.tier !== 'base-container' || result.needsDaclAugmentation || result.error || result.warnings.length
      : !result.some(item => item.backend === 'bubblewrap')) process.exitCode = 1;`;
  execFileSync(node, ['--input-type=module', '-e', check, sdkDirectory], { stdio: 'inherit', windowsHide: true });
  const deployment = { schemaVersion: 1, backend: process.platform === 'win32' ? 'processcontainer' : 'bubblewrap',
    sdkVersion: '1.0.0', nodeExecutable: node, sdkDirectory };
  fs.writeFileSync(path.join(directory, 'mxc-deployment.json'), JSON.stringify(deployment, null, 2) + '\n');
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`开发沙箱资源已准备: ${prepareDevelopmentRuntime(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
