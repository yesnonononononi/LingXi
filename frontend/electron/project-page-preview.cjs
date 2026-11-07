/**
 * 项目页面预览（阶段一）的主进程诊断模块。
 *
 * <p>职责只有一件事：把**目标 iframe** 的加载事件转发给渲染层，作为「已收到页面加载事件 / 已确认失败」的证据。
 * 它不代理网络、不读写文件、不给页面任何 Node 能力。</p>
 *
 * <p>三条口径（与 docs/project-page-designer-plan.zh-CN.md 第 5 节一致）：</p>
 * <ol>
 *   <li>来源校验必须同时看 {@code event.sender} 与 {@code event.senderFrame}：只看 sender 时，
 *       用户页面里的注入点也能借用主窗口 webContents 的身份调进来。</li>
 *   <li>只上报「URL 的 origin 等于目标 origin 的**子 frame**」的事件（frame 级 navigate / finish / fail）；
 *       主 frame 是 LingXi 自己的页面，它的导航（开发态刷新、路由变化触发的整页跳转）不能当成项目页面的事件。</li>
 *   <li>unwatch 与 webContents destroyed 都要摘监听器，避免窗口销毁后仍向已死 webContents send。</li>
 * </ol>
 *
 * <p>为什么用 `did-frame-navigate` / `did-frame-finish-load` 而不是 `did-start-loading` / `did-finish-load`：
 * 后者是「标签页」级别的事件，`did-start-loading` 对空载与被立刻取消的空导航也会触发（实测「上报了开始、
 * 随后 did-stop-loading、却永远没有完成事件」），而 `did-finish-load` 只在**主 frame** 完成时触发，
 * 子 frame 的完成永远不会经过它。用标签级事件既会误报开始、又收不到完成，界面就会从
 * 「已收到页面加载事件」退回「正在尝试加载」。frame 级事件带 URL 与响应码，是更诚实的证据来源；
 * 本模块仍只用 `mainFrame.frames` 的 URL 快照做 origin 匹配，不把 frameRoutingId 泄漏到渲染层。</p>
 */
const CHANNELS = Object.freeze({
  watch: 'project-page:watch',
  unwatch: 'project-page:unwatch',
  event: 'project-page:event',
});

/** 与 `file-preview.cjs` 的 `resolveLocalBase` 保持同一份回环口径。 */
const ALLOWED_HOSTNAMES = Object.freeze(['localhost', '127.0.0.1', '[::1]']);

/** ERR_ABORTED：正常取消（换地址、销毁 iframe）也会报这个码，不作为失败证据上报。 */
const ERR_ABORTED = -3;

/** frame 树最大遍历深度：只防病态嵌套，不是安全边界。 */
const MAX_FRAME_DEPTH = 8;

/**
 * 校验并规范化目标 origin。
 *
 * @param {string} value 渲染层提交的 origin（完整 URL 也可）。
 * @returns {string} 规范化 origin。
 * @throws {Error} 协议 / 主机 / 端口 / 凭据不合法时抛出。
 */
function normalizeTargetOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('目标页面地址不能为空');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('目标页面地址格式不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('只支持 http/https 的本机页面地址');
  }
  if (!ALLOWED_HOSTNAMES.includes(url.hostname)) {
    throw new Error('只支持本机回环地址的页面');
  }
  if (!url.port) {
    throw new Error('页面地址必须带明确的端口');
  }
  if (url.username || url.password) {
    throw new Error('页面地址不能包含账号密码');
  }
  return url.origin;
}

/**
 * 校验 generation 序号。
 *
 * @param {number} value 渲染层提交的序号。
 * @returns {number} 合法的正整数序号。
 */
function normalizeGeneration(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('页面预览序号不正确');
  }
  return value;
}

/**
 * 取 URL 的 origin；解析失败返回空串（`about:blank`、`blob:` 等一律不匹配）。
 *
 * @param {string} value 任意 URL。
 * @returns {string} origin 或空串。
 */
