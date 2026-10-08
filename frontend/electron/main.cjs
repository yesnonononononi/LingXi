const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const backend = require('./backend.cjs');
const { registerFilePreview } = require('./file-preview.cjs');
const { createUpdater } = require('./updater.cjs');

// 生产环境下关闭默认冗余的控制台警告
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

// Windows 原生应用标识 (确保系统通知显示正确的应用名与图标)
if (process.platform === 'win32') {
  app.setAppUserModelId('com.lingxi.lx');
}

// 单实例锁：后端端口固定 8088，多开必然撞端口；第二次启动只把已有窗口唤到前台。
// 必须在 whenReady 之前调用，否则拿不到锁的进程窗口已经建出来了。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

let mainWindow = null;
let splashWindow = null;
let tray = null;
let isQuiting = false;
let backendStopped = false;
const closeFilePreviews = registerFilePreview({ ipcMain, shell, getWindow: () => mainWindow });

// 开发态判定（与 createWindow 内保持一致）：开发态允许缺后端产物，由开发者在 IDE 里起后端
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// 后端日志与工作目录都放 userData：安装到 Program Files 后应用目录不可写
const userDataDir = app.getPath('userData');
const backendLogPath = path.join(userDataDir, 'logs', 'backend.log');

// ---------------------------------------------------------------- 更新器日志

/**
 * 更新器日志独立成一个文件。
 *
 * 为什么不并进 backend.log：两者生命周期不同（后端每次启动一条新流，更新器在
 * 应用存活期常驻），且排查「为什么没更新」时需要一份干净、不被后端输出淹没的记录。
 * 只保留最近一次运行（覆盖写），避免无限增长。
 */
const updaterLogPath = path.join(userDataDir, 'logs', 'updater.log');
let updaterLogStream = null;
function ensureUpdaterLog() {
  if (updaterLogStream) return updaterLogStream;
  try {
    fs.mkdirSync(path.dirname(updaterLogPath), { recursive: true });
    updaterLogStream = fs.createWriteStream(updaterLogPath, { flags: 'w' });
  } catch {
    // 日志写不了不能影响更新功能本身，退化为只走控制台
    updaterLogStream = null;
  }
  return updaterLogStream;
}

const updaterLogger = {
  info(msg) {
    const line = `[${new Date().toISOString()}] [INFO] ${msg}`;
    console.log(`[Updater] ${msg}`);
    ensureUpdaterLog()?.write(`${line}\n`);
  },
  warn(msg) {
    const line = `[${new Date().toISOString()}] [WARN] ${msg}`;
    console.warn(`[Updater] ${msg}`);
    ensureUpdaterLog()?.write(`${line}\n`);
  },
  error(msg) {
    const line = `[${new Date().toISOString()}] [ERROR] ${msg}`;
    console.error(`[Updater] ${msg}`);
    ensureUpdaterLog()?.write(`${line}\n`);
  },
};

/**
 * 把更新状态推给渲染层。
 *
 * 只在窗口存活时推；窗口销毁（用户点了彻底退出）后静默丢弃 ——
 * 与 SseEventPublisher「无订阅者时静默丢弃」的处理保持一致，不阻塞主进程。
 */
function broadcastUpdateState(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('update:state', state);
  } catch {
    // 窗口正在销毁竞态下 send 会抛，忽略即可
  }
}

const updater = createUpdater({
  app,
  getWindow: () => mainWindow,
  broadcast: broadcastUpdateState,
  logger: updaterLogger,
});

/**
 * 所有更新类 IPC 的收发校验。
 *
 * ⚠️ 为什么每个 handler 都要查 event.sender：
 *    本应用 sandbox:false + 页面里可能渲染用户/模型产出的内容（含 iframe、外链）。
 *    不做来源校验的话，任何一个注入点都能调用更新接口 —— 而更新接口能触发
 *    「下载并执行一个可执行文件」，是最高的权限。这是本项目里最需要严格把关的入口。
 */
