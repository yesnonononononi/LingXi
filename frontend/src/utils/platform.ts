/**
 * 跨平台环境与系统能力抽象层。
 *
 * 在桌面客户端 (Electron) 下调用操作系统原生能力 (系统文件夹选择、原生横幅通知、托盘交互等)，
 * 在 Web 浏览器环境下自动优雅降级。
 */

import type {DesignDocumentWriteRequest, FilePreviewData, FilePreviewIpcRequest, NativeFileResult} from '../types/filePreview';
import type {ElectronImageAPI} from '../types/imageActions';
import type {
  ProjectPageState,
  ProjectPageIpcResult,
  ProjectPageCommandRequest,
  ProjectPageLayoutRequest,
  ProjectPageMenuLabels,
  ShowWithAgentPayload,
} from '../types/projectPagePreview';
import type {UpdateActionResult, UpdateLookupResult, UpdateStatePayload} from '../types/update';
import type {TextEditCommand} from './contextMenu';
import {readImageBlob, suggestImageFileName, toPngBytes} from './imageTransfer';

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
  /** 提示音 id；不传则该条通知不出声（静音由调用方决定，主进程不做默认填充）。 */
  sound?: string;
}

/** 用户点击通知后主进程回传的信息。 */
export interface NotifyActivation {
  sessionId: string | null;
  kind: string | null;
}

/** 主页背景选图结果（主进程已完成大小/类型/解码校验；取消时 canceled=true）。 */
export interface BackgroundPickResult {
  readonly ok: boolean;
  readonly canceled?: boolean;
  /** 本机文件名（**不是路径**）：渲染层只保管它，用来重启后回读。 */
  readonly fileName?: string;
  readonly dataUrl?: string;
  readonly width?: number;
  readonly height?: number;
  readonly error?: string;
}

/** 主页背景读图结果。 */
export interface BackgroundLoadResult {
  readonly ok: boolean;
  readonly fileName?: string;
  readonly dataUrl?: string;
  readonly error?: string;
}

/** 主页背景清除结果。 */
export interface BackgroundClearResult {
  readonly ok: boolean;
  /** 实际删除的文件数。 */
  readonly removed?: number;
  readonly error?: string;
}

/**
 * 主页背景 IPC（桌面端可用，Web 端为 undefined）。
 *
 * <p>⚠️ 三个方法都只接受/返回**文件名与 data URL**，没有任何传路径的入口 ——
 * 目录穿越在主进程侧就会被文件名白名单拒绝。</p>
 */
export interface ElectronBackgroundAPI {
  pick: () => Promise<BackgroundPickResult>;
  load: (fileName: string) => Promise<BackgroundLoadResult>;
  clear: () => Promise<BackgroundClearResult>;
}

/** 网页视图仅在主进程创建，远程页面不持有此通道。 */
export interface ElectronProjectPageAPI {
  command: (request: ProjectPageCommandRequest) => Promise<ProjectPageIpcResult<ProjectPageState>>;
  layout: (request: ProjectPageLayoutRequest) => Promise<ProjectPageIpcResult<{applied: boolean}>>;
  /** 原生右键菜单文案（按当前语言推送）。旧客户端没有此方法，调用方需判空。 */
  setLabels?: (labels: ProjectPageMenuLabels) => Promise<ProjectPageIpcResult<{applied: boolean}>>;
  onEvent: (callback: (event: ProjectPageState) => void) => () => void;
  onShowWithAgent?: (callback: (payload: ShowWithAgentPayload) => void) => () => void;
}

export interface ElectronAPI {

  previewFile?: (request: FilePreviewIpcRequest) => Promise<NativeFileResult<FilePreviewData>>;
  openFile?: (request: FilePreviewIpcRequest) => Promise<NativeFileResult<void>>;
  revealFile?: (request: FilePreviewIpcRequest) => Promise<NativeFileResult<void>>;
  unwatchFile?: (watchId: string) => Promise<NativeFileResult<void>>;
  /** 设计原型落盘：路径必须是工作区内 `.lingxi/design/*.html`。 */
  writeDesignDocument?: (request: DesignDocumentWriteRequest) => Promise<NativeFileResult<{ path: string; size: number }>>;
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
  /** 主页背景（选图 / 读图 / 清除）。Web 端为 undefined，调用方需判空。 */
  background?: ElectronBackgroundAPI;
  packs?: ElectronPacksAPI;
  /** 项目页面原生视图通道。Web 端为 undefined，调用方需判空。 */
  projectPage?: ElectronProjectPageAPI;
  /** 自动更新（桌面端打包态可用）。Web 端为 undefined，调用方需判空。 */
  updater?: ElectronUpdaterAPI;
  /**
   * 文本编辑命令（右键菜单的剪切/复制/粘贴/全选）。
   *
   * <p>为什么必须走主进程：渲染层的 `document.execCommand('paste')` 被 Chromium 禁用，
   * 只有 `webContents.paste()` 能把系统剪贴板内容落进焦点输入框（也才进撤销栈）。
   * 四条命令在主进程按白名单校验，渲染层给不了别的动作。</p>
   */
  edit?: (command: TextEditCommand) => Promise<boolean>;
  /**
   * 图片动作（右键菜单的复制图片 / 保存图片）。Web 端为 undefined，调用方需判空。
   *
   * <p>字节由渲染层取好再交过来：图源可能是只有渲染进程能解析的 `blob:`。主进程只做
   * 「写剪贴板」与「弹系统保存对话框」这两件渲染层做不到的事。</p>
   */
  image?: ElectronImageAPI;
}

