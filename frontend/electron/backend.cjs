'use strict';

/**
 * 后端（Spring Boot fat jar）的启动 / 就绪等待 / 关闭。
 *
 * 三条硬约束（都是 Windows 桌面端踩过的坑）：
 * 1. 必须用 javaw.exe 启动 —— 它是 GUI 子系统程序，不挂控制台，天然没有黑窗口；
 *    用 java.exe 就得靠 windowsHide 兜，一旦哪天 stdio 改成 inherit 黑窗口立刻回来。
 * 2. 「进程活着」不等于「服务可用」：JVM 起来到 Tomcat 监听端口之间有好几秒，
 *    就绪只能靠探测端口，不能靠 sleep 拍脑袋。
 * 3. Windows 上父进程退出不会带走子进程，必须显式杀，否则每次退出都残留一个孤儿 JVM 占着 8088。
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

/** 端口固定 8088：前端 utils/apiConfig.ts 的桌面端默认地址就是它，改这里必须同步改前端 */
const BACKEND_PORT = 8088;
/** 冷启动 = JVM + Spring 上下文 + 数据库连接池，给足 90s */
const READY_TIMEOUT_MS = 90000;
const READY_POLL_MS = 300;

let child = null;
let logStream = null;
let logFn = () => {};
/** 是否由本进程启动 —— 复用别人起的后端时退出不能去杀它 */
let ownsProcess = false;
let stopping = false;
/** 就绪后才置位：启动期的进程退出由就绪循环报错，不能再走 onCrash 弹第二次窗 */
let started = false;

/**
 * 解析产物位置。
 * 打包态：jar 与 JRE 都随 extraResources 落到 resources/backend 下；
 * 开发态：JRE 取 frontend/build/backend/，jar 取仓库根 target/。
 *
 * @param frontendRoot frontend 目录绝对路径（即 electron/ 的上一级）
 */
function resolveLayout(frontendRoot, isPackaged, resourcesPath) {
  const runtimeDir = isPackaged
    ? path.join(resourcesPath, 'backend', 'runtime')
    : path.join(frontendRoot, 'build', 'backend', 'runtime');
  return {
    runtimeDir,
    jar: isPackaged
      ? path.join(resourcesPath, 'backend', 'app.jar')
      : path.resolve(frontendRoot, '..', 'target', 'dp-0.0.1-SNAPSHOT.jar'),
    // 类 Unix 没有 javaw，只有 java；那边本来也不会弹控制台
    javaExe: path.join(runtimeDir, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java'),
  };
}

/** 探测端口是否已被监听（连上即视为有服务） */
function isPortOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execFileAsync(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, () => resolve());
  });
}

/**
 * 启动后端。
 *
 * @returns {Promise<{port:number, reused:boolean, skipped?:boolean}>}
 *   reused=true 表示 8088 上本来就有服务（IDE 里跑的后端，或上次残留），直接复用；
 *   skipped=true 表示开发态缺产物、按约定跳过（由开发者自己起后端）。
 */
