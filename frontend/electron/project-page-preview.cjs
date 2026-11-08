/** 原生网页使用独立会话，不能继承主页面的 preload 与系统能力。 */
const CHANNELS = Object.freeze({
  navigate: 'project-page:navigate',
  layout: 'project-page:layout',
  close: 'project-page:close',
  event: 'project-page:event',
});
const PARTITION = 'persist:lingxi-project-pages';

function normalizeTargetUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('目标页面地址不能为空');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('目标页面地址格式不正确'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('页面地址必须使用 http/https 协议');
  if (url.username || url.password) throw new Error('页面地址不能包含账号密码');
  return url.href;
}

function normalizeTargetOrigin(value) {
  return new URL(normalizeTargetUrl(value)).origin;
}

function normalizeGeneration(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('页面预览序号不正确');
  return value;
}

function normalizeLayout(request) {
  const bounds = request && request.bounds;
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]) && Math.abs(bounds[key]) <= 100000)) {
    throw new Error('页面预览区域尺寸不正确');
  }
  if (bounds.width < 0 || bounds.height < 0 || typeof request.visible !== 'boolean') throw new Error('页面预览区域状态不正确');
  return {visible: request.visible, bounds: {
    x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height),
  }};
}

function registerProjectPagePreview({ipcMain, getWindow, WebContentsView, session}) {
  const states = new Map();
  let previewSession;

  const destroyView = state => {
    const view = state.view;
    state.view = null;
    if (!view) return;
    if (!state.window.isDestroyed()) state.window.contentView.removeChildView(view);
    const contents = view.webContents;
    if (contents && !contents.isDestroyed()) contents.close({waitForBeforeUnload: false});
  };

  const release = state => {
    destroyView(state);
    state.host.removeListener('destroyed', state.release);
    state.host.removeListener('did-start-navigation', state.hostNavigation);
    states.delete(state.key);
  };

  const assertSender = event => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('页面预览只能从主窗口主框架发起');
    }
    return window;
  };

  const getState = window => {
    const host = window.webContents;
    let state = states.get(host.id);
    if (!state) {
      state = {key: host.id, window, host, generation: 0, view: null, layout: null};
      state.release = () => release(state);
      // 主页面刷新后旧组件已消失，不能把原生视图留在新页面上。
      state.hostNavigation = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) release(state); };
      host.once('destroyed', state.release);
      host.on('did-start-navigation', state.hostNavigation);
      states.set(host.id, state);
    }
    return state;
  };

  const emit = (state, view, generation, payload) => {
    if (state.view === view && state.generation === generation && !state.host.isDestroyed()) {
      state.host.send(CHANNELS.event, {...payload, generation});
    }
  };

  const applyLayout = state => {
    if (!state.view || !state.layout) return;
    const scale = state.host.getZoomFactor();
    const [width, height] = state.window.getContentSize();
    const rect = state.layout.bounds;
    const x = Math.max(0, Math.min(width, Math.round(rect.x * scale)));
    const y = Math.max(0, Math.min(height, Math.round(rect.y * scale)));
    const right = Math.max(x, Math.min(width, Math.round((rect.x + rect.width) * scale)));
    const bottom = Math.max(y, Math.min(height, Math.round((rect.y + rect.height) * scale)));
    state.view.setBounds({x, y, width: right - x, height: bottom - y});
    state.view.setVisible(state.layout.visible && right > x && bottom > y);
  };

  const createView = (state, generation) => {
    if (!previewSession) {
      previewSession = session.fromPartition(PARTITION);
      previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      previewSession.setPermissionCheckHandler(() => false);
      previewSession.on('will-download', event => event.preventDefault());
    }
    const view = new WebContentsView({webPreferences: {
      session: previewSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    }});
    state.view = view;
    view.setVisible(false);
    state.window.contentView.addChildView(view);
    const contents = view.webContents;
    const send = payload => emit(state, view, generation, payload);
    const fail = (errorCode, errorDescription, url) => send({type: 'did-fail-load', errorCode, errorDescription, url});
    const guardNavigation = (event, url) => {
      try { normalizeTargetUrl(url); } catch (error) {
        event.preventDefault();
        fail(-301, error.message, url);
      }
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) send({type: 'did-start-loading', url});
    });
    contents.on('did-navigate', (_event, url) => send({type: 'did-navigate', url}));
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
      if (mainFrame) send({type: 'did-navigate', url});
    });
    contents.on('did-finish-load', () => send({type: 'did-finish-load', url: contents.getURL()}));
    contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      if (mainFrame && code !== -3) fail(code, description, url);
    });
    contents.on('render-process-gone', (_event, details) => fail(0, `网页进程已退出: reason=${details.reason}`, contents.getURL()));
    const load = url => {
      void contents.loadURL(url).catch(error => {
        if (error.code !== 'ERR_ABORTED') fail(error.errno || 0, error.message, url);
      });
    };
    // 新窗口链接留在当前预览内，远程页面不能创建带系统能力的窗口。
    contents.setWindowOpenHandler(({url}) => {
      try { load(normalizeTargetUrl(url)); } catch (error) { fail(-301, error.message, url); }
      return {action: 'deny'};
    });
    applyLayout(state);
    return load;
  };

  const handle = (channel, action) => ipcMain.handle(channel, (event, request) => {
    try {
      const window = assertSender(event);
      const generation = normalizeGeneration(request && request.generation);
      return {ok: true, data: action(getState(window), request, generation)};
    } catch (error) {
      return {ok: false, error: error.message};
    }
  });

  handle(CHANNELS.navigate, (state, request, generation) => {
    const url = normalizeTargetUrl(request.url);
    if (generation <= state.generation) throw new Error('页面预览请求已过期');
    destroyView(state);
    state.generation = generation;
    state.layout = null;
    createView(state, generation)(url);
    return {generation};
  });
  handle(CHANNELS.layout, (state, request, generation) => {
    if (generation !== state.generation || !state.view) return {applied: false};
    state.layout = normalizeLayout(request);
    applyLayout(state);
    return {applied: true};
  });
  handle(CHANNELS.close, (state, _request, generation) => {
    if (generation < state.generation) return {released: false};
    state.generation = generation;
    destroyView(state);
    state.layout = null;
    return {released: true};
  });

  return {close: () => {
    for (const state of [...states.values()]) release(state);
    for (const channel of [CHANNELS.navigate, CHANNELS.layout, CHANNELS.close]) ipcMain.removeHandler(channel);
  }};
}

module.exports = {registerProjectPagePreview, normalizeTargetUrl, normalizeTargetOrigin, normalizeGeneration, normalizeLayout, CHANNELS};
