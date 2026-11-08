/** 主进程管理标签与加载，前端只保存每个标签尚未提交的地址草稿。 */
import {computed, getCurrentInstance, onBeforeUnmount, reactive, ref, watch} from 'vue';
import {t} from '../i18n';
import type {ElectronProjectPageAPI} from '../utils/platform';
import type {ProjectPageCommandRequest, ProjectPageLayout, ProjectPageLoadState, ProjectPagePreviewApi, ProjectPageRejectReason, ProjectPageState, ProjectPageTab, ProjectPageUrlResult} from '../types/projectPagePreview';

const REJECT_KEYS: Record<ProjectPageRejectReason, string> = {
  empty: 'projectPagePreview.rejectEmpty', malformed: 'projectPagePreview.rejectMalformed',
  protocol: 'projectPagePreview.rejectProtocol', credentials: 'projectPagePreview.rejectCredentials',
};
const STATE_KEYS: Record<ProjectPageLoadState, string> = {
  idle: 'projectPagePreview.statusIdle', loading: 'projectPagePreview.statusLoading', loaded: 'projectPagePreview.statusLoaded',
  timeout: 'projectPagePreview.statusTimeout', failed: 'projectPagePreview.statusFailed', stopped: 'projectPagePreview.statusStopped',
};
const FAILURE_HINT_KEYS: Record<number, string> = {
  [-27]: 'projectPagePreview.failureBlockedByResponse', [-102]: 'projectPagePreview.failureConnectionRefused',
  [-118]: 'projectPagePreview.failureConnectionTimeout', [-101]: 'projectPagePreview.failureConnectionReset',
  [-105]: 'projectPagePreview.failureNameNotResolved', [-202]: 'projectPagePreview.failureCertificate', [-200]: 'projectPagePreview.failureCertificate',
};

export function validateProjectPageUrl(input: string): ProjectPageUrlResult {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) {
    return {ok: false, reason: 'empty'};
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {ok: false, reason: 'malformed'};
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {ok: false, reason: 'protocol'};
  }
  if (parsed.username || parsed.password) {
    return {ok: false, reason: 'credentials'};
  }
  return {ok: true, url: parsed.toString(), origin: parsed.origin};
}

function getBridge(): ElectronProjectPageAPI | undefined {
  return typeof window === 'undefined' ? undefined : window.electronAPI?.projectPage;
}

export function useProjectPagePreview(): ProjectPagePreviewApi {
  const open = ref(false);
  const tabs = ref<ProjectPageTab[]>([]);
  const activeTabId = ref('');
  const generation = ref(0);
  const addressError = ref('');
  const drafts = reactive<Record<string, string>>({});
  const initialDraft = ref('');
  const activeTab = computed(() => tabs.value.find(tab => tab.id === activeTabId.value));
  const committedUrl = computed(() => activeTab.value?.url ?? '');
  const addressInput = computed(() => activeTabId.value ? drafts[activeTabId.value] ?? committedUrl.value : initialDraft.value);
  const loadState = computed(() => activeTab.value?.loadState ?? 'idle');
  let revision = 0;
  let unsubscribe: (() => void) | undefined;
  let layout: ProjectPageLayout = {visible: false, bounds: {x: 0, y: 0, width: 0, height: 0}};

  const applyState = (state: ProjectPageState): void => {
    if (!open.value || state.generation !== generation.value || state.revision <= revision) return;
    for (const tab of state.tabs) {
      const previous = tabs.value.find(item => item.id === tab.id);
      // 导航只更新未编辑的输入，后台标签也各自保留草稿。
      if (drafts[tab.id] === undefined || drafts[tab.id] === previous?.url) {
        drafts[tab.id] = !activeTabId.value && tab.id === state.activeTabId && !tab.url ? initialDraft.value : tab.url;
      }
    }
    for (const id of Object.keys(drafts)) if (!state.tabs.some(tab => tab.id === id)) delete drafts[id];
    revision = state.revision;
    tabs.value = state.tabs;
    activeTabId.value = state.activeTabId;
  };
  const reportError = (attempt: number, error: unknown): void => {
    if (open.value && generation.value === attempt) addressError.value = error instanceof Error ? error.message : String(error);
  };
  const updateLayout = (value: ProjectPageLayout): void => {
    layout = value;
    const bridge = getBridge();
    if (!bridge || !open.value) return;
    const attempt = generation.value;
    void bridge.layout({...layout, generation: attempt}).then(result => {
      if (!result.ok) reportError(attempt, result.error);
    }).catch(error => reportError(attempt, error));
  };
  const execute = (request: Omit<ProjectPageCommandRequest, 'generation'>): void => {
    const bridge = getBridge();
    if (!bridge || !open.value) return;
    const attempt = generation.value;
    addressError.value = '';
    try {
      unsubscribe ??= bridge.onEvent(applyState);
      void bridge.command({...request, generation: attempt}).then(result => {
        if (!result.ok) reportError(attempt, result.error);
        else {
          applyState(result.data);
          if (open.value && generation.value === attempt) updateLayout(layout);
        }
      }).catch(error => reportError(attempt, error));
    } catch (error) { reportError(attempt, error); }
  };
  watch(open, value => {
    if (!value) return;
    generation.value += 1;
    revision = 0;
    execute({action: 'sync'});
  }, {flush: 'sync'});

  const openAddress = (address?: string): void => {
    open.value = true;
    if (address === undefined) return;
    const result = validateProjectPageUrl(address);
    if (!result.ok) { addressError.value = t(REJECT_KEYS[result.reason]); return; }
    updateAddress(result.url);
    execute({action: 'navigate', tabId: activeTabId.value || undefined, url: result.url});
  };
  const updateAddress = (value: string): void => {
    if (activeTabId.value) drafts[activeTabId.value] = value;
    else initialDraft.value = value;
    addressError.value = '';
  };
  const createTab = (): void => {
    if (!open.value) { open.value = true; return; }
    execute({action: 'create'});
  };
  const activateTab = (id: string): void => execute({action: 'activate', tabId: id});
  const closeTab = (id: string): void => execute({action: 'close-tab', tabId: id});
  const control = (action: 'back' | 'forward' | 'reload' | 'stop'): void => {
    if (activeTabId.value) execute({action, tabId: activeTabId.value});
  };
  const close = (): void => {
    unsubscribe?.(); unsubscribe = undefined;
    generation.value += 1;
    const bridge = getBridge();
    if (bridge) void bridge.command({action: 'close', generation: generation.value}).catch(() => undefined);
    open.value = false;
    tabs.value = [];
    activeTabId.value = '';
    for (const id of Object.keys(drafts)) delete drafts[id];
    initialDraft.value = '';
    addressError.value = '';
    revision = 0;
  };
  const statusText = computed(() => t(STATE_KEYS[loadState.value]));
  const diagnoseText = computed(() => {
    if (loadState.value === 'timeout') return t('projectPagePreview.hintTimeout');
    if (loadState.value !== 'failed') return '';
    const tab = activeTab.value;
    const hint = t(FAILURE_HINT_KEYS[tab?.errorCode ?? 0] ?? 'projectPagePreview.failureGeneric');
    return tab?.errorDescription ? `${hint}（${tab.errorDescription}）` : hint;
  });
  if (getCurrentInstance()) onBeforeUnmount(close);
  return {open, tabs, activeTabId, activeTab, addressInput, committedUrl, loadState, generation, addressError, statusText, diagnoseText,
    openAddress, updateAddress, createTab, activateTab, closeTab, goBack: () => control('back'), goForward: () => control('forward'),
    reload: () => control('reload'), stop: () => control('stop'), close, updateLayout, applyState};
}
