import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const java = path.resolve(argument('java', path.join(frontend, 'build/backend/runtime/bin', process.platform === 'win32' ? 'javaw.exe' : 'java')));
const jar = path.resolve(argument('jar', path.join(frontend, 'build/backend/app.jar')));
const state = path.resolve(argument('state', undefined) ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-startup-')));
const timeout = Number(argument('timeout-ms', '90000'));
if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('启动验证时限必须为正数');

for (const file of [java, jar]) {
  if (!fs.existsSync(file)) throw new Error(`缺少启动验证产物: ${file}`);
}
fs.mkdirSync(state, { recursive: true });
const listener = net.createServer();
await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));

// 独立用户目录与配置，防止验证进程打开真实数据库或连接用户配置的 MCP。
const args = ['-Dfile.encoding=UTF-8', `-Duser.home=${state}`, '-jar', jar, `--server.port=${port}`,
  '--logging.level.org.springframework.boot.availability.ApplicationAvailabilityBean=DEBUG',
  '--lingxi.skill.dir=', `--lingxi.data.dir=${path.join(state, 'data')}`,
  `--lingxi.sandbox.application-directory=${path.dirname(frontend)}`,
  `--lingxi.sandbox.state-directory=${path.join(state, 'sandbox')}`,
  `--lingxi.log.dir=${path.join(state, 'logs')}`];
for (const config of ['user-configs', 'mcp', 'model', 'provider', 'personalization']) {
  args.push(`--lingxi.config.${config}.path=${path.join(state, `${config}.json`)}`);
}
args.push(`--lingxi.config.sandbox-security.directory=${path.join(state, 'security')}`);
const log = fs.createWriteStream(path.join(state, 'startup.log'));
const child = spawn(java, args, { cwd: state, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let tail = '';
let exited = false;
let failure;
const closed = new Promise(resolve => child.once('close', resolve));
for (const stream of [child.stdout, child.stderr]) {
  stream.pipe(log, { end: false });
  stream.on('data', chunk => { tail = (tail + chunk.toString('utf8')).slice(-24000); });
}
child.once('error', error => { failure = error; });
child.once('exit', (code, signal) => {
  exited = true;
  failure = new Error(`后端验证进程已退出: code=${code}, signal=${signal}`);
});

try {
  const deadline = Date.now() + timeout;
  let ready = false;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    // 端口与 Started 日志可能先于启动任务完成，必须等 Spring 就绪并验证真实业务接口。
    if (/ReadinessState.*ACCEPTING_TRAFFIC/.test(tail)) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/config/current`, { signal: AbortSignal.timeout(2000) });
        const body = await response.json();
        if (response.ok && body.code === 1 && Object.hasOwn(body, 'data')) { ready = true; break; }
      } catch { /* 等待业务接口就绪。 */ }
    }
    await delay(200);
  }
  if (!ready) throw new Error(`后端启动验证超时: timeout=${timeout}ms`);
  console.log(`打包后端启动通过: port=${port}, log=${path.join(state, 'startup.log')}`);
} catch (error) {
  console.error(tail);
  console.error(`启动日志: ${path.join(state, 'startup.log')}`);
  process.exitCode = 1;
  console.error(error.message);
} finally {
  if (!exited && child.pid) {
    if (process.platform === 'win32') {
      await new Promise(resolve => execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, resolve));
    } else child.kill('SIGTERM');
    await closed;
  }
  log.end();
}
