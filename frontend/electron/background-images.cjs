'use strict';

/**
 * 主页背景图片的主进程侧实现（三条 IPC）。
 *
 * <p><b>为什么单独成模块：</b>与 `file-preview.cjs` / `notification-window.cjs` 同构 ——
 * main.cjs 只负责把 electron 的能力注入进来，本模块保持「不 require('electron')」，
 * 因此可以用普通 node 直接跑通三条路径（selftest 与手工验证都靠这一点，
 * 不必启动整个桌面应用）。</p>
 *
 * <p><b>安全边界（渲染层永远不接触路径）：</b></p>
 * <ol>
 *   <li>三个 handler 一律先做来源校验（沿用 update:* 系列的 {@link assertTrustedSender}）；</li>
 *   <li>`background:load` 只接受**纯文件名**：先 `path.basename(x) === x`，再 `/^[A-Za-z0-9._-]+$/`，
 *       再校验扩展名白名单，最后再核一次「解析后的父目录就是 backgrounds 目录」（防目录穿越/符号名）；</li>
 *   <li>大小上限 5MB、扩展名白名单 png/jpg/jpeg/webp、`nativeImage` 解码失败一律拒绝（防伪装扩展名）；</li>
 *   <li>`background:clear` 只删 `userData/backgrounds/` 下由本功能产生的图片（按扩展名白名单逐个删，绝不递归）；</li>
 *   <li>选图时**先写新文件再删旧文件**：写失败不会把用户原有的背景图弄丢。</li>
 * </ol>
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 图片大小上限 5MB（data URL 常驻 CSS 变量，8MB 图 ≈ 11MB 字符串，见可行性评估风险 5）。 */
const MAX_BYTES = 5 * 1024 * 1024;
/** 长边上限 2560：超出用 nativeImage 等比缩放，避免超大图拖慢合成。 */
const MAX_EDGE = 2560;
/** 允许的扩展名（取值与 dialog filters 同源，改一处必须改另一处）。 */
const ALLOWED_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);
const ALLOWED_EXT_SET = new Set(ALLOWED_EXTENSIONS);
/** 文件名白名单：只允许字母数字与 . _ -（与渲染层 useBackgroundPreference 同构）。 */
const FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;
/** 扩展名 → MIME，用于拼 data URL。 */
const MIME_BY_EXT = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
});

/**
 * 校验一个「渲染层传来的文件名」是否安全。
 *
 * @param {unknown} input 渲染层传来的值
 * @returns {string|null} 通过校验的纯文件名；任何可疑输入返回 null
 */
function sanitizeFileName(input) {
  if (typeof input !== 'string') return null;
  if (input.length === 0 || input.length > 128) return null;
  // 1) 必须本身就是 basename：`../x.png`、`a/b.png`、`C:\x.png` 全部在这里被挡掉
  if (path.basename(input) !== input) return null;
  // 2) 字符白名单（顺带排除 `:`、空格、引号等）
  if (!FILE_NAME_RE.test(input)) return null;
  // 3) 不许以点开头（`.` / `..` / 隐藏文件边角）
  if (input.startsWith('.')) return null;
  // 4) 扩展名必须是图片白名单
  const ext = path.extname(input).slice(1).toLowerCase();
  if (!ALLOWED_EXT_SET.has(ext)) return null;
  return input;
}

/**
 * 本功能独占的图片目录（userData 下，安装到 Program Files 后仍可写）。
 * @param {string} userDataDir Electron 的 userData 目录
 * @returns {string} 绝对目录路径
 */
function backgroundsDir(userDataDir) {
  return path.join(userDataDir, 'backgrounds');
}

/**
 * 把图片缓冲拼成 data URL。
 * @param {Buffer} buffer 图片字节
 * @param {string} ext 小写扩展名（不含点）
 * @returns {string} data URL
 */
function toDataUrl(buffer, ext) {
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * 列出目录内由本功能产生的图片文件（只按扩展名白名单命中，不递归、不删其它文件）。
 * @param {string} dir 图片目录
 * @returns {string[]} 文件名列表
 */
function listStoredBackgrounds(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // 目录还不存在
  }
  const names = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).slice(1).toLowerCase();
    if (!ALLOWED_EXT_SET.has(ext)) continue;
    if (!FILE_NAME_RE.test(entry.name)) continue;
    names.push(entry.name);
  }
  return names;
}

/**
 * 清空图片目录里由本功能产生的文件。
 * @param {string} dir 图片目录
 * @returns {number} 实际删除的文件数
 */
function removeStoredBackgrounds(dir) {
  let removed = 0;
  for (const name of listStoredBackgrounds(dir)) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch {
      // 单个文件删不掉（被占用）不影响其它文件与「已清除」的语义
    }
  }
  return removed;
}

/**
 * 注册三条背景 IPC。
 *
 * @param {object} deps 依赖注入（便于用普通 node 跑真路径，不必启动 Electron）
 * @param {import('electron').IpcMain} deps.ipcMain 主进程 IPC 总线
 * @param {import('electron').Dialog} deps.dialog 原生对话框
 * @param {import('electron').NativeImage} deps.nativeImage 原生图片工具
 * @param {string} deps.userDataDir userData 目录
 * @param {() => any} deps.getWindow 取主窗口（对话框的父窗口，可返回 null）
 * @param {(event: any) => boolean} deps.assertTrustedSender 来源校验
 * @returns {{dir: string, close: () => void}} 目录与注销函数
 */