async function start({ frontendRoot, isPackaged, resourcesPath, userDataDir, logPath, isDev, onCrash }) {
  logFn = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(`[Backend] ${msg}`);
    if (logStream) logStream.write(`${line}\n`);
  };

  const layout = resolveLayout(frontendRoot, isPackaged, resourcesPath);

  // 端口已占用：可能是用户在 IDE 里跑着后端，也可能是上次崩溃残留的孤儿 JVM。
  // 两种都直接复用 —— 既不会「端口占用」启动失败，也不会去杀不属于自己的进程。
  if (await isPortOpen(BACKEND_PORT)) {
    logFn(`端口 ${BACKEND_PORT} 已有服务，直接复用（退出时不会结束它）`);
    return { port: BACKEND_PORT, reused: true };
  }

  const missing = [];
  if (!fs.existsSync(layout.jar)) missing.push(`后端 jar: ${layout.jar}`);
  if (!fs.existsSync(layout.javaExe)) missing.push(`内置 JRE: ${layout.javaExe}`);
  if (missing.length > 0) {
    const detail = `缺少后端运行产物：\n  - ${missing.join('\n  - ')}\n请先执行 npm run backend:runtime 生成。`;
    // 开发态由开发者自己起后端（IDE），不该因为没打产物就挡住前端调试
    if (isDev) {
      logFn(`开发态跳过启动后端：${missing.join('; ')}`);
      return { port: BACKEND_PORT, reused: false, skipped: true };
    }
    throw new Error(detail);
  }

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // H2 库文件目录由后端按配置项 lingxi.data.dir 自行创建（缺省 ~/.lingxi/data），
  // Electron 不插手数据目录，这里只负责日志文件。
  logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const args = [
    '-Dfile.encoding=UTF-8',
    '-Duser.language=zh',
    '-Duser.country=CN',
    '-Xms128m',
    '-Xmx512m',
    '-jar',
    layout.jar,
    `--server.port=${BACKEND_PORT}`,
  ];
  // 数据库内置（H2 文件库，用户机器不需要装任何数据库）。
  // 传 LX_SPRING_PROFILE 环境变量可覆盖为其他 Spring profile（默认不传，走主配置）。
  if (process.env.LX_SPRING_PROFILE) {
    args.push(`--spring.profiles.active=${process.env.LX_SPRING_PROFILE}`);
  }

  logFn(`启动后端: ${layout.javaExe} ${args.join(' ')}`);
  child = spawn(layout.javaExe, args, {
    // cwd 必须是可写目录：application.yaml 的 `optional:file:.env` 按 cwd 解析，
    // 而装到 Program Files 后 jar 旁边不可写。用户把自己的 .env 放进这个目录即可。
    cwd: userDataDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, JAVA_HOME: layout.runtimeDir },
  });
  ownsProcess = true;

  // javaw 没有控制台，不重定向日志就彻底什么都看不到；出问题只能靠这个文件
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  child.on('error', (err) => logFn(`后端进程启动失败: ${err.message}`));
  child.on('exit', (code, signal) => {
    // 启动期的退出由下面的就绪循环负责报错，这里再弹一次就成双弹窗了
    if (stopping || !started) return;
    logFn(`后端进程意外退出: code=${code} signal=${signal}`);
    onCrash?.(code, signal);
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastLoggedSecond = -1;
  let ready = false;
  while (Date.now() < deadline) {
    if (await isPortOpen(BACKEND_PORT)) {
      ready = true;
      break;
    }
    // 进程都死了就别再等到超时，早点把日志路径给用户
    if (child && child.exitCode !== null) break;
    const elapsedSecond = Math.floor((Date.now() - (deadline - READY_TIMEOUT_MS)) / 1000);
    if (elapsedSecond >= 5 && elapsedSecond % 5 === 0 && elapsedSecond !== lastLoggedSecond) {
      lastLoggedSecond = elapsedSecond;
      logFn(`等待后端就绪… ${elapsedSecond}s`);
    }
    await sleep(READY_POLL_MS);
  }

  if (!ready) {
    throw new Error(
      `后端在 ${READY_TIMEOUT_MS / 1000}s 内未就绪（端口 ${BACKEND_PORT} 无响应）。\n后端日志: ${logPath}`
    );
  }

  logFn(`后端就绪: http://127.0.0.1:${BACKEND_PORT}`);
  started = true;
  return { port: BACKEND_PORT, reused: false };
}

/** 关闭后端；只杀自己启动的那个进程树 */
async function stop() {
  if (!child || !ownsProcess || stopping) {
    logStream?.end();
    return;
  }
  stopping = true;
  const pid = child.pid;
  if (process.platform === 'win32') {
    // /T 连子进程树一起收，/F 强制 —— Windows 没有 SIGTERM 语义，JVM 收不到优雅关闭信号
    await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F']);
  } else {
    child.kill('SIGTERM');
  }
  logFn(`后端已关闭: pid=${pid}`);
  logStream?.end();
  logStream = null;
  child = null;
  ownsProcess = false;
}

module.exports = { start, stop, BACKEND_PORT };
