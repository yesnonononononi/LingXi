const path = require('node:path');
const os = require('node:os');

/**
 * 延迟取 electron 运行时。
 *
 * <p>本模块里只有建窗口与取屏幕才真正需要 electron；把 require 提到顶层会让这个文件
 * 在纯 node 下（单元测试）直接崩掉，而其中的 {@link micaSupportedFor} /
 * {@link normalizePayload} 是纯函数，最值得被测。</p>
 */
function electron() {
  return require('electron');
}

// ---------------------------------------------------------------- 常量

/** 通知卡片尺寸：宽度取 Windows 原生 Toast 的观感（略宽一点以容纳中文标题）。 */
const WIDTH = 384;
const HEIGHT = 116;
/** 卡片间距与距工作区边缘的留白。 */
const GAP = 10;
const MARGIN = 18;
/** 同屏最多堆叠数量，超出后最旧的一条立即让位。 */
const MAX_VISIBLE = 4;
/** 默认停留时长；鼠标悬停期间暂停计时。 */
const DEFAULT_DURATION_MS = 9000;
/** 入场动画期间不定位，等窗口 ready 后统一摆放。 */
const ANIMATION_MS = 220;

/** 通知标题与正文的长度上限：Windows 横幅放不下更多，超了就是被系统硬截。 */
const TITLE_MAX = 120;
const BODY_MAX = 240;
/** 允许的结果种类；非法值一律按「已完成」处理，避免渲染层拿到未知 class。 */
const KNOWN_KINDS = ['completed', 'failed', 'cancelled', 'suspended'];

/**
 * 判定某个系统版本是否支持 DWM Mica 材质。
 *
 * <p>Mica 需要 Windows 11 22H2（build 22621）及以上。低于该版本时
 * {@code backgroundMaterial} 在 Electron 里等同于 {@code none}，窗口会露出
 * 纯黑底 —— 因此必须显式探测，退回「半透明深色 + 无模糊」的兜底观感。</p>
 *
 * <p>参数化是为了可测：真机只有一个 build 号，写死就没法验证边界。</p>
 *
 * @param platform {@code process.platform} 的取值
 * @param release {@code os.release()} 的取值，形如 {@code 10.0.26200}
 */
function micaSupportedFor(platform, release) {
  if (platform !== 'win32') return false;
  const build = Number(String(release).split('.')[2] || 0);
  return Number.isFinite(build) && build >= 22621;
}

/** 当前系统是否支持 DWM Mica 材质。 */
function supportsMica() {
  return micaSupportedFor(process.platform, os.release());
}

/**
 * 归一化一条通知请求。
 *
 * <p>内容最终来自模型/用户产出，不能信任：长度、类型、枚举全部在这里收口一次，
 * 下游（自绘窗口与原生横幅）共用同一份结果，避免两条路径的过滤口径漂移。</p>
 */
function normalizePayload(data) {
  const source = data && typeof data === 'object' ? data : {};
  const rawTitle = typeof source.title === 'string' ? source.title.trim() : '';
  const title = rawTitle ? rawTitle.slice(0, TITLE_MAX) : 'LX';
  const body = typeof source.body === 'string' ? source.body.slice(0, BODY_MAX) : '';
  const sessionId = typeof source.sessionId === 'string' || typeof source.sessionId === 'number'
    ? String(source.sessionId)
    : null;
  const kind = KNOWN_KINDS.includes(source.kind) ? source.kind : 'completed';
  const duration = Number.isFinite(source.duration) && source.duration > 0 ? source.duration : undefined;
  const theme = source.theme === 'light' ? 'light' : 'dark';
  return { title, body, sessionId, kind, duration, theme };
}

/** 通知窗口的入口页面：开发态走 Vite 服务，打包态走 dist 内的多入口产物。 */
function resolveEntry(isDev, frontendRoot) {
  if (isDev) {
    const url = process.env.ELECTRON_URL || 'http://localhost:5174';
    return { kind: 'url', value: new URL('notification.html', url + '/').toString() };
  }
  return { kind: 'file', value: path.join(frontendRoot, 'dist', 'notification.html') };
}

