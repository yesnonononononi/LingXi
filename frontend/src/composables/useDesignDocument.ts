import {onBeforeUnmount, ref, type Ref} from 'vue';
import {getApiBaseUrl} from '../utils/apiConfig';
import {createLocalId} from '../utils/ids';

/** 设计原型在工作区里的固定目录；主进程写口按同一前缀做白名单。 */
export const DESIGN_DOCUMENT_DIR = '.lingxi/design/';

export type DesignDocumentStatus = 'unbound' | 'dirty' | 'saving' | 'saved' | 'error';

/** 由文件名生成工作区内的原型路径：只保留主进程白名单允许的字符。 */
export function buildDesignDocumentPath(fileName: string): string {
  const base = (fileName || 'design-prototype')
    .replace(/\.html?$/i, '')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/^[.-]+/, '') || 'design-prototype';
  return `${DESIGN_DOCUMENT_DIR}${base}.html`;
}

/** 主进程读盘时会把换行统一成 LF，比较「是不是自己刚写的」前要同样处理。 */
const normalizeContent = (content: string): string => content.replace(/\r\n?/g, '\n');

/**
 * 设计画布与工作区文件的绑定：画布保存、Agent 改写都落在同一个文件上。
 *
 * <p>自己写盘也会触发目录监听，所以记住最后一次写入的内容，读回相同内容时不算外部改动，
 * 否则每次保存都会把画布重载一遍、丢掉选中状态。</p>
 */
export function useDesignDocument(options: {
  sessionId: Ref<string | number | undefined | null>;
  onExternalChange: (content: string) => void;
}) {
  const boundPath = ref('');
  const status = ref<DesignDocumentStatus>('unbound');
  const error = ref('');

  let watchId: string | undefined;
  let lastKnownContent = '';
  let unsubscribe: (() => void) | undefined;
  const watchKey = createLocalId('design-watch');

  const resolveSessionId = (): string => {
    const id = options.sessionId.value;
    if (id == null || id === '') throw new Error('请先创建会话，再把设计原型交给 AI');
    return String(id);
  };

  const releaseWatch = (): void => {
    if (watchId) void window.electronAPI?.unwatchFile?.(watchId);
    watchId = undefined;
  };

  const readBack = async (): Promise<void> => {
    const api = window.electronAPI;
    if (!api?.previewFile || !boundPath.value) return;
    const result = await api.previewFile({
      sessionId: resolveSessionId(),
      path: boundPath.value,
      baseUrl: getApiBaseUrl() || window.location.origin,
      watchKey,
    });
    if (!result.ok) throw new Error(result.error);
    if (result.data.watchId && result.data.watchId !== watchId) {
      releaseWatch();
      watchId = result.data.watchId;
    }
    if (result.data.truncated) throw new Error('设计原型文件过大，画布无法完整加载');
    const content = normalizeContent(result.data.content);
    if (content === lastKnownContent) return;
    lastKnownContent = content;
    options.onExternalChange(result.data.content);
    // 重载会走画布的快照逻辑并标记未保存，这里改回：画布此刻与文件一致。
    status.value = 'saved';
  };

  const ensureSubscribed = (): void => {
    if (unsubscribe || !window.electronAPI?.onFileChanged) return;
    unsubscribe = window.electronAPI.onFileChanged(change => {
      if (!watchId || change.watchId !== watchId) return;
      readBack().catch(err => {
        status.value = 'error';
        error.value = err instanceof Error ? err.message : '读取设计原型失败';
      });
    });
  };

  /** 保存画布内容；首次保存时按文件名绑定路径并开始监听。 */
  const save = async (content: string, fileName: string): Promise<string> => {
    const api = window.electronAPI;
    if (!api?.writeDesignDocument) throw new Error('设计原型保存需要桌面客户端');
    const sessionId = resolveSessionId();
    if (!boundPath.value) boundPath.value = buildDesignDocumentPath(fileName);

    status.value = 'saving';
    error.value = '';
    try {
      const result = await api.writeDesignDocument({
        sessionId,
        baseUrl: getApiBaseUrl() || window.location.origin,
        path: boundPath.value,
        content,
      });
      if (!result.ok) throw new Error(result.error);
      // 先记下内容再建监听：监听回调读回的就是这一份，不能被当成 Agent 改动。
      lastKnownContent = normalizeContent(content);
      status.value = 'saved';
      ensureSubscribed();
      if (!watchId) await readBack();
      return boundPath.value;
    } catch (err) {
      status.value = 'error';
      error.value = err instanceof Error ? err.message : '保存设计原型失败';
      throw err;
    }
  };

  const markDirty = (): void => {
    if (boundPath.value && status.value !== 'saving') status.value = 'dirty';
  };

  const unbind = (): void => {
    releaseWatch();
    boundPath.value = '';
    lastKnownContent = '';
    status.value = 'unbound';
    error.value = '';
  };

  onBeforeUnmount(() => {
    unsubscribe?.();
    releaseWatch();
  });

  return {boundPath, status, error, save, markDirty, unbind};
}
