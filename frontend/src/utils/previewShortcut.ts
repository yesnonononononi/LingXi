export interface PreviewShortcutEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  code: string;
  repeat: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/**
 * 判断按键事件是否命中「切换右侧预览面板」快捷键（Ctrl+\ / Cmd+\）。
 * 同时校验 code 与 key，避免中文输入法激活时 key 变化导致快捷键失效。
 */
export function isTogglePreviewShortcut(event: PreviewShortcutEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  return event.code === 'Backslash' || event.key === '\\';
}

/** 返回当前平台对应的预览面板快捷键展示文案。 */
export function formatTogglePreviewShortcut(platform?: string): string {
  return platform === 'darwin' ? '⌘\\' : 'Ctrl+\\';
}