function safeOrigin(value) {
  if (typeof value !== 'string' || !value) {
    return '';
  }
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

/**
 * 列出 webContents 的 frame 快照。
 *
 * <p>frame 已销毁时访问 `url` 会抛异常，因此逐个 try 兜住——一个坏 frame 不能拖垮整次扫描。</p>
 *
 * @param {import('electron').WebContents} webContents 目标 webContents。
 * @returns {Array<{url: string, isMain: boolean}>} frame 列表（含主 frame）。
 */
function listFrames(webContents) {
  const frames = [];
  // frame 已销毁时访问 webContents.mainFrame 本身也可能抛（窗口正在销毁的那一帧），同样要兜住。
  let mainFrame = null;
  try {
    mainFrame = webContents ? webContents.mainFrame : null;
  } catch {
    mainFrame = null;
  }
  if (!mainFrame) {
    return frames;
  }
  const walk = (frame, depth) => {
    if (!frame || depth > MAX_FRAME_DEPTH) {
      return;
    }
    let url = '';
    try {
      url = typeof frame.url === 'string' ? frame.url : '';
    } catch {
      url = '';
    }
    frames.push({ url, isMain: frame === mainFrame });
    let children = [];
    try {
      children = Array.isArray(frame.frames) ? frame.frames : [];
    } catch {
      children = [];
    }
    for (const child of children) {
      walk(child, depth + 1);
    }
  };
  walk(mainFrame, 0);
  return frames;
}

/**
 * 找出 origin 匹配目标页面的子 frame（主 frame 永远不算）。
 *
 * @param {import('electron').WebContents} webContents 目标 webContents。
 * @param {string} origin 目标 origin。
 * @returns {string} 命中的子 frame URL；没有命中返回空串。
 */
function findTargetSubFrameUrl(webContents, origin) {
  for (const frame of listFrames(webContents)) {
    if (frame.isMain) {
      continue;
    }
    if (safeOrigin(frame.url) === origin) {
      return frame.url;
    }
  }
  return '';
}

/**
 * 注册页面预览诊断 IPC。
 *
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   getWindow: () => import('electron').BrowserWindow | null,
 * }} deps 主进程注入的 electron 能力（便于测试替换）。
 * @returns {{close: () => void}} 注销函数：解绑全部监听器与 handler。
 */
function registerProjectPagePreview({ ipcMain, getWindow }) {
  /** webContents.id -> {webContents, origin, generation, listeners} */
  const sessions = new Map();

  /**
   * 来源校验：主窗口的**主 frame** 才能订阅/退订。
   *
   * @param {import('electron').IpcMainInvokeEvent} event IPC 事件。
   * @throws {Error} 窗口不可用或来源不是主窗口主 frame 时抛出。
   */
  const assertSender = (event) => {
    const window = typeof getWindow === 'function' ? getWindow() : null;
    if (!window || window.isDestroyed() || !window.webContents) {
      throw new Error('页面预览窗口不可用');
    }
    if (event.sender !== window.webContents) {
      throw new Error('页面预览只能从主窗口发起');
    }
    const mainFrame = window.webContents.mainFrame;
    if (!event.senderFrame || event.senderFrame !== mainFrame) {
      throw new Error('页面预览只能从主窗口主框架发起');
    }
  };

  /**
   * 向订阅方推送一条诊断事件。
   *
   * @param {object} session 订阅会话。
   * @param {object} payload 事件体（不含 generation，统一在此补）。
   */
  const emit = (session, payload) => {
    const webContents = session.webContents;
    if (!webContents || webContents.isDestroyed()) {
      return;
    }
    webContents.send(CHANNELS.event, { ...payload, generation: session.generation });
  };

  /**
   * 摘掉订阅会话上的全部监听器。
   *
   * @param {object|undefined} session 订阅会话。
   */
  const detach = (session) => {
    if (!session) {
      return;
    }
    const { webContents, listeners } = session;
    sessions.delete(session.key);
    if (!webContents || webContents.isDestroyed()) {
      return;
    }
    for (const [name, handler] of listeners) {
      try {
        webContents.removeListener(name, handler);
      } catch {
        /* 已销毁的 webContents 直接忽略 */
      }
    }
    listeners.clear();
  };

  /**
   * 为 webContents 建立一次订阅（同一 webContents 只保留最新的 origin + generation）。
   *
   * @param {import('electron').WebContents} webContents 订阅方 webContents。
   * @param {string} origin 目标页面 origin。
   * @param {number} generation 加载尝试序号。
   */
  const attach = (webContents, origin, generation) => {
    const key = webContents.id;
    detach(sessions.get(key));
    const session = { key, webContents, origin, generation, listeners: new Map() };

    /**
     * 目标子 frame 真正开始一次导航。
     *
     * <p>不用 webContents 的 `did-start-loading`：它是「标签页转圈」级别的事件，空载、被立刻取消的空导航
     * 也会触发，实测会出现「报了一个开始、随后 did-stop-loading、却永远没有完成事件」的假开始，
     * 让界面从「已收到页面加载事件」倒退回「正在尝试加载」。`did-frame-navigate` 带着 URL 与响应码，
     * 是真正的 frame 级导航证据。</p>
     */
    const onFrameNavigate = (_event, url, httpResponseCode, httpStatusText, isMainFrame) => {
      // 主 frame 是 LingXi 自己的页面，它的导航不属于项目页面。
      if (isMainFrame !== false) {
        return;
      }
      if (safeOrigin(url) !== origin) {
        return;
      }
      emit(session, { type: 'did-start-loading', url: typeof url === 'string' ? url : '' });
    };

    /**
     * 目标子 frame 完成加载。
     *
     * <p>必须用 `did-frame-finish-load`：webContents 的 `did-finish-load` 只在**主 frame** 完成时触发，
     * 子 frame 的完成事件永远不会经过它——这就是「页面加载成功后收不到完成证据」的原因。</p>
     */
    const onFrameFinish = (_event, isMainFrame) => {
      if (isMainFrame !== false) {
        return;
      }
      const url = findTargetSubFrameUrl(webContents, origin);
      if (url) {
        emit(session, { type: 'did-finish-load', url });
      }
    };
    const onFail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // 只报子 frame：主 frame 是应用自身页面，它的失败不属于项目页面。
      if (isMainFrame !== false) {
        return;
      }
      if (safeOrigin(validatedURL) !== origin) {
        return;
      }
      if (errorCode === ERR_ABORTED) {
        return;
      }
      emit(session, {
        type: 'did-fail-load',
        url: typeof validatedURL === 'string' ? validatedURL : '',
        errorCode: Number(errorCode) || 0,
        errorDescription: typeof errorDescription === 'string' ? errorDescription : '',
      });
    };
    const onDestroyed = () => {
      detach(session);
    };

    session.listeners.set('did-frame-navigate', onFrameNavigate);
    session.listeners.set('did-frame-finish-load', onFrameFinish);
    session.listeners.set('did-fail-load', onFail);
    session.listeners.set('destroyed', onDestroyed);
    for (const [name, handler] of session.listeners) {
      webContents.on(name, handler);
    }
    sessions.set(key, session);
  };

  /**
   * 统一包装 handler：来源校验 + 错误收口成 { ok, data } / { ok, error }。
   *
   * @param {(event: any, request: any) => any} handler 实际处理函数。
   * @returns {(event: any, request: any) => Promise<object>} IPC handler。
   */
  const run = (handler) => async (event, request) => {
    try {
      assertSender(event);
      return { ok: true, data: await handler(event, request) };
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '页面预览操作失败，请重试';
      return { ok: false, error: message };
    }
  };

  ipcMain.handle(CHANNELS.watch, run(async (event, request) => {
    const origin = normalizeTargetOrigin(request && request.origin);
    const generation = normalizeGeneration(request && request.generation);
    attach(event.sender, origin, generation);
    return { origin, generation };
  }));

  ipcMain.handle(CHANNELS.unwatch, run(async (event) => {
    detach(sessions.get(event.sender.id));
    return { released: true };
  }));

  return {
    close: () => {
      for (const session of [...sessions.values()]) {
        detach(session);
      }
      for (const channel of [CHANNELS.watch, CHANNELS.unwatch]) {
        try {
          ipcMain.removeHandler(channel);
        } catch {
          /* 未注册时忽略 */
        }
      }
    },
  };
}

module.exports = {
  registerProjectPagePreview,
  normalizeTargetOrigin,
  normalizeGeneration,
  CHANNELS,
  ALLOWED_HOSTNAMES,
};
