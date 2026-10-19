// LingXi 桌宠主进程：透明窗口、拖动、托盘、右键菜单、配置持久化。
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 逻辑尺寸（缩放为 1 时的窗口大小），与 src/pet.mjs 的 viewBox 对应
const PET_WIDTH = 220;
// 比宠物高 20px，多出来的高度留给头顶的气泡
const PET_HEIGHT = 300;
const SCALE_CHOICES = [1, 1.25, 1.5];
const DRAG_TICK_MS = 16;
const EDGE_MARGIN = 48;
const CONFIG_FILE = 'deskpet-config.json';

let win = null;
let tray = null;
let dragGeometry = null;
let dragTimer = null;
let dragOffset = { x: 0, y: 0 };
let quitting = false;

const DEFAULT_CONFIG = Object.freeze({
  scale: 1,
  alwaysOnTop: true,
  position: null,
});

let config = { ...DEFAULT_CONFIG };

function configPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    config = {
      scale: SCALE_CHOICES.includes(parsed.scale) ? parsed.scale : DEFAULT_CONFIG.scale,
      alwaysOnTop: typeof parsed.alwaysOnTop === 'boolean' ? parsed.alwaysOnTop : DEFAULT_CONFIG.alwaysOnTop,
      position:
        parsed.position && Number.isFinite(parsed.position.x) && Number.isFinite(parsed.position.y)
          ? { x: Math.round(parsed.position.x), y: Math.round(parsed.position.y) }
          : null,
    };
  } catch {
    // 首次运行没有配置文件，或文件被写坏：退回默认值即可，不打扰用户
    config = { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    console.error('保存桌宠配置失败:', error.message);
  }
}

function resolveWindowSize(scale) {
  return {
    width: Math.round(PET_WIDTH * scale),
    height: Math.round(PET_HEIGHT * scale),
  };
}

/** 首次启动落在主屏右下角，并保证完整可见。 */
function resolveInitialPosition(size) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const target = config.position ?? {
    x: workArea.x + workArea.width - size.width - EDGE_MARGIN,
    y: workArea.y + workArea.height - size.height - EDGE_MARGIN,
  };
  return dragGeometry.clampToWorkArea(target, size, workArea);
}

function createWindow() {
  const size = resolveWindowSize(config.scale);
  const position = resolveInitialPosition(size);

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive(); // 不抢焦点，桌宠不该打断用户手头的输入
  });

  // 拖动过程中丢了焦点就当作松手，避免窗口「粘」在光标上
  win.on('blur', () => {
    if (dragTimer) stopDrag(true);
  });

  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
}

// ---------- 拖动 ----------
function startDrag() {
  if (!win) return;
  stopDrag(false);

  const cursor = screen.getCursorScreenPoint();
  const [windowX, windowY] = win.getPosition();
  dragOffset = { x: cursor.x - windowX, y: cursor.y - windowY };
  dragTimer = setInterval(stepDrag, DRAG_TICK_MS);
}

function stepDrag() {
  if (!win || win.isDestroyed() || !dragGeometry) return;

  const cursor = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const workArea = screen.getDisplayNearestPoint(cursor).workArea;
  const next = dragGeometry.clampToWorkArea(
    { x: cursor.x - dragOffset.x, y: cursor.y - dragOffset.y },
    { width: bounds.width, height: bounds.height },
    workArea,
  );
  win.setPosition(next.x, next.y);
}

function stopDrag(persist) {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (!win || win.isDestroyed()) return;

  const [x, y] = win.getPosition();
  config.position = { x, y };
  if (persist) saveConfig();
}

// ---------- 缩放 ----------
function applyScale(scale) {
  if (!win || win.isDestroyed()) return;
  if (!SCALE_CHOICES.includes(scale)) return;

  const currentSize = win.getBounds();
  const nextSize = resolveWindowSize(scale);
  const nextPosition = dragGeometry.resolveScaledPosition(
    { x: currentSize.x, y: currentSize.y },
    { width: currentSize.width, height: currentSize.height },
    nextSize,
  );
  const workArea = screen.getDisplayNearestPoint({ x: nextPosition.x, y: nextPosition.y }).workArea;
  const clamped = dragGeometry.clampToWorkArea(nextPosition, nextSize, workArea);

  config.scale = scale;
  config.position = clamped;
  win.setBounds({ x: clamped.x, y: clamped.y, width: nextSize.width, height: nextSize.height });
  saveConfig();
  refreshTrayMenu();
}

function toggleAlwaysOnTop() {
  config.alwaysOnTop = !config.alwaysOnTop;
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
  }
  saveConfig();
  refreshTrayMenu();
}

// ---------- 菜单 ----------
function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '置顶显示',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: toggleAlwaysOnTop,
    },
    {
      label: '大小',
      submenu: SCALE_CHOICES.map((scale) => ({
        label: `${Math.round(scale * 100)}%`,
        type: 'radio',
        checked: config.scale === scale,
        click: () => applyScale(scale),
      })),
    },
    { type: 'separator' },
    {
      label: '躲起来',
      click: () => win && win.hide(),
    },
    {
      label: '退出桌宠',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildMenu());
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  let icon = nativeImage.createEmpty();
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    console.warn('托盘图标缺失，请先运行 scripts/gen-tray-icon.ps1:', iconPath);
  }

  tray = new Tray(icon);
  tray.setToolTip('LingXi 桌宠');
  refreshTrayMenu();
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.setAlwaysOnTop(config.alwaysOnTop, 'screen-saver');
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.on('pet:drag-start', startDrag);
  ipcMain.on('pet:drag-end', () => stopDrag(true));
  ipcMain.on('pet:quit', () => {
    quitting = true;
    app.quit();
  });
  ipcMain.on('pet:open-menu', () => {
    if (win && !win.isDestroyed()) buildMenu().popup({ window: win });
  });

  ipcMain.handle('pet:get-config', () => ({
    scale: config.scale,
    alwaysOnTop: config.alwaysOnTop,
  }));

  ipcMain.handle('pet:set-scale', (_event, scale) => {
    applyScale(scale);
    return config.scale;
  });
}

// ---------- 生命周期 ----------
const hasLock = app.requestSingleInstanceLock();

if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    // 主进程是 CJS、几何模块是 ESM，只能动态引入；只引一次，之后所有回调复用
    dragGeometry = await import('./src/drag.mjs');

    app.setAppUserModelId('com.summit.lingxi.deskpet');
    loadConfig();
    registerIpc();
    createWindow();
    createTray();
  });

  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    saveConfig();
  });
}