function assertTrustedSender(event) {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

/** 启动遮罩：后端就绪前必须给用户反馈，否则首次启动会「点了没反应」好几秒 */
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 210,
    frame: false,
    resizable: false,
    center: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0f172a',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0f172a;color:#e2e8f0;
      font-family:"Segoe UI","Microsoft YaHei",sans-serif;display:flex;
      align-items:center;justify-content:center;flex-direction:column;gap:14px;user-select:none}
    .title{font-size:15px;font-weight:600;letter-spacing:.5px}
    .tip{font-size:12px;color:#64748b}
    .bar{width:180px;height:3px;border-radius:2px;background:#1e293b;overflow:hidden}
    .bar::after{content:"";display:block;width:40%;height:100%;border-radius:2px;
      background:linear-gradient(90deg,#3b82f6,#6366f1);animation:slide 1.1s ease-in-out infinite}
    @keyframes slide{0%{transform:translateX(-110%)}100%{transform:translateX(280%)}}
  </style></head><body>
    <div class="title">LX</div>
    <div class="bar"></div>
    <div class="tip">正在启动本地服务…</div>
  </body></html>`;

  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.destroy();
  }
  splashWindow = null;
}

function createWindow() {
  const iconPath = path.join(__dirname, 'resources/icon.ico');
  nativeTheme.themeSource = 'dark';

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    center: true,
    show: false,
    backgroundColor: '#09090b',
    title: 'LX',
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin' ? {
      titleBarOverlay: { color: '#09090b', symbolColor: '#a1a1aa', height: 36 },
    } : {}),
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      additionalArguments: ['--lingxi-custom-titlebar'],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // 禁用后台节流，保证窗口最小化到托盘时长任务/SSE流依然全速运行
      backgroundThrottling: false,
    },
  });

  // 窗口准备好后再显示，消除白屏/黑屏闪烁；同时撤掉启动遮罩
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
    }
    closeSplash();
  });

  // 拦截外链点击，改由系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 拦截点击窗口右上角 "X" 关闭按钮：改为隐藏至系统托盘常驻
  mainWindow.on('close', (event) => {
    if (!isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  const devUrl = process.env.ELECTRON_URL || 'http://localhost:5174';

  if (isDev) {
    mainWindow.loadURL(devUrl);
    // 开发模式允许使用 F12 切换控制台
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 创建与初始化系统托盘
function setupTray() {
  const iconPath = path.join(__dirname, 'resources/icon.ico');
  tray = new Tray(iconPath);
  tray.setToolTip('LX - 智能体交互控制台');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示 LX 界面',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: '彻底退出',
      click: () => {
        isQuiting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // 鼠标左键点击托盘图标：智能切换 显示 / 隐藏
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      if (mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.focus();
      }
    } else {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// 原生按钮与页面主题同步，避免深色页面顶部仍出现浅色背景。
ipcMain.handle('window:set-titlebar-theme', (event, isDark) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || typeof isDark !== 'boolean') return;
  nativeTheme.themeSource = isDark ? 'dark' : 'light';
  if (process.platform === 'darwin') return;
  mainWindow.setTitleBarOverlay({
    color: isDark ? '#09090b' : '#f5f5f7',
    symbolColor: isDark ? '#a1a1aa' : '#52525b',
    height: 36,
  });
});

// IPC 处理器：系统原生文件夹选择器
ipcMain.handle('dialog:select-directory', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win || mainWindow, {
    title: '选择工作空间目录',
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// IPC 处理器：发送 Windows 原生横幅通知
ipcMain.handle('notify', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const iconPath = path.join(__dirname, 'resources/icon.ico');
    const notification = new Notification({
      title: title || 'LX',
      body: body || '',
      icon: iconPath,
    });

    // 用户点击系统横幅通知时，自动打开并激活 LX 窗口
    notification.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });

    notification.show();
    return true;
  }
  return false;
});

// ---------------------------------------------------------------- 更新 IPC

/** 查询当前更新状态（渲染层挂载时拉一次初值，之后靠 update:state 事件驱动） */
ipcMain.handle('update:get-state', (event) => {
  if (!assertTrustedSender(event)) return null;
  const s = updater.getState();
  return {
    currentVersion: s.currentVersion,
    enabled: updater.isEnabled(),
    // ⚠️ phase 与 progress 必须一并下发：缺了它们，渲染层重开设置页时
    //    只能把任何 pending 一律还原成 available（历史缺口）。
    phase: s.phase,
    error: s.error ?? null,
    progress: s.progress ?? { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 },
    pending: s.pending
      ? {
          version: s.pending.version,
          releaseNotes: s.pending.changeLog,
          forceupdate: s.pending.forceupdate,
          mandatory: s.pending.mandatory,
          installable: s.pending.installable,
          rejectReason: s.pending.rejectReason ?? null,
        }
      : null,
  };
});

/** 手动检查更新 */
ipcMain.handle('update:check', async (event) => {
  if (!assertTrustedSender(event)) return { ok: false, error: '来源未授权' };
  if (!updater.isEnabled()) return { ok: false, error: '当前环境不支持自动更新' };
  await updater.check({ manual: true });
  return { ok: true };
});

/** 下载已发现的更新 */
ipcMain.handle('update:download', async (event) => {
  if (!assertTrustedSender(event)) return { ok: false, error: '来源未授权' };
  try {
    await updater.startDownload();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

/**
 * 安装并重启。
 *
 * ⚠️ 强制更新（mandatory=true）时不校验前端传入的意图：
 *    一旦 pending.mandatory 为真，前端无论如何都必须走到安装。
 *    这是「强制」的定义。用户唯一的出路是卸载应用。
 *
 * ⚠️ 但「是否已下载完成」必须由主进程判定：install() 会拒绝尚未下载的状态，
 *    并把真实原因回给渲染层（历史缺口：未下载也返回 true，用户点了没反应）。
 */
ipcMain.handle('update:install', (event) => {
  if (!assertTrustedSender(event)) return { ok: false, error: '来源未授权' };
  return updater.install();
});

/** 打开更新器日志（排障用：用户报「更新失败」时让 TA 直接把文件发过来） */
ipcMain.handle('update:open-log', async (event) => {
  if (!assertTrustedSender(event)) return false;
  ensureUpdaterLog()?.end();
  updaterLogStream = null;
  shell.showItemInFolder(updaterLogPath);
  return true;
});

// 第二次启动：不新建窗口，把已有窗口唤到前台（单实例锁的配套处理）
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;

  // 先起后端再建窗口：前端一加载就发请求，后端没就绪会满屏请求失败
  createSplash();
  try {
    await backend.start({
      frontendRoot: path.resolve(__dirname, '..'),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      userDataDir,
      logPath: backendLogPath,
      isDev,
      onCrash: (code, signal) => {
        // 运行期后端挂掉不能静默吞掉，明确告诉用户去哪看日志
        dialog.showErrorBox(
          'LX 后端服务已停止',
          `本地服务意外退出 (code=${code} signal=${signal})。\n请重启应用。\n日志: ${backendLogPath}`
        );
        isQuiting = true;
        app.quit();
      },
    });
  } catch (err) {
    closeSplash();
    dialog.showErrorBox('LX 启动失败', String((err && err.message) || err));
    isQuiting = true;
    app.quit();
    return;
  }

  createWindow();
  setupTray();

  // 更新器在窗口建好之后再起：它的状态要推给渲染层，且首次检查是延时的，
  // 不影响启动路径（更新失败绝不能让应用起不来）。
  try {
    updater.start();
  } catch (err) {
    updaterLogger.error(`初始化失败（不影响应用使用）: ${(err && err.message) || err}`);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

// 在退出前标记彻底退出，确保关闭窗口拦截器放行
app.on('before-quit', () => {
  isQuiting = true;
  closeFilePreviews();
  // 停掉更新器的定时器，避免退出过程中触发一次检查
  updater.stop();
  updaterLogStream?.end();
  updaterLogStream = null;
});

// 退出前必须把后端进程收干净：Windows 不会因为父进程退出而带走子进程。
// will-quit 里做异步收尾要先 preventDefault，收完再 quit 一次（此时 backendStopped 已置位、放行）。
app.on('will-quit', (event) => {
  if (backendStopped) return;
  event.preventDefault();
  backend
    .stop()
    .catch(() => {})
    .finally(() => {
      backendStopped = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  // 托盘模式下窗口全部关闭时不自动退出，保持托盘后台驻留
  if (process.platform === 'darwin' || isQuiting) {
    app.quit();
  }
});
