const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const electron = require('electron');

const frontendRoot = path.resolve(__dirname, '..');
const outputDir = path.join(frontendRoot, 'node_modules/.tmp/titlebar-verification');
fs.mkdirSync(outputDir, { recursive: true });
electron.app.setPath('userData', outputDir);
electron.app.on('window-all-closed', () => {});

// 复用真实窗口配置和主题处理器，隔离应用启动，避免触碰正在运行的会话与后端。
let windowOptions;
const handlers = new Map();
class WindowStub {
  constructor(options) {
    windowOptions = options;
    this.webContents = { setWindowOpenHandler() {}, on() {} };
  }
  once() {}
  on() {}
  loadFile() {}
  loadURL() {}
}
const context = vm.createContext({
  require(name) {
    if (name === 'electron') return {
      ...electron,
      BrowserWindow: WindowStub,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      app: {
        setAppUserModelId() {}, requestSingleInstanceLock: () => true,
        getPath: () => outputDir, whenReady: () => ({ then() {} }), on() {}, quit() {},
      },
    };
    if (name === './backend.cjs') return {};
    if (name === './file-preview.cjs') return require('../electron/file-preview.cjs');
    return require(name);
  },
  __dirname: path.join(frontendRoot, 'electron'),
  process: { platform: process.platform, argv: [], env: {} },
  console,
});
vm.runInContext(fs.readFileSync(path.join(frontendRoot, 'electron/main.cjs'), 'utf8'), context);
vm.runInContext('createWindow()', context);

const deadline = setTimeout(() => {
  console.error('标题栏验证超时');
  electron.app.exit(1);
}, 30000);

electron.app.whenReady().then(async () => {
  const window = new electron.BrowserWindow({ ...windowOptions, show: false });
  context.verifiedWindow = window;
  vm.runInContext('mainWindow = verifiedWindow', context);
  const applyTheme = handlers.get('window:set-titlebar-theme');
  electron.ipcMain.handle('window:set-titlebar-theme', applyTheme);
  let overlay;
  const updateOverlay = window.setTitleBarOverlay.bind(window);
  window.setTitleBarOverlay = options => {
    overlay = options;
    updateOverlay(options);
  };

  await window.loadFile(path.join(frontendRoot, 'dist/index.html'));
  for (const theme of ['dark', 'light']) {
    await window.webContents.executeJavaScript(`localStorage.setItem('lingxi-theme', '${theme}')`);
    await window.loadFile(path.join(frontendRoot, 'dist/index.html'));
    await new Promise(resolve => setTimeout(resolve, 250));
    const state = await window.webContents.executeJavaScript(`({
      customTitleBar: window.electronAPI.customTitleBar,
      overlayVisible: navigator.windowControlsOverlay?.visible,
      headerCount: document.querySelectorAll('.desktop-titlebar').length,
      headerHeight: document.querySelector('.desktop-titlebar')?.getBoundingClientRect().height,
      background: getComputedStyle(document.querySelector('.desktop-titlebar')).backgroundColor,
      viewportHeight: innerHeight,
      contentHeight: document.querySelector('.h-screen')?.getBoundingClientRect().height,
    })`);
    assert.equal(state.customTitleBar, true);
    assert.equal(state.headerCount, 1);
    assert.equal(state.headerHeight, 36);
    assert.equal(state.background, theme === 'dark' ? 'rgb(9, 9, 11)' : 'rgb(245, 245, 247)');
    assert.equal(electron.nativeTheme.themeSource, theme);
    if (process.platform !== 'darwin') {
      assert.equal(state.overlayVisible, true);
      assert.equal(overlay.color, theme === 'dark' ? '#09090b' : '#f5f5f7');
      assert.equal(overlay.symbolColor, theme === 'dark' ? '#a1a1aa' : '#52525b');
    }
    if (state.contentHeight !== undefined) assert.equal(state.contentHeight + 36, state.viewportHeight);
    const screenshot = await window.capturePage({ x: 0, y: 0, width: 1200, height: 140 });
    fs.writeFileSync(path.join(outputDir, `${theme}.png`), screenshot.toPNG());
    console.log(`${theme}: 标题栏、系统按钮、边框主题和内容高度验证通过`);
  }
  window.destroy();

  const legacyWindow = new electron.BrowserWindow({
    ...windowOptions, show: false, titleBarStyle: 'default', titleBarOverlay: false,
    webPreferences: { ...windowOptions.webPreferences, additionalArguments: [] },
  });
  await legacyWindow.loadFile(path.join(frontendRoot, 'dist/index.html'));
  const legacyState = await legacyWindow.webContents.executeJavaScript(`({
    customTitleBar: window.electronAPI.customTitleBar,
    headerCount: document.querySelectorAll('.desktop-titlebar').length,
  })`);
  assert.equal(legacyState.customTitleBar, false);
  assert.equal(legacyState.headerCount, 0);
  console.log('旧窗口: 不再叠加第二层标题栏');
  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify({
    verifiedAt: new Date().toISOString(), dark: true, light: true, legacyWindow: true,
  }, null, 2));
  legacyWindow.destroy();
  clearTimeout(deadline);
  electron.app.exit(0);
}).catch(error => {
  console.error(error);
  fs.writeFileSync(path.join(outputDir, 'error.log'), String(error.stack || error));
  clearTimeout(deadline);
  electron.app.exit(1);
});
