/** 标签与网页实例由主进程持有，远程内容不能继承主页面的系统能力。 */
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {buildPageScript, runPageScript} = require('./mcp/page-scripts.cjs');
const {MAX_LOG_ENTRIES, normalizeConsoleLevel, appendRingBuffer, normalizeHeaders, resolveContentType, MAX_STORED_RESPONSE_BODY_CHARS} = require('./mcp/logs.cjs');
const {listTools} = require('./mcp/registry.cjs');
const CHANNELS = Object.freeze({
  command: 'project-page:command',
  layout: 'project-page:layout',
  labels: 'project-page:labels',
  event: 'project-page:event',
  showWithAgent: 'project-page:show-with-agent',
  ensureOpen: 'project-page:ensure-open',
});
const PARTITION = 'persist:lingxi-project-pages';
const PROJECT_PAGE_LOAD_TIMEOUT_MS = 15000;
/** 原生视图底色与面板 `--file-bg` 对齐，避免暗色模式下重排或重绘瞬间透出默认白底。 */
const VIEW_BG_COLORS = Object.freeze({dark: '#0c0e13', light: '#ffffff'});
/** 右键菜单兜底文案：渲染层来不及推送语言时，菜单也只能是单语言，不能中英混排。 */
const DEFAULT_MENU_LABELS = Object.freeze({
  showWithAgent: '让 Agent 分析此页面',
  showWithAgentWithSelection: '让 Agent 分析选中文本与页面',
  back: '后退',
  forward: '前进',
  reload: '重新加载',
});
const MENU_LABEL_KEYS = Object.keys(DEFAULT_MENU_LABELS);

