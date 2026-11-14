import type {InjectionKey} from 'vue';

/** 一次编辑的定位信息：差异与撤销都要按 (executionId, recordId) 取记录。 */
export interface FilePreviewEditRef {
  executionId: string;
  recordId: string;
}

/** 打开预览后要定位到的行：`line` 是目标行号（1 起），`seq` 是请求序号。 */
export interface FilePreviewLineAnchor {
  line: number;
  seq: number;
}

/**
 * 「打开文件预览」的入参。
 *
 * <p>用对象而不是位置参数：行号、编辑上下文都是可选的，位置参数一长就得写
 * `openFilePreview(sessionId, path, undefined, 34)`，漏一个就静默错位。</p>
 */
export interface FilePreviewOpenRequest {
  /** 解析工作区用的会话；绝对路径不需要，可省略。 */
  sessionId?: string | number;
  /** 文件路径：本机绝对路径，或相对会话工作目录的路径。 */
  path: string;
  /** 由编辑工具行打开时携带；缺失表示「只是看文件」，面板不提供差异与撤销。 */
  edit?: FilePreviewEditRef;
  /** 打开后定位到的行号（1 起）；缺省只打开文件不定位。 */
  line?: number;
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

/** 设计原型落盘入参：只含原始字段，跨进程不能带响应式 Proxy。 */
export interface DesignDocumentWriteRequest {
  sessionId: string;
  baseUrl: string;
  path: string;
  content: string;
}

export interface FilePreviewTab {
  id: string;
  request: FilePreviewRequest;
  name: string;
  data?: FilePreviewData;
  loading: boolean;
  error: string;
  /**
   * 行定位请求。属于渲染态而不是读文件请求：主进程只读整个文件，定位完全在面板里完成。
   *
   * <p>`seq` 每次打开自增 —— 重复点同一个链接也要能再次滚回那一行。</p>
   */
  lineAnchor?: FilePreviewLineAnchor;
}

/**
 * 「打开文件预览」注入通道。
 *
 * <p>只有编辑工具行会带 {@code edit}：面板据此提供差异视图与撤销。读文件、本地文件链接、
 * 日志跳转都不带，行为与之前完全一致。</p>
 */
export const FILE_PREVIEW_KEY: InjectionKey<(request: FilePreviewOpenRequest) => void> =
  Symbol('file-preview');

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
