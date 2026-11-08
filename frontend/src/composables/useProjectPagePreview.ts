/** 页面状态以主进程事件为准，换代后旧视图的事件不得覆盖当前页面。 */
import {computed, getCurrentInstance, onBeforeUnmount, ref} from 'vue';
import type {ComputedRef} from 'vue';
import {t} from '../i18n';
import type {ElectronProjectPageAPI} from '../utils/platform';
import type {
  ProjectPageDiagnosticEvent,
  ProjectPageLoadState,
  ProjectPageLayout,
  ProjectPagePreviewApi,
  ProjectPageRejectReason,
  ProjectPageUrlResult,
} from '../types/projectPagePreview';

/** 加载等待超时毫秒数；超时只改变提示，**不销毁**网页视图（迟到的成功仍可更新状态）。 */
export const PROJECT_PAGE_LOAD_TIMEOUT_MS = 15000;

/** Chromium 错误码 → 便于理解的检查建议；未收录的码只回显主进程给的描述。 */
const FAILURE_HINT_KEYS: Record<number, string> = {
  // ERR_BLOCKED_BY_RESPONSE：跨源嵌入被响应头拒绝（X-Frame-Options / CSP frame-ancestors）
  [-27]: 'projectPagePreview.failureBlockedByResponse',
  // ERR_CONNECTION_REFUSED
  [-102]: 'projectPagePreview.failureConnectionRefused',
  // ERR_CONNECTION_TIMED_OUT
  [-118]: 'projectPagePreview.failureConnectionTimeout',
  // ERR_CONNECTION_RESET
  [-101]: 'projectPagePreview.failureConnectionReset',
  // ERR_NAME_NOT_RESOLVED
  [-105]: 'projectPagePreview.failureNameNotResolved',
  // ERR_CERT_AUTHORITY_INVALID / ERR_CERT_COMMON_NAME_INVALID
  [-202]: 'projectPagePreview.failureCertificate',
  [-200]: 'projectPagePreview.failureCertificate',
};

/** 地址校验失败原因 → i18n key。 */
const REJECT_KEYS: Record<ProjectPageRejectReason, string> = {
  empty: 'projectPagePreview.rejectEmpty',
  malformed: 'projectPagePreview.rejectMalformed',
  protocol: 'projectPagePreview.rejectProtocol',
  credentials: 'projectPagePreview.rejectCredentials',
};

/** 状态 → i18n key。 */
const STATE_KEYS: Record<ProjectPageLoadState, string> = {
  idle: 'projectPagePreview.statusIdle',
  loading: 'projectPagePreview.statusLoading',
  loaded: 'projectPagePreview.statusLoaded',
  timeout: 'projectPagePreview.statusTimeout',
  failed: 'projectPagePreview.statusFailed',
};

/**
 * 校验用户输入的页面地址。
 *
 * 允许本机与远程 HTTP/HTTPS 页面，禁止内嵌账号密码；路径、查询与锚点全部保留。
 *
 * @param input 用户原始输入。
 * @returns 规范化后的 URL 与 origin，或失败原因码。
 */
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

/** 取主进程暴露的页面预览通道；Web 端（无 preload）返回 undefined。 */
function getProjectPageBridge(): ElectronProjectPageAPI | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return window.electronAPI?.projectPage;
}

/** composable 选项。 */
export interface UseProjectPagePreviewOptions {
  /** 加载等待超时毫秒数；测试可注入更短的值。 */
  timeoutMs?: number;
}

/**
 * 创建页面预览状态机。
 *
 * @param options 可选配置（超时时长）。
 * @returns 页面预览 API，供 ChatView provide 给预览面板。
 */
