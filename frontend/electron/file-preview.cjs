const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BYTES = 256 * 1024;
const MAX_LINES = 3000;

function resolveLocalBase(value) {
  const url = new URL(value || 'http://localhost:8088');
  if (!['http:', 'https:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('远程服务的文件暂不支持本地预览');
  }
  return url.origin;
}

async function fetchData(base, endpoint) {
  const response = await fetch(base + endpoint, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error('无法读取会话工作空间，请检查本地服务');
  const result = await response.json();
  if (result.code !== 1 || !result.data) throw new Error('会话或工作空间不存在');
  return result.data;
}

function resolveId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('会话标识不正确');
  const id = String(value ?? '');
  if (!/^\d+$/.test(id)) throw new Error('请先创建会话后再预览文件');
  return id;
}

async function resolveWorkspaceFile(request) {
  const base = resolveLocalBase(request?.baseUrl);
  const sessionId = resolveId(request?.sessionId);
  const config = await fetchData(base, '/config/current');
  if (config.type !== 'LOCAL') throw new Error('沙箱文件暂不支持本地预览，请切换到本地工作空间');
  const session = await fetchData(base, '/session/' + sessionId);
  const workspaceId = resolveId(session.workspaceId);
  const workspace = await fetchData(base, '/workspace/find/' + workspaceId);
  if (!workspace.hostDir) throw new Error('会话没有可用的本地工作目录');
  const filePath = await resolveContainedFile(workspace.hostDir, request.path);
  return { filePath, sessionId, base };
}

async function resolveContainedFile(root, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim() || requestedPath.includes('\0')) {
    throw new Error('文件路径不能为空');
  }
  const realRoot = await fsp.realpath(root);
  const candidate = path.resolve(realRoot, requestedPath);
  const relative = path.relative(realRoot, candidate);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
      || (process.platform === 'win32' && relative.includes(':'))) {
    throw new Error('只能预览当前会话工作目录内的文件');
  }
  // 检查最终真实路径，防止符号链接或目录联接越过工作空间边界。
  const realFile = await fsp.realpath(candidate);
  const realRelative = path.relative(realRoot, realFile);
  if (!realRelative || realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
    throw new Error('文件实际位置不在当前会话工作目录内');
  }
  return realFile;
}

async function readTextPreview(filePath) {
  const file = await fsp.open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('所选路径不是文件');
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    let encoding = 'UTF-8';
    let content;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      encoding = 'UTF-16LE';
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      encoding = 'UTF-16BE';
    }
    try {
      content = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: stat.size > bytesRead });
    } catch {
      encoding = 'GB18030';
      try {
        content = new TextDecoder('gb18030', { fatal: true }).decode(bytes, { stream: stat.size > bytesRead });
      } catch {
        throw new Error('文件编码无法识别或不是文本文件，请在文件夹中查看');
      }
    }
    if (/[\x00-\x08\x0e-\x1f]/.test(content)) throw new Error('二进制文件无法按代码预览，请在文件夹中查看');
    content = content.replace(/\r\n?/g, '\n');
    const lines = content.split('\n');
    const truncated = stat.size > bytesRead || lines.length > MAX_LINES;
    if (lines.length > MAX_LINES) content = lines.slice(0, MAX_LINES).join('\n');
    return { path: filePath, content, encoding, size: stat.size, truncated };
  } finally {
    await file.close();
  }
}

function registerFilePreview({ ipcMain, shell, getWindow }) {
  const watches = new Map();
  const watchedSenders = new WeakSet();
  const assertSender = event => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error('文件操作窗口不可用');
    if (event.senderFrame && event.senderFrame !== window.webContents.mainFrame) throw new Error('文件操作只能从主窗口发起');
  };
  const closeWatch = id => {
    const entry = watches.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.watcher.close();
    watches.delete(id);
  };
  const run = handler => async (event, request) => {
    try {
      assertSender(event);
      return { ok: true, data: await handler(event, request) };
    } catch (error) {
      const message = error.code === 'ENOENT' ? '文件不存在或已被删除'
        : error.code === 'EACCES' || error.code === 'EPERM' ? '没有权限读取该文件'
          : error.code ? '无法操作该文件，请检查文件状态'
            : error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name) ? '无法连接本地服务，请检查服务状态' : error.message;
      return { ok: false, error: message || '文件操作失败，请重试' };
    }
  };
  ipcMain.handle('file-preview:read', run(async (event, request) => {
    const resolved = await resolveWorkspaceFile(request);
    const data = await readTextPreview(resolved.filePath);
    const key = resolved.base + '/' + resolved.sessionId + '/' + resolved.filePath + '/' + request.watchKey;
    let watchId = [...watches].find(([, entry]) => entry.key === key && entry.sender === event.sender)?.[0];
    if (!watchId && watches.size < 12) {
      watchId = randomUUID();
      const entry = { key, sender: event.sender, timer: null, watcher: null };
      try {
        // 监听目录才能捕获编辑器通过替换文件进行的保存。
        entry.watcher = fs.watch(path.dirname(resolved.filePath), (_type, name) => {
          if (name && String(name).toLowerCase() !== path.basename(resolved.filePath).toLowerCase()) return;
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            if (!event.sender.isDestroyed()) event.sender.send('file-preview:changed', { watchId });
          }, 180);
        });
        entry.watcher.on('error', () => closeWatch(watchId));
        watches.set(watchId, entry);
        if (!watchedSenders.has(event.sender)) {
          watchedSenders.add(event.sender);
          event.sender.once('destroyed', () => {
            for (const [id, watched] of watches) if (watched.sender === event.sender) closeWatch(id);
          });
        }
      } catch {
        watchId = undefined;
      }
    }
    return { ...data, watchId };
  }));
  ipcMain.handle('file-preview:unwatch', run(async (event, id) => {
    if (watches.get(id)?.sender === event.sender) closeWatch(id);
  }));
  ipcMain.handle('file-preview:open', run(async (_event, request) => {
    const { filePath } = await resolveWorkspaceFile(request);
    // Windows 会把部分脚本当作程序执行，这些文件只允许定位后自行选择编辑器。
    const safeExtensions = new Set(['.txt', '.md', '.java', '.json', '.yaml', '.yml', '.xml', '.vue', '.ts', '.tsx', '.css', '.scss', '.sql', '.csv', '.log', '.properties', '.kt', '.go', '.rs', '.c', '.h', '.cpp']);
    if (!safeExtensions.has(path.extname(filePath).toLowerCase())) throw new Error('该文件请通过“定位”选择编辑器打开');
    const error = await shell.openPath(filePath);
    if (error) throw new Error('没有可用的默认程序，请在文件夹中选择编辑器');
  }));
  ipcMain.handle('file-preview:reveal', run(async (_event, request) => {
    const { filePath } = await resolveWorkspaceFile(request);
    shell.showItemInFolder(filePath);
  }));
  return () => [...watches.keys()].forEach(closeWatch);
}

module.exports = { registerFilePreview, resolveContainedFile, readTextPreview, resolveLocalBase, MAX_BYTES };
