/**
 * 跨平台环境与系统能力抽象层。
 *
 * 在桌面客户端 (Electron) 下调用操作系统原生能力 (系统文件夹选择、原生横幅通知、托盘交互等)，
 * 在 Web 浏览器环境下自动优雅降级。
 */

import type { FilePreviewRequest, FilePreviewData, NativeFileResult } from '../types/filePreview';
import type { UpdateStatePayload, UpdateLookupResult, UpdateActionResult } from '../types/update';

export interface ElectronAPI {
  previewFile?: (request: FilePreviewRequest) => Promise<NativeFileResult<FilePreviewData>>;
  openFile?: (request: FilePreviewRequest) => Promise<NativeFileResult<void>>;
  revealFile?: (request: FilePreviewRequest) => Promise<NativeFileResult<void>>;
  unwatchFile?: (watchId: string) => Promise<NativeFileResult<void>>;
  onFileChanged?: (callback: (change: { watchId: string }) => void) => () => void;
  selectDirectory: () => Promise<string | null>;
  notify: (options: { title: string; body: string }) => Promise<boolean>;
  platform: string;
  setTitleBarTheme?: (isDark: boolean) => Promise<void>;
  customTitleBar?: boolean;
  /** 自动更新（桌面端打包态可用）。Web 端为 undefined，调用方需判空。 */
  updater?: ElectronUpdaterAPI;
}

/**
 * 渲染层可用的更新接口。
 *
 * ⚠️ 这里刻意只有「读状态」和「发意图」两类方法，没有任何涉及 URL 或文件的方法。
 *    下载、校验、安装全部在主进程完成 —— 渲染层接触不到，也就无法被注入利用。
 */
export interface ElectronUpdaterAPI {
  getState: () => Promise<UpdateLookupResult | null>;
  check: () => Promise<UpdateActionResult>;
  download: () => Promise<UpdateActionResult>;
  install: () => Promise<UpdateActionResult>;
  openLog: () => Promise<boolean>;
  /** 订阅更新状态；返回取消订阅函数 */
  onState: (callback: (state: UpdateStatePayload) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

/** 当前是否运行于 Electron 桌面客户端 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && Boolean(window.electronAPI);
}

/**
 * 调起本地文件夹选择器。
 *
 * - 在 Electron 环境下：调用原生系统的选择目录对话框，返回选中的真实物理绝对路径。
 * - 在 Web 浏览器环境下：返回 null（调用方可提示或降级为手动输入）。
 */
export async function openDirectoryPicker(): Promise<string | null> {
  if (isElectron() && window.electronAPI?.selectDirectory) {
    try {
      const selected = await window.electronAPI.selectDirectory();
      return selected || null;
    } catch (err) {
      console.error('[openDirectoryPicker] 原生目录选择失败:', err);
      return null;
    }
  }
  return null;
}

/** 判定当前应用是否处于后台、最小化或失焦状态（用于在用户未查看窗口时触发系统提醒） */
export function isAppInactive(): boolean {
  if (typeof document === 'undefined') return false;
  return document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());
}

/**
 * 发送系统原生通知 (Windows 10/11 悬浮横幅)。
 *
 * 优先调用桌面端原生 Notification API；若在 Web 端且支持 Notification 权限则降级使用 Web Notification。
 * @param title 通知标题
 * @param body 通知主体内容
 * @param onlyWhenInactive 若为 true，则仅在应用处于后台/未聚焦时弹出
 */
export async function sendDesktopNotification(
  title: string,
  body: string,
  onlyWhenInactive: boolean = false
): Promise<boolean> {
  if (onlyWhenInactive && !isAppInactive()) {
    return false;
  }

  // 1. Electron 桌面端原生通知
  if (isElectron() && window.electronAPI?.notify) {
    try {
      return await window.electronAPI.notify({ title, body });
    } catch (err) {
      console.warn('[sendDesktopNotification] 桌面通知发送失败:', err);
    }
  }

  // 2. Web 浏览器端降级通知 (若用户已授权)
  if (typeof window !== 'undefined' && 'Notification' in window) {
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
      return true;
    }
  }

  return false;
}

