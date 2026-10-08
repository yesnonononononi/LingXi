#!/usr/bin/env node
/**
 * 生成桌面端要随包分发的后端运行产物：精简 JRE + Spring Boot fat jar。
 *
 * 产物落到 frontend/build/backend/：
 *   build/backend/app.jar          ← 后端可执行 jar
 *   build/backend/runtime/         ← jlink 产出的精简 JRE（含 bin/javaw.exe）
 * electron-builder 通过 extraResources 把它整体拷进安装包的 resources/backend。
 *
 * 用法：
 *   node scripts/build-backend-runtime.mjs                # 打 jar + 生成 JRE
 *   node scripts/build-backend-runtime.mjs --skip-jar     # 复用已有 target/*.jar
 *   node scripts/build-backend-runtime.mjs --jar=<path>   # 指定现成 jar
 *   node scripts/build-backend-runtime.mjs --all-modules  # 全模块 JRE（体积大但绝对不缺模块）
 *   node scripts/build-backend-runtime.mjs --offline      # maven 加 -o
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendRoot, '..');
const stageDir = path.join(frontendRoot, 'build', 'backend');
const runtimeDir = path.join(stageDir, 'runtime');
const isWin = process.platform === 'win32';

const argv = process.argv.slice(2);
const skipJar = argv.includes('--skip-jar');
const allModules = argv.includes('--all-modules');
const offline = argv.includes('--offline');
const explicitJar = argv.find((a) => a.startsWith('--jar='))?.slice('--jar='.length);

/**
 * jlink 模块清单：按 Spring Boot 3 + Tomcat + MyBatis-Plus + Druid + MySQL 连接器 + Jackson 的实际依赖裁剪。
 * 每一条都别随手删：
 *   java.desktop    → Spring 的 BeanWrapper 用 java.beans.Introspector，缺了直接起不来
 *   java.instrument → Spring 的 Instrumentation 支持
 *   jdk.unsupported → sun.misc.Unsafe，Netty / Jackson / Druid 都靠它
 *   jdk.crypto.ec   → TLS ECDHE 套件，调 DeepSeek / OpenAI 这类 HTTPS 接口必需
 *   jdk.charsets    → GBK 等非 UTF-8 字符集
 *   jdk.localedata  → 中文 locale 的日期 / 数字格式
 * 真缺模块时的症状是运行期 NoClassDefFoundError，届时用 --all-modules 兜底。
 */
const MODULES = [
  'java.base',
  'java.logging',
  'java.naming',
  'java.management',
  'java.instrument',
  'java.sql',
  'java.desktop',
  'java.xml',
  'java.net.http',
  'java.security.jgss',
  'java.security.sasl',
  'jdk.unsupported',
  'jdk.crypto.ec',
  'jdk.zipfs',
  'jdk.charsets',
  'jdk.localedata',
  'jdk.management',
  'jdk.naming.dns',
];

