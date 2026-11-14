/**
 * 图片动作的跨进程契约（复制到剪贴板 / 另存为）。
 *
 * <p>渲染层负责取字节，主进程负责写剪贴板与弹系统保存对话框 —— 这两件事都只有主进程能做。
 * 载荷只有 `ArrayBuffer` 与文件名字符串，没有任何路径入参：保存位置一律由用户在系统对话框里选。</p>
 */

/** 复制结果。 */
export interface ImageCopyResult {
  ok: boolean;
  /** 失败原因（中文业务文案，可直接给用户看）。 */
  error?: string;
}

/** 保存结果。 */
export interface ImageSaveResult {
  ok: boolean;
  /** 用户在对话框里取消。 */
  canceled?: boolean;
  /** 实际写入的绝对路径（成功时返回，用于排障）。 */
  path?: string;
  error?: string;
}

/** 渲染层的图片动作通道（Web 端为 undefined）。 */
export interface ElectronImageAPI {
  copy: (bytes: ArrayBuffer) => Promise<ImageCopyResult>;
  save: (bytes: ArrayBuffer, suggestedName: string) => Promise<ImageSaveResult>;
}
