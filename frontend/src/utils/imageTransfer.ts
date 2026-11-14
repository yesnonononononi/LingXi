/**
 * 图片字节与文件名：右键菜单「复制图片 / 保存图片」共用的取字节入口。
 *
 * <p>为什么字节必须在渲染层取：图源可能是 `blob:`（用户刚上传的附件，只有本进程能解析）、
 * `data:` 或后端 `http(s)` 地址。主进程一条都取不全，所以统一在这里 fetch 成字节，
 * 再交给主进程做真正的系统动作（写剪贴板、弹保存对话框）。</p>
 */

/** 单张图片经过 IPC 的上限（40MB）：再大就是内存里三份拷贝，收益远不抵成本。 */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

/** MIME → 保存扩展名。缺项一律按 png，避免生成一个没有扩展名的文件。 */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

/** 文件名里不允许出现的字符：Windows 全量非法集 + 分隔符 + 控制字符。 */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/** 认定为「已经带了图片扩展名」的后缀。 */
const IMAGE_SUFFIX_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

/**
 * 按 MIME 取保存扩展名。
 *
 * @param mime 图片 MIME
 * @returns 小写扩展名（不含点），未知类型退回 png
 */
export function resolveImageExtension(mime: string): string {
  return EXTENSION_BY_MIME[(mime || '').toLowerCase()] || 'png';
}

/**
 * 把「可读名称」变成保存对话框的默认文件名。
 *
 * <p>入参五花八门：可能是文件绝对路径、可能是「用户上传图片 2」这种说明文字。所以先取最后一段
 * 路径分量、再洗掉文件名非法字符，最后补上图片扩展名 —— 让用户在对话框里只需要点确定。</p>
 *
 * @param name 可读名称（文件名或图片说明）
 * @param mime 图片 MIME，决定兜底扩展名
 * @returns 安全可用的文件名，永不为空
 */
export function suggestImageFileName(name: string, mime: string): string {
  const extension = resolveImageExtension(mime);
  const lastSegment = (name || '').split(/[\\/]/).pop() ?? '';
  const cleaned = lastSegment.replace(ILLEGAL_NAME_CHARS, '_').trim();
  if (!cleaned) {
    return `image.${extension}`;
  }
  return IMAGE_SUFFIX_RE.test(cleaned) ? cleaned : `${cleaned}.${extension}`;
}

/**
 * 读取图片字节。
 *
 * <p>只接受同源、`blob:`、`data:` 与开了 CORS 的远端地址；取不到时抛中文错误 ——
 * 调用方据此提示用户，而不是静默地把空字节写进剪贴板。</p>
 *
 * @param src 图片地址
 * @returns 图片字节
 */
export async function readImageBytes(src: string): Promise<ArrayBuffer> {
  const blob = await readImageBlob(src);
  return blob.arrayBuffer();
}

/**
 * 读取图片 Blob（保存原格式用）。
 *
 * @param src 图片地址
 * @returns 图片 Blob，大小与空内容都在这里挡掉
 */
export async function readImageBlob(src: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(src);
  } catch (err) {
    throw new Error(`无法读取该图片：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    throw new Error(`无法读取该图片（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  if (blob.size === 0) {
    throw new Error('图片内容为空');
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB，无法复制或保存`);
  }
  return blob;
}

/**
 * 转成 PNG 字节。
 *
 * <p>剪贴板只认位图：`nativeImage` 从缓冲解码只支持 PNG/JPEG，webp、gif 直接写进去会是一张空图。
 * 所以复制路径统一转一次 PNG；非图片或环境不支持转码时退回原始字节，让调用方拿明确失败，
 * 而不是把别的格式硬塞进剪贴板。</p>
 *
 * @param blob 原始图片
 * @returns PNG 字节
 */
export async function toPngBytes(blob: Blob): Promise<ArrayBuffer> {
  if (blob.type === 'image/png') {
    return blob.arrayBuffer();
  }
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return blob.arrayBuffer();
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) {
      return blob.arrayBuffer();
    }
    context.drawImage(bitmap, 0, 0);
    const png = await canvas.convertToBlob({type: 'image/png'});
    return png.arrayBuffer();
  } finally {
    bitmap.close();
  }
}
