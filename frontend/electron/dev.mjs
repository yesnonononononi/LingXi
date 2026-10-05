import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';

console.log('[Electron Dev] 启动 Vite 开发服务器...');
const viteProcess = spawn(npxCmd, ['vite'], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  shell: true,
});

function waitForVite(url, maxAttempts = 40) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      const req = http.get(url, (res) => {
        resolve();
      });
      req.on('error', () => {
        if (attempts >= maxAttempts) {
          reject(new Error('等待 Vite 启动超时 (http://localhost:5174)'));
        } else {
          setTimeout(check, 400);
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

  const electronProcess = spawn(npxCmd, ['electron', '.', '--dev'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ELECTRON_URL: 'http://localhost:5174',
    },
  });

  electronProcess.on('close', (code) => {
    console.log(`[Electron Dev] Electron 客户端已退出 (代码: ${code})`);
    viteProcess.kill();
    process.exit(code || 0);
  });

  viteProcess.on('close', (code) => {
    electronProcess.kill();
    process.exit(code || 0);
  });
} catch (err) {
  console.error('[Electron Dev] 启动失败:', err);
  viteProcess.kill();
  process.exit(1);
}
