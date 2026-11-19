import {spawn} from 'child_process';
import http from 'http';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, '..');
const viteBin = path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');
const electronCli = path.join(frontendDir, 'node_modules', 'electron', 'cli.js');

console.log('[Electron Dev] 启动 Vite 开发服务器...');
const viteProcess = spawn(process.execPath, [viteBin], {
  cwd: frontendDir,
  stdio: 'inherit',
});

let viteExitError = null;
viteProcess.on('exit', (code, signal) => {
  if (code !== 0 && code !== null) {
    viteExitError = new Error(`Vite 开发服务器提前退出 (code=${code})`);
  } else if (signal) {
    viteExitError = new Error(`Vite 开发服务器被终止 (signal=${signal})`);
  }
});

function waitForVite(url, maxAttempts = 120) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (viteExitError) {
        reject(viteExitError);
        return;
      }
      attempts++;
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.setTimeout(1000, () => {
        req.destroy(new Error('timeout'));
      });
      req.on('error', () => {
        if (viteExitError) {
          reject(viteExitError);
        } else if (attempts >= maxAttempts) {
          reject(new Error(`等待 Vite 启动超时 (${url})`));
        } else {
          setTimeout(check, 500);
        }
      });
      req.end();
    };
    check();
  });
}

try {
  await waitForVite('http://localhost:5174');
  console.log('[Electron Dev] Vite 服务器就绪，正在启动 Electron 桌面客户端...');

  const electronProcess = spawn(process.execPath, [electronCli, '.', '--dev'], {
    cwd: frontendDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ELECTRON_URL: 'http://localhost:5174',
    },
  });

  const cleanup = () => {
    if (!viteProcess.killed) viteProcess.kill();
    if (!electronProcess.killed) electronProcess.kill();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  electronProcess.on('close', (code) => {
    console.log(`[Electron Dev] Electron 客户端已退出 (代码: ${code})`);
    if (!viteProcess.killed) viteProcess.kill();
    process.exit(code || 0);
  });

  viteProcess.on('close', (code) => {
    if (!electronProcess.killed) electronProcess.kill();
    process.exit(code || 0);
  });
} catch (err) {
  console.error('[Electron Dev] 启动失败:', err);
  if (!viteProcess.killed) viteProcess.kill();
  process.exit(1);
}
