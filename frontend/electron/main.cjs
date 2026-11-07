const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeTheme, nativeImage, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const backend = require('./backend.cjs');
const { registerFilePreview } = require('./file-preview.cjs');
const { registerProjectPagePreview } = require('./project-page-preview.cjs');
const { registerBackgroundImages } = require('./background-images.cjs');
const { registerNotificationWindow, normalizePayload } = require('./notification-window.cjs');
const { createDisabledPet, resolvePetExposure } = require('./pet-feature-gate.cjs');
// M3 T04：偏好与菜单的单一真源（两个都是纯 CJS、零数据文件依赖，随包安全）。
const petPrefsModule = require('./pet-prefs.cjs');
const petMenu = require('./pet-menu.cjs');
const petPrefsWiringModule = require('./pet-prefs-wiring.cjs');

const { createUpdater } = require('./updater.cjs');

// 生产环境下关闭默认冗余的控制台警告
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

// 开发宿主与安装版不能共用任务栏分组，否则 Windows 会复用另一侧的图标关联。
const windowsAppId = app.isPackaged ? 'com.lingxi.lx' : 'com.lingxi.lx.development';
if (process.platform === 'win32') {
  app.setAppUserModelId(windowsAppId);
}

// 开发与安装版的浏览器配置分开，避免单实例锁和 API 地址互相覆盖。
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'aether-agent-chat-development'));
}

// 同一版本只保留一个窗口；开发与安装版各有自己的 userData 和锁。
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
/**
 * 主动重启（数据目录变更后切换生效）标记。
 *
 * <p>重启时要先停后端，而停后端会触发 onCrash —— 那是「意外退出」的告警路径，
 * 这里必须能被识别成主动行为，否则用户会先看到一句「后端服务已停止」的错误框。</p>
 */
let relaunching = false;
const closeFilePreviews = registerFilePreview({ ipcMain, shell, getWindow: () => mainWindow });

/**
 * 项目页面预览（阶段一）诊断通道：只上报目标 iframe 的加载事件。
 *
 * <p>不拦 will-navigate 也不改 setWindowOpenHandler —— 现有的外链策略（http/https 交给系统浏览器、
 * 其余 deny/allow 原样）已经能挡住 iframe 发起的顶层弹窗；iframe 自身的顶层导航由渲染层
 * sandbox（不含 allow-top-navigation）限制。这里不再加第二道会误伤现有外链的闸门。</p>
 */
const projectPagePreview = registerProjectPagePreview({ ipcMain, getWindow: () => mainWindow });

// 开发态判定（与 createWindow 内保持一致）：开发态允许缺后端产物，由开发者在 IDE 里起后端
const isDev = !app.isPackaged || process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

/** 应用根目录（打包后为 resources/app）；通知窗口按它解析 dist/notification.html。 */
const frontendRoot = path.resolve(__dirname, '..');

/**
 * 自绘通知窗口管理器。
 *
 * <p>放在这里（而不是 main 顶部）是因为它需要 isDev 与 frontendRoot 才能解析入口页面，
 * 且必须在任何 notify IPC 之前完成注册。</p>
 */
const notifications = registerNotificationWindow({
  ipcMain,
  getWindow: () => mainWindow,
  isDev,
  frontendRoot,
});

/**
 * 桌宠暴露开关（单一真源：`electron/pet-feature-gate.cjs`）。
 *
 * <p>用户硬约束：桌宠只在开发链（`pet-up.cmd` / `npm run dev:pet`）可见，
 * <b>安装版不得出现桌宠入口</b>。判定口径全部收敛在那个纯函数里
 * （安装版恒关且 env 不得覆盖；开发态默认开、`LX_PET=0` 可关），这里不写第二处判断。</p>
 */
const petExposure = resolvePetExposure({ isPackaged: app.isPackaged });