/**
 * 渲染层可用的更新接口。
 *
 * ⚠️ 这里刻意只有「读状态」和「发意图」两类方法，没有任何涉及 URL 或文件的方法。
 *    下载、校验、安装全部在主进程完成 —— 渲染层接触不到，也就无法被注入利用。
 */
export interface CustomScannedPackManifest extends RemotePackManifest {
  readonly packDir: string;
}

export interface ElectronPacksAPI {
  fetchRegistry: (category: RemotePackManifest['category']) => Promise<{ ok: boolean; packs?: RemotePackManifest[]; error?: string }>;
  listInstalled: () => Promise<{ ok: boolean; packs?: RemotePackManifest[]; error?: string }>;
  install: (request: { id: string; files?: readonly string[] }) => Promise<{ ok: boolean; manifest?: RemotePackManifest; error?: string }>;
  load: (packId: string) => Promise<{ ok: boolean; manifest?: RemotePackManifest; cssText?: string; error?: string }>;
  uninstall: (packId: string) => Promise<{ ok: boolean; error?: string }>;
  pickCustomDir: () => Promise<{ ok: boolean; canceled?: boolean; dirPath?: string; error?: string }>;
  scanCustomDir: (dirPath: string) => Promise<{ ok: boolean; dirPath?: string; packs?: CustomScannedPackManifest[]; error?: string }>;
  loadCustom: (request: { id: string; packDir: string }) => Promise<{ ok: boolean; manifest?: RemotePackManifest; cssText?: string; error?: string }>;
  openGuide: () => Promise<{ ok: boolean; error?: string }>;
}

export interface RemotePackManifest {
  readonly id: string;
  readonly category: 'theme' | 'font' | 'background' | 'sidebar' | 'input' | 'component';
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly hostApiVersion?: string;
  readonly capabilities?: readonly string[];
  readonly preview?: {
    readonly canvas: string;
    readonly surface: string;
    readonly accent: string;
    readonly text: string;
  };
  readonly fontPreview?: {
    readonly sample: string;
    readonly family: string;
  };
  readonly files?: readonly string[];
}

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

/**
 * 执行一条文本编辑命令（右键菜单的剪切 / 复制 / 粘贴 / 全选）。
 *
 * <p>桌面端恒走主进程：`document.execCommand('paste')` 在 Chromium 里被禁用，
 * 只有 `webContents.paste()` 能读系统剪贴板且保留撤销栈。Web 端（`vite dev` 直接开浏览器）
 * 退回 `execCommand`，粘贴则读剪贴板后手动插入。</p>
 *
 * @param command 命令 id
 * @returns 命令是否真的派发出去（失败时返回 false，调用方无需额外提示）
 */
export async function runTextEditCommand(command: TextEditCommand): Promise<boolean> {
  if (typeof document === 'undefined') {
    return false;
  }
  const bridge = isElectron() ? window.electronAPI?.edit : undefined;
  if (bridge) {
    try {
      return await bridge(command);
    } catch (err) {
      console.error('执行文本命令失败:', err);
      return false;
    }
  }
  if (command !== 'paste') {
    return document.execCommand(command);
  }
  try {
    const text = await navigator.clipboard.readText();
    return text ? document.execCommand('insertText', false, text) : true;
  } catch (err) {
    console.error('执行文本命令失败:', err);
    return false;
  }
}

/** 图片保存的结果。`saved` 与 `canceled` 都是正常结局，只有 `failed` 需要用户重试。 */
export type ImageSaveOutcome = 'saved' | 'canceled' | 'failed';

/**
 * 把图片复制进系统剪贴板。
 *
 * <p>桌面端交给主进程 `clipboard.writeImage`：渲染层的 `navigator.clipboard.write` 在
 * `file://` 页面里不可用，也没有位图写入的可靠路径。Web 端退回标准 Clipboard API。</p>
 *
 * @param src 图片地址（data: / blob: / http(s)）
 * @returns 是否成功写入剪贴板（失败已打日志，调用方无需再提示）
 */
export async function copyImageToClipboard(src: string): Promise<boolean> {
  try {
    const blob = await readImageBlob(src);
    const png = await toPngBytes(blob);
    const bridge = isElectron() ? window.electronAPI?.image : undefined;
    if (bridge) {
      const result = await bridge.copy(png);
      if (!result.ok) {
        console.error('复制图片失败:', result.error);
      }
      return result.ok;
    }
    await navigator.clipboard.write([new ClipboardItem({'image/png': new Blob([png], {type: 'image/png'})})]);
    return true;
  } catch (err) {
    console.error('复制图片失败:', err);
    return false;
  }
}

/**
 * 另存一张图片：桌面端弹系统保存对话框，Web 端退到浏览器下载。
 *
 * <p>保存位置由用户在系统对话框里选，渲染层从头到尾拿不到路径入参 —— 不给「任意路径写文件」
 * 留任何入口。</p>
 *
 * @param src 图片地址（data: / blob: / http(s)）
 * @param suggestedName 默认文件名（来自图片说明或原文件名）
 * @returns 保存结局
 */
export async function saveImageFile(src: string, suggestedName: string): Promise<ImageSaveOutcome> {
  try {
    const blob = await readImageBlob(src);
    const fileName = suggestImageFileName(suggestedName, blob.type);
    const bridge = isElectron() ? window.electronAPI?.image : undefined;
    if (bridge) {
      const result = await bridge.save(await blob.arrayBuffer(), fileName);
      if (result.ok) {
        return 'saved';
      }
      if (result.canceled) {
        return 'canceled';
      }
      console.error('保存图片失败:', result.error);
      return 'failed';
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    return 'saved';
  } catch (err) {
    console.error('保存图片失败:', err);
    return 'failed';
  }
}


