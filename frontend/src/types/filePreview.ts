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

/**
 * 交给主进程的读文件入参：<b>只含主进程真正用得上的字段</b>。
 *
 * <p>{@code edit} 是渲染进程的展示状态，主进程根本不读它。它留在这里有两个害处：
 * 一来是跨界载荷里的无用数据，二来——这才是真踩过的坑——Vue 的 {@code ref} 会把嵌套对象
 * 变成响应式 Proxy，而 V8 结构化克隆<b>拒收 Proxy</b>，IPC 直接报
 * {@code An object could not be cloned.}。所以跨界一律走白名单，不做整对象透传。</p>
 */
export type FilePreviewIpcRequest = Omit<FilePreviewRequest, 'edit'>;

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

/**
 * 渲染态请求 → 跨进程载荷：逐字段白名单，不做整对象透传。
 *
 * <p>不能写成 {@code {...request}}：那是浅拷贝，嵌套的 {@code edit} 依旧是响应式 Proxy，
 * 结构化克隆会以 {@code An object could not be cloned.} 拒绝。也不能指望 {@code structuredClone}
 * 兜底 —— 它对 Proxy 同样报错。显式挑字段是唯一稳的写法。</p>
 */
export function toFilePreviewIpcRequest(request: FilePreviewRequest): FilePreviewIpcRequest {
  return {
    sessionId: request.sessionId,
    path: request.path,
    baseUrl: request.baseUrl,
    watchKey: request.watchKey
  };
}
