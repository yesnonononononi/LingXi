import {computed, ref, watch, type Ref} from 'vue';
import type {ChatSession} from '../types/chat';
import type {FilePreviewOpenRequest, FilePreviewTab} from '../types/filePreview';
import type {ProjectPagePreviewApi} from '../types/projectPagePreview';
import type {
  DesignPreviewTab,
  NewPreviewTab,
  PlanPreviewTab,
  UnifiedPreviewTab,
} from '../types/previewPanel';
import {resolveLivePlanTab} from '../utils/toolCallCard';

export interface UseUnifiedPreviewTabsOptions {
  fileTabs: Ref<FilePreviewTab[]>;
  activeFileId: Ref<string>;
  filePreviewOpen: Ref<boolean>;
  openFilePreview: (request: FilePreviewOpenRequest) => void;
  closeFileTab: (id: string) => void;
  pagePreview: ProjectPagePreviewApi;
  sessions?: () => readonly ChatSession[];
  t: (key: string, params?: Record<string, string | number>) => string;
}

export function useUnifiedPreviewTabs(options: UseUnifiedPreviewTabsOptions) {
  const {
    fileTabs,
    activeFileId,
    filePreviewOpen,
    openFilePreview,
    closeFileTab,
    pagePreview,
    sessions,
    t,
  } = options;

  const tabOrder = ref<string[]>([]);
  const activeTabKey = ref<string>('');
  const designTabs = ref<DesignPreviewTab[]>([]);
  const planTabs = ref<PlanPreviewTab[]>([]);
  const newTabs = ref<NewPreviewTab[]>([]);

  const livePlanTabs = computed<PlanPreviewTab[]>(() =>
    sessions ? planTabs.value.map(tab => resolveLivePlanTab(tab, sessions())) : planTabs.value
  );

  const previewPanelOpen = ref(false);
  const panelMounted = ref(false);

  let designSeq = 0;
  let newTabSeq = 0;
  let pendingReplaceNewKey = '';
  let pendingPageUrl = '';

  const ensureInOrder = (key: string, replaceKey?: string): void => {
    if (replaceKey) {
      const idx = tabOrder.value.indexOf(replaceKey);
      if (idx !== -1) {
        if (!tabOrder.value.includes(key)) {
          tabOrder.value.splice(idx, 1, key);
        } else {
          tabOrder.value.splice(idx, 1);
        }
        return;
      }
    }
    if (!tabOrder.value.includes(key)) {
      tabOrder.value.push(key);
    }
  };

  const removeFromOrder = (key: string): string => {
    const idx = tabOrder.value.indexOf(key);
    if (idx === -1) return activeTabKey.value;
    tabOrder.value.splice(idx, 1);
    if (activeTabKey.value !== key) return activeTabKey.value;
    const next = tabOrder.value[idx] ?? tabOrder.value[idx - 1] ?? '';
    return next;
  };

  // 同步文件标签增删
  watch(
    () => fileTabs.value.map(tab => tab.id),
    (ids) => {
      const idSet = new Set(ids);
      for (const id of ids) {
        ensureInOrder(`file:${id}`);
      }
      tabOrder.value = tabOrder.value.filter(key => !key.startsWith('file:') || idSet.has(key.slice(5)));
    },
    {immediate: true}
  );

  // 同步浏览页面标签增删（来自 Electron 主进程状态）
  watch(
    () => pagePreview.tabs.value.map(tab => tab.id),
    (ids, prevIds) => {
      const isInitialSync = prevIds === undefined;
      const idSet = new Set(ids);
      const prevSet = new Set(prevIds ?? []);
      const added = ids.filter(id => !prevSet.has(id));

      for (const id of added) {
        const key = `page:${id}`;
        const replaceKey = pendingReplaceNewKey;
        pendingReplaceNewKey = '';
        if (replaceKey) {
          const newId = replaceKey.slice(4);
          newTabs.value = newTabs.value.filter(tab => tab.id !== newId);
        }
        ensureInOrder(key, replaceKey);
        activeTabKey.value = key;
        if (pendingPageUrl) {
          const urlToOpen = pendingPageUrl;
          pendingPageUrl = '';
          pagePreview.activateTab(id);
          pagePreview.openAddress(urlToOpen);
        }
      }

      for (const id of ids) {
        ensureInOrder(`page:${id}`);
      }
      tabOrder.value = tabOrder.value.filter(key => !key.startsWith('page:') || idSet.has(key.slice(5)));

      if (isInitialSync && ids.length > 0) {
        const activeId = pagePreview.activeTabId.value;
        if (activeId && idSet.has(activeId)) {
          activeTabKey.value = `page:${activeId}`;
        }
        if (pagePreview.open.value) {
          showPreviewPanel();
        }
      }
    },
    {immediate: true}
  );

  watch(
    () => pagePreview.activeTabId.value,
    (id) => {
      if (!id) return;
      const key = `page:${id}`;
      if (activeTabKey.value.startsWith('page:') || pendingReplaceNewKey) {
        ensureInOrder(key);
        activeTabKey.value = key;
      }
    }
  );

  const resolvePageTitle = (url: string, title: string): string => {
    if (title?.trim()) return title.trim();
    if (url) {
      try {
        return new URL(url).host || url;
      } catch {
        return url;
      }
    }
    return t('projectPagePreview.newTabTitle');
  };

  const unifiedTabs = computed<UnifiedPreviewTab[]>(() => {
    const fileMap = new Map(fileTabs.value.map(tab => [`file:${tab.id}`, tab]));
    const pageMap = new Map(pagePreview.tabs.value.map(tab => [`page:${tab.id}`, tab]));
    const designMap = new Map(designTabs.value.map(tab => [`design:${tab.id}`, tab]));
    const planMap = new Map(livePlanTabs.value.map(tab => [`plan:${tab.id}`, tab]));
    const newMap = new Map(newTabs.value.map(tab => [`new:${tab.id}`, tab]));

    const result: UnifiedPreviewTab[] = [];
    for (const key of tabOrder.value) {
      if (key.startsWith('file:')) {
        const tab = fileMap.get(key);
        if (tab) result.push({ key, kind: 'file', targetId: tab.id, title: tab.name });
      } else if (key.startsWith('page:')) {
        const tab = pageMap.get(key);
        if (tab) {
          result.push({
            key,
            kind: 'page',
            targetId: tab.id,
            title: resolvePageTitle(tab.url, tab.title),
            url: tab.url,
            favicon: tab.favicon,
            isLoading: tab.isLoading,
          });
        }
      } else if (key.startsWith('design:')) {
        const tab = designMap.get(key);
        if (tab) result.push({ key, kind: 'design', targetId: tab.id, title: tab.title });
      } else if (key.startsWith('plan:')) {
        const tab = planMap.get(key);
        if (tab) result.push({ key, kind: 'plan', targetId: tab.id, title: tab.title });
      } else if (key.startsWith('new:')) {
        const tab = newMap.get(key);
        if (tab) result.push({ key, kind: 'new', targetId: tab.id, title: tab.title });
      }
    }
    return result;
  });

  const showPreviewPanel = (): void => {
    panelMounted.value = true;
    previewPanelOpen.value = true;
  };

  const createNewTab = (): void => {
    const id = `new-${++newTabSeq}`;
    newTabs.value.push({ id, title: t('filePreview.newTab') });
    const key = `new:${id}`;
    ensureInOrder(key);
    activeTabKey.value = key;
    showPreviewPanel();
  };

  const activateTab = (key: string): void => {
    if (!key) return;
    activeTabKey.value = key;
    if (key.startsWith('file:')) {
      activeFileId.value = key.slice(5);
      filePreviewOpen.value = true;
    } else if (key.startsWith('page:')) {
      pagePreview.open.value = true;
      pagePreview.activateTab(key.slice(5));
    }
    showPreviewPanel();
  };

  const openFilePreviewInPanel = (request: FilePreviewOpenRequest): void => {
    openFilePreview(request);
    if (activeFileId.value) {
      const key = `file:${activeFileId.value}`;
      ensureInOrder(key);
      activeTabKey.value = key;
    }
    showPreviewPanel();
  };

  const openDesignPreview = (opts?: { replaceKey?: string; initialContent?: string; initialFileName?: string }): void => {
    const idx = ++designSeq;
    const id = `design-${idx}`;
    const baseTitle = t('filePreview.modeDesign');
    const title = opts?.initialFileName || (idx > 1 ? `${baseTitle} ${idx}` : baseTitle);
    designTabs.value.push({
      id,
      title,
      initialContent: opts?.initialContent,
      initialFileName: opts?.initialFileName,
    });
    const key = `design:${id}`;
    if (opts?.replaceKey?.startsWith('new:')) {
      const oldId = opts.replaceKey.slice(4);
      newTabs.value = newTabs.value.filter(tab => tab.id !== oldId);
    }
    ensureInOrder(key, opts?.replaceKey);
    activeTabKey.value = key;
    showPreviewPanel();
  };

  const openPlanPreview = (planTab: PlanPreviewTab): void => {
    const existing = planTabs.value.find(item => item.id === planTab.id);
    if (existing) {
      existing.title = planTab.title;
      existing.promptCard = planTab.promptCard;
      existing.sessionId = planTab.sessionId;
    } else {
      planTabs.value.push({ ...planTab });
    }
    const key = `plan:${planTab.id}`;
    ensureInOrder(key);
    activeTabKey.value = key;
    showPreviewPanel();
  };

  const openPageFromNewTab = (replaceNewTabId: string, url?: string): void => {
    pendingReplaceNewKey = replaceNewTabId ? `new:${replaceNewTabId}` : '';
    pendingPageUrl = url ?? '';
    if (!pagePreview.open.value || pagePreview.tabs.value.length === 0) {
      pagePreview.open.value = true;
      if (url && pagePreview.tabs.value.length > 0) {
        pendingPageUrl = '';
        pagePreview.openAddress(url);
      }
    } else {
      pagePreview.createTab();
    }
    showPreviewPanel();
  };

  const handleNewTabAction = (payload: { type: 'url' | 'page' | 'design'; tabId: string; url?: string }): void => {
    if (payload.type === 'design') {
      openDesignPreview({ replaceKey: payload.tabId ? `new:${payload.tabId}` : undefined });
      return;
    }
    openPageFromNewTab(payload.tabId, payload.type === 'url' ? payload.url : undefined);
  };

  const closeUnifiedTab = (tab: UnifiedPreviewTab): void => {
    const nextKey = removeFromOrder(tab.key);
    if (tab.kind === 'file') {
      closeFileTab(tab.targetId);
    } else if (tab.kind === 'page') {
      pagePreview.closeTab(tab.targetId);
    } else if (tab.kind === 'design') {
      designTabs.value = designTabs.value.filter(item => item.id !== tab.targetId);
    } else if (tab.kind === 'plan') {
      planTabs.value = planTabs.value.filter(item => item.id !== tab.targetId);
    } else if (tab.kind === 'new') {
      newTabs.value = newTabs.value.filter(item => item.id !== tab.targetId);
    }

    if (nextKey) {
      activateTab(nextKey);
    } else if (tabOrder.value.length === 0) {
      createNewTab();
    }
  };

  const closePreviewPanel = (): void => {
    previewPanelOpen.value = false;
    filePreviewOpen.value = false;
    pagePreview.hide();
  };

  const togglePreviewPanel = (): void => {
    if (previewPanelOpen.value) {
      closePreviewPanel();
      return;
    }
    if (tabOrder.value.length === 0) {
      createNewTab();
      return;
    }
    if (!activeTabKey.value || !tabOrder.value.includes(activeTabKey.value)) {
      activeTabKey.value = tabOrder.value[0]!;
    }
    if (activeTabKey.value.startsWith('page:')) {
      pagePreview.open.value = true;
    }
    showPreviewPanel();
  };

  const resetSessionPages = (): void => {
    pagePreview.close();
    tabOrder.value = tabOrder.value.filter(key => !key.startsWith('page:'));
    if (activeTabKey.value.startsWith('page:')) {
      activeTabKey.value = tabOrder.value[0] ?? '';
    }
    if (tabOrder.value.length === 0) {
      previewPanelOpen.value = false;
    }
  };

  return {
    previewPanelOpen,
    panelMounted,
    unifiedTabs,
    activeTabKey,
    designTabs,
    planTabs: livePlanTabs,
    showPreviewPanel,
    togglePreviewPanel,
    closePreviewPanel,
    createNewTab,
    activateTab,
    closeUnifiedTab,
    openFilePreviewInPanel,
    openDesignPreview,
    openPlanPreview,
    handleNewTabAction,
    resetSessionPages,
  };
}
