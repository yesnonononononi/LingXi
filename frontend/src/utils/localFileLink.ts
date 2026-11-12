/**
 * 本地文件链接：把 Markdown 里形如 `[预览代码](/D:/repo/a.cjs:34)` 的链接识别成本机文件。
 *
 * <p>解析只在这里做一次，判定结果由 markdown.ts（渲染）与 MarkdownRenderer（点击）共用，
 * 两边各写一份正则迟早会对不上。只认绝对路径：Web 链接（含 `//host/x` 这种协议相对地址）
 * 一律不接管，保持普通链接行为。</p>
 */

/** 本地文件链接的类名与 data 属性：渲染方与点击处理方共用，禁止各自再写一份字面量。 */
export const LOCAL_FILE_LINK_CLASS = 'lx-local-file';
export const LOCAL_FILE_PATH_ATTR = 'data-local-file-path';
export const LOCAL_FILE_LINE_ATTR = 'data-local-file-line';

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const TRAILING_LINE = /:(\d+)$/;

export interface LocalFileLinkTarget {
  /** 文件绝对路径；`/D:/x` 这种多写前导斜杠的写法已归一成 `D:/x`。 */
  path: string;
  /** 行号（1 起）；链接没带行号时为空。 */
  line?: number;
}

/**
 * 从链接地址里取出本地文件路径与可选行号。
 *
 * @param href Markdown 渲染后的 href（markdown-it 已做百分号编码，这里要还原）。
 * @returns 本机绝对路径则返回目标，Web 链接、相对路径、空值返回 undefined。
 */
export function parseLocalFileLink(href: string | null | undefined): LocalFileLinkTarget | undefined {
  const raw = typeof href === 'string' ? href.trim() : '';
  // 协议相对地址（//example.com/x）同样以 / 开头，必须先按 Web 链接排除。
  if (!raw || raw.startsWith('//')) return undefined;
  const decoded = decodeHref(raw);
  if (decoded.startsWith('//')) return undefined;

  const matched = TRAILING_LINE.exec(decoded);
  const path = normalizeAbsolutePath(matched ? decoded.slice(0, matched.index) : decoded);
  if (!path) return undefined;
  const line = matched ? Number(matched[1]) : 0;
  return line >= 1 ? { path, line } : { path };
}

/**
 * 展示用的完整位置（路径 + 行号）：tooltip 与日志直接读它，避免各自拼字符串。
 *
 * @param target 解析结果。
 * @returns 例如 `D:/repo/a.cjs:34`。
 */
export function formatLocalFileLocation(target: LocalFileLinkTarget): string {
  return target.line ? `${target.path}:${target.line}` : target.path;
}

/** 还原 markdown-it 的百分号编码；带裸 `%` 的路径解码会抛错，此时原样使用比丢掉链接更合适。 */
function decodeHref(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 归一成本机绝对路径；不是绝对路径返回 undefined。 */
function normalizeAbsolutePath(value: string): string | undefined {
  if (!value) return undefined;
  // `/D:/repo/a.cjs` 的前导斜杠只是 Markdown 写法，Windows 盘符路径要还原成 `D:/repo/a.cjs`。
  const path = value.startsWith('/') && WINDOWS_ABSOLUTE.test(value.slice(1)) ? value.slice(1) : value;
  if (WINDOWS_ABSOLUTE.test(path)) return path;
  // 其余只认 POSIX 绝对路径；协议相对的 `//host/x` 上面已经挡掉。
  return path.startsWith('/') ? path : undefined;
}
