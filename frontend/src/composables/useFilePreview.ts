import { computed, onBeforeUnmount, ref } from 'vue';
import { getApiBaseUrl } from '../utils/apiConfig';
import { createLocalId } from '../utils/ids';
import type { FilePreviewTab } from '../types/filePreview';

export function useFilePreview() {
  const fileTabs = ref<FilePreviewTab[]>([]);
  const activeFileId = ref('');
  const filePreviewOpen = ref(false);
  const activeFile = computed(() => fileTabs.value.find(tab => tab.id === activeFileId.value));
  let unsubscribe: (() => void) | undefined;
  const pendingRefreshes = new Set<string>();

  const refreshFile = async (tab: FilePreviewTab) => {
    if (tab.loading) {
      pendingRefreshes.add(tab.request.watchKey);
      return;
    }
    tab.loading = true;
    tab.error = '';
    try {
      const api = window.electronAPI;
      if (!api?.previewFile) throw new Error('文件预览需要使用桌面客户端，请启动或更新桌面应用');
      const result = await api.previewFile({ ...tab.request });
      if (!result.ok) throw new Error(result.error);
      // 关闭标签后到达的读取结果必须释放监听，不能重新打开已关闭的文件。
      if (!fileTabs.value.includes(tab)) {
        if (result.data.watchId) void api.unwatchFile?.(result.data.watchId);
        return;
      }
      if (tab.data?.watchId && tab.data.watchId !== result.data.watchId) void api.unwatchFile?.(tab.data.watchId);
      tab.data = result.data;
    } catch (error) {
      tab.error = error instanceof Error ? error.message : '文件读取失败，请重试';
    } finally {
      tab.loading = false;
      if (pendingRefreshes.delete(tab.request.watchKey) && fileTabs.value.includes(tab)) void refreshFile(tab);
    }
  };

  const openFilePreview = (sessionId: string | number | undefined, path: string) => {
    const baseUrl = getApiBaseUrl() || 'http://localhost:8088';
    const normalizedPath = path.replace(/\\/g, '/');
    const id = `${baseUrl}:${sessionId}:${normalizedPath.toLowerCase()}`;
    let tab = fileTabs.value.find(item => item.id === id);
    if (!tab) {
      if (fileTabs.value.length >= 12) closeFileTab(fileTabs.value[0]!.id);
      fileTabs.value.push({
        id, name: normalizedPath.split('/').pop() || path,
        request: { sessionId: String(sessionId ?? ''), path, baseUrl, watchKey: createLocalId('file-watch') },
        loading: false, error: '',
      });
      tab = fileTabs.value[fileTabs.value.length - 1]!;
    }
    activeFileId.value = id;
    filePreviewOpen.value = true;
    if (!unsubscribe && window.electronAPI?.onFileChanged) {
      unsubscribe = window.electronAPI.onFileChanged(({ watchId }) => {
        const changed = fileTabs.value.find(item => item.data?.watchId === watchId);
        if (changed) void refreshFile(changed);
      });
    }
    void refreshFile(tab);
  };

  const closeFileTab = (id: string) => {
    const index = fileTabs.value.findIndex(tab => tab.id === id);
    const tab = fileTabs.value[index];
    if (!tab) return;
    if (tab.data?.watchId) void window.electronAPI?.unwatchFile?.(tab.data.watchId);
    fileTabs.value.splice(index, 1);
    if (activeFileId.value === id) activeFileId.value = fileTabs.value[Math.min(index, fileTabs.value.length - 1)]?.id ?? '';
    if (!fileTabs.value.length) filePreviewOpen.value = false;
  };

  const runFileAction = async (action: 'open' | 'reveal') => {
    const tab = activeFile.value;
    if (!tab) return;
    try {
      const handler = action === 'open' ? window.electronAPI?.openFile : window.electronAPI?.revealFile;
      if (!handler) throw new Error('该操作需要使用桌面客户端');
      const result = await handler({ ...tab.request });
      if (!result.ok) throw new Error(result.error);
      tab.error = '';
    } catch (error) {
      tab.error = error instanceof Error ? error.message : '文件操作失败，请重试';
    }
  };

  onBeforeUnmount(() => {
    unsubscribe?.();
    for (const tab of fileTabs.value) {
      if (tab.data?.watchId) void window.electronAPI?.unwatchFile?.(tab.data.watchId);
    }
    fileTabs.value = [];
  });

  return { fileTabs, activeFileId, activeFile, filePreviewOpen, openFilePreview, closeFileTab, refreshFile, runFileAction };
}
