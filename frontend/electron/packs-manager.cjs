/**
 * GitHub 官方纯资源扩展包管理器（Electron 主进程）。
 *
 * <p><b>职责：</b>从官方 GitHub 仓库（`yesnonononononi/lingxi-packs`）拉取 `registry.json` 与纯资源扩展包
 * （CSS / 字体 / 图片），校验后落盘到 `&lt;userData&gt;/packs/&lt;pack-id&gt;/`；渲染进程通过受控 IPC 读取。</p>
 *
 * <p><b>安全边界：</b></p>
 * <ul>
 *   <li>只从固定的官方 GitHub Raw 仓库前缀拉取，不接受渲染进程传入任意 URL；</li>
 *   <li>`packId` 与相对文件路径均做严格白名单校验，杜绝目录穿越；</li>
 *   <li>只允许静态资源扩展名（.json / .css / 字体 / 图片），拒绝一切 .js / .mjs 脚本落盘。</li>
 * </ul>
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CATEGORIES_RAW_BASE =
  'https://raw.githubusercontent.com/yesnonononononi/lingxi-packs/main/categories';
const DEFAULT_PACKS_RAW_BASE =
  'https://raw.githubusercontent.com/yesnonononononi/lingxi-packs/main/packs';
const SUPPORTED_HOST_API_VERSION = '1';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ALLOWED_CATEGORIES = new Set(['theme', 'font', 'background', 'sidebar', 'input', 'component']);

const MIME_BY_EXT = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const ALLOWED_RESOURCE_EXTS = new Set([
  '.json',
  '.css',
  ...Object.keys(MIME_BY_EXT),
]);

function sanitizePackId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return PACK_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function sanitizeRelativeFile(raw) {
  if (typeof raw !== 'string') return null;
  const normalized = raw.replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) {
    return null;
  }
  const segments = normalized.split('/');
  if (segments.some(seg => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) {
    return null;
  }
  const ext = path.extname(normalized).toLowerCase();
  if (!ALLOWED_RESOURCE_EXTS.has(ext)) {
    return null;
  }
  return normalized;
}

/** 将 CSS 中的本地相对资源引用 `url('./...')` 内联为 data URL，避免 dev/prod 跨域与 CSP 问题。 */
function inlineCssLocalAssets(cssText, packDir) {
  if (typeof cssText !== 'string' || !cssText) return '';
  return cssText.replace(/url\(\s*(['"]?)(\.[^)'"]+)\1\s*\)/g, (full, _quote, relPath) => {
    const safeRel = sanitizeRelativeFile(relPath.replace(/^\.\//, ''));
    if (!safeRel) return full;
    const ext = path.extname(safeRel).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) return full;
    const absPath = path.resolve(packDir, safeRel);
    if (!absPath.startsWith(packDir + path.sep) || !fs.existsSync(absPath)) {
      return full;
    }
    try {
      const buf = fs.readFileSync(absPath);
      if (buf.byteLength > MAX_FILE_BYTES) return full;
      return `url('data:${mime};base64,${buf.toString('base64')}')`;
    } catch {
      return full;
    }
  });
}

async function fetchBufferWithTimeout(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} (${url})`);
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_FILE_BYTES) {
      throw new Error(`文件超出大小限制 (${ab.byteLength} B)`);
    }
    return Buffer.from(ab);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRemoteManifest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sanitizePackId(raw.id);
  const category = typeof raw.category === 'string' && ALLOWED_CATEGORIES.has(raw.category) ? raw.category : null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id || !category || !name) return null;

  const hostApiVersion = typeof raw.hostApiVersion === 'string' ? raw.hostApiVersion : '1';
  if (hostApiVersion !== SUPPORTED_HOST_API_VERSION) return null;

  return {
    id,
    category,
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    version: typeof raw.version === 'string' ? raw.version : '1.0.0',
    hostApiVersion,
    capabilities: Array.isArray(raw.capabilities)
      ? raw.capabilities.filter(c => typeof c === 'string')
      : [],
    preview: raw.preview && typeof raw.preview === 'object' ? raw.preview : undefined,
    fontPreview: raw.fontPreview && typeof raw.fontPreview === 'object' ? raw.fontPreview : undefined,
    entryCss: typeof raw.entryCss === 'string' ? (sanitizeRelativeFile(raw.entryCss) ?? 'pack.css') : 'pack.css',
    files: Array.isArray(raw.files)
      ? raw.files.map(sanitizeRelativeFile).filter(Boolean)
      : ['manifest.json', 'pack.css'],
  };
}

function listInstalledPacksFromDir(packsRoot) {
  if (!fs.existsSync(packsRoot)) return [];
  const entries = fs.readdirSync(packsRoot, { withFileTypes: true });
  const list = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = sanitizePackId(entry.name);
    if (!id) continue;
    const manifestPath = path.join(packsRoot, id, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const normalized = normalizeRemoteManifest(raw);
      if (normalized && normalized.id === id) {
        list.push(normalized);
      }
    } catch {
      // 损坏的扩展包目录静默跳过，不阻塞其余已安装扩展包
    }
  }
  return list;
}

function loadPackFromDir(packDir, expectedId) {
  const manifestPath = path.join(packDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `缺少 manifest.json: ${packDir}` };
  }
  try {
    const manifest = normalizeRemoteManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    if (!manifest || (expectedId && manifest.id !== expectedId)) {
      return { ok: false, error: '扩展包 manifest 格式无效或版本不兼容' };
    }
    const cssPath = path.resolve(packDir, manifest.entryCss);
    if (!cssPath.startsWith(packDir + path.sep) || !fs.existsSync(cssPath)) {
      return { ok: false, error: `缺少样式入口: ${manifest.entryCss}` };
    }
    const rawCss = fs.readFileSync(cssPath, 'utf8');
    const cssText = inlineCssLocalAssets(rawCss, packDir);
    return { ok: true, manifest, cssText };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function loadInstalledPackFromDir(packsRoot, rawId) {
  const id = sanitizePackId(rawId);
  if (!id) {
    return { ok: false, error: '扩展包 ID 非法' };
  }
  const packDir = path.resolve(packsRoot, id);
  if (!fs.existsSync(path.join(packDir, 'manifest.json'))) {
    return { ok: false, error: `扩展包未安装: ${id}` };
  }
  return loadPackFromDir(packDir, id);
}

/**
 * 扫描用户输入的绝对路径：
 * 1. 若该目录根下直接存在 manifest.json，按单个扩展包加载；
 * 2. 否则扫描直接子目录，收集所有包含合法 manifest.json 的扩展包。
 */
function scanCustomPacksDir(rawDirPath) {
  if (typeof rawDirPath !== 'string' || !rawDirPath.trim()) {
    return { ok: false, error: '请输入扩展包目录的绝对路径' };
  }
  const trimmed = rawDirPath.trim();
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, error: '必须输入绝对路径（例如 D:\\my-packs）' };
  }
  const resolvedDir = path.resolve(trimmed);
  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    return { ok: false, error: `目录不存在或不可访问: ${resolvedDir}` };
  }

  const packs = [];
  const rootManifestPath = path.join(resolvedDir, 'manifest.json');
  if (fs.existsSync(rootManifestPath)) {
    try {
      const normalized = normalizeRemoteManifest(JSON.parse(fs.readFileSync(rootManifestPath, 'utf8')));
      if (normalized) {
        packs.push({ ...normalized, packDir: resolvedDir });
      }
    } catch {
      return { ok: false, error: '根目录 manifest.json 解析失败' };
    }
  } else {
    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(resolvedDir, entry.name);
      const subManifest = path.join(subDir, 'manifest.json');
      if (!fs.existsSync(subManifest)) continue;
      try {
        const normalized = normalizeRemoteManifest(JSON.parse(fs.readFileSync(subManifest, 'utf8')));
        if (normalized) {
          packs.push({ ...normalized, packDir: subDir });
        }
      } catch {
        // 单个损坏子目录跳过，不影响其余扩展包
      }
    }
  }

  return { ok: true, dirPath: resolvedDir, packs };
}

function registerPacksManager({
  ipcMain,
  dialog,
  shell,
  appPath,
  getWindow,
  userDataDir,
  assertTrustedSender,
  categoriesRawBase = DEFAULT_CATEGORIES_RAW_BASE,
  packsRawBase = DEFAULT_PACKS_RAW_BASE,
  fetchImpl = globalThis.fetch,
}) {
  const CHANNELS = [
    'packs:fetch-registry',
    'packs:list-installed',
    'packs:install',
    'packs:load',
    'packs:uninstall',
    'packs:pick-custom-dir',
    'packs:scan-custom-dir',
    'packs:load-custom',
    'packs:open-guide',
  ];
  const packsRoot = path.resolve(userDataDir, 'packs');

  ipcMain.handle('packs:fetch-registry', async (event, category) => {
    assertTrustedSender(event, 'packs:fetch-registry');
    if (typeof category !== 'string' || !ALLOWED_CATEGORIES.has(category)) {
      return { ok: false, error: `非法扩展包类目: ${String(category ?? '')}` };
    }
    if (typeof fetchImpl !== 'function') {
      return { ok: false, error: '当前运行时不支持 fetch' };
    }
    try {
      const categoryUrl = `${categoriesRawBase}/${category}.json`;
      const buf = await fetchBufferWithTimeout(fetchImpl, categoryUrl);
      const parsed = JSON.parse(buf.toString('utf8'));
      const rawList = Array.isArray(parsed?.packs) ? parsed.packs : [];
      const packs = rawList
        .map(normalizeRemoteManifest)
        .filter(item => item && item.category === category);
      return { ok: true, packs };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('packs:list-installed', async (event) => {
    assertTrustedSender(event, 'packs:list-installed');
    try {
      return { ok: true, packs: listInstalledPacksFromDir(packsRoot) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('packs:install', async (event, request) => {
    assertTrustedSender(event, 'packs:install');
    if (typeof fetchImpl !== 'function') {
      return { ok: false, error: '当前运行时不支持 fetch' };
    }
    const id = sanitizePackId(request?.id);
    if (!id) {
      return { ok: false, error: '扩展包 ID 非法' };
    }

    const rawFiles = Array.isArray(request?.files) ? request.files : ['manifest.json', 'pack.css'];
    const files = [...new Set(['manifest.json', ...rawFiles.map(sanitizeRelativeFile).filter(Boolean)])];
    if (!files.some(f => f.endsWith('.css'))) {
      files.push('pack.css');
    }

    const tempDir = path.resolve(packsRoot, `.tmp-${id}-${Date.now()}`);
    const targetDir = path.resolve(packsRoot, id);

    try {
      fs.mkdirSync(tempDir, { recursive: true });
      for (const relFile of files) {
        const fileUrl = `${packsRawBase}/${id}/${relFile}`;
        const buf = await fetchBufferWithTimeout(fetchImpl, fileUrl);
        const dest = path.resolve(tempDir, relFile);
        if (!dest.startsWith(tempDir + path.sep)) {
          throw new Error(`非法文件路径: ${relFile}`);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
      }

      const manifestRaw = JSON.parse(fs.readFileSync(path.join(tempDir, 'manifest.json'), 'utf8'));
      const manifest = normalizeRemoteManifest(manifestRaw);
      if (!manifest || manifest.id !== id) {
        throw new Error('扩展包 manifest 校验失败或版本不兼容');
      }

      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.renameSync(tempDir, targetDir);
      return { ok: true, manifest };
    } catch (err) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('packs:load', async (event, packId) => {
    assertTrustedSender(event, 'packs:load');
    return loadInstalledPackFromDir(packsRoot, packId);
  });

  ipcMain.handle('packs:uninstall', async (event, packId) => {
    assertTrustedSender(event, 'packs:uninstall');
    const id = sanitizePackId(packId);
    if (!id) {
      return { ok: false, error: '扩展包 ID 非法' };
    }
    const targetDir = path.resolve(packsRoot, id);
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('packs:pick-custom-dir', async (event) => {
    assertTrustedSender(event, 'packs:pick-custom-dir');
    if (!dialog) {
      return { ok: false, error: '当前环境不支持目录选择对话框' };
    }
    const win = typeof getWindow === 'function' ? getWindow() : undefined;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) {
      return { ok: false, canceled: true };
    }
    return { ok: true, dirPath: result.filePaths[0] };
  });

  ipcMain.handle('packs:scan-custom-dir', async (event, dirPath) => {
    assertTrustedSender(event, 'packs:scan-custom-dir');
    try {
      return scanCustomPacksDir(dirPath);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('packs:load-custom', async (event, request) => {
    assertTrustedSender(event, 'packs:load-custom');
    const rawDir = request?.packDir;
    const rawId = sanitizePackId(request?.id);
    if (typeof rawDir !== 'string' || !path.isAbsolute(rawDir.trim()) || !rawId) {
      return { ok: false, error: '自定义扩展包路径或 ID 非法' };
    }
    return loadPackFromDir(path.resolve(rawDir.trim()), rawId);
  });

  ipcMain.handle('packs:open-guide', async (event) => {
    assertTrustedSender(event, 'packs:open-guide');
    if (!shell) {
      return { ok: false, error: '当前环境不支持打开外部浏览器' };
    }
    try {
      const win = typeof getWindow === 'function' ? getWindow() : undefined;
      const currentUrl = win?.webContents?.getURL?.() ?? '';
      if (/^https?:\/\//i.test(currentUrl)) {
        const origin = new URL(currentUrl).origin;
        await shell.openExternal(`${origin}/docs/extension-packs-guide.html`);
        return { ok: true };
      }

      // 打包态位于 app.asar 内，外部浏览器无法直接读取 asar 路径，先落地到 userData/docs
      const sourcePath = appPath
        ? path.join(appPath, 'dist', 'docs', 'extension-packs-guide.html')
        : path.resolve(__dirname, '..', 'dist', 'docs', 'extension-packs-guide.html');
      if (!fs.existsSync(sourcePath)) {
        return { ok: false, error: `未找到指南文档: ${sourcePath}` };
      }
      const docsDir = path.join(userDataDir, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });
      const targetPath = path.join(docsDir, 'extension-packs-guide.html');
      fs.writeFileSync(targetPath, fs.readFileSync(sourcePath));
      const openErr = await shell.openPath(targetPath);
      if (openErr) {
        return { ok: false, error: openErr };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  return {
    close() {
      for (const channel of CHANNELS) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}

module.exports = {
  DEFAULT_CATEGORIES_RAW_BASE,
  DEFAULT_PACKS_RAW_BASE,
  sanitizePackId,
  sanitizeRelativeFile,
  inlineCssLocalAssets,
  listInstalledPacksFromDir,
  loadInstalledPackFromDir,
  scanCustomPacksDir,
  registerPacksManager,
};