/**
 * 偏好端口（**给 S4 的 `registerPetWindow` 用**：右键菜单与 `pet:prefs-set` 都要它）。
 *
 * <p>为什么提前定义（在 `pet` 注册之前）：`registerPetWindow` 的入参里就要把它传下去，
 * 而接线器要到下面（偏好块）才能建起来。方法体内引用 `petPrefsWiring`，**调用时机都在
 * `app.whenReady()` 之后**（IPC / 菜单点击），那时它早已初始化，不存在 TDZ 问题。</p>
 *
 * <p>为什么只暴露这一个对象：菜单点击、右键菜单、将来渲染层的 `pet:prefs-set` 必须走
 * **同一条**落盘路径（`setPrefs`：先落盘 → 广播 → 重建菜单），否则会出现
 * "托盘保存了、右键没保存"这种幽灵 bug。</p>
 *
 * <p><b>S4 接法</b>：`registerPetWindow({ ..., prefs: petPrefsPort, menu: petMenu })`，
 * 然后在 `ipcMain.on('pet:context-menu')` 里把内联模板换成
 * `petMenu.buildContextMenuItems({ prefs: prefs.getPrefs(), isVisible: isVisible(), actions })`。</p>
 */
const petPrefsPort = {
  /**
   * 读当前偏好（渲染层与右键菜单的勾选态来源）。
   *
   * @returns {{version: number, follow: boolean, roam: boolean}} 偏好快照
   */
  getPrefs: () => petPrefsWiring.getPrefs(),
  /**
   * 应用一次偏好变更（先落盘 → 广播 → 重建菜单）。
   *
   * @param {{follow?: boolean, roam?: boolean}} patch 只接受布尔
   * @returns {{prefs: object, ok: boolean, problems: string[], changed: boolean}} 结果
   */
  setPrefs: (patch) => petPrefsWiring.setPrefs(patch),
  /**
   * 订阅偏好变更（渲染层广播挂这里）。
   *
   * @param {(prefs: object) => void} listener 回调
   * @returns {() => void} 取消订阅函数
   */
  onPrefsChange: (listener) => petPrefsWiring.onChange(listener),
};

/**
 * 桌宠窗口管理器（阶段一：透明置顶 + 点击穿透 + 自定义拖拽 + 位置持久化）。
 *
 * <p>与通知窗口一样在这里注册：它需要 isDev / frontendRoot 解析入口页面，
 * 且装配早于托盘菜单（托盘要按它的可见性渲染勾选项）。</p>
 *
 * <p>门禁关闭时不 require 桌宠模块、不建窗口，用 {@link createDisabledPet} 的空对象兜底——
 * 下游 `pet.show()` / `pet.isVisible()` / `pet.destroy()` 等调用零分叉。</p>
 */
const pet = petExposure.enabled
  ? require('./pet-window.cjs').registerPetWindow({ ipcMain, isDev, frontendRoot, prefs: petPrefsPort, menu: petMenu })
  : createDisabledPet();

/**
 * 桌宠资源协议模块（`lxa://`）。它只服务桌宠资源，主应用零使用 ⇒ 门禁关闭时连 require 都不做
 * （打包态的包里因此不会有"被加载的桌宠代码路径"）。
 */
const lxProtocol = petExposure.enabled ? require('./lx-protocol.cjs') : null;

/**
 * 桌宠资源的 `lxa://` 协议特权。
 *
 * <p>⚠️ 必须在 ready 之前登记：ready 之后登记会抛异常且不生效，表现就是
 * `lxa://` 被当成未知 scheme，模型永远加载不出来。</p>
 */
if (lxProtocol) lxProtocol.registerLxSchemePrivileges();


// 后端日志与工作目录都放 userData：安装到 Program Files 后应用目录不可写
const userDataDir = app.getPath('userData');
const backendLogPath = path.join(userDataDir, 'logs', 'backend.log');

// ------------------------------------------------------------ 桌宠偏好（M3 T04）

