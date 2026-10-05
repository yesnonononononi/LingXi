import type { InjectionKey } from 'vue';

export interface FilePreviewRequest {
  sessionId: string;
  path: string;
  baseUrl: string;
  watchKey: string;
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

export const FILE_PREVIEW_KEY: InjectionKey<(sessionId: string | number | undefined, path: string) => void> = Symbol('file-preview');