function registerBackgroundImages(deps) {
  const { ipcMain, dialog, nativeImage, userDataDir, getWindow, assertTrustedSender } = deps;
  const dir = backgroundsDir(userDataDir);
  /** IPC 通道名集中在此，preload 侧必须一一对应。 */
  const CHANNELS = ['background:pick', 'background:load', 'background:clear'];

  /**
   * 选图：原生对话框 → 大小/类型/解码校验 → 必要时等比缩放 → 先写新文件再删旧文件。
   * 返回 { ok, fileName, dataUrl, width, height }（取消时 { ok:false, canceled:true }）。
   */
  ipcMain.handle('background:pick', async (event) => {
    if (!assertTrustedSender(event)) return { ok: false, error: '来源未授权' };
    try {
      const win = typeof getWindow === 'function' ? getWindow() : null;
      const dialogOptions = {
        title: '选择主页背景图片',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: [...ALLOWED_EXTENSIONS] }],
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      const sourcePath = result.filePaths[0];
      const ext = path.extname(sourcePath).slice(1).toLowerCase();
      if (!ALLOWED_EXT_SET.has(ext)) return { ok: false, error: '仅支持 PNG / JPG / WEBP 图片' };

      let stat = null;
      try {
        stat = fs.statSync(sourcePath);
      } catch {
        return { ok: false, error: '无法读取所选文件' };
      }
      if (!stat.isFile()) return { ok: false, error: '所选路径不是文件' };
      if (stat.size > MAX_BYTES) return { ok: false, error: `图片超过 ${MAX_BYTES / 1024 / 1024}MB 上限` };

      // 解码校验：扩展名可以伪装，nativeImage 解不出来就不是可用图片
      const image = nativeImage.createFromPath(sourcePath);
      if (!image || image.isEmpty()) return { ok: false, error: '无法解码该图片（文件可能已损坏或并非图片）' };

      let buffer = null;
      let outExt = ext;
      let size = image.getSize();
      const longEdge = Math.max(size.width, size.height);
      if (longEdge > MAX_EDGE) {
        const scale = MAX_EDGE / longEdge;
        const width = Math.max(1, Math.round(size.width * scale));
        const height = Math.max(1, Math.round(size.height * scale));
        const resized = image.resize({ width, height, quality: 'best' });
        if (!resized || resized.isEmpty()) return { ok: false, error: '图片缩放失败' };
        // 缩放后统一存 PNG：避免二次有损压缩，也避免 webp 编码不可用
        buffer = resized.toPNG();
        outExt = 'png';
        size = resized.getSize();
      } else {
        buffer = fs.readFileSync(sourcePath);
      }
      if (buffer.length > MAX_BYTES) {
        return { ok: false, error: `图片超过 ${MAX_BYTES / 1024 / 1024}MB 上限（压缩后仍然过大）` };
      }

      fs.mkdirSync(dir, { recursive: true });
      const fileName = `${crypto.randomUUID()}.${outExt}`;
      const targetPath = path.join(dir, fileName);
      // 先写新文件：写不进去就直接返回失败，用户原有背景图保持不动
      fs.writeFileSync(targetPath, buffer);
      // 再删旧文件（只删本目录内的图片，不递归、不碰其它文件）
      for (const name of listStoredBackgrounds(dir)) {
        if (name === fileName) continue;
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          // 旧文件删不掉只会多占一点磁盘，不影响新图生效
        }
      }
      return {
        ok: true,
        fileName,
        dataUrl: toDataUrl(buffer, outExt),
        width: size.width,
        height: size.height,
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  /**
   * 读图：只接受纯文件名，返回 data URL。
   * 渲染层永远不传路径，只传 `background:pick` 给它的那个文件名。
   */
  ipcMain.handle('background:load', async (event, fileName) => {
    if (!assertTrustedSender(event)) return { ok: false, error: '来源未授权' };
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return { ok: false, error: '非法文件名' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fullPath = path.join(dir, safeName);
      // 双保险：即使 basename 校验被绕过，解析后的父目录也必须就是 backgrounds 目录
      if (path.dirname(path.resolve(fullPath)) !== path.resolve(dir)) {
        return { ok: false, error: '非法文件名' };
      }
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) return { ok: false, error: '背景文件不存在' };
      if (stat.size > MAX_BYTES) return { ok: false, error: '背景文件超过大小上限' };
      const buffer = fs.readFileSync(fullPath);
      const ext = path.extname(safeName).slice(1).toLowerCase();
      return { ok: true, fileName: safeName, dataUrl: toDataUrl(buffer, ext) };
    } catch {
      // 文件被删 / 无权限：统一报「不存在」，由渲染层静默回落到默认背景
      return { ok: false, error: '背景文件不存在' };
    }
  });

  /** 清除：删掉 backgrounds 目录下由本功能产生的图片文件。 */
  ipcMain.handle('background:clear', async (event) => {
    if (!assertTrustedSender(event)) return { ok: false, error: '来源未授权' };
    try {
      const removed = removeStoredBackgrounds(dir);
      return { ok: true, removed };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  return {
    dir,
    /** 退出时注销 handler（与 closeFilePreviews 同风格）。 */
    close: () => {
      for (const channel of CHANNELS) {
        try {
          ipcMain.removeHandler(channel);
        } catch {
          // 注销失败不影响退出
        }
      }
    },
  };
}

module.exports = {
  registerBackgroundImages,
  sanitizeFileName,
  listStoredBackgrounds,
  removeStoredBackgrounds,
  backgroundsDir,
  toDataUrl,
  MAX_BYTES,
  MAX_EDGE,
  ALLOWED_EXTENSIONS,
};