/**
 * 桌宠偏好文件路径（设计 §9.2）。
 *
 * <p><b>为什么与位置文件分开</b>：`pet-window-state.json` 坏掉只影响下次落点，
 * 偏好文件坏掉只影响两个开关的默认值，互不连坐（`pet-prefs.json` 是这个模块独占的文件）。</p>
 */
const petPrefsFilePath = path.join(userDataDir, 'pet-prefs.json');

/**
 * 偏好仓库（门禁关闭时为 `null`：安装版不读不写偏好文件）。
 *
 * <p>路径在这里算（`app.getPath('userData')` 只有主进程能拿），仓库本身在
 * `electron/pet-prefs.cjs` 里，原子写与逐字段降级都由它保证。</p>
 */
const petPrefsStore = petExposure.enabled
  ? petPrefsModule.createPrefsStore({ filePath: petPrefsFilePath })
  : null;

/**
 * 系统"减少动态效果"探针结果（U-M4）。
 *
 * <p>探针是纯函数（`pet-prefs.cjs` 的 `detectReducedMotion`），这里只负责把 Electron
 * 侧可能存在的两个接口喂进去；<b>接口不可用时它是"不动"</b>（不覆盖默认值），
 * 理由与翻转方法写在那边的文档注释里。</p>
 */
const reducedMotionProbe = petPrefsModule.detectReducedMotion({ app, systemPreferences });

/**
 * 偏好-菜单接线器（**全部纯逻辑在它里面**，见 `electron/pet-prefs-wiring.cjs`）。
 *
 * <p>`main.cjs` 只提供四个 Electron 侧适配器：偏好仓库、可见性、门禁、菜单重建。
 * 这样"点击开关 → 先落盘 → 广播 → 重建菜单 → 勾选态"这条链在 node 里可以真跑
 * （`tests/petPrefsWiring.test.cjs` 的 W 系列用例就是手摇它）。</p>
 */
const petPrefsWiring = petPrefsWiringModule.createPrefsWiring({
  store: petPrefsStore,
  prefersReducedMotion: reducedMotionProbe.reducedMotion,
  builder: petMenu,
  isVisible: () => pet.isVisible(),
  includePet: petExposure.enabled,
  warn: (message) => console.warn(message),
  actions: {
    /** 显示主窗口（托盘第一项）。 */
    showMain: () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    },
    /** 显示/隐藏桌宠（托盘勾选项 + 右键菜单同一项）。 */
    toggleVisible: () => {
      pet.toggle();
    },
    /** 彻底退出（托盘最后一项）。 */
    quitApp: () => {
      isQuiting = true;
      app.quit();
    },
  },
  rebuildTray: (spec) => {
    // tray 可能还没建出来（setupTray 之前不会有 setPrefs 调用，但保持防御）
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate(spec));
  },
});

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

/**
 * 主页背景图片 IPC（选图 / 读图 / 清除）。
 *
 * <p>与 file-preview 同构地做成独立模块：校验逻辑（文件名白名单、大小上限、解码校验、
 * 先写后删）全在 `background-images.cjs` 里，本文件只注入 electron 能力。
 * 三条 handler 都做来源校验 —— 渲染层虽然只拿文件名与 data URL，但落盘与删文件是高权限动作。</p>
 */