export function useProjectPagePreview(
  options: UseProjectPagePreviewOptions = {},
): ProjectPagePreviewApi {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : PROJECT_PAGE_LOAD_TIMEOUT_MS;

  const open = ref<boolean>(false);
  const addressInput = ref<string>('');
  const committedUrl = ref<string>('');
  const committedOrigin = ref<string>('');
  const loadState = ref<ProjectPageLoadState>('idle');
  const generation = ref<number>(0);
  const addressError = ref<string>('');
  const failureDetail = ref<string>('');
  const failureCode = ref<number>(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let currentLayout: ProjectPageLayout = {visible: false, bounds: {x: 0, y: 0, width: 0, height: 0}};

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /**
   * 为指定代起一次「加载等待超时」计时器。
   *
   * <p>每次真正开始等待（新尝试、或同一代内页面又发起一次加载）都要重新起表：
   * 只在 loaded 时 clearTimer 而不重开，页内二次加载挂住就会永久停在「正在尝试加载…」。</p>
   *
   * @param attempt 计时器归属的 generation；非当前代的结果被丢弃。
   */
  const armTimeout = (attempt: number): void => {
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      // 迟到计时器：只有当前代仍在等待时才降级为超时提示。
      if (generation.value !== attempt) {
        return;
      }
      if (loadState.value === 'loading') {
        loadState.value = 'timeout';
      }
    }, timeoutMs);
  };

  /**
   * 主进程诊断事件的唯一归并入口。
   *
   * <p>⚠️ generation 必须参与判断：旧地址 / 旧尝试的迟到结果不得覆盖新地址的状态
   * （计划书阶段一验收第 6 条）。</p>
   */
  const applyDiagnosticEvent = (event: ProjectPageDiagnosticEvent): void => {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      return;
    }
    if (event.generation !== generation.value) {
      return;
    }
    if (event.type === 'did-navigate' && event.url) {
      const result = validateProjectPageUrl(event.url);
      if (result.ok) {
        // 用户正在编辑的新地址不能被后台导航覆盖。
        if (addressInput.value === committedUrl.value) addressInput.value = result.url;
        committedUrl.value = result.url;
        committedOrigin.value = result.origin;
      }
      return;
    }
    if (event.type === 'did-fail-load') {
      clearTimer();
      const code = typeof event.errorCode === 'number' ? event.errorCode : 0;
      failureDetail.value = typeof event.errorDescription === 'string' ? event.errorDescription : '';
      loadState.value = 'failed';
      addressError.value = '';
      // 失败原因码留给 diagnoseText 使用；这里只记录一次，不做二次猜测。
      failureCode.value = code;
      return;
    }
    if (event.type === 'did-finish-load') {
      // 已确认失败时后续成功事件不覆盖失败结论（同一代内失败是粘性的）。
      if (loadState.value === 'failed') {
        return;
      }
      clearTimer();
      loadState.value = 'loaded';
      return;
    }
    if (event.type === 'did-start-loading') {
      failureDetail.value = '';
      failureCode.value = 0;
      // 同一代内页面又发起了一次加载：语义上确实重新开始等了，状态回到 loading，
      // 并且**必须重新起超时计时器** —— 否则这次等待没有任何兜底，界面会永久停在「正在尝试加载…」。
      loadState.value = 'loading';
      armTimeout(generation.value);
    }
  };

  const reportBridgeFailure = (attempt: number, error: unknown): void => {
    applyDiagnosticEvent({type: 'did-fail-load', generation: attempt,
      errorDescription: error instanceof Error ? error.message : String(error)});
  };

  const updateLayout = (layout: ProjectPageLayout): void => {
    currentLayout = layout;
    const bridge = getProjectPageBridge();
    if (!bridge || !committedUrl.value) return;
    const attempt = generation.value;
    void bridge.layout({...layout, generation: attempt}).then(result => {
      if (!result.ok) reportBridgeFailure(attempt, result.error);
    }).catch(error => reportBridgeFailure(attempt, error));
  };

  /** 监听先于加载，避免快速页面的完成事件丢失。 */
  const navigate = (url: string, attempt: number): void => {
    const bridge = getProjectPageBridge();
    if (!bridge) return;
    try {
      unsubscribe ??= bridge.onEvent(applyDiagnosticEvent);
      void bridge.navigate({url, generation: attempt}).then(result => {
        if (!result.ok) reportBridgeFailure(attempt, result.error);
        else if (generation.value === attempt) updateLayout(currentLayout);
      }).catch(error => reportBridgeFailure(attempt, error));
    } catch (error) {
      reportBridgeFailure(attempt, error);
    }
  };

  const startAttempt = (url: string, origin: string): void => {
    clearTimer();
    generation.value += 1;
    const attempt = generation.value;
    committedUrl.value = url;
    committedOrigin.value = origin;
    loadState.value = 'loading';
    addressError.value = '';
    failureDetail.value = '';
    failureCode.value = 0;
    open.value = true;
    armTimeout(attempt);
    navigate(url, attempt);
  };

  const updateAddress = (value: string): void => {
    addressInput.value = typeof value === 'string' ? value : '';
    addressError.value = '';
  };

  const openAddress = (address?: string): void => {
    open.value = true;
    if (typeof address !== 'string') {
      return;
    }
    const result = validateProjectPageUrl(address);
    if (!result.ok) {
      addressError.value = t(REJECT_KEYS[result.reason]);
      return;
    }
    addressInput.value = result.url;
    startAttempt(result.url, result.origin);
  };

  const reload = (): void => {
    if (!committedUrl.value) {
      return;
    }
    startAttempt(committedUrl.value, committedOrigin.value);
  };

  const close = (): void => {
    clearTimer();
    unsubscribe?.();
    unsubscribe = undefined;
    generation.value += 1;
    const bridge = getProjectPageBridge();
    if (bridge) void bridge.close({generation: generation.value}).catch(() => undefined);
    committedUrl.value = '';
    committedOrigin.value = '';
    loadState.value = 'idle';
    addressError.value = '';
    failureDetail.value = '';
    failureCode.value = 0;
    open.value = false;
  };

  const statusText: ComputedRef<string> = computed(() => t(STATE_KEYS[loadState.value]));

  const diagnoseText: ComputedRef<string> = computed(() => {
    if (loadState.value === 'timeout') {
      return t('projectPagePreview.hintTimeout');
    }
    if (loadState.value !== 'failed') {
      return '';
    }
    const hintKey = FAILURE_HINT_KEYS[failureCode.value] ?? 'projectPagePreview.failureGeneric';
    const hint = t(hintKey);
    return failureDetail.value ? `${hint}（${failureDetail.value}）` : hint;
  });

  const api: ProjectPagePreviewApi = {
    open,
    addressInput,
    committedUrl,
    committedOrigin,
    loadState,
    generation,
    addressError,
    failureDetail,
    statusText,
    diagnoseText,
    openAddress,
    updateAddress,
    reload,
    close,
    updateLayout,
    applyDiagnosticEvent,
  };

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      close();
    });
  }

  return api;
}
