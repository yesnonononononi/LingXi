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
  /**
   * 主进程是否仍持有当前代次的会话。
   *
   * <p>收起（{@link hide}）不改变它，只有 {@link close} 才置 false。
   * 这条标志是「收起不换代」的唯一判据：旧实现每次 open 都让 generation 前进，
   * 主进程见代次前进就销毁全部标签，于是点 ✕ 收起再打开必丢正在浏览的网页。</p>
   */
  let sessionAlive = false;
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
    // 可见性请求只对打开着的会话有效；**隐藏**指令必须透传，否则收起后原生视图会留在屏幕上盖住界面。
    const applicable = open.value || !value.visible;
    // 隐藏通知常带 0 尺寸（卸载 / 收起 / 弹窗遮挡），不能让它覆盖最后一次真实位置：
    // 重开时若只能靠下一帧 ResizeObserver 重新量尺寸，窗口被隐藏或 rAF 被节流时就恢复不出来。
    const keepSentBounds = value.visible || (value.bounds.width > 0 && value.bounds.height > 0);
    if (applicable) layout = keepSentBounds ? value : {...layout, visible: value.visible};
    const bridge = getBridge();
    if (!bridge || !applicable) return;
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
    // 只有真正销毁过（close）才开新的一代；收起再打开沿用同一代，主进程据此保留全部标签。
    if (!sessionAlive) {
      generation.value += 1;
      sessionAlive = true;
    }
    revision = 0;
    // 重开时先按上次量到的位置亮出来，随后的 ResizeObserver 观测再校正。
    layout = {...layout, visible: true};
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
  const showWithAgent = (tabId?: string, selectionText?: string): void => {
    const targetId = tabId || activeTabId.value;
    if (targetId) execute({action: 'show-with-agent', tabId: targetId, selectionText});
  };
  /**
   * 收起面板：只让原生视图让位，标签、登录态与表单留在主进程，重开按 sync 快照原样恢复。
   *
   * <p>与 {@link close} 的区别是「不改代次、不发 close 指令、不清前端快照」。
   * 用户点面板 ✕、选中子 Agent 会话等「收起」场景必须走这里。</p>
   */
  const hide = (): void => {
    if (!open.value) return;
    open.value = false;
    const bridge = getBridge();
    if (!bridge || !generation.value) return;
    // 隐藏指令必须发出去：原生视图浮在 DOM 之上，不发就会盖住界面。
    void bridge.layout({visible: false, bounds: layout.bounds, generation: generation.value}).catch(() => undefined);
  };
  const close = (): void => {
    unsubscribe?.(); unsubscribe = undefined;
    sessionAlive = false;
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
    reload: () => control('reload'), stop: () => control('stop'), showWithAgent, hide, close, updateLayout, applyState};
}