const backgroundImages = registerBackgroundImages({
  ipcMain,
  dialog,
  nativeImage,
  userDataDir,
  getWindow: () => mainWindow,
  assertTrustedSender,
});

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
    html,body{margin:0;height:100%;background:white;color:#e2e8f0;
      font-family:"Segoe UI","Microsoft YaHei",sans-serif;display:flex;
      align-items:center;justify-content:center;flex-direction:column;gap:14px;user-select:none}
    .title{font-size:15px;font-weight:600;letter-spacing:.5px;color:black}
    .tip{font-size:12px;color:black}
    .bar{width:180px;height:3px;border-radius:2px;background:blue;overflow:hidden}
    .bar::after{content:"";display:block;width:40%;height:100%;border-radius:2px;
      background:linear-gradient(90deg,#3b82f6,#6366f1);animation:slide 1.1s ease-in-out infinite}
    @keyframes slide{0%{transform:translateX(-110%)}100%{transform:translateX(280%)}}
  </style></head><body>
    <div class="title">LX</div>
    <div class="bar"></div>
    <div class="tip">奋力加载中…</div>
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
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, 'resources/icon.ico')
    : path.join(__dirname, 'resources/icon.png');
  nativeTheme.themeSource = 'dark';
  const icon = nativeImage.createFromPath(iconPath);
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
    icon: icon,
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

  if (process.platform === 'win32') {
    // 必须在显示前设置；Shell 读不到 asar 内的 ICO，安装版直接使用已嵌入图标的 EXE。
    mainWindow.setAppDetails({
      appId: windowsAppId,
      appIconPath: app.isPackaged ? process.execPath : iconPath,
      appIconIndex: 0,
      relaunchCommand: app.isPackaged
        ? `"${process.execPath}"`
        : `"${process.execPath}" "${app.getAppPath()}" --dev`,
      relaunchDisplayName: app.isPackaged ? 'LX' : 'LX 开发版',
    });
  }

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
  tray.setToolTip('LX ');
  // 初始菜单与后续重建走**同一条**路径：模板全部来自 `pet-menu.cjs`，
  // 本文件不再出现任何 label 字面量（"托盘与右键同源"的唯一实现方式）。
  petPrefsWiring.rebuildTray();

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

/**
 * 重建托盘菜单（勾选态与事实对齐的唯一入口）。
 *
 * <p>三个触发点：托盘的 `pet.onVisibilityChange`、偏好变更（接线器内部）、
 * 以及未来的任何需要刷新的时机。**这是上一轮悬空引用的正确定义**：
 * 菜单点击 → `petPrefsPort.setPrefs()` → 接线器 → 注入的 `rebuildTray(spec)` →
 * `tray.setContextMenu`，全程没有任何"被调用但没有定义"的名字。</p>
 *
 * @returns {void}
 */
function rebuildTrayMenu() {
  petPrefsWiring.rebuildTray();
}

// 桌宠可见性变化时重建托盘菜单，保证勾选状态与事实一致
pet.onVisibilityChange(() => {
  rebuildTrayMenu();
});

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

// IPC 处理器：推送一条任务通知（自绘云母卡片，失败时退回系统原生横幅）
ipcMain.handle('notify', (event, payload) => {
  // 与更新类 IPC 同一口径：本应用 sandbox:false 且页面会渲染用户/模型产出的内容，
  // 不校验来源的话任何注入点都能弹任意文案。
  if (!assertTrustedSender(event)) return false;
  // 长度、类型、枚举在模块内统一收口，自绘与原生两条路径共用同一份结果
  const request = normalizePayload(payload);

  if (notifications.show(request)) return true;
  return showNativeNotification(request.title, request.body);
});

/**
 * 系统原生通知：仅在自绘窗口建不出来时兜底。
 *
 * <p>原生 Toast 的样式由 Explorer 决定，做不出云母半透明，所以它只是「宁可难看也别没提醒」
 * 的退路，不是主路径。</p>
 */
function showNativeNotification(title, body) {
  if (!Notification.isSupported()) return false;
  const iconPath = path.join(__dirname, 'resources/icon.ico');
  const notification = new Notification({ title: title || 'LX', body: body || '', icon: iconPath });

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

/**
 * IPC 处理器：重启应用。
 *
 * <p>数据目录（H2 库位置）在进程启动时就定死了，改目录必须重启才切得过去。
 * 这里不能只调 app.relaunch —— Windows 不会随父进程带走子进程，残留的 JVM
 * 会继续占着旧目录，新进程再启动就被端口探测判为「后端已就绪」而直接复用。
 * 因此必须先停后端、确认停干净，再重启。</p>
 */
ipcMain.handle('app:relaunch', async (event) => {
  if (!assertTrustedSender(event)) return false;
  relaunching = true;
  isQuiting = true;
  await backend.stop().catch(() => { });
  backendStopped = true;
  app.relaunch();
  app.exit(0);
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

  // 桌宠资源协议：ready 之后才能 handle。失败不影响主应用（模型加载不到而已）
  if (lxProtocol) {
    try {
      // 开发态额外挂上 public/live2d：否则改完素材要先 build 一次才被桌宠看见
      const extraBases = isDev ? [path.join(frontendRoot, 'public', 'live2d')] : [];
      lxProtocol.registerLxProtocol({ userDataDir, appRoot: app.getAppPath(), extraBases });
    } catch (err) {
      console.warn(`[lxa] 协议注册失败（桌宠模型将加载不出来）: ${(err && err.message) || err}`);
    }
  }

  // 先起后端再建窗口：前端一加载就发请求，后端没就绪会满屏请求失败
  createSplash();

  // 桌宠与托盘先行建立：两者都不依赖后端（桌宠是 pet.html 独立页面 + 自注册 IPC，
  // 托盘只是本进程的 Tray 对象），所以必须排在 backend.start() 之前。
  // 早先的写法把它们放在后端成功之后，后端起不来就 return 走了，
  // 桌宠永远不出现 —— 一个附加功能把唯一的存活 UI 拖下了水。
  let petReady = false;
  // 用返回值判成败，不用 pet.isVisible()：showInactive() 之后要等 ready-to-show
  // 才真正可见，紧接着读 isVisible() 会是 false，把建好的桌宠误判成失败。
  // 门禁关闭时 pet 是空对象，show() 恒为 false ⇒ petReady 保持 false（没有任何窗口被建出来）。
  try {
    petReady = !!pet.show();
  } catch (err) {
    console.warn(`[pet] 桌宠窗口创建失败（不影响应用使用）: ${(err && err.message) || err}`);
  }

  // 托盘必须在 pet.show() 之后：buildTrayMenu() 用 pet.isVisible() 渲染「显示桌宠」
  // 的勾选状态，先建托盘会把初始勾选定死成 false，与事实矛盾。
  let trayReady = false;
  try {
    setupTray();
    trayReady = true;
  } catch (err) {
    console.warn(`[tray] 托盘创建失败（不影响应用使用）: ${(err && err.message) || err}`);
  }

  try {
    await backend.start({
      frontendRoot: path.resolve(__dirname, '..'),
      isPackaged: app.isPackaged,
      executablePath: app.getPath('exe'),
      resourcesPath: process.resourcesPath,
      userDataDir,
      logPath: backendLogPath,
      isDev,
      onCrash: (code, signal) => {
        // 主动重启时后端是被我们自己停掉的，不是崩溃。
        if (relaunching) return;
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
    // 桌宠与托盘都已建成时不退出：应用退化成「只有桌宠」的可用状态，
    // 用户还能从托盘「彻底退出」。这里硬 quit 会把刚建好的桌宠一起带走，
    // 等于白白丢掉唯一的存活 UI。
    if (petReady && trayReady) {
      console.warn('[boot] 后端起不来，保留桌宠与托盘继续驻留；退出请走托盘菜单');
      return;
    }
    // 桌宠或托盘没建成时维持原有退出行为：没有托盘就没有退出入口，
    // 留下去只是一个关不掉的僵尸进程。
    isQuiting = true;
    app.quit();
    return;
  }

  // 主窗口仍然只在后端就绪后才建：前端一加载就发请求，后端没就绪会满屏请求失败。
  // 桌宠与托盘已在前面建好，这里只补主窗口。
  createWindow();

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
  // 页面预览只是摘掉 webContents 监听器与 IPC handler，没有需要落盘的状态
  projectPagePreview.close();
  // 背景 IPC 只是注销通道，不删用户图片（图片要跨重启保留）
  backgroundImages.close();
  // 通知卡片不进任务栏，退出后没人能关掉它们，必须在这里主动收干净
  notifications.closeAll();

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
    .catch(() => { })
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
