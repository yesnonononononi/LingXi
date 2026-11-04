import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export function resolveMaven(repoRoot) {
  const isWin = process.platform === 'win32';
  const wrapper = path.join(repoRoot, isWin ? 'mvnw.cmd' : 'mvnw');
  const properties = path.join(repoRoot, '.mvn/wrapper/maven-wrapper.properties');
  const scriptOnly = fs.existsSync(properties) && /^\s*distributionType\s*=\s*only-script\s*$/m.test(fs.readFileSync(properties, 'utf8'));
  if (fs.existsSync(wrapper) && (scriptOnly || fs.existsSync(path.join(repoRoot, '.mvn/wrapper/maven-wrapper.jar')))) {
    return { label: 'mvnw', command: wrapper, prefix: [] };
  }
  for (const home of [process.env.MAVEN_HOME, process.env.M2_HOME, 'D:/languages/mvn'].filter(Boolean)) {
    const boot = path.join(home, 'boot');
    const config = path.join(home, 'bin/m2.conf');
    if (!fs.existsSync(boot) || !fs.existsSync(config)) continue;
    const classworlds = fs.readdirSync(boot).find(name => /^plexus-classworlds-.*\.jar$/.test(name));
    if (!classworlds) continue;
    const javaHome = process.env.JAVA_HOME || (isWin ? 'D:/languages/jdk/jdk-21' : null);
    return {
      label: `Maven (${home})`,
      command: javaHome ? path.join(javaHome, 'bin', isWin ? 'java.exe' : 'java') : 'java',
      prefix: ['-classpath', path.join(boot, classworlds), `-Dclassworlds.conf=${config}`, `-Dmaven.home=${home}`, `-Dmaven.multiModuleProjectDirectory=${repoRoot}`, 'org.codehaus.plexus.classworlds.launcher.Launcher'],
    };
  }
  throw new Error('找不到 Maven，请检查仓库 wrapper 或 MAVEN_HOME / M2_HOME');
}

/**
 * 从 mvn 参数里取出本地仓库位置（`-Dmaven.repo.local=<path>`）。
 *
 * <p><b>为什么要单独解析它：</b>仓库位置目前只以 <b>CLI 参数</b> 形式传给 mvn
 * （`build-backend.mjs` 与 `framework-deps.mjs` 都传 `-Dmaven.repo.local=<repository>`）。
 * CLI 参数只对 Maven 自身可见，<b>不会</b>传给 surefire fork 及其再拉起的子进程；而那些子进程
 * （`scripts/Initialize-Development.ps1` → `scripts/Migrate-SqliteToH2.ps1`）需要靠
 * `MAVEN_REPO_LOCAL` 环境变量或 `~/.m2` 去找 h2 / sqlite-jdbc jar。CI 上 `~/.m2/repository`
 * 是空的（依赖只落在隔离仓库 `.run/maven/<hash>`），于是迁移脚本找不到 h2 → 测试稳定红，
 * 而本地因为 `~/.m2` 或 Maven 安装目录的 `conf/settings.xml` 里有 jar 所以永远绿。</p>
 *
 * @param {string[]} args mvn 参数（形如 `['-B', '-ntp', '-Dmaven.repo.local=D:/x/repo', 'test']`）
 * @returns {string} 仓库路径；没有该参数时返回空串（交给 mvn 自己的默认值）
 */
export function localRepositoryOf(args) {
  if (!Array.isArray(args)) return '';
  const prefix = '-Dmaven.repo.local=';
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg.startsWith(prefix)) continue;
    const value = arg.slice(prefix.length).trim();
    if (value.length > 0) return value;
  }
  return '';
}

/**
 * 跑 Maven，并把"隔离仓库位置"沿环境变量传给整条子进程链。
 *
 * <p><b>为什么必须在 env 里再传一次：</b>见 {@link localRepositoryOf} 的说明。这里把
 * `-Dmaven.repo.local` 的值写成 `MAVEN_REPO_LOCAL`，surefire fork 与它拉起的 PowerShell
 * 子进程都会继承，于是 `Migrate-SqliteToH2.ps1` 的既有解析顺序
 * （`-LocalRepository` 参数 → `MAVEN_REPO_LOCAL` → `settings.xml` → `~/.m2/repository`）
 * 能直接命中构建真正使用的那个隔离仓库 —— <b>不需要改脚本的解析语义</b>，
 * 也保留了"调用方显式给 `-H2Jar` / `-LocalRepository` 优先于环境变量"这条既有优先级。</p>
 *
 * @param {{command: string, prefix: string[], label?: string}} maven {@link resolveMaven} 的返回值
 * @param {string[]} args 传给 mvn 的参数
 * @param {string} repoRoot 仓库根目录（同时作为 mvn 的工作目录）
 * @param {{repository?: string}} [options] 额外选项；`repository` 省略时从 `args` 里解析
 * @returns {void}
 * @throws {TypeError} 参数形状不对时抛出
 * @throws {Error} Maven 启动失败或退出码非 0 时抛出
 */
export function runMaven(maven, args, repoRoot, options = {}) {
  if (maven === null || typeof maven !== 'object' || typeof maven.command !== 'string') {
    throw new TypeError('runMaven: maven 必须是 resolveMaven() 的返回值（含 command 字段）');
  }
  if (!Array.isArray(args)) throw new TypeError('runMaven: args 必须是数组');
  if (typeof repoRoot !== 'string' || repoRoot.trim().length === 0) {
    throw new TypeError('runMaven: repoRoot 必须是非空字符串');
  }
  const explicit = options !== null && typeof options === 'object' && typeof options.repository === 'string'
    ? options.repository.trim()
    : '';
  const declared = explicit.length > 0 ? explicit : localRepositoryOf(args);
  const env = { ...process.env, MAVEN_USER_HOME: path.join(repoRoot, '.run/maven-wrapper') };
  if (declared.length > 0) {
    // 相对路径按 mvn 的工作目录（repoRoot）解析，保证子进程拿到的是绝对路径
    env.MAVEN_REPO_LOCAL = path.resolve(repoRoot, declared);
  }
  const result = spawnSync(maven.command, [...maven.prefix, ...args], {
    cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' && /\.cmd$/i.test(maven.command),
    env,
  });
  if (result.error) throw new Error(`Maven 启动失败: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Maven 退出码 ${result.status}`);
}
