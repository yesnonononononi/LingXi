'use strict';

/**
 * 图片右键动作的主进程侧（复制到剪贴板 / 另存为）。
 *
 * <p><b>为什么单独成模块：</b>与 `background-images.cjs` / `file-preview.cjs` 同构 ——
 * main.cjs 只注入 electron 能力，本文件<b>不 require('electron')</b>，所以能直接用普通 node
 * 跑通两条路径（单元测试不必启动桌面应用）。</p>
 *
 * <p><b>安全边界：</b></p>
 * <ol>
 *   <li>两个 handler 都先做来源校验（与 `update:*` / `background:*` 同一口径）；</li>
 *   <li>载荷只接受字节与文件名字符串，<b>没有任何路径入参</b>：保存位置一律由用户在系统对话框里选；</li>
 *   <li>默认文件名先取 basename、再洗字符、再核扩展名白名单，用户看到的是一个干净的文件名；</li>
 *   <li>字节上限与渲染层同源（{@link MAX_BYTES}），并且必须能被 `nativeImage` 解码 ——
 *       扩展名与内容对不上时宁可报错，也不往剪贴板塞一张空图。</li>
 * </ol>
 */

const fs = require('node:fs');
const path = require('node:path');

/** 单张图片上限 40MB（与渲染层 `utils/imageTransfer.ts` 的 MAX_IMAGE_BYTES 保持一致）。 */
const MAX_BYTES = 40 * 1024 * 1024;

/** 保存对话框允许的扩展名（同时是文件名白名单的判定依据）。 */
const ALLOWED_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

/** 扩展名 → 对话框过滤器名。 */
const FILTER_NAME_BY_EXT = Object.freeze({
  png: 'PNG 图片',
  jpg: 'JPEG 图片',
  jpeg: 'JPEG 图片',
  webp: 'WEBP 图片',
  gif: 'GIF 图片',
  bmp: 'BMP 图片',
});

/** 文件名里不允许出现的字符：Windows 全量非法集 + 控制字符。 */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** 默认文件名（用户说明为空或全被洗掉时用）。 */
const FALLBACK_NAME = 'image.png';

/**
 * 把渲染层传来的字节载荷转成 Buffer。
 *
 * <p>结构化克隆可能给出 ArrayBuffer、Uint8Array（Buffer 过 IPC 后会变成 Uint8Array），
 * 两种都要认；其它类型一律当非法载荷，不做「尽力猜测」。</p>
 *
 * @param {unknown} input 渲染层载荷
 * @returns {Buffer|null} 合法时为 Buffer
 */
function toBuffer(input) {
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

/**
 * 校验并转换载荷，顺便挡掉空内容与超大图。
 *
 * @param {unknown} input 渲染层载荷
 * @returns {{ok: true, buffer: Buffer} | {ok: false, error: string}}
 */
function resolvePayload(input) {
  const buffer = toBuffer(input);
  if (!buffer) return { ok: false, error: '图片来源无效' };
  if (buffer.length === 0) return { ok: false, error: '图片内容为空' };
  if (buffer.length > MAX_BYTES) {
    return { ok: false, error: `图片超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB，无法复制或保存` };
  }
  return { ok: true, buffer };
}

/**
 * 把默认文件名洗成安全值。
 *
 * <p>渲染层已经洗过一遍，这里再洗一遍不是重复劳动：主进程不能假定渲染层的实现没被绕过，
 * 而这个名字会被拼进保存对话框的默认路径。</p>
 *
 * @param {unknown} input 渲染层传来的建议文件名
 * @returns {string} 安全文件名（带白名单扩展名）
 */
function sanitizeSuggestedName(input) {
  const raw = typeof input === 'string' ? input : '';
  const base = raw.split(/[\\/]/).pop() || '';
  const cleaned = base.replace(ILLEGAL_NAME_CHARS, '_').trim();
  if (!cleaned) return FALLBACK_NAME;
  const ext = path.extname(cleaned).slice(1).toLowerCase();
  if (ALLOWED_EXTENSIONS.includes(ext)) return cleaned;
  // 没有扩展名或扩展名不认识：按 PNG 补，切不可原样交给系统
  return `${cleaned}.png`;
}

/**
 * 按扩展名给出保存对话框的过滤器。
 *
 * @param {string} fileName 已校验的文件名
 * @returns {Array<{name: string, extensions: string[]}>} dialog filters
 */
function resolveFilters(fileName) {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const name = FILTER_NAME_BY_EXT[ext] || '图片';
  return [
    { name, extensions: [ext] },
    { name: '所有图片', extensions: [...ALLOWED_EXTENSIONS] },
  ];
}

/**
 * 注册两条图片动作 IPC。
 *
 * @param {object} deps 依赖注入（便于用普通 node 跑真路径，不必启动 Electron）
 * @param {import('electron').IpcMain} deps.ipcMain 主进程 IPC 总线
 * @param {import('electron').Dialog} deps.dialog 原生对话框
 * @param {import('electron').Clipboard} deps.clipboard 系统剪贴板
 * @param {import('electron').NativeImage} deps.nativeImage 原生图片工具
 * @param {(event: any) => boolean} deps.assertTrustedSender 来源校验
 * @param {string} deps.downloadsDir 保存对话框的默认目录
 * @param {() => any} deps.getWindow 取主窗口（对话框的父窗口，可返回 null）
 * @returns {{channels: string[], close: () => void}} 通道名与注销函数
 */
function registerImageActions(deps) {
  const { ipcMain, dialog, clipboard, nativeImage, assertTrustedSender, downloadsDir, getWindow } = deps;
  /** IPC 通道名集中在此，preload 侧必须一一对应。 */
  const channels = ['image:copy', 'image:save'];

  /** 复制：字节 → nativeImage → 系统剪贴板。 */
  ipcMain.handle('image:copy', (event, payload) => {
    if (!assertTrustedSender(event)) return { ok: false, error: '来源未授权' };
    const resolved = resolvePayload(payload);
    if (!resolved.ok) return resolved;
    let image = null;
    try {
      image = nativeImage.createFromBuffer(resolved.buffer);
    } catch {
      return { ok: false, error: '无法解码该图片' };
    }
    if (!image || image.isEmpty()) return { ok: false, error: '无法解码该图片（文件可能已损坏或格式不受支持）' };
    clipboard.writeImage(image);
    return { ok: true };
  });

  /** 另存为：字节 → 系统保存对话框 → 写盘。 */
  ipcMain.handle('image:save', async (event, payload, suggestedName) => {
    if (!assertTrustedSender(event)) return { ok: false, error: '来源未授权' };
    const resolved = resolvePayload(payload);
    if (!resolved.ok) return resolved;
    const fileName = sanitizeSuggestedName(suggestedName);
    const options = {
      title: '保存图片',
      defaultPath: path.join(downloadsDir, fileName),
      filters: resolveFilters(fileName),
    };
    try {
      const win = typeof getWindow === 'function' ? getWindow() : null;
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (!result || result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
      }
      fs.writeFileSync(result.filePath, resolved.buffer);
      return { ok: true, path: result.filePath };
    } catch (err) {
      return { ok: false, error: `保存失败：${err && err.message ? err.message : '未知错误'}` };
    }
  });

  return {
    channels,
    /** 注销两条 handler（重载主进程模块时避免重复注册）。 */
    close() {
      for (const channel of channels) ipcMain.removeHandler(channel);
    },
  };
}

module.exports = { registerImageActions, sanitizeSuggestedName, MAX_BYTES };
