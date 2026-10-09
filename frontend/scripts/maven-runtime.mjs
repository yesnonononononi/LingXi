import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

export function runMaven(maven, args, repoRoot) {
  const result = spawnSync(maven.command, [...maven.prefix, ...args], {
    cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' && /\.cmd$/i.test(maven.command),
    env: { ...process.env, MAVEN_USER_HOME: path.join(repoRoot, '.run/maven-wrapper') },
  });
  if (result.error) throw new Error(`Maven 启动失败: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Maven 退出码 ${result.status}`);
}
