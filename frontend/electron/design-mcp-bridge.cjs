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

const MAX_FULL_PAGE_HEIGHT = 6000;
const CAPTURE_TIMEOUT_MS = 15000;

/** 等两帧，确保 resize 之后的布局与绘制都落到新尺寸上。 */
async function waitTwoFrames(webContents) {
  await webContents
    .executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
    .catch(() => undefined);
}

/** 量文档尺寸；量不到就返回 null，由调用方退回原视口。 */
async function readDocumentSize(webContents) {
  const raw = await webContents.executeJavaScript(
    'JSON.stringify({w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),'
    + ' h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)})',
  ).catch(() => '');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Number.isFinite(parsed.h) || parsed.h <= 0) return null;
    return {width: Number.isFinite(parsed.w) ? parsed.w : 0, height: parsed.h};
  } catch {
    return null;
  }
}

/** 截图加超时：隐藏窗口的合成器偶尔不给帧，这里不能无限等。 */
function captureWithTimeout(webContents, timeoutMs = CAPTURE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`截图超时（${timeoutMs}ms）`)), timeoutMs);
    webContents.capturePage().then(
      image => {
        clearTimeout(timer);
        resolve(image);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 把截图规整成返回值：按 DPR 缩回请求的 CSS 尺寸。
 *
 * 隐藏窗口按设备像素出图（1.5x 很常见），不缩回 CSS 尺寸就是在尺寸上撒谎。
 */
function buildShot(image, captureWidth, captureHeight, requestedHeight, fullPageTruncated) {
  const size = image.getSize();
  const normalized = size.width !== captureWidth || size.height !== captureHeight
    ? image.resize({width: captureWidth, height: captureHeight})
    : image;
  const pngBuffer = normalized.toPNG();
  return {
    width: captureWidth,
    height: captureHeight,
    mimeType: 'image/png',
    base64: pngBuffer.toString('base64'),
    pngBuffer,
    fullPageApplied: captureHeight > requestedHeight,
    fullPageTruncated,
  };
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
    await waitTwoFrames(win.webContents);

    let captureWidth = width;
    let captureHeight = height;
    let fullPageTruncated = false;
    if (fullPage) {
      // 隐藏窗口的 CDP Page.captureScreenshot 抓超视口区域会一直挂住（实测 20s 无返回），
      // 所以改成把窗口长到内容高度再 capturePage：同一次实测 55ms 就拿到了整页。
      const size = await readDocumentSize(win.webContents);
      if (size && size.height > height) {
        captureHeight = Math.min(Math.round(size.height), MAX_FULL_PAGE_HEIGHT);
        fullPageTruncated = size.height > captureHeight;
        win.setContentSize(width, captureHeight);
        await waitTwoFrames(win.webContents);
      }
    }

    const image = await captureWithTimeout(win.webContents);
    if (image.getSize().width === 0 || image.getSize().height === 0) {
      // 隐藏窗口偶尔不出帧，capturePage 会给一张 0x0 空图（历史结果里那些 8 字节 PNG 就是它）
      await waitTwoFrames(win.webContents);
      const retried = await captureWithTimeout(win.webContents);
      if (retried.getSize().width === 0 || retried.getSize().height === 0) {
        throw new Error('离屏截图失败：隐藏窗口没有产出画面');
      }
      return buildShot(retried, captureWidth, captureHeight, height, fullPageTruncated);
    }
    return buildShot(image, captureWidth, captureHeight, height, fullPageTruncated);
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
      const error = new Error(typeof message.error === 'string' && message.error ? message.error : 'Design 画布操作失败');
      // 渲染层能给出更精确的错误码（如批注不存在），透传给工具层
      if (typeof message.code === 'string' && message.code) error.code = message.code;
      entry.reject(error);
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
    capture: async ({viewports, fullPage = false, saveToTemp = true, saveDir} = {}) => {
      const state = await requestRenderer('get_state', {includeHtml: true});
      if (!state || !state.active || !state.html) {
        throw new Error('当前没有已加载原型的 Design 画布可供截图');
      }
      const targets = normalizeViewports(viewports);
      const shots = [];
      const rawSaveDir = typeof saveDir === 'string' ? saveDir.trim() : '';
      let targetDir = '';
      if (rawSaveDir) {
        if (!path.isAbsolute(rawSaveDir)) {
          throw new Error('saveDir 必须是绝对路径');
        }
        targetDir = path.normalize(rawSaveDir);
      } else if (saveToTemp) {
        targetDir = process.platform === 'win32' && process.env.PUBLIC
          ? path.join(process.env.PUBLIC, 'lingxi-design-mcp')
          : path.join(os.tmpdir(), 'lingxi-design-mcp');
      }
      if (targetDir) await fs.promises.mkdir(targetDir, {recursive: true});

      for (const viewport of targets) {
        const rendered = await rendererFn({
          html: state.html,
          width: viewport.width,
          height: viewport.height,
          fullPage: Boolean(fullPage),
        });
        let filePath = '';
        if (!rendered || !rendered.pngBuffer || rendered.pngBuffer.length < 100) {
          // 空图就是 8 字节的 PNG 签名，写出去等于给模型一张坏图
          throw new Error(`截图失败：${viewport.name} 视口没有产出有效图像`);
        }
        if (targetDir && rendered.pngBuffer) {
          filePath = path.join(targetDir, `design-${viewport.name}-${Date.now()}-${randomUUID().slice(0, 6)}.png`);
          // 异步写：多视口串行同步写几 MB PNG 会把主进程卡住
          await fs.promises.writeFile(filePath, rendered.pngBuffer);
        }
        shots.push({
          name: viewport.name,
          width: rendered.width,
          height: rendered.height,
          mimeType: rendered.mimeType || 'image/png',
          base64: rendered.base64,
          filePath,
          fullPageApplied: Boolean(rendered.fullPageApplied),
          fullPageTruncated: Boolean(rendered.fullPageTruncated),
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
