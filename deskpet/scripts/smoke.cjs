// 冒烟验证：真实 Electron 渲染桌宠并截图，确认 SVG 没有画歪、表情切换生效。
// 用法：node_modules\.bin\electron scripts/smoke.cjs
// 截图输出到 .lingxi/tmp/（不进项目工作区）
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT_DIR = path.join(__dirname, '..', '..', '.lingxi', 'tmp');
const CASES = [
  { name: 'idle-normal', face: 'normal', action: 'idle' },
  { name: 'happy', face: 'happy', action: 'idle' },
  { name: 'angry', face: 'angry', action: 'idle' },
  { name: 'sleepy', face: 'sleepy', action: 'sleep' },
  { name: 'shy', face: 'shy', action: 'drag' },
  { name: 'excited', face: 'excited', action: 'idle' },
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 冒烟环境没有真正的主进程逻辑，给渲染层一个最小可用的应答，避免报错刷屏
  ipcMain.handle('pet:get-config', () => ({ scale: 1, alwaysOnTop: true }));

  const win = new BrowserWindow({
    width: 440,
    height: 600,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // 截图为验证造型服务：铺一层浅底，宠物放大到整个画布
  await win.webContents.insertCSS(`
    html, body { background: #F8F5F2 !important; }
    .pet-slot { width: 100% !important; height: 100% !important; }
    #bubble { display: none !important; }
  `);

  await wait(400);

  const written = [];
  for (const item of CASES) {
    await win.webContents.executeJavaScript(
      `(() => {
        const svg = document.getElementById('pet-svg');
        svg.dataset.face = ${JSON.stringify(item.face)};
        svg.dataset.action = ${JSON.stringify(item.action)};
        return svg.dataset.face;
      })()`,
    );
    await wait(220);
    const image = await win.webContents.capturePage();
    const file = path.join(OUT_DIR, `deskpet-smoke-${item.name}.png`);
    fs.writeFileSync(file, image.toPNG());
    written.push(file);
  }

  console.log('冒烟截图完成:', written.join(' | '));
  win.destroy();
  app.quit();
});
