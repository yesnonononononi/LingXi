/** 标签与网页实例由主进程持有，远程内容不能继承主页面的系统能力。 */
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

function buildQueryScript({customSelector = '', maxItems = 40} = {}) {
  return `(() => {
    const customSelector = ${JSON.stringify(customSelector)};
    const defaultSelector = ${JSON.stringify(DEFAULT_INTERACTIVE_SELECTOR)};
    const maxItems = ${maxItems};
    const targetSelector = customSelector || defaultSelector;
    const nodes = Array.from(document.querySelectorAll(targetSelector));
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const normalizeText = value => String(value || '').trim().replace(/\\s+/g, ' ');
    const escapeAttr = value => String(value).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
    const isUnique = sel => {
      try {
        return document.querySelectorAll(sel).length === 1;
      } catch {
        return false;
      }
    };
    const buildSelectorHint = el => {
      const tag = el.tagName.toLowerCase();
      if (el.id) {
        const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id;
        const idSel = '#' + escapedId;
        if (isUnique(idSel)) return idSel;
      }
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
      if (testId) {
        const attr = el.hasAttribute('data-testid') ? 'data-testid' : 'data-test';
        const sel = '[' + attr + '="' + escapeAttr(testId) + '"]';
        if (isUnique(sel)) return sel;
      }
      const name = el.getAttribute('name');
      if (name) {
        const sel = tag + '[name="' + escapeAttr(name) + '"]';
        if (isUnique(sel)) return sel;
      }
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.length <= 60) {
        const sel = tag + '[aria-label="' + escapeAttr(ariaLabel) + '"]';
        if (isUnique(sel)) return sel;
      }
      const parts = [];
      let cur = el;
      for (let depth = 0; cur && cur.nodeType === 1 && depth < 3; depth++) {
        const curTag = cur.tagName.toLowerCase();
        if (curTag === 'html' || curTag === 'body') break;
        const parent = cur.parentElement;
        if (!parent) {
          parts.unshift(curTag);
          break;
        }
        const sameTagSiblings = Array.from(parent.children).filter(s => s.tagName === cur.tagName);
        const segment = sameTagSiblings.length > 1
          ? curTag + ':nth-of-type(' + (sameTagSiblings.indexOf(cur) + 1) + ')'
          : curTag;
        parts.unshift(segment);
        const candidate = parts.join(' > ');
        if (isUnique(candidate)) return candidate;
        cur = parent;
      }
      return parts.join(' > ') || tag;
    };
    const resolveLabel = el => {
      if (el.labels && el.labels.length > 0) {
        const txt = normalizeText(el.labels[0].innerText || el.labels[0].textContent);
        if (txt) return txt.slice(0, 80);
      }
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const refText = labelledBy
          .split(/\\s+/)
          .map(id => document.getElementById(id))
          .filter(Boolean)
          .map(node => normalizeText(node.innerText || node.textContent))
          .filter(Boolean)
          .join(' ');
        if (refText) return refText.slice(0, 80);
      }
      return '';
    };
    const resolveValue = (el, tag, type) => {
      if (tag === 'input') {
        if (type === 'password') return el.value ? '***' : '';
        if (type === 'checkbox' || type === 'radio') return '';
        return String(el.value || '').slice(0, 100);
      }
      if (tag === 'textarea') return String(el.value || '').slice(0, 100);
      if (tag === 'select') {
        const opt = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
        return normalizeText(opt ? (opt.textContent || opt.value) : el.value).slice(0, 100);
      }
      if (el.isContentEditable) return normalizeText(el.innerText || el.textContent).slice(0, 100);
      return '';
    };
    const inViewNodes = [];
    const outViewNodes = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
      if (inViewport || customSelector) inViewNodes.push({el, inViewport});
      else outViewNodes.push({el, inViewport});
    }
    const ordered = customSelector ? inViewNodes : inViewNodes.concat(outViewNodes);
    const items = [];
    for (let i = 0; i < ordered.length && items.length < maxItems; i++) {
      const {el, inViewport} = ordered[i];
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || '';
      const ariaChecked = el.getAttribute('aria-checked');
      const ariaSelected = el.getAttribute('aria-selected');
      const ariaExpanded = el.getAttribute('aria-expanded');
      const item = {
        index: items.length,
        tag,
        role: el.getAttribute('role') || '',
        id: el.id || '',
        className: typeof el.className === 'string' ? el.className.trim() : '',
        type,
        name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        label: resolveLabel(el),
        href: el.getAttribute('href') || '',
        value: resolveValue(el, tag, type),
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        inViewport,
        selectorHint: buildSelectorHint(el),
        text: normalizeText(el.innerText || el.textContent).slice(0, 100),
      };
      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
        item.checked = Boolean(el.checked);
      } else if (ariaChecked === 'true' || ariaChecked === 'false') {
        item.checked = ariaChecked === 'true';
      }
      if (ariaSelected === 'true' || ariaSelected === 'false') {
        item.selected = ariaSelected === 'true';
      }
      if (ariaExpanded === 'true' || ariaExpanded === 'false') {
        item.expanded = ariaExpanded === 'true';
      }
      items.push(item);
    }
    const bodyText = normalizeText(document.body?.innerText || '').slice(0, 1500);
    return {
      url: window.location.href,
      title: document.title,
      totalMatched: nodes.length,
      visibleCount: ordered.length,
      elements: items,
      textExcerpt: bodyText,
    };
  })()`;
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

function registerProjectPagePreview({ipcMain, getWindow, WebContentsView, session, Menu, nativeTheme, nativeImage, timeoutMs = PROJECT_PAGE_LOAD_TIMEOUT_MS}) {
  const states = new Map();
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
    }
    const view = new WebContentsView({webPreferences: {
      session: previewSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    }});
    applyViewTheme(view);
    const tab = {id: randomUUID(), view, contents: view.webContents, url: '', title: '', favicon: '', loadState: 'idle',
      isLoading: false, committedNavigation: false, errorCode: 0, errorDescription: '', timer: undefined,
      openedByAgent: false, agentGlowDismissed: false, agentBusy: false, agentOverlayTimer: undefined};
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

  const runTabScript = async (tab, script) => {
    const contents = tab.contents;
    if (!contents || contents.isDestroyed() || typeof contents.executeJavaScript !== 'function') {
      throw new Error('当前网页标签不可执行脚本');
    }
    return contents.executeJavaScript(script, true);
  };

  const withAgentControl = async (tab, fn) => {
    beginAgentControl(tab);
    try {
      return await fn();
    } finally {
      endAgentControl(tab);
    }
  };

  const automation = {
    listTabs: async () => {
      const state = await ensureAutomationState();
      return snapshot(state);
    },
    navigate: async ({action = 'goto', url, tabId, newTab = false, waitUntilLoad = true, waitTimeoutMs} = {}) => {
      const state = await ensureAutomationState();
      const normalizedAction = typeof action === 'string' ? action.trim().toLowerCase() : 'goto';
      if (normalizedAction === 'back' || normalizedAction === 'forward' || normalizedAction === 'reload') {
        const tab = resolveAutomationTab(state, tabId);
        return withAgentControl(tab, async () => {
          state.activeTabId = tab.id;
          const contents = tab.contents;
          if (!contents || contents.isDestroyed()) throw new Error('网页实例已销毁');
          const loadPromise = waitUntilLoad ? waitForTabLoad(tab, waitTimeoutMs) : null;
          if (normalizedAction === 'back') {
            if (!contents.navigationHistory.canGoBack()) throw new Error('当前标签页无法后退');
            contents.navigationHistory.goBack();
          } else if (normalizedAction === 'forward') {
            if (!contents.navigationHistory.canGoForward()) throw new Error('当前标签页无法前进');
            contents.navigationHistory.goForward();
          } else {
            if (!tab.url) throw new Error('当前标签页尚未打开任何地址');
            contents.reload();
          }
          publish(state);
          const loadResult = loadPromise ? await loadPromise : {loadState: tab.loadState};
          return {
            action: normalizedAction,
            tabId: tab.id,
            url: tab.url,
            title: tab.title,
            loadState: loadResult.loadState ?? tab.loadState,
            errorCode: loadResult.errorCode ?? tab.errorCode,
            errorDescription: loadResult.errorDescription ?? tab.errorDescription,
          };
        });
      }
      if (normalizedAction !== 'goto') {
        throw new Error(`不支持的导航动作: ${action}`);
      }
      const targetUrl = normalizeTargetUrl(url);
      const tab = newTab ? createTab(state) : resolveAutomationTab(state, tabId);
      if (newTab || !tab.url) {
        tab.openedByAgent = true;
      }
      return withAgentControl(tab, async () => {
        state.activeTabId = tab.id;
        const loadPromise = waitUntilLoad ? waitForTabLoad(tab, waitTimeoutMs) : null;
        load(state, tab, targetUrl);
        publish(state);
        const loadResult = loadPromise ? await loadPromise : {loadState: tab.loadState};
        return {
          action: 'goto',
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          loadState: loadResult.loadState ?? tab.loadState,
          errorCode: loadResult.errorCode ?? tab.errorCode,
          errorDescription: loadResult.errorDescription ?? tab.errorDescription,
        };
      });
    },
    activateTab: async tabId => {
      const state = await ensureAutomationState();
      const tab = requireTab(state, tabId);
      state.activeTabId = tab.id;
      applyLayout(state);
      return publish(state);
    },
    closeTab: async tabId => {
      const state = await ensureAutomationState();
      const tab = requireTab(state, tabId);
      const ids = [...state.tabs.keys()];
      const index = ids.indexOf(tab.id);
      destroyTab(state, tab);
      if (state.activeTabId === tab.id) state.activeTabId = ids[index + 1] ?? ids[index - 1] ?? '';
      if (!state.tabs.size) createTab(state);
      applyLayout(state);
      return publish(state);
    },
    click: async ({selector, text, index = 0, hoverOnly = false, tabId} = {}) => {
      const rawSelector = typeof selector === 'string' ? selector.trim() : '';
      const rawText = typeof text === 'string' ? text.trim() : '';
      if (!rawSelector && !rawText) throw new Error('selector 与 text 不能同时为空');
      const targetIndex = Number.isInteger(index) && index >= 0 ? index : 0;
      const shouldHoverOnly = Boolean(hoverOnly);
      const state = await ensureAutomationState();
      const tab = resolveAutomationTab(state, tabId);
      const script = `(() => {
        const rawSelector = ${JSON.stringify(rawSelector)};
        const rawText = ${JSON.stringify(rawText)};
        const targetIndex = ${targetIndex};
        const shouldHoverOnly = ${shouldHoverOnly};
        const baseSelector = rawSelector || ${JSON.stringify(DEFAULT_CLICK_SELECTOR)};
        let nodes = Array.from(document.querySelectorAll(baseSelector));
        if (rawText) {
          const needle = rawText.toLowerCase();
          nodes = nodes.filter(el => {
            const label = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '').trim().replace(/\\s+/g, ' ').toLowerCase();
            return label.includes(needle);
          });
        }
        const visible = nodes.filter(el => {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        const candidates = visible.length > 0 ? visible : nodes;
        const el = candidates[targetIndex];
        if (!el) return { ok: false, error: '未找到匹配元素: ' + (rawSelector || rawText), matchedCount: nodes.length, visibleCount: visible.length };
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        const centerX = Math.round(rect.left + rect.width / 2);
        const centerY = Math.round(rect.top + rect.height / 2);
        if (shouldHoverOnly) {
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, clientX: centerX, clientY: centerY }));
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: false, clientX: centerX, clientY: centerY }));
        } else {
          el.focus?.();
          el.click();
        }
        return {
          ok: true,
          hoverOnly: shouldHoverOnly,
          centerX,
          centerY,
          matchedCount: nodes.length,
          visibleCount: visible.length,
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          className: typeof el.className === 'string' ? el.className : '',
          text: (el.innerText || el.textContent || '').trim().slice(0, 120),
          currentUrl: window.location.href,
          currentTitle: document.title,
        };
      })()`;
      const result = await withAgentControl(tab, async () => {
        const res = await runTabScript(tab, script);
        if (res?.ok && shouldHoverOnly && typeof tab.contents?.sendInputEvent === 'function') {
          tab.contents.sendInputEvent({type: 'mouseMove', x: res.centerX, y: res.centerY});
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        return res;
      });
      if (!result?.ok) throw new Error(result?.error || '点击元素失败');
      return {...result, tabId: tab.id, url: result.currentUrl || tab.url, title: result.currentTitle || tab.title};
    },
    fill: async ({selector, value = '', index = 0, clear = true, submit = false, tabId} = {}) => {
      if (typeof selector !== 'string' || !selector.trim()) throw new Error('selector 不能为空');
      const targetIndex = Number.isInteger(index) && index >= 0 ? index : 0;
      const textValue = value === undefined || value === null ? '' : String(value);
      const shouldClear = Boolean(clear);
      const shouldSubmit = Boolean(submit);
      const normalizedSelector = selector.trim();
      const state = await ensureAutomationState();
      const tab = resolveAutomationTab(state, tabId);
      const resolveTargetSnippet = `
        const selector = ${JSON.stringify(normalizedSelector)};
        const targetIndex = ${targetIndex};
        const nodes = Array.from(document.querySelectorAll(selector));
        const visible = nodes.filter(el => {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        const candidates = visible.length > 0 ? visible : nodes;
        const el = candidates[targetIndex];
        if (!el) return { ok: false, error: '未找到匹配输入元素: ' + selector, matchedCount: nodes.length };
      `;

      // 优先走 Electron 原生输入通道（isTrusted: true），避免 React 受控组件忽略合成 Event 导致输入回退为空。
      if (typeof tab.contents?.insertText === 'function') {
        const result = await withAgentControl(tab, async () => {
          const prepScript = `(() => {
            ${resolveTargetSnippet}
            const nextValue = ${JSON.stringify(textValue)};
            const shouldClear = ${shouldClear};
            const shouldSubmit = ${shouldSubmit};
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            el.focus?.();
            if (el.tagName === 'SELECT') {
              const options = Array.from(el.options || []);
              const byValue = options.find(opt => opt.value === nextValue);
              const byText = byValue || options.find(opt => (opt.textContent || '').trim() === nextValue)
                || options.find(opt => (opt.textContent || '').trim().includes(nextValue));
              const resolved = byText ? byText.value : nextValue;
              const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
              if (descriptor && descriptor.set) descriptor.set.call(el, resolved);
              else el.value = resolved;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              if (shouldSubmit && el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
              return {
                ok: true,
                handled: true,
                tag: el.tagName.toLowerCase(),
                id: el.id || '',
                className: typeof el.className === 'string' ? el.className : '',
                valueLength: (el.value ?? el.textContent ?? '').length,
              };
            }
            const isEmptyBefore = (el.value ?? el.textContent ?? '').length === 0;
            if (el.isContentEditable) {
              const range = document.createRange();
              range.selectNodeContents(el);
              if (!shouldClear) range.collapse(false);
              const selection = window.getSelection();
              selection?.removeAllRanges();
              selection?.addRange(range);
            } else if (shouldClear) {
              if (typeof el.select === 'function') el.select();
              else if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, (el.value || '').length);
            } else if (typeof el.setSelectionRange === 'function') {
              const len = (el.value || '').length;
              el.setSelectionRange(len, len);
            }
            return { ok: true, handled: false, isEmptyBefore };
          })()`;
          const prep = await runTabScript(tab, prepScript);
          if (!prep?.ok) throw new Error(prep?.error || '填充元素失败');
          if (prep.handled) return prep;

          if (typeof tab.contents.focus === 'function') tab.contents.focus();
          if (shouldClear && textValue === '') {
            if (!prep.isEmptyBefore) {
              if (typeof tab.contents.delete === 'function') {
                tab.contents.delete();
              } else if (typeof tab.contents.sendInputEvent === 'function') {
                tab.contents.sendInputEvent({type: 'keyDown', keyCode: 'Backspace'});
                tab.contents.sendInputEvent({type: 'keyUp', keyCode: 'Backspace'});
              }
            }
          } else if (textValue !== '') {
            await tab.contents.insertText(textValue);
          }

          const readScript = `(() => {
            ${resolveTargetSnippet}
            return {
              ok: true,
              tag: el.tagName.toLowerCase(),
              id: el.id || '',
              className: typeof el.className === 'string' ? el.className : '',
              valueLength: (el.value ?? el.textContent ?? '').length,
            };
          })()`;
          let readResult = await runTabScript(tab, readScript);

          // 面板收起/失焦时 insertText 可能被 Chromium 忽略，兜底用 CDP Input.insertText 写入。
          if (textValue !== '' && readResult?.ok && readResult.valueLength === 0 && tab.contents.debugger) {
            await withDebugger(tab.contents, dbg => dbg.sendCommand('Input.insertText', {text: textValue}));
            readResult = await runTabScript(tab, readScript);
          }

          if (shouldSubmit && typeof tab.contents.sendInputEvent === 'function') {
            tab.contents.sendInputEvent({type: 'keyDown', keyCode: 'Return'});
            tab.contents.sendInputEvent({type: 'char', keyCode: 'Return'});
            tab.contents.sendInputEvent({type: 'keyUp', keyCode: 'Return'});
          }
          return readResult;
        });
        if (!result?.ok) throw new Error(result?.error || '填充元素失败');
        return {...result, tabId: tab.id, url: tab.url, title: tab.title};
      }

      const script = `(() => {
        ${resolveTargetSnippet}
        const nextValue = ${JSON.stringify(textValue)};
        const shouldClear = ${shouldClear};
        const shouldSubmit = ${shouldSubmit};
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        el.focus?.();
        if (el.isContentEditable) {
          el.textContent = shouldClear ? nextValue : ((el.textContent || '') + nextValue);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: nextValue, inputType: 'insertText' }));
        } else if (el.tagName === 'SELECT') {
          const options = Array.from(el.options || []);
          const byValue = options.find(opt => opt.value === nextValue);
          const byText = byValue || options.find(opt => (opt.textContent || '').trim() === nextValue)
            || options.find(opt => (opt.textContent || '').trim().includes(nextValue));
          const resolved = byText ? byText.value : nextValue;
          const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
          if (descriptor && descriptor.set) descriptor.set.call(el, resolved);
          else el.value = resolved;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          const finalValue = shouldClear ? nextValue : ((el.value || '') + nextValue);
          if (descriptor && descriptor.set) descriptor.set.call(el, finalValue);
          else el.value = finalValue;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (shouldSubmit) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
        }
        return {
          ok: true,
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          className: typeof el.className === 'string' ? el.className : '',
          valueLength: (el.value ?? el.textContent ?? '').length,
        };
      })()`;
      const result = await withAgentControl(tab, () => runTabScript(tab, script));
      if (!result?.ok) throw new Error(result?.error || '填充元素失败');
      return {...result, tabId: tab.id, url: tab.url, title: tab.title};
    },
    wait: async ({selector, text, ms, timeoutMs: waitLimitMs = 10000, tabId} = {}) => {
      const rawSelector = typeof selector === 'string' ? selector.trim() : '';
      const rawText = typeof text === 'string' ? text.trim() : '';
      const fixedMs = Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), 15000) : 0;
      const state = await ensureAutomationState();
      const tab = resolveAutomationTab(state, tabId);
      return withAgentControl(tab, async () => {
        if (!rawSelector && !rawText) {
          const delayMs = fixedMs || 1000;
          await new Promise(resolve => setTimeout(resolve, delayMs));
          return {ok: true, waitedMs: delayMs, tabId: tab.id, url: tab.url, title: tab.title};
        }
        const maxWait = Number.isFinite(waitLimitMs) && waitLimitMs > 0 ? Math.min(Math.round(waitLimitMs), 15000) : 10000;
        const startedAt = Date.now();
        const deadline = startedAt + maxWait;
        while (Date.now() < deadline) {
          const checkScript = `(() => {
            const sel = ${JSON.stringify(rawSelector)};
            const txt = ${JSON.stringify(rawText)};
            let selectorOk = !sel;
            if (sel) {
              const nodes = Array.from(document.querySelectorAll(sel));
              selectorOk = nodes.some(el => {
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
              });
            }
            let textOk = !txt;
            if (txt) {
              const bodyText = (document.body?.innerText || '').trim();
              textOk = bodyText.includes(txt);
            }
            return { matched: selectorOk && textOk, url: window.location.href, title: document.title };
          })()`;
          const status = await runTabScript(tab, checkScript);
          if (status?.matched) {
            return {
              ok: true,
              waitedMs: Date.now() - startedAt,
              tabId: tab.id,
              url: status.url || tab.url,
              title: status.title || tab.title,
            };
          }
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        throw new Error(`等待超时（${maxWait}ms）未满足条件: ${rawSelector || rawText}`);
      });
    },
    scroll: async ({direction = 'down', amount, selector, tabId} = {}) => {
      const normalizedDirection = typeof direction === 'string' ? direction.trim().toLowerCase() : 'down';
      const rawSelector = typeof selector === 'string' ? selector.trim() : '';
      const px = Number.isFinite(amount) && amount > 0 ? Math.round(amount) : 0;
      const state = await ensureAutomationState();
      const tab = resolveAutomationTab(state, tabId);
      const script = `(() => {
        const dir = ${JSON.stringify(normalizedDirection)};
        const px = ${px};
        const sel = ${JSON.stringify(rawSelector)};
        const target = sel ? document.querySelector(sel) : null;
        if (sel && !target) return { ok: false, error: '未找到滚动目标元素: ' + sel };
        if (target && !px && dir === 'down') {
          target.scrollIntoView({ block: 'center', behavior: 'instant' });
        } else {
          const step = px || Math.round(window.innerHeight * 0.8);
          const container = target || document.scrollingElement || document.documentElement;
          if (dir === 'top') container.scrollTop = 0;
          else if (dir === 'bottom') container.scrollTop = container.scrollHeight;
          else if (dir === 'up') container.scrollTop = Math.max(0, container.scrollTop - step);
          else container.scrollTop = Math.min(container.scrollHeight, container.scrollTop + step);
        }
        const root = target || document.scrollingElement || document.documentElement;
        return {
          ok: true,
          scrollTop: Math.round(root.scrollTop),
          scrollHeight: Math.round(root.scrollHeight),
          clientHeight: Math.round(root.clientHeight),
          atBottom: root.scrollTop + root.clientHeight >= root.scrollHeight - 2,
          url: window.location.href,
          title: document.title,
        };
      })()`;
      const result = await withAgentControl(tab, () => runTabScript(tab, script));
      if (!result?.ok) throw new Error(result?.error || '滚动页面失败');
      return {...result, tabId: tab.id};
    },
    query: async ({selector, limit = 40, tabId} = {}) => {
      const maxItems = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 40;
      const customSelector = typeof selector === 'string' && selector.trim() ? selector.trim() : '';
      const state = await ensureAutomationState();
      const tab = resolveAutomationTab(state, tabId);
      const script = buildQueryScript({customSelector, maxItems});
      const result = await withAgentControl(tab, () => runTabScript(tab, script));
      return {...result, tabId: tab.id};
    },
    screenshot: async ({
      tabId,
      maxWidth = 1280,
      saveToTemp = true,
      savePath,
      viewportWidth = DEFAULT_SCREENSHOT_VIEWPORT.width,
      viewportHeight = DEFAULT_SCREENSHOT_VIEWPORT.height,
      fullPage = false,
    } = {}) => {
      const state = await ensureAutomationState();
      const tab = resolveAutomationTab(state, tabId);
      const contents = tab.contents;
      if (!contents || contents.isDestroyed()) throw new Error('网页实例不可用');
      const targetViewportWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? Math.round(viewportWidth) : 0;
      const targetViewportHeight = Number.isFinite(viewportHeight) && viewportHeight > 0
        ? Math.round(viewportHeight)
        : DEFAULT_SCREENSHOT_VIEWPORT.height;
      const wantFullPage = Boolean(fullPage);
      const canUseCdp = (targetViewportWidth > 0 || wantFullPage)
        && Boolean(contents.debugger && typeof contents.debugger.sendCommand === 'function');

      return withAgentControl(tab, async () => {
        await syncAgentOverlay(tab, {forceHide: true, waitForPaint: true});
        let pngBuffer = null;
        let finalSize = null;
        try {
          if (canUseCdp) {
            try {
              const cdpResult = await withDebugger(contents, async dbg => {
                let metricsOverridden = false;
                try {
                  if (targetViewportWidth > 0) {
                    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
                      width: targetViewportWidth,
                      height: targetViewportHeight,
                      deviceScaleFactor: 1,
                      mobile: false,
                    });
                    metricsOverridden = true;
                    await runTabScript(
                      tab,
                      'typeof requestAnimationFrame === "function" ? new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))) : true',
                    ).catch(() => undefined);
                  }
                  const shotParams = wantFullPage
                    ? {format: 'png', captureBeyondViewport: true}
                    : {format: 'png'};
                  return await dbg.sendCommand('Page.captureScreenshot', shotParams);
                } finally {
                  if (metricsOverridden) {
                    await dbg.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
                  }
                }
              });
              if (cdpResult && typeof cdpResult.data === 'string' && cdpResult.data) {
                pngBuffer = Buffer.from(cdpResult.data, 'base64');
                if (nativeImage && typeof nativeImage.createFromBuffer === 'function') {
                  let img = nativeImage.createFromBuffer(pngBuffer);
                  let imgSize = img.getSize();
                  if (Number.isFinite(maxWidth) && maxWidth > 0 && imgSize.width > maxWidth) {
                    img = img.resize({width: Math.round(maxWidth)});
                    imgSize = img.getSize();
                    pngBuffer = img.toPNG();
                  }
                  if (imgSize.width > 0 && imgSize.height > 0) finalSize = imgSize;
                }
                if (!finalSize) {
                  finalSize = readPngDimensions(pngBuffer) || {
                    width: targetViewportWidth || DEFAULT_SCREENSHOT_VIEWPORT.width,
                    height: targetViewportHeight,
                  };
                }
              }
            } catch {
              // CDP 截图失败（如被外部 DevTools 占用）时回退到原生 capturePage。
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
        } finally {
          await syncAgentOverlay(tab);
        }

        let filePath = '';
        const rawSavePath = typeof savePath === 'string' ? savePath.trim() : '';
        if (rawSavePath) {
          if (!path.isAbsolute(rawSavePath)) {
            throw new Error('savePath 必须是绝对路径');
          }
          filePath = path.normalize(rawSavePath);
          fs.mkdirSync(path.dirname(filePath), {recursive: true});
          fs.writeFileSync(filePath, pngBuffer);
        } else if (saveToTemp) {
          const dir = process.platform === 'win32' && process.env.PUBLIC
            ? path.join(process.env.PUBLIC, 'lingxi-browser-mcp')
            : path.join(os.tmpdir(), 'lingxi-browser-mcp');
          fs.mkdirSync(dir, {recursive: true});
          filePath = path.join(dir, `shot-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
          fs.writeFileSync(filePath, pngBuffer);
        }
        return {
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          mimeType: 'image/png',
          width: finalSize.width,
          height: finalSize.height,
          base64: pngBuffer.toString('base64'),
          filePath,
        };
      });
    },
  };

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