function fail(message) {
  console.error(`\n[backend-runtime] 失败: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: isWin && /\.cmd$/i.test(command),
    ...options,
  });
  if (result.error) fail(`${command} 执行失败: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} 退出码 ${result.status}`);
}

function dirSizeMb(dir) {
  let total = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += fs.statSync(full).size;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return (total / 1024 / 1024).toFixed(1);
}

// ---------------------------------------------------------------- 0. 定位 JDK

/** jlink 只存在于 JDK（JRE 没有 jmods），所以必须先拿到一个真 JDK */
function resolveJdk() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);
  candidates.push('D:\\languages\\jdk\\jdk-21');

  for (const home of candidates) {
    const jlink = path.join(home, 'bin', isWin ? 'jlink.exe' : 'jlink');
    if (fs.existsSync(jlink)) return { home, jlink };
  }
  return { home: null, jlink: 'jlink' };
}

const jdk = resolveJdk();

/**
 * 定位 maven。
 * 本机 `./mvnw` 是坏的（`.mvn/wrapper` 只有 properties、缺 jar），
 * 而 `mvn` 经 Git Bash 会把 POSIX 路径喂给 Windows java，报
 * `ClassNotFoundException: org.codehaus.plexus.classworlds.launcher.Launcher`。
 * 因此退路是绕开 shell、自己拼 java 命令行直接起 classworlds Launcher。
 */
function resolveMaven() {
  const wrapperJar = path.join(repoRoot, '.mvn', 'wrapper', 'maven-wrapper.jar');
  if (fs.existsSync(wrapperJar)) {
    return { label: 'mvnw', command: path.join(repoRoot, isWin ? 'mvnw.cmd' : 'mvnw'), prefix: [] };
  }

  const homes = [
    process.env.MAVEN_HOME,
    process.env.M2_HOME,
    process.env.MAVEN_USER_HOME,
    'D:\\languages\\mvn',
  ].filter(Boolean);

  for (const home of homes) {
    const bootDir = path.join(home, 'boot');
    const m2Conf = path.join(home, 'bin', 'm2.conf');
    if (!fs.existsSync(bootDir) || !fs.existsSync(m2Conf)) continue;
    const classworlds = fs
      .readdirSync(bootDir)
      .find((name) => /^plexus-classworlds-.*\.jar$/.test(name));
    if (!classworlds) continue;
    const javaExe = jdk.home
      ? path.join(jdk.home, 'bin', isWin ? 'java.exe' : 'java')
      : 'java';
    return {
      label: `classworlds Launcher (${home})`,
      command: javaExe,
      prefix: [
        '-classpath',
        path.join(bootDir, classworlds),
        `-Dclassworlds.conf=${m2Conf}`,
        `-Dmaven.home=${home}`,
        `-Dmaven.multiModuleProjectDirectory=${repoRoot}`,
        'org.codehaus.plexus.classworlds.launcher.Launcher',
      ],
    };
  }
  return null;
}

// ---------------------------------------------------------------- 1. 打后端 jar

fs.mkdirSync(stageDir, { recursive: true });

function findExistingJar() {
  const targetDir = path.join(repoRoot, 'target');
  if (!fs.existsSync(targetDir)) return null;
  const jars = fs
    .readdirSync(targetDir)
    .filter((name) => name.endsWith('.jar') && !name.endsWith('.original'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(targetDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return jars.length > 0 ? path.join(targetDir, jars[0].name) : null;
}

let jarPath = explicitJar ? path.resolve(repoRoot, explicitJar) : null;

if (!jarPath && !skipJar) {
  const maven = resolveMaven();
  if (!maven) {
    fail(
      '找不到可用的 maven（./mvnw 缺 wrapper jar，也没找到 classworlds Launcher）。\n' +
        '请自行 `mvn -DskipTests package` 后加 --skip-jar 重跑，或用 --jar=<path> 指定 jar。'
    );
  }
  console.log(`[backend-runtime] 1/3 打包后端 jar（${maven.label}）...`);
  const mvnArgs = [...maven.prefix, ...(offline ? ['-o'] : []), '-DskipTests', 'package'];
  run(maven.command, mvnArgs, { cwd: repoRoot });
} else {
  console.log('[backend-runtime] 1/3 跳过 maven，复用已有 jar');
}

if (!jarPath) jarPath = findExistingJar();
if (!jarPath || !fs.existsSync(jarPath)) {
  fail(`未找到可用 jar（${path.join(repoRoot, 'target')} 下没有非 .original 的 .jar）。`);
}

// 先删旧 app.jar 再复制：copyFileSync 本身就能覆盖，但万一复制中途失败（源损坏、磁盘满），
// 覆盖写会留下「上一个版本的完整内容」且毫无报错 —— 结果是一个装着旧后端的安装包。
// 先删让这种失败变成「app.jar 不存在」的显性错误，而不是静默过期。
const stagedJar = path.join(stageDir, 'app.jar');
if (fs.existsSync(stagedJar)) {
  fs.rmSync(stagedJar, { force: true });
}
fs.copyFileSync(jarPath, stagedJar);
console.log(`[backend-runtime]      ${path.basename(jarPath)} → build/backend/app.jar`);

// ---------------------------------------------------------------- 2. jlink 精简 JRE

console.log('[backend-runtime] 2/3 生成精简 JRE (jlink)...');
// jlink 要求输出目录不存在或为空，先清干净，避免上次残留的旧模块混进来
if (fs.existsSync(runtimeDir)) {
  fs.rmSync(runtimeDir, { recursive: true, force: true });
}

const jlinkArgs = [
  '--add-modules',
  allModules ? 'ALL-MODULE-PATH' : MODULES.join(','),
  '--strip-debug',
  '--no-header-files',
  '--no-man-pages',
  '--compress=zip-6',
  '--output',
  runtimeDir,
];
if (jdk.home) jlinkArgs.push('--module-path', path.join(jdk.home, 'jmods'));

console.log(`[backend-runtime]      JDK: ${jdk.home || '(PATH 上的 jlink)'}`);
console.log(`[backend-runtime]      模块: ${allModules ? 'ALL-MODULE-PATH' : MODULES.join(', ')}`);
run(jdk.jlink, jlinkArgs);

// ---------------------------------------------------------------- 3. 自检

console.log('[backend-runtime] 3/3 自检内置 JRE...');
const javawExe = path.join(runtimeDir, 'bin', isWin ? 'javaw.exe' : 'java');
const javaExe = path.join(runtimeDir, 'bin', isWin ? 'java.exe' : 'java');
if (!fs.existsSync(javawExe)) fail(`jlink 产物缺少 ${javawExe}`);
run(javaExe, ['-version']);

console.log('\n[backend-runtime] 完成');
console.log(`  app.jar    ${(fs.statSync(stagedJar).size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  runtime/   ${dirSizeMb(runtimeDir)} MB`);
console.log(`  输出目录   ${stageDir}`);
// 打印来源与时间戳：安装包里的后端到底是哪一版，只能靠这两行核对，别让「打了旧 jar」变成事后猜谜。
// 时间取上游 jarPath 而非 app.jar：两者在 copyFileSync 下其实都会保留源 mtime（实测 Windows 亦然），
// 读 jarPath 的好处是语义直白 —— 这里报的就是「被复制进来的那份东西有多旧」。
console.log(`  jar 来源   ${path.relative(repoRoot, jarPath)}`);
console.log(`  jar 时间   ${fs.statSync(jarPath).mtime.toLocaleString('zh-CN')}`);
