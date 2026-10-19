const path = require('node:path');

/**
 * 延迟取 electron 运行时。
 *
 * <p>本模块里只有建窗口与取屏幕才真正需要 electron；把 require 提到顶层会让这个文件
 * 在纯 node 下（单元测试）直接崩掉，而其中的 {@link normalizePayload} 是纯函数，最值得被测。</p>
 */
function electron() {
  return require('electron');
}

// ---------------------------------------------------------------- 常量

/** 通知卡片尺寸：宽度取 Windows 原生 Toast 的观感（略宽一点以容纳中文标题）。 */
const WIDTH = 384;
const HEIGHT = 116;
/**
 * 卡片四周留给「光晕 / 投影」的余量。
 *
 * <p>没有这一圈，卡片铺满整个窗口，CSS 的外发光与投影会被窗口边缘直接裁掉 ——
 * 浅色主题下白玻璃贴在白色背景上就彻底消失了（实测踩过）。窗口因此比卡片大一圈。</p>
 *
 * <p><b>必须与 `notification.css` 里 body 的 padding 保持一致。</b></p>
 */
const GLOW_PAD = 22;
/** 卡片间距与距工作区边缘的留白。 */
const GAP = 8;
const MARGIN = 14;
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
 * 允许的提示音 id。
 *
 * <p>必须与渲染层 `src/notification/sound.ts` 的 `SOUND_IDS` 一致 —— 少一项的表现是
 * 「设置里能选、真通知不出声」，测试里有专门一条盯两端一致。</p>
 */
const KNOWN_SOUNDS = ['none', 'chime', 'marimba', 'bell', 'pop'];

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
  // null 表示「这条通知不出声」：静音由渲染层决定要不要发，主进程不理解「关掉」这个状态
  const sound = KNOWN_SOUNDS.includes(source.sound) ? source.sound : null;
  return { title, body, sessionId, kind, duration, theme, sound };
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
 * 定义，应用连背景色都改不了，想要「纯黑 + 发光边框」或「毛玻璃」在原生通知里无解。
 * 所以这里自建一个无边框、置顶、不进任务栏的窗口，样式全由页面 CSS 决定。</p>
 *
 * <p><b>代价（必须明确）：</b>自绘窗口不进 Windows 通知中心、不受专注助手拦截、也没有
 * 系统级的通知音与优先级。这是用「样式自由」换来的，属于产品层面的取舍。</p>
 */
function registerNotificationWindow({ ipcMain, getWindow, isDev, frontendRoot }) {
  /** 活动通知，索引 0 是最新的一条（贴右下角），其余依次上移。 */
  const active = [];
  let seq = 0;

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
    // 窗口尺寸 = 卡片 + 两侧光晕余量
    const windowWidth = WIDTH + GLOW_PAD * 2;
    const windowHeight = HEIGHT + GLOW_PAD * 2;
    // 相邻两条窗口的垂直步长：卡片高 + 上下光晕 + 视觉间距
    const step = windowHeight + GAP;
    active.forEach((item, index) => {
      if (!item.win || item.win.isDestroyed()) return;
      // 让「卡片」的右边缘与底边缘各自距工作区 MARGIN；窗口本身多出来的一圈是透明光晕区
      const x = area.x + area.width - MARGIN - windowWidth + GLOW_PAD;
      const y = area.y + area.height - MARGIN - windowHeight + GLOW_PAD - index * step;
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
    // 一律用透明窗口：卡片四周要留出光晕/投影的余量，那一圈必须是透的，
    // 否则深色主题下会是黑框、浅色主题下会是白框，比没有还难看。
    // 代价是丢掉 DWM 系统投影 —— 投影改由 CSS 自己画，反而更可控。
    const win = new BrowserWindow({
      width: WIDTH + GLOW_PAD * 2,
      height: HEIGHT + GLOW_PAD * 2,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // 不抢焦点：用户正在别的应用里打字时，通知不该把光标抢走
      focusable: false,
      webPreferences: {
        preload: path.join(__dirname, 'notification-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        // 卡片有入场动画，节流会让动画在小窗里卡顿
        backgroundThrottling: false,
        // 提示音走 Web Audio，这里显式声明依赖而不是吃默认值：
        // 音频栈被挂起时的表现是「设置里能试听、真通知没声」，极难定位
        autoplayPolicy: 'no-user-gesture-required',
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
  normalizePayload,
  KNOWN_SOUNDS,
  WIDTH,
  HEIGHT,
  GLOW_PAD,
  MAX_VISIBLE,
  TITLE_MAX,
  BODY_MAX,
};
 
