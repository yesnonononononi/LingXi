import type {InjectionKey} from 'vue';

/** 一次编辑的定位信息：差异与撤销都要按 (executionId, recordId) 取记录。 */
export interface FilePreviewEditRef {
  executionId: string;
  recordId: string;
}

export interface FilePreviewRequest {
  sessionId?: string;
  path: string;
  baseUrl?: string;
  watchKey: string;
  /** 由编辑工具行打开时携带；缺失表示「只是看文件」，面板不提供差异与撤销。 */
  edit?: FilePreviewEditRef;
}

export interface FilePreviewData {
  path: string;
  content: string;
  encoding: string;
  size: number;
  truncated: boolean;
  watchId?: string;
}

export type NativeFileResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface FilePreviewTab {
  id: string;
  request: FilePreviewRequest;
  name: string;
  data?: FilePreviewData;
  loading: boolean;
  error: string;
}

/**
 * 「打开文件预览」注入通道。
 *
 * <p>第三个参数只在「点的是编辑工具行」时传入：面板据此提供差异视图与撤销。
 * 读文件、按路径打开等场景不传，行为与之前完全一致。</p>
 */
export const FILE_PREVIEW_KEY: InjectionKey<
  (sessionId: string | number | undefined, path: string, edit?: FilePreviewEditRef) => void
> = Symbol('file-preview');