const DEFAULT_INTERACTIVE_SELECTOR = [
  'a',
  'button',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'summary',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

const DEFAULT_CLICK_SELECTOR = [
  'button',
  'a',
  'summary',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * browser_query 的页面脚本。
 *
 * <p>脚本体在 electron/page-scripts/query.js：这里只保留入口名，既有调用点与测试继续可用。</p>
 */
function buildQueryScript({customSelector = '', maxItems = 40, defaultSelector = DEFAULT_INTERACTIVE_SELECTOR} = {}) {
  return buildPageScript('query', {customSelector, maxItems, defaultSelector});
}

function normalizeMenuLabels(request) {
  const labels = {...DEFAULT_MENU_LABELS};
  if (!request || typeof request !== 'object') return labels;
  for (const key of MENU_LABEL_KEYS) {
    const value = request[key];
    if (typeof value === 'string' && value.trim() && value.length <= 200) labels[key] = value.trim();
  }
  return labels;
}

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

const DEFAULT_SCREENSHOT_VIEWPORT = Object.freeze({width: 1280, height: 800});
function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
}

async function withDebugger(contents, fn) {
  const dbg = contents?.debugger;
  if (!dbg || typeof dbg.sendCommand !== 'function') {
    throw new Error('当前网页实例不支持 CDP debugger');
  }
  const attachedByUs = typeof dbg.isAttached === 'function' ? !dbg.isAttached() : false;
  if (attachedByUs) dbg.attach('1.3');
  try {
    return await fn(dbg);
  } finally {
    if (attachedByUs && typeof dbg.isAttached === 'function' && dbg.isAttached()) {
      dbg.detach();
    }
  }
}

function registerProjectPagePreview({ipcMain, getWindow, WebContentsView, session, Menu, nativeTheme, nativeImage, designBridge = null, timeoutMs = PROJECT_PAGE_LOAD_TIMEOUT_MS}) {
  const states = new Map();
  const tabsByContentsId = new Map();
  const pendingRequests = new Map();
  let networkSeq = 0;
  const nextRequestId = () => `req-${++networkSeq}`;
  let previewSession;
  // 菜单文案由渲染层按当前语言推送，主进程不做翻译。
  let menuLabels = DEFAULT_MENU_LABELS;
  let darkTheme = Boolean(nativeTheme?.shouldUseDarkColors);

  const applyViewTheme = view => {
    if (typeof view?.setBackgroundColor === 'function') {
      view.setBackgroundColor(darkTheme ? VIEW_BG_COLORS.dark : VIEW_BG_COLORS.light);
    }
  };

  const clearTimer = tab => { clearTimeout(tab.timer); tab.timer = undefined; };
  const clearAgentOverlayTimer = tab => { clearTimeout(tab.agentOverlayTimer); tab.agentOverlayTimer = undefined; };
  const isAgentGlowActive = tab => Boolean(tab?.openedByAgent && !tab?.agentGlowDismissed);
  const syncAgentOverlay = async (tab, {forceHide = false, waitForPaint = false} = {}) => {
    const contents = tab?.contents;
    if (!contents || contents.isDestroyed() || typeof contents.executeJavaScript !== 'function') return;
    const glowVisible = !forceHide && isAgentGlowActive(tab);
    const busyVisible = !forceHide && Boolean(tab.agentBusy);
    const script = `(() => {
      const HOST_ID = '__lingxi_agent_overlay_host__';
      const glowVisible = ${glowVisible};
      const busyVisible = ${busyVisible};
      if (!glowVisible && !busyVisible) {
        try { document.querySelectorAll('[data-lx-agent-flash]').forEach(n => n.remove()); } catch {}
      }
      const existing = document.getElementById(HOST_ID);
      if (!glowVisible && !busyVisible) {
        if (existing) existing.remove();
        if (${Boolean(waitForPaint)} && typeof requestAnimationFrame === 'function') {
          return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        }
        return;
      }
      const rootEl = document.documentElement || document.body;
      if (!rootEl) return;
      let host = existing;
      if (!host) {
        host = document.createElement('div');
        host.id = HOST_ID;
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;background:transparent;';
        const shadow = host.attachShadow({ mode: 'closed' });
        shadow.innerHTML = \`
          <style>
            @keyframes lingxi-ring-pulse {
              0%, 100% {
                box-shadow:
                  inset 0 0 18px 2px rgba(59, 130, 246, 0.28),
                  inset 0 0 56px 12px rgba(37, 99, 235, 0.20),
                  inset 0 0 110px 24px rgba(59, 130, 246, 0.10);
              }
              50% {
                box-shadow:
                  inset 0 0 24px 4px rgba(96, 165, 250, 0.38),
                  inset 0 0 72px 18px rgba(59, 130, 246, 0.28),
                  inset 0 0 130px 32px rgba(37, 99, 235, 0.15);
              }
            }
            @keyframes lingxi-spin {
              to { transform: rotate(360deg); }
            }
            .ring {
              position: fixed;
              inset: 0;
              pointer-events: none;
              animation: lingxi-ring-pulse 2.4s ease-in-out infinite;
            }
            .banner {
              position: fixed;
              top: 14px;
              left: 50%;
              transform: translateX(-50%);
              display: inline-flex;
              align-items: center;
              gap: 8px;
              padding: 6px 14px;
              border-radius: 9999px;
              background: rgba(15, 23, 42, 0.86);
              border: 1px solid rgba(96, 165, 250, 0.55);
              box-shadow: 0 6px 20px rgba(37, 99, 235, 0.28);
              backdrop-filter: blur(8px);
              color: #eff6ff;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
              font-size: 12px;
              font-weight: 500;
              letter-spacing: 0.02em;
              white-space: nowrap;
              pointer-events: none;
              user-select: none;
            }
            .spinner {
              width: 12px;
              height: 12px;
              border-radius: 50%;
              border: 1.8px solid rgba(147, 197, 253, 0.35);
              border-top-color: #60a5fa;
              animation: lingxi-spin 0.75s linear infinite;
              flex-shrink: 0;
            }
          </style>
          <div class="ring" data-role="ring"></div>
          <div class="banner" data-role="banner">
            <span class="spinner"></span>
            <span>浏览器正在被 LingXi 操控</span>
          </div>
        \`;
        host.__lingxiShadow = shadow;
        rootEl.appendChild(host);
      }
      const shadow = host.__lingxiShadow;
      if (shadow) {
        const ring = shadow.querySelector('[data-role="ring"]');
        const banner = shadow.querySelector('[data-role="banner"]');
        if (ring) ring.style.display = glowVisible ? 'block' : 'none';
        if (banner) banner.style.display = busyVisible ? 'inline-flex' : 'none';
      }
    })()`;
    try {
      await contents.executeJavaScript(script, true);
    } catch {
      // 忽略页面尚未就绪或已销毁时的注入异常
    }
  };
  const beginAgentControl = tab => {
    clearAgentOverlayTimer(tab);
    tab.agentBusy = true;
    void syncAgentOverlay(tab);
  };
  const endAgentControl = (tab, holdMs = 800) => {
    clearAgentOverlayTimer(tab);
    tab.agentOverlayTimer = setTimeout(() => {
      tab.agentOverlayTimer = undefined;
      tab.agentBusy = false;
      void syncAgentOverlay(tab);
    }, holdMs);
  };

  const destroyTab = (state, tab) => {
    state.tabs.delete(tab.id);
    if (tab.contents && tab.contents.id !== undefined) {
      tabsByContentsId.delete(tab.contents.id);
    }
    if (Array.isArray(tab.agentResumeWaiters) && tab.agentResumeWaiters.length > 0) {
      for (const waiter of tab.agentResumeWaiters) {
        waiter.reject(new Error('网页标签已关闭，人工接管等待已取消'));
      }
      tab.agentResumeWaiters = [];
    }
    clearTimer(tab);
    clearAgentOverlayTimer(tab);
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
      agentGlowActive: isAgentGlowActive(tab),
      agentBusy: Boolean(tab.agentBusy),
      agentPaused: Boolean(tab.agentPaused),
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
  const capturePageHtml = async contents => {
    if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())
      || typeof contents.executeJavaScript !== 'function') {
      return '';
    }
    try {
      const result = await contents.executeJavaScript(
        'document.documentElement ? document.documentElement.outerHTML : ""',
      );
      return typeof result === 'string' ? result : '';
    } catch {
      return '';
    }
  };
  const captureShowWithAgentPayload = async (tab, selectionText) => {
    const [image, html] = await Promise.all([
      tab.contents.capturePage(),
      capturePageHtml(tab.contents),
    ]);
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      selectionText: typeof selectionText === 'string' ? selectionText.trim() : '',
      imageBuffer: image.toPNG(),
      html,
    };
  };
  const load = (state, tab, url, options) => {
    tab.url = normalizeTargetUrl(url);
    tab.committedNavigation = false;
    applyViewTheme(tab.view);
    // 先把非零视口与可见性落到原生视图再发起导航，否则隐藏态的新视图会让页面首屏脚本读到 0x0 视口。
    applyLayout(state);
    // 加载失败以原生事件为准，取消旧导航产生的 Promise 拒绝不能污染新页面。
    void tab.contents.loadURL(tab.url, options).catch(() => undefined);
  };

  const createTab = (state, {url, background = false, options} = {}) => {
    if (!previewSession) {
      previewSession = session.fromPartition(PARTITION);
      previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      previewSession.setPermissionCheckHandler(() => false);
      previewSession.on('will-download', event => event.preventDefault());
      if (previewSession.webRequest && typeof previewSession.webRequest.onBeforeRequest === 'function') {
        previewSession.webRequest.onBeforeRequest((details, callback) => {
          if (details && details.webContentsId !== undefined && tabsByContentsId.has(details.webContentsId)) {
            pendingRequests.set(details.id, {
              method: details.method || 'GET',
              url: details.url || '',
              resourceType: details.resourceType || '',
              startedAt: Date.now(),
              webContentsId: details.webContentsId,
              requestHeaders: {},
            });
          }
          callback({});
        });
        if (typeof previewSession.webRequest.onBeforeSendHeaders === 'function') {
          previewSession.webRequest.onBeforeSendHeaders((details, callback) => {
            const pending = details ? pendingRequests.get(details.id) : null;
            if (pending && details.requestHeaders) {
              pending.requestHeaders = normalizeHeaders(details.requestHeaders);
            }
            callback({});
          });
        }
        if (typeof previewSession.webRequest.onCompleted === 'function') {
          previewSession.webRequest.onCompleted(details => {
            const pending = pendingRequests.get(details.id);
            pendingRequests.delete(details.id);
            const targetTab = tabsByContentsId.get(details.webContentsId);
            if (!targetTab || targetTab.cdpNetworkEnabled) return;
            const responseHeaders = normalizeHeaders(details.responseHeaders);
            appendRingBuffer(targetTab.networkLogs, {
              id: nextRequestId(),
              method: details.method || pending?.method || 'GET',
              url: details.url || pending?.url || '',
              resourceType: details.resourceType || pending?.resourceType || '',
              statusCode: Number.isFinite(details.statusCode) ? details.statusCode : 0,
              ok: Number.isFinite(details.statusCode) ? details.statusCode >= 200 && details.statusCode < 400 : true,
              durationMs: pending ? Math.max(0, Date.now() - pending.startedAt) : 0,
              error: '',
              timestamp: Date.now(),
              contentType: resolveContentType(responseHeaders),
              requestHeaders: pending?.requestHeaders || {},
              responseHeaders,
              requestBody: '',
              responseBody: '',
              base64Encoded: false,
              bodyLength: 0,
              bodyCaptured: false,
              bodyUnavailableReason: 'webRequest 通道不提供响应体（CDP Network 未启用）',
              _bodyPromise: null,
            });
          });
        }
        if (typeof previewSession.webRequest.onErrorOccurred === 'function') {
          previewSession.webRequest.onErrorOccurred(details => {
            const pending = pendingRequests.get(details.id);
            pendingRequests.delete(details.id);
            const targetTab = tabsByContentsId.get(details.webContentsId);
            if (!targetTab || targetTab.cdpNetworkEnabled) return;
            appendRingBuffer(targetTab.networkLogs, {
              id: nextRequestId(),
              method: details.method || pending?.method || 'GET',
              url: details.url || pending?.url || '',
              resourceType: details.resourceType || pending?.resourceType || '',
              statusCode: 0,
              ok: false,
              durationMs: pending ? Math.max(0, Date.now() - pending.startedAt) : 0,
              error: details.error || 'net::ERR_FAILED',
              timestamp: Date.now(),
              contentType: '',
              requestHeaders: pending?.requestHeaders || {},
              responseHeaders: {},
              requestBody: '',
              responseBody: '',
              base64Encoded: false,
              bodyLength: 0,
              bodyCaptured: false,
              bodyUnavailableReason: 'webRequest 通道不提供响应体（CDP Network 未启用）',
              _bodyPromise: null,
            });
          });
        }
      }
    }
    const view = new WebContentsView({webPreferences: {
      session: previewSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    }});
    applyViewTheme(view);
    const tab = {id: randomUUID(), view, contents: view.webContents, url: '', title: '', favicon: '', loadState: 'idle',
      isLoading: false, committedNavigation: false, errorCode: 0, errorDescription: '', timer: undefined,
      openedByAgent: false, agentGlowDismissed: false, agentBusy: false, agentPaused: false, agentResumeWaiters: [], agentOverlayTimer: undefined,
      cdpNetworkEnabled: false, consoleLogs: [], networkLogs: []};
    state.tabs.set(tab.id, tab);
    if (tab.contents && tab.contents.id !== undefined) {
      tabsByContentsId.set(tab.contents.id, tab);
    }
    if (!background || !state.activeTabId) state.activeTabId = tab.id;
    view.setVisible(false);
    state.window.contentView.addChildView(view);
    const contents = tab.contents;
    if (
      contents?.debugger &&
      typeof contents.debugger.attach === 'function' &&
      typeof contents.debugger.sendCommand === 'function' &&
      typeof contents.debugger.on === 'function'
    ) {
      const dbg = contents.debugger;
      const cdpPending = new Map();
      try {
        if (typeof dbg.isAttached !== 'function' || !dbg.isAttached()) {
          dbg.attach('1.3');
        }
        tab.cdpNetworkEnabled = true;
        dbg.on('detach', () => {
          tab.cdpNetworkEnabled = false;
          cdpPending.clear();
        });
        dbg.on('message', (_event, method, params) => {
          if (!params || !params.requestId) return;
          if (method === 'Network.requestWillBeSent') {
            const req = params.request || {};
            cdpPending.set(params.requestId, {
              method: req.method || 'GET',
              url: req.url || '',
              resourceType: params.type || '',
              requestHeaders: normalizeHeaders(req.headers),
              requestBody: typeof req.postData === 'string' ? req.postData.slice(0, MAX_STORED_RESPONSE_BODY_CHARS) : '',
              responseHeaders: {},
              mimeType: '',
              statusCode: 0,
              startedAt: Date.now(),
            });
          } else if (method === 'Network.responseReceived') {
            const pending = cdpPending.get(params.requestId);
            if (!pending) return;
            const res = params.response || {};
            pending.statusCode = Number.isFinite(res.status) ? res.status : 0;
            pending.responseHeaders = normalizeHeaders(res.headers);
            pending.mimeType = typeof res.mimeType === 'string' ? res.mimeType : '';
            if (res.requestHeaders) {
              pending.requestHeaders = {...pending.requestHeaders, ...normalizeHeaders(res.requestHeaders)};
            }
          } else if (method === 'Network.loadingFinished') {
            const pending = cdpPending.get(params.requestId);
            cdpPending.delete(params.requestId);
            if (!pending) return;
            const entry = {
              id: nextRequestId(),
              method: pending.method,
              url: pending.url,
              resourceType: pending.resourceType,
              statusCode: pending.statusCode,
              ok: pending.statusCode > 0 ? pending.statusCode >= 200 && pending.statusCode < 400 : true,
              durationMs: Math.max(0, Date.now() - pending.startedAt),
              error: '',
              timestamp: Date.now(),
              contentType: resolveContentType(pending.responseHeaders, pending.mimeType),
              requestHeaders: pending.requestHeaders,
              responseHeaders: pending.responseHeaders,
              requestBody: pending.requestBody,
              responseBody: '',
              base64Encoded: false,
              bodyLength: 0,
              bodyCaptured: false,
              bodyUnavailableReason: '响应体尚未抓取完成',
              _bodyPromise: null,
            };
            appendRingBuffer(tab.networkLogs, entry);
            entry._bodyPromise = dbg.sendCommand('Network.getResponseBody', {requestId: params.requestId})
              .then(res => {
                if (res && typeof res.body === 'string') {
                  entry.bodyLength = res.body.length;
                  entry.base64Encoded = Boolean(res.base64Encoded);
                  entry.responseBody = res.body.slice(0, MAX_STORED_RESPONSE_BODY_CHARS);
                  entry.bodyCaptured = true;
                  entry.bodyUnavailableReason = '';
                }
              })
              .catch(() => {
                entry.bodyCaptured = false;
                entry.bodyUnavailableReason = '响应体已不在 CDP 缓冲（Network 缓冲被裁剪或页面已导航）';
              })
              .finally(() => {
                entry._bodyPromise = null;
              });
          } else if (method === 'Network.loadingFailed') {
            const pending = cdpPending.get(params.requestId);
            cdpPending.delete(params.requestId);
            if (!pending) return;
            appendRingBuffer(tab.networkLogs, {
              id: nextRequestId(),
              method: pending.method,
              url: pending.url,
              resourceType: pending.resourceType,
              statusCode: pending.statusCode || 0,
              ok: false,
              durationMs: Math.max(0, Date.now() - pending.startedAt),
              error: params.errorText || 'net::ERR_FAILED',
              timestamp: Date.now(),
              contentType: resolveContentType(pending.responseHeaders, pending.mimeType),
              requestHeaders: pending.requestHeaders,
              responseHeaders: pending.responseHeaders,
              requestBody: pending.requestBody,
              responseBody: '',
              base64Encoded: false,
              bodyLength: 0,
              bodyCaptured: false,
              bodyUnavailableReason: '请求失败，没有响应体',
              _bodyPromise: null,
            });
          }
        });
        Promise.resolve(dbg.sendCommand('Network.enable', {
          maxTotalBufferSize: 10 * 1024 * 1024,
          maxResourceBufferSize: 5 * 1024 * 1024,
        })).catch(() => {
          tab.cdpNetworkEnabled = false;
        });
      } catch {
        tab.cdpNetworkEnabled = false;
      }
    }
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
          label: hasText ? menuLabels.showWithAgentWithSelection : menuLabels.showWithAgent,
          click: async () => {
            try {
              const payload = await captureShowWithAgentPayload(tab, params.selectionText);
              if (!state.host.isDestroyed()) {
                state.host.send(CHANNELS.showWithAgent, payload);
              }
            } catch (error) {
              console.error(`页面截图失败: url=${tab.url}`, error);
            }
          },
        },
        { type: 'separator' },
        {
          label: menuLabels.back,
          enabled: !contents.isDestroyed() && contents.navigationHistory && contents.navigationHistory.canGoBack(),
          click: () => { if (contents.navigationHistory && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); },
        },
        {
          label: menuLabels.forward,
          enabled: !contents.isDestroyed() && contents.navigationHistory && contents.navigationHistory.canGoForward(),
          click: () => { if (contents.navigationHistory && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); },
        },
        {
          label: menuLabels.reload,
          enabled: Boolean(tab.url),
          click: () => contents.reload(),
        },
      ];
      const menu = menuClass.buildFromTemplate(template);
      menu.popup({ window: state.window });
    });
    contents.on('console-message', (event, legacyLevel, legacyMessage, legacyLine, legacySourceId) => {
      if (!current()) return;
      const isObjEvent = event && typeof event === 'object' && 'message' in event && legacyMessage === undefined;
      const level = normalizeConsoleLevel(isObjEvent ? event.level : legacyLevel);
      const message = String(isObjEvent ? event.message : (legacyMessage ?? '')).slice(0, 1000);
      const line = Number.isFinite(isObjEvent ? event.lineNumber : legacyLine)
        ? Number(isObjEvent ? event.lineNumber : legacyLine)
        : 0;
      const sourceId = String(isObjEvent ? (event.sourceId || '') : (legacySourceId || '')).slice(0, 300);
      appendRingBuffer(tab.consoleLogs, {level, message, line, sourceId, timestamp: Date.now()});
    });
    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('content-bounds-updated', event => event.preventDefault());
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!current() || !mainFrame || inPlace) return;
      clearTimer(tab);
      tab.committedNavigation = false;
      applyViewTheme(tab.view);
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
    contents.on('did-navigate', (_event, url) => { tab.committedNavigation = true; applyViewTheme(tab.view); updateUrl(url); });
    contents.on('dom-ready', () => {
      if (!current()) return;
      applyViewTheme(tab.view);
      applyLayout(state);
      if (isAgentGlowActive(tab) || tab.agentBusy) void syncAgentOverlay(tab);
    });
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
    if (url) load(state, tab, url, options);
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
        load(state, tab, url); break;
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
        return captureShowWithAgentPayload(tab, request.selectionText).then(payload => {
          if (!state.host.isDestroyed()) {
            state.host.send(CHANNELS.showWithAgent, payload);
          }
          return payload;
        });
      }
      case 'dismiss-agent-glow': {
        const tab = request.tabId ? requireTab(state, request.tabId) : (state.tabs.get(state.activeTabId) ?? requireTab(state, ''));
        tab.agentGlowDismissed = true;
        void syncAgentOverlay(tab);
        break;
      }
      case 'pause-agent': {
        const tab = request.tabId ? requireTab(state, request.tabId) : (state.tabs.get(state.activeTabId) ?? requireTab(state, ''));
        tab.agentPaused = true;
        void syncAgentOverlay(tab, {forceHide: true});
        break;
      }
      case 'resume-agent': {
        const tab = request.tabId ? requireTab(state, request.tabId) : (state.tabs.get(state.activeTabId) ?? requireTab(state, ''));
        tab.agentPaused = false;
        if (Array.isArray(tab.agentResumeWaiters) && tab.agentResumeWaiters.length > 0) {
          const waiters = tab.agentResumeWaiters.splice(0, tab.agentResumeWaiters.length);
          for (const waiter of waiters) waiter.resolve();
        }
        void syncAgentOverlay(tab);
        break;
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
  ipcMain.handle(CHANNELS.labels, (event, request) => {
    try {
      assertSender(event);
      menuLabels = normalizeMenuLabels(request);
      return {ok: true, data: {applied: true}};
    } catch (error) { return {ok: false, error: error.message}; }
  });
  const setTheme = isDark => {
    darkTheme = Boolean(isDark);
    for (const state of states.values()) {
      for (const tab of state.tabs.values()) applyViewTheme(tab.view);
    }
  };

  /** 确保主窗口存在且预览面板已就绪（供本地 MCP 等主进程调用方使用）。 */
  const ensureAutomationState = async () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) {
      throw new Error('主窗口未就绪或已关闭');
    }
    const state = getState(window);
    if (!state.host.isDestroyed()) {
      state.host.send(CHANNELS.ensureOpen, {});
    }
    const deadline = Date.now() + 2000;
    while ((state.closed || state.generation <= 0 || !state.layout?.visible) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    if (state.closed || state.generation <= 0) {
      state.closed = false;
      if (state.generation <= 0) state.generation = 1;
      if (!state.tabs.size) createTab(state);
    }
    applyLayout(state);
    return state;
  };

  const resolveAutomationTab = (state, tabId) => {
    if (typeof tabId === 'string' && tabId.trim()) {
      return requireTab(state, tabId.trim());
    }
    const active = state.tabs.get(state.activeTabId);
    if (active) return active;
    const first = state.tabs.values().next().value;
    if (first) {
      state.activeTabId = first.id;
      return first;
    }
    return createTab(state);
  };

  const waitForTabLoad = (tab, waitMs) => new Promise(resolve => {
    const contents = tab.contents;
    if (!contents || contents.isDestroyed()) {
      resolve({loadState: 'failed', errorDescription: '网页实例已销毁'});
      return;
    }
    const effectiveWaitMs = Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, 30000) : timeoutMs;
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      contents.removeListener('did-finish-load', onFinish);
      contents.removeListener('did-fail-load', onFail);
      contents.removeListener('did-stop-loading', onStop);
    };
    const finish = result => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onFinish = () => {
      if (tab.committedNavigation) finish({loadState: tab.loadState || 'loaded'});
    };
    const onFail = (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) finish({loadState: 'failed', errorCode: code, errorDescription: description});
    };
    const onStop = () => {
      if (!contents.isLoadingMainFrame()) finish({loadState: tab.loadState || 'stopped'});
    };
    contents.on('did-finish-load', onFinish);
    contents.on('did-fail-load', onFail);
    contents.on('did-stop-loading', onStop);
    timer = setTimeout(() => finish({loadState: 'timeout'}), effectiveWaitMs);
  });

  const waitUntilAgentResumed = tab => {
    if (!tab.agentPaused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (!Array.isArray(tab.agentResumeWaiters)) tab.agentResumeWaiters = [];
      tab.agentResumeWaiters.push({resolve, reject});
    });
  };

  const withAgentControl = async (tab, fn) => {
    await waitUntilAgentResumed(tab);
    beginAgentControl(tab);
    try {
      return await fn();
    } finally {
      endAgentControl(tab);
    }
  };

  /** 工具宿主：把标签、脚本、截图能力交给 electron/mcp/tools 下的工具实现。 */
  const host = {
    designBridge,
    defaultInteractiveSelector: DEFAULT_INTERACTIVE_SELECTOR,
    defaultClickSelector: DEFAULT_CLICK_SELECTOR,
    acquireState: () => ensureAutomationState(),
    resolveTab: (state, tabId) => resolveAutomationTab(state, tabId),
    requireTab,
    createTab: state => createTab(state),
    publish,
    listTabs: async () => snapshot(await ensureAutomationState()),
    activateTab: (state, tab) => {
      state.activeTabId = tab.id;
      applyLayout(state);
      return publish(state);
    },
    closeTab: (state, tab) => {
      const ids = [...state.tabs.keys()];
      const index = ids.indexOf(tab.id);
      destroyTab(state, tab);
      if (state.activeTabId === tab.id) state.activeTabId = ids[index + 1] ?? ids[index - 1] ?? '';
      if (!state.tabs.size) createTab(state);
      applyLayout(state);
      return publish(state);
    },
    loadUrl: (state, tab, url) => {
      load(state, tab, url);
      publish(state);
    },
    navigateHistory: (state, tab, action) => {
      const contents = tab.contents;
      if (!contents || contents.isDestroyed()) throw new Error('网页实例已销毁');
      if (action === 'back') {
        if (!contents.navigationHistory.canGoBack()) throw new Error('当前标签页无法后退');
        contents.navigationHistory.goBack();
      } else if (action === 'forward') {
        if (!contents.navigationHistory.canGoForward()) throw new Error('当前标签页无法前进');
        contents.navigationHistory.goForward();
      } else {
        if (!tab.url) throw new Error('当前标签页尚未打开任何地址');
        contents.reload();
      }
      publish(state);
    },
    waitForTabLoad: (tab, waitMs) => waitForTabLoad(tab, waitMs),
    withAgentControl,
    runScript: (tab, name, args) => runPageScript(tab.contents, name, args),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    logs: tab => ({
      console: Array.isArray(tab.consoleLogs) ? tab.consoleLogs : [],
      network: Array.isArray(tab.networkLogs) ? tab.networkLogs : [],
    }),
    canInsertText: tab => typeof tab.contents?.insertText === 'function',
    focusContents: tab => {
      if (typeof tab.contents?.focus === 'function') tab.contents.focus();
    },
    insertText: (tab, text) => tab.contents.insertText(text),
    deleteContent: tab => {
      if (typeof tab.contents?.delete === 'function') {
        tab.contents.delete();
        return;
      }
      if (typeof tab.contents?.sendInputEvent === 'function') {
        tab.contents.sendInputEvent({type: 'keyDown', keyCode: 'Backspace'});
        tab.contents.sendInputEvent({type: 'keyUp', keyCode: 'Backspace'});
      }
    },
    pressEnter: tab => {
      if (typeof tab.contents?.sendInputEvent !== 'function') return;
      tab.contents.sendInputEvent({type: 'keyDown', keyCode: 'Return'});
      tab.contents.sendInputEvent({type: 'char', keyCode: 'Return'});
      tab.contents.sendInputEvent({type: 'keyUp', keyCode: 'Return'});
    },
    canCdpInsert: tab => Boolean(tab.contents?.debugger),
    cdpInsertText: (tab, text) => withDebugger(tab.contents, dbg => dbg.sendCommand('Input.insertText', {text})),
    canSendInputEvent: tab => typeof tab.contents?.sendInputEvent === 'function',
    sendKey: (tab, keyCode, modifiers) => {
      tab.contents.sendInputEvent({type: 'keyDown', keyCode, modifiers});
      if (keyCode.length === 1 || keyCode === 'Return') {
        tab.contents.sendInputEvent({type: 'char', keyCode, modifiers});
      }
      tab.contents.sendInputEvent({type: 'keyUp', keyCode, modifiers});
    },
    dispatchHover: async (tab, x, y) => {
      if (typeof tab.contents?.sendInputEvent !== 'function') return;
      tab.contents.sendInputEvent({type: 'mouseMove', x, y});
      await new Promise(resolve => setTimeout(resolve, 80));
    },
    /**
     * 观察一次动作是否引发导航。
     *
     * <p>必须在动作**之前**注册监听、动作**之后**调用 settle：否则导航起头早于计时器，
     * 静默窗口会误判成「没导航」。</p>
     */
    beginNavigationWatch: tab => {
      const contents = tab.contents;
      if (!contents || contents.isDestroyed() || typeof contents.on !== 'function') {
        return {settle: async () => null};
      }
      let sawStart = false;
      const onStart = (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) sawStart = true;
      };
      contents.on('did-start-navigation', onStart);
      return {
        settle: ({silenceMs = 400, maxWaitMs = 5000} = {}) => new Promise(resolve => {
          let settled = false;
          let silenceTimer = null;
          let hardTimer = null;
          const onStop = () => {
            if (sawStart) finish();
          };
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(silenceTimer);
            clearTimeout(hardTimer);
            contents.removeListener('did-start-navigation', onStart);
            contents.removeListener('did-stop-loading', onStop);
            resolve({url: tab.url, title: tab.title, loadState: tab.loadState, navigated: sawStart});
          };
          contents.on('did-stop-loading', onStop);
          // 动作后这段时间内没有任何主框架导航起头，就判定为「不导航」
          silenceTimer = setTimeout(() => {
            if (!sawStart) finish();
          }, silenceMs);
          hardTimer = setTimeout(finish, maxWaitMs);
        }),
      };
    },
    captureScreenshot: async (tab, {maxWidth, viewportWidth, viewportHeight, fullPage}) => {
      const contents = tab.contents;
      if (!contents || contents.isDestroyed()) throw new Error('网页实例不可用');
      await syncAgentOverlay(tab, {forceHide: true, waitForPaint: true});
      try {
        let pngBuffer = null;
        let finalSize = null;
        const canUseCdp = (viewportWidth > 0 || fullPage)
          && Boolean(contents.debugger && typeof contents.debugger.sendCommand === 'function');
        if (canUseCdp) {
          try {
            const cdpResult = await withDebugger(contents, async dbg => {
              let metricsOverridden = false;
              try {
                if (viewportWidth > 0) {
                  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
                    width: viewportWidth,
                    height: viewportHeight,
                    deviceScaleFactor: 1,
                    mobile: false,
                  });
                  metricsOverridden = true;
                  await runPageScript(contents, 'raf-wait').catch(() => undefined);
                }
                return await dbg.sendCommand(
                  'Page.captureScreenshot',
                  fullPage ? {format: 'png', captureBeyondViewport: true} : {format: 'png'},
                );
              } finally {
                if (metricsOverridden) {
                  await dbg.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
                }
              }
            });
            if (cdpResult && typeof cdpResult.data === 'string' && cdpResult.data) {
              pngBuffer = Buffer.from(cdpResult.data, 'base64');
              if (nativeImage && typeof nativeImage.createFromBuffer === 'function') {
                let image = nativeImage.createFromBuffer(pngBuffer);
                let size = image.getSize();
                if (Number.isFinite(maxWidth) && maxWidth > 0 && size.width > maxWidth) {
                  image = image.resize({width: Math.round(maxWidth)});
                  size = image.getSize();
                  pngBuffer = image.toPNG();
                }
                if (size.width > 0 && size.height > 0) finalSize = size;
              }
              if (!finalSize) {
                finalSize = readPngDimensions(pngBuffer) || {
                  width: viewportWidth || DEFAULT_SCREENSHOT_VIEWPORT.width,
                  height: viewportHeight,
                };
              }
            }
          } catch {
            // CDP 截图失败（如被外部 DevTools 占用）时回退到原生 capturePage
            pngBuffer = null;
            finalSize = null;
          }
        }
        if (!pngBuffer) {
          let image = await contents.capturePage();
          const size = image.getSize();
          if (Number.isFinite(maxWidth) && maxWidth > 0 && size.width > maxWidth) {
            image = image.resize({width: Math.round(maxWidth)});
          }
          finalSize = image.getSize();
          pngBuffer = image.toPNG();
        }
        return {buffer: pngBuffer, width: finalSize.width, height: finalSize.height};
      } finally {
        await syncAgentOverlay(tab);
      }
    },
    saveScreenshot: async (buffer, savePath) => {
      if (savePath) {
        if (!path.isAbsolute(savePath)) throw new Error('savePath 必须是绝对路径');
        const target = path.normalize(savePath);
        await fs.promises.mkdir(path.dirname(target), {recursive: true});
        await fs.promises.writeFile(target, buffer);
        return target;
      }
      const dir = process.platform === 'win32' && process.env.PUBLIC
        ? path.join(process.env.PUBLIC, 'lingxi-browser-mcp')
        : path.join(os.tmpdir(), 'lingxi-browser-mcp');
      await fs.promises.mkdir(dir, {recursive: true});
      const filePath = path.join(dir, `shot-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
      await fs.promises.writeFile(filePath, buffer);
      return filePath;
    },
  };

  const automation = {};
  for (const tool of listTools(false)) {
    if (!tool.method) continue;
    automation[tool.method] = (args = {}) => tool.run(host, args);
  }
  const tabsTool = listTools(false).find(tool => tool.name === 'browser_tabs');
  automation.listTabs = () => tabsTool.run(host, {action: 'list'});
  automation.activateTab = tabId => tabsTool.run(host, {action: 'activate', tabId});
  automation.closeTab = tabId => tabsTool.run(host, {action: 'close', tabId});

  return {
    setTheme,
    automation,
    close: () => {
      for (const state of [...states.values()]) release(state);
      ipcMain.removeHandler(CHANNELS.command);
      ipcMain.removeHandler(CHANNELS.layout);
      ipcMain.removeHandler(CHANNELS.labels);
    },
  };
}
module.exports = {registerProjectPagePreview, normalizeTargetUrl, normalizeTargetOrigin, normalizeGeneration, normalizeLayout, normalizeMenuLabels, DEFAULT_MENU_LABELS, DEFAULT_INTERACTIVE_SELECTOR, DEFAULT_CLICK_SELECTOR, buildQueryScript, CHANNELS, PROJECT_PAGE_LOAD_TIMEOUT_MS, VIEW_BG_COLORS};
