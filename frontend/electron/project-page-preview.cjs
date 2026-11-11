/** 标签与网页实例由主进程持有，远程内容不能继承主页面的系统能力。 */
const {randomUUID} = require('node:crypto');
const CHANNELS = Object.freeze({
  command: 'project-page:command',
  layout: 'project-page:layout',
  event: 'project-page:event',
  showWithAgent: 'project-page:show-with-agent',
});
const PARTITION = 'persist:lingxi-project-pages';
const PROJECT_PAGE_LOAD_TIMEOUT_MS = 15000;

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

function registerProjectPagePreview({ipcMain, getWindow, WebContentsView, session, Menu, timeoutMs = PROJECT_PAGE_LOAD_TIMEOUT_MS}) {
  const states = new Map();
  let previewSession;

  const clearTimer = tab => { clearTimeout(tab.timer); tab.timer = undefined; };
  const destroyTab = (state, tab) => {
    state.tabs.delete(tab.id);
    clearTimer(tab);
    if (!state.window.isDestroyed()) state.window.contentView.removeChildView(tab.view);
    if (!tab.contents.isDestroyed()) tab.contents.close({waitForBeforeUnload: false});
  };
  const destroyTabs = state => {
    for (const tab of [...state.tabs.values()]) destroyTab(state, tab);
    state.activeTabId = '';
  };
  const release = state => {
    destroyTabs(state);
    state.host.removeListener('destroyed', state.release);
    state.host.removeListener('did-start-navigation', state.hostNavigation);
    states.delete(state.key);
  };
  const assertSender = event => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('页面预览只能从主窗口主框架发起');
    }
    return window;
  };
  const getState = window => {
    let state = states.get(window.webContents.id);
    if (!state) {
      const host = window.webContents;
      state = {key: host.id, window, host, generation: 0, revision: 0, closed: true, tabs: new Map(), activeTabId: '', layout: null};
      state.release = () => release(state);
      state.hostNavigation = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) release(state); };
      host.once('destroyed', state.release);
      host.on('did-start-navigation', state.hostNavigation);
      states.set(host.id, state);
    }
    return state;
  };
  const snapshot = state => ({
    generation: state.generation, revision: ++state.revision, activeTabId: state.activeTabId,
    tabs: [...state.tabs.values()].map(tab => ({
      id: tab.id, url: tab.url, title: tab.title, favicon: tab.favicon,
      loadState: tab.loadState, isLoading: tab.isLoading, errorCode: tab.errorCode, errorDescription: tab.errorDescription,
      canGoBack: !tab.contents.isDestroyed() && tab.contents.navigationHistory.canGoBack(),
      canGoForward: !tab.contents.isDestroyed() && tab.contents.navigationHistory.canGoForward(),
    })),
  });
  const publish = state => {
    const value = snapshot(state);
    if (!state.host.isDestroyed()) state.host.send(CHANNELS.event, value);
    return value;
  };
  const applyLayout = state => {
    const scale = state.host.getZoomFactor();
    const [width, height] = state.window.getContentSize();
    const rect = state.layout?.bounds ?? {x: 0, y: 0, width: 0, height: 0};
    const x = Math.max(0, Math.min(width, Math.round(rect.x * scale)));
    const y = Math.max(0, Math.min(height, Math.round(rect.y * scale)));
    const right = Math.max(x, Math.min(width, Math.round((rect.x + rect.width) * scale)));
    const bottom = Math.max(y, Math.min(height, Math.round((rect.y + rect.height) * scale)));
    for (const tab of state.tabs.values()) {
      tab.view.setBounds({x, y, width: right - x, height: bottom - y});
      tab.view.setVisible(Boolean(state.layout?.visible && tab.id === state.activeTabId && tab.url && right > x && bottom > y));
    }
  };
  const requireTab = (state, id) => {
    const tab = state.tabs.get(id);
    if (!tab) throw new Error('网页标签已关闭，请重新打开');
    return tab;
  };
  const load = (tab, url, options) => {
    tab.url = normalizeTargetUrl(url);
    tab.committedNavigation = false;
    // 加载失败以原生事件为准，取消旧导航产生的 Promise 拒绝不能污染新页面。
    void tab.contents.loadURL(tab.url, options).catch(() => undefined);
  };

  const createTab = (state, {url, background = false, options} = {}) => {
    if (!previewSession) {
      previewSession = session.fromPartition(PARTITION);
      previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      previewSession.setPermissionCheckHandler(() => false);
      previewSession.on('will-download', event => event.preventDefault());
    }
    const view = new WebContentsView({webPreferences: {
      session: previewSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    }});
    const tab = {id: randomUUID(), view, contents: view.webContents, url: '', title: '', favicon: '', loadState: 'idle',
      isLoading: false, committedNavigation: false, errorCode: 0, errorDescription: '', timer: undefined};
    state.tabs.set(tab.id, tab);
    if (!background || !state.activeTabId) state.activeTabId = tab.id;
    view.setVisible(false);
    state.window.contentView.addChildView(view);
    const contents = tab.contents;
    const current = () => state.tabs.get(tab.id) === tab;
    const send = () => { if (current()) { applyLayout(state); publish(state); } };
    const fail = (code, description) => {
      if (!current()) return;
      clearTimer(tab);
      tab.isLoading = false;
      tab.loadState = 'failed';
      tab.errorCode = code;
      tab.errorDescription = description;
      send();
    };
    const guardNavigation = (event, target) => {
      try { normalizeTargetUrl(target); } catch (error) { event.preventDefault(); fail(-301, error.message); }
    };
    contents.on('context-menu', (_event, params) => {
      let menuClass = Menu;
      if (!menuClass) {
        try { menuClass = require('electron').Menu; } catch { menuClass = undefined; }
      }
      if (!menuClass) return;
      const hasText = Boolean(params.selectionText && params.selectionText.trim());
      const template = [
        {
          label: hasText ? 'Show with Agent (分析选中文本与页面)' : 'Show with Agent (让 Agent 分析此页面)',
          click: async () => {
            try {
              const image = await contents.capturePage();
              const buffer = image.toPNG();
              if (!state.host.isDestroyed()) {
                state.host.send(CHANNELS.showWithAgent, {
                  tabId: tab.id,
                  url: tab.url,
                  title: tab.title,
                  selectionText: params.selectionText ? params.selectionText.trim() : '',
                  imageBuffer: buffer,
                });
              }
            } catch (error) {
              console.error('Show with Agent capturePage failed:', error);
            }
          },
        },
        { type: 'separator' },
        {
          label: '返回',
          enabled: !contents.isDestroyed() && contents.navigationHistory && contents.navigationHistory.canGoBack(),
          click: () => { if (contents.navigationHistory && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); },
        },
        {
          label: '前进',
          enabled: !contents.isDestroyed() && contents.navigationHistory && contents.navigationHistory.canGoForward(),
          click: () => { if (contents.navigationHistory && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); },
        },
        {
          label: '重新加载',
          enabled: Boolean(tab.url),
          click: () => contents.reload(),
        },
      ];
      const menu = menuClass.buildFromTemplate(template);
      menu.popup({ window: state.window });
    });
    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('content-bounds-updated', event => event.preventDefault());
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!current() || !mainFrame || inPlace) return;
      clearTimer(tab);
      tab.committedNavigation = false;
      tab.isLoading = true;
      tab.loadState = 'loading';
      tab.errorCode = 0;
      tab.errorDescription = '';
      tab.timer = setTimeout(() => {
        tab.timer = undefined;
        if (current() && tab.loadState === 'loading') { tab.loadState = 'timeout'; send(); }
      }, timeoutMs);
      send();
    });
    const updateUrl = url => {
      try { tab.url = normalizeTargetUrl(url); } catch { return; }
      send();
    };
    contents.on('did-navigate', (_event, url) => { tab.committedNavigation = true; updateUrl(url); });
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) updateUrl(url); });
    contents.on('page-title-updated', (_event, title) => { tab.title = title; send(); });
    contents.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons.find(url => { try { normalizeTargetUrl(url); return true; } catch { return false; } }) ?? '';
      send();
    });
    contents.on('did-finish-load', () => {
      // 旧错误页的完成事件可能迟到，不能结束尚未提交的新导航。
      if (!current() || !tab.committedNavigation || contents.getURL() !== tab.url) return;
      clearTimer(tab);
      tab.isLoading = false;
      if (tab.loadState !== 'failed') tab.loadState = 'loaded';
      send();
    });
    contents.on('did-stop-loading', () => {
      if (!current() || contents.isLoadingMainFrame()) return;
      tab.isLoading = false;
      if (tab.loadState === 'loading') { clearTimer(tab); tab.loadState = 'stopped'; }
      send();
    });
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => { if (mainFrame && code !== -3) fail(code, description); });
    contents.on('render-process-gone', (_event, details) => fail(0, `网页进程已退出: reason=${details.reason}`));
    contents.setWindowOpenHandler(details => {
      if (!current()) return {action: 'deny'};
      try {
        const url = normalizeTargetUrl(details.url);
        const post = details.postBody;
        const options = {httpReferrer: details.referrer};
        if (post) {
          options.postData = post.data;
          options.extraHeaders = `Content-Type: ${post.contentType}${post.boundary ? '; boundary=' + post.boundary : ''}`;
        }
        createTab(state, {url, background: details.disposition === 'background-tab', options});
        applyLayout(state);
        publish(state);
      } catch (error) { fail(-301, error.message); }
      return {action: 'deny'};
    });
    if (url) load(tab, url, options);
    return tab;
  };

  const command = (state, request) => {
    switch (request.action) {
      case 'sync': if (!state.tabs.size) createTab(state); break;
      case 'create': {
        const url = request.url === undefined ? undefined : normalizeTargetUrl(request.url);
        createTab(state, {url}); break;
      }
      case 'activate': state.activeTabId = requireTab(state, request.tabId).id; break;
      case 'close-tab': {
        const tab = requireTab(state, request.tabId);
        const ids = [...state.tabs.keys()];
        const index = ids.indexOf(tab.id);
        destroyTab(state, tab);
        if (state.activeTabId === tab.id) state.activeTabId = ids[index + 1] ?? ids[index - 1] ?? '';
        if (!state.tabs.size) createTab(state);
        break;
      }
      case 'navigate': {
        const url = normalizeTargetUrl(request.url);
        const tab = request.tabId ? requireTab(state, request.tabId) : state.tabs.get(state.activeTabId) ?? createTab(state);
        load(tab, url); break;
      }
      case 'back': case 'forward': case 'reload': case 'stop': {
        const tab = requireTab(state, request.tabId);
        const contents = tab.contents;
        if (request.action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        if (request.action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        if (request.action === 'reload' && tab.url) contents.reload();
        if (request.action === 'stop') { clearTimer(tab); contents.stop(); tab.isLoading = false; tab.loadState = 'stopped'; }
        break;
      }
      case 'show-with-agent': {
        const tab = request.tabId ? requireTab(state, request.tabId) : (state.tabs.get(state.activeTabId) ?? requireTab(state, ''));
        return tab.contents.capturePage().then(image => {
          const buffer = image.toPNG();
          const payload = {
            tabId: tab.id,
            url: tab.url,
            title: tab.title,
            selectionText: typeof request.selectionText === 'string' ? request.selectionText.trim() : '',
            imageBuffer: buffer,
          };
          if (!state.host.isDestroyed()) {
            state.host.send(CHANNELS.showWithAgent, payload);
          }
          return payload;
        });
      }
      case 'close': destroyTabs(state); state.closed = true; state.layout = null; break;
      default: throw new Error('不支持此网页标签操作');
    }
    applyLayout(state);
    return publish(state);
  };
  const handle = (channel, action) => ipcMain.handle(channel, (event, request) => {
    try {
      const window = assertSender(event);
      const generation = normalizeGeneration(request?.generation);
      const state = getState(window);
      if (generation < state.generation || (state.closed && generation <= state.generation)) throw new Error('页面预览请求已过期');
      if (generation > state.generation) {
        destroyTabs(state); state.generation = generation; state.revision = 0; state.closed = false; state.layout = null;
      }
      const data = action(state, request);
      if (data && typeof data.then === 'function') {
        return data.then(resolved => ({ok: true, data: resolved})).catch(error => ({ok: false, error: error.message}));
      }
      return {ok: true, data};
    } catch (error) { return {ok: false, error: error.message}; }
  });
  handle(CHANNELS.command, command);
  handle(CHANNELS.layout, (state, request) => {
    state.layout = normalizeLayout(request);
    applyLayout(state);
    return {applied: true};
  });
  return {close: () => {
    for (const state of [...states.values()]) release(state);
    ipcMain.removeHandler(CHANNELS.command);
    ipcMain.removeHandler(CHANNELS.layout);
  }};
}
module.exports = {registerProjectPagePreview, normalizeTargetUrl, normalizeTargetOrigin, normalizeGeneration, normalizeLayout, CHANNELS, PROJECT_PAGE_LOAD_TIMEOUT_MS};