/**
 * 自绘通知窗口管理器。
 *
 * <p><b>为什么不用系统原生 Notification：</b>Windows Toast 的视觉完全由 Explorer 的 XAML
 * 定义，应用连背景色都改不了，「云母半透明」在原生通知里无解。所以这里自建一个无边框、
 * 置顶、不进任务栏的窗口，用 {@code backgroundMaterial: 'mica'} 取系统材质、再叠一层
 * 半透明卡片，才拿得到要的效果。</p>
 *
 * <p><b>代价（必须明确）：</b>自绘窗口不进 Windows 通知中心、不受专注助手拦截、也没有
 * 系统级的通知音与优先级。这是用「样式自由」换来的，属于产品层面的取舍。</p>
 */
function registerNotificationWindow({ ipcMain, getWindow, isDev, frontendRoot }) {
  /** 活动通知，索引 0 是最新的一条（贴右下角），其余依次上移。 */
  const active = [];
  let seq = 0;

  const isWin = () => supportsMica();

  /** 定位基准：跟随主窗口所在显示器，主窗口没了就用主显示器。 */
  function workArea() {
    const { screen } = electron();
    const main = getWindow();
    if (main && !main.isDestroyed()) {
      return screen.getDisplayMatching(main.getBounds()).workArea;
    }
    return screen.getPrimaryDisplay().workArea;
  }

  /** 按数组顺序重新摆放：0 号贴底，往上依次堆叠。 */
  function layout() {
    const area = workArea();
    active.forEach((item, index) => {
      if (!item.win || item.win.isDestroyed()) return;
      const x = area.x + area.width - WIDTH - MARGIN;
      const y = area.y + area.height - MARGIN - HEIGHT - index * (HEIGHT + GAP);
      item.win.setPosition(Math.round(x), Math.round(y), false);
    });
  }

  /** 通知窗口只允许它的渲染层发指令，来源一律比对 webContents。 */
  function isFromNotification(event) {
    return active.some(item => item.win && !item.win.isDestroyed()
      && item.win.webContents === event.sender);
  }

  function findItem(event) {
    for (const item of active) {
      if (item.win && !item.win.isDestroyed() && item.win.webContents === event.sender) return item;
    }
    return null;
  }

  function clearTimer(item) {
    if (item.timer) {
      clearTimeout(item.timer);
      item.timer = null;
    }
  }

  function armTimer(item) {
    clearTimer(item);
    if (item.paused) return;
    item.timer = setTimeout(() => dismiss(item), item.duration);
  }

  /** 关掉一条并重排剩下的。 */
  function dismiss(item) {
    clearTimer(item);
    const index = active.indexOf(item);
    if (index >= 0) active.splice(index, 1);
    if (item.win && !item.win.isDestroyed()) item.win.destroy();
    layout();
  }

  /**
   * 点击通知：唤起主窗口并把「是哪条会话」回传给渲染层。
   *
   * <p>只 show+focus 是不够的 —— 用户在 A 会话看到 B 会话完成的通知，点回来还是 A，
   * 等于白通知。sessionId 必须带回去让渲染层切会话。</p>
   */
  function activate(item) {
    const main = getWindow();
    const payload = item.payload;
    dismiss(item);
    if (!main || main.isDestroyed()) return;
    if (main.isMinimized()) main.restore();
    if (!main.isVisible()) main.show();
    main.focus();
    try {
      main.webContents.send('notification:activate', {
        sessionId: payload.sessionId ?? null,
        kind: payload.kind ?? null,
      });
    } catch {
      // 窗口正在销毁的竞态下 send 会抛，通知本身已经关掉了，忽略即可
    }
  }

  /** 创建一条通知窗口。任何一步失败都返回 null，由调用方决定是否退回系统通知。 */
  function create(payload) {
    const entry = resolveEntry(isDev, frontendRoot);
    const { BrowserWindow } = electron();
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      // 不用 transparent: 它与 backgroundMaterial 在 Windows 上会互相压制，
      // 结果是材质不生效且窗口发灰。改用全透明 backgroundColor + 页面自身透明背景。
      // 无材质的旧系统没有 DWM 云母可透，必须给一个实色底，否则会露出窗口的默认白底。
      backgroundColor: isWin() ? '#00000000' : '#18181b',
      ...(isWin() ? { backgroundMaterial: 'mica' } : {}),
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // 不抢焦点：用户正在别的应用里打字时，通知不该把光标抢走
      focusable: false,
      hasShadow: true,
      webPreferences: {
        preload: path.join(__dirname, 'notification-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        // 卡片有入场动画，节流会让动画在小窗里卡顿
        backgroundThrottling: false,
      },
    });

    const item = {
      id: ++seq,
      win,
      payload,
      duration: Number.isFinite(payload.duration) ? payload.duration : DEFAULT_DURATION_MS,
      paused: false,
      timer: null,
    };

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      layout();
      win.showInactive();
      // 等渲染层的入场动画起步后再开始计时，避免动画还没出来就开始倒计时
      setTimeout(() => { if (active.includes(item)) armTimer(item); }, ANIMATION_MS);
    });

    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.webContents.send('notification:data', {
        ...payload,
        id: item.id,
        mica: isWin(),
      });
    });

    // 渲染层崩了不能把窗口留在屏幕上挡视线
    win.webContents.on('render-process-gone', () => dismiss(item));

    win.on('closed', () => {
      clearTimer(item);
      const index = active.indexOf(item);
      if (index >= 0) {
        active.splice(index, 1);
        layout();
      }
    });

    if (entry.kind === 'url') {
      win.loadURL(entry.value);
    } else {
      win.loadFile(entry.value);
    }

    active.unshift(item);
    if (active.length > MAX_VISIBLE) dismiss(active[active.length - 1]);
    return item;
  }

  // ---------------------------------------------------------------- IPC

  /** 渲染层：鼠标进入/离开卡片，用于暂停自动消失计时。 */
  ipcMain.handle('notification:set-hover', (event, hovered) => {
    if (!isFromNotification(event)) return false;
    const item = findItem(event);
    if (!item) return false;
    item.paused = hovered === true;
    if (item.paused) clearTimer(item);
    else armTimer(item);
    return true;
  });

  /** 渲染层：点击卡片主体，要求唤起主窗口并跳转会话。 */
  ipcMain.handle('notification:activate', (event) => {
    if (!isFromNotification(event)) return false;
    const item = findItem(event);
    if (!item) return false;
    activate(item);
    return true;
  });

  /** 渲染层：点了关闭按钮。 */
  ipcMain.handle('notification:dismiss', (event) => {
    if (!isFromNotification(event)) return false;
    const item = findItem(event);
    if (!item) return false;
    dismiss(item);
    return true;
  });

  return {
    /**
     * 弹一条自绘通知。返回 true 表示已接管；false 表示调用方应退回系统原生通知。
     *
     * @param {object} payload { title, body, sessionId, kind, duration }
     */
    show(payload) {
      try {
        create(normalizePayload(payload));
        return true;
      } catch (err) {
        console.warn('[notification] 自绘通知创建失败，退回系统通知:', err);
        return false;
      }
    },
    /** 退出前收干净，避免残留窗口挂在桌面上。 */
    closeAll() {
      for (const item of active.slice()) dismiss(item);
    },
    /** 供测试与排障查询当前屏上还有几条。 */
    count() {
      return active.length;
    },
  };
}

module.exports = {
  registerNotificationWindow,
  supportsMica,
  micaSupportedFor,
  normalizePayload,
  WIDTH,
  HEIGHT,
  MAX_VISIBLE,
  TITLE_MAX,
  BODY_MAX,
};
 
