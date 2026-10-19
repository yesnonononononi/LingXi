/**
 * 跨平台环境与系统能力抽象层。
 *
 * 在桌面客户端 (Electron) 下调用操作系统原生能力 (系统文件夹选择、原生横幅通知、托盘交互等)，
 * 在 Web 浏览器环境下自动优雅降级。
 */

import type { FilePreviewRequest, FilePreviewData, NativeFileResult } from '../types/filePreview';
import type { UpdateStatePayload, UpdateLookupResult, UpdateActionResult } from '../types/update';

/** 通知类别：决定通知卡片的图标与配色。 */
export type NotifyKind = 'completed' | 'failed' | 'cancelled' | 'suspended';

/** 一条任务通知的请求体（与主进程 `notification-window.cjs` 的 payload 一致）。 */
export interface NotifyRequest {
  title: string;
  body: string;
  /** 归属会话；用户点通知时据此跳转。 */
  sessionId?: string | number | null;
  kind?: NotifyKind;
  /** 停留时长（毫秒）；不传由主进程取默认值。 */
  duration?: number;
  /** 主应用当前主题，通知卡片据此配色（不传则通知窗口自行回退）。 */
  theme?: 'dark' | 'light';
}

/** 用户点击通知后主进程回传的信息。 */
export interface NotifyActivation {
  sessionId: string | null;
  kind: string | null;
}

export interface ElectronAPI {

  previewFile?: (request: FilePreviewRequest) => Promise<NativeFileResult<FilePreviewData>>;
  openFile?: (request: FilePreviewRequest) => Promise<NativeFileResult<void>>;
  revealFile?: (request: FilePreviewRequest) => Promise<NativeFileResult<void>>;
  unwatchFile?: (watchId: string) => Promise<NativeFileResult<void>>;
  onFileChanged?: (callback: (change: { watchId: string }) => void) => () => void;
  selectDirectory: () => Promise<string | null>;
  /** 重启应用（仅桌面端；主进程会先停后端再重启）。Web 端为 undefined。 */
  relaunchApp?: () => Promise<boolean>;
  /** 发送任务通知（自绘云母卡片，系统不支持时退回原生横幅） */
  notify: (options: NotifyRequest) => Promise<boolean>;
  /** 订阅「用户点了通知」事件；返回取消订阅函数。Web 端为 undefined。 */
  onNotificationActivate?: (callback: (payload: NotifyActivation) => void) => () => void;

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

/**
 * 重启应用（数据目录改完必须重启才切得过去）。
 *
 * <p>桌面端由主进程先停后端、再 relaunch；Web 端没有可重启的进程，返回 false
 * 交给调用方提示用户手动重启 —— 这里不做任何「假装重启成功」的降级。</p>
 *
 * @returns 是否真的把重启意图交给了桌面端
 */
export async function relaunchApp(): Promise<boolean> {
  if (isElectron() && window.electronAPI?.relaunchApp) {
    try {
      await window.electronAPI.relaunchApp();
      return true;
    } catch (err) {
      console.error('[relaunchApp] 重启失败:', err);
      return false;
    }
  }
  return false;
}

/** 判定当前应用是否处于后台、最小化或失焦状态（用于在用户未查看窗口时触发系统提醒） */
export function isAppInactive(): boolean {
  if (typeof document === 'undefined') return false;
  return document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus());
}

/**
 * 发送一条任务通知（桌面端自绘云母卡片，Web 端降级为浏览器通知）。
 *
 * @param request 通知内容与归属会话
 * @param onlyWhenInactive 若为 true，则仅在应用处于后台/未聚焦时弹出
 * @returns 是否成功弹出
 */
export async function sendDesktopNotification(
  request: NotifyRequest,
  onlyWhenInactive: boolean = false
): Promise<boolean> {
  if (onlyWhenInactive && !isAppInactive()) {
    return false;
  }
  const { title, body } = request;

  // 1. Electron 桌面端：主进程建自绘云母窗口，建不出来时它自己退回原生横幅
  if (isElectron() && window.electronAPI?.notify) {
    try {
      return await window.electronAPI.notify(request);
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

/**
 * 订阅「用户点击了通知」。
 *
 * @param handler 收到归属会话后由调用方负责切会话
 * @returns 取消订阅函数；非桌面端返回空实现
 */
export function onNotificationActivate(handler: (payload: NotifyActivation) => void): () => void {
  if (!isElectron() || !window.electronAPI?.onNotificationActivate) {
    return () => {};
  }
  return window.electronAPI.onNotificationActivate(handler);
}


