/**
 * Design 画布与内置 MCP 之间的主进程桥接器。
 *
 * <p>通过 IPC 请求/响应协议读取当前激活 Design 画布的状态（绑定路径、选中元素、计算样式、批注列表），
 * 并在主进程用离屏隐藏 BrowserWindow 按多视口渲染真实 PNG 截图，供 Agent 视觉自检。</p>
 */
const {randomUUID} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DESIGN_MCP_CHANNELS = Object.freeze({
  request: 'design-mcp:request',
  response: 'design-mcp:response',
});

const DEFAULT_DESIGN_VIEWPORTS = Object.freeze([
  {name: 'desktop', width: 1280, height: 800},
  {name: 'mobile', width: 390, height: 844},
]);

function normalizeViewports(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return DEFAULT_DESIGN_VIEWPORTS.map(item => ({...item}));
  }
  const normalized = [];
  for (const item of input.slice(0, 4)) {
    if (!item || typeof item !== 'object') continue;
    const width = Number.isFinite(item.width) ? Math.max(320, Math.min(2560, Math.round(item.width))) : 1280;
    const height = Number.isFinite(item.height) ? Math.max(400, Math.min(2400, Math.round(item.height))) : 800;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 32) : `${width}x${height}`;
    normalized.push({name, width, height});
  }
  return normalized.length > 0 ? normalized : DEFAULT_DESIGN_VIEWPORTS.map(item => ({...item}));
}

async function defaultRenderHtmlViewport({BrowserWindow, html, width, height, fullPage = false}) {
  if (!BrowserWindow) {
    throw new Error('当前环境不支持离屏渲染截图');
  }
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  try {
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    await win.loadURL(dataUrl);
    await win.webContents.executeJavaScript(
      'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))',
    ).catch(() => undefined);

    let pngBuffer = null;
    const dbg = win.webContents.debugger;
    if (fullPage && dbg && typeof dbg.sendCommand === 'function') {
      const attachedByUs = !dbg.isAttached();
      if (attachedByUs) dbg.attach('1.3');
      try {
        const res = await dbg.sendCommand('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
        if (res && typeof res.data === 'string' && res.data) {
          pngBuffer = Buffer.from(res.data, 'base64');
        }
      } finally {
        if (attachedByUs && dbg.isAttached()) dbg.detach();
      }
    }
    if (!pngBuffer) {
      const image = await win.webContents.capturePage();
      pngBuffer = image.toPNG();
    }
    return {
      width,
      height,
      mimeType: 'image/png',
      base64: pngBuffer.toString('base64'),
      pngBuffer,
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function registerDesignMcpBridge({
  ipcMain,
  getWindow,
  BrowserWindow,
  renderHtmlViewport,
  requestTimeoutMs = 5000,
}) {
  const pending = new Map();

  const onResponse = (_event, message) => {
    if (!message || typeof message !== 'object' || typeof message.requestId !== 'string') return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.data);
    } else {
      entry.reject(new Error(typeof message.error === 'string' && message.error ? message.error : 'Design 画布操作失败'));
    }
  };

  if (ipcMain && typeof ipcMain.on === 'function') {
    ipcMain.on(DESIGN_MCP_CHANNELS.response, onResponse);
  }

  const requestRenderer = (action, payload = {}) => {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed()) || !win.webContents) {
      return Promise.reject(new Error('主窗口未就绪或已关闭'));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('当前没有打开并激活的 Design 画布，或画布响应超时'));
      }, requestTimeoutMs);
      pending.set(requestId, {resolve, reject, timer});
      win.webContents.send(DESIGN_MCP_CHANNELS.request, {requestId, action, payload});
    });
  };

  const rendererFn = renderHtmlViewport || ((opts) => defaultRenderHtmlViewport({...opts, BrowserWindow}));

  const bridge = {
    getState: async () => {
      return requestRenderer('get_state', {});
    },
    resolveComment: async ({commentId, all = false} = {}) => {
      const normalizedId = typeof commentId === 'string' ? commentId.trim() : '';
      if (!all && !normalizedId) {
        throw new Error('commentId 与 all=true 至少提供一项');
      }
      return requestRenderer('resolve_comment', {commentId: normalizedId, all: Boolean(all)});
    },
    capture: async ({viewports, fullPage = false, saveToTemp = true} = {}) => {
      const state = await requestRenderer('get_state', {includeHtml: true});
      if (!state || !state.active || !state.html) {
        throw new Error('当前没有已加载原型的 Design 画布可供截图');
      }
      const targets = normalizeViewports(viewports);
      const shots = [];
      const tempDir = saveToTemp
        ? (process.platform === 'win32' && process.env.PUBLIC
          ? path.join(process.env.PUBLIC, 'lingxi-design-mcp')
          : path.join(os.tmpdir(), 'lingxi-design-mcp'))
        : '';
      if (tempDir) fs.mkdirSync(tempDir, {recursive: true});

      for (const vp of targets) {
        const rendered = await rendererFn({
          html: state.html,
          width: vp.width,
          height: vp.height,
          fullPage: Boolean(fullPage),
        });
        let filePath = '';
        if (tempDir && rendered.pngBuffer) {
          filePath = path.join(tempDir, `design-${vp.name}-${Date.now()}-${randomUUID().slice(0, 6)}.png`);
          fs.writeFileSync(filePath, rendered.pngBuffer);
        }
        shots.push({
          name: vp.name,
          width: rendered.width,
          height: rendered.height,
          mimeType: rendered.mimeType || 'image/png',
          base64: rendered.base64,
          filePath,
        });
      }
      return {
        fileName: state.fileName || '',
        boundPath: state.boundPath || '',
        shots,
      };
    },
    close: () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Design MCP 桥接器已关闭'));
      }
      pending.clear();
      if (ipcMain && typeof ipcMain.removeListener === 'function') {
        ipcMain.removeListener(DESIGN_MCP_CHANNELS.response, onResponse);
      }
    },
  };

  return bridge;
}

module.exports = {
  DESIGN_MCP_CHANNELS,
  DEFAULT_DESIGN_VIEWPORTS,
  normalizeViewports,
  registerDesignMcpBridge,
};
