export const DEFAULT_WINDOW_TITLE = 'LX';

/** 解析桌面端/浏览器窗口标题：优先使用当前会话名，空串或空白回退为默认产品名。 */
export function resolveWindowTitle(sessionTitle: string | null | undefined): string {
  const trimmed = sessionTitle?.trim();
  return trimmed || DEFAULT_WINDOW_TITLE;
}
