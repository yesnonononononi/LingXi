/**
 * 项目页面预览的唯一状态源（阶段一）。
 *
 * <p>职责边界：本 composable 只持有「地址 / 提交后的地址 / 加载状态 / 加载尝试序号 / 订阅句柄」，
 * 不直接操作 DOM —— iframe 由 {@code ProjectPagePreview.vue} 渲染，以 {@code generation} 作 key。</p>
 *
 * <p>加载状态口径（硬性）：只允许「正在尝试加载 / 加载等待超时 / 已收到页面加载事件 / 已确认失败」。
 * iframe 的 {@code load} 事件与 HTTP 200 都不等于业务可用；界面另有一行固定说明「浏览模式 · 编辑能力尚未接入」。</p>
 *
 * <p>失败诊断只认主进程 {@code did-fail-load}（子 frame、目标 origin 匹配）——没有诊断证据时不编造原因。</p>
 */
import {computed, getCurrentInstance, onBeforeUnmount, ref} from 'vue';
import type {ComputedRef} from 'vue';
import {t} from '../i18n';
import type {ElectronProjectPageAPI} from '../utils/platform';
import type {
  ProjectPageDiagnosticEvent,
  ProjectPageLoadState,
  ProjectPagePreviewApi,
  ProjectPageRejectReason,
  ProjectPageUrlResult,
} from '../types/projectPagePreview';

/** 加载等待超时毫秒数；超时只改变提示，**不销毁** iframe（迟到的成功仍可更新状态）。 */
export const PROJECT_PAGE_LOAD_TIMEOUT_MS = 15000;

/** 允许的本机回环主机名，与 `electron/file-preview.cjs` 的 `resolveLocalBase` 口径一致。 */
const ALLOWED_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

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
  host: 'projectPagePreview.rejectHost',
  port: 'projectPagePreview.rejectPort',
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
 * <p>只接受 http/https + 本机回环主机 + 明确端口，禁止账号密码；path / query / hash 全部保留。</p>
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
  if (!ALLOWED_HOSTNAMES.includes(parsed.hostname)) {
    return {ok: false, reason: 'host'};
  }
  if (!parsed.port) {
    return {ok: false, reason: 'port'};
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

  /** 释放主进程订阅：先退订再忘掉 origin，避免把旧 origin 丢掉。 */
  const releaseSubscription = (): void => {
    const bridge = getProjectPageBridge();
    const origin = committedOrigin.value;
    unsubscribe?.();
    unsubscribe = undefined;
    if (bridge && origin) {
      // 退订失败不影响界面状态；主进程在 webContents destroyed 时也会自行摘监听器。
      void Promise.resolve(bridge.unwatch()).catch(() => undefined);
    }
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
      if (loadState.value === 'failed') {
        return;
      }
      // 同一代内页面又发起了一次加载：语义上确实重新开始等了，状态回到 loading，
      // 并且**必须重新起超时计时器** —— 否则这次等待没有任何兜底，界面会永久停在「正在尝试加载…」。
      loadState.value = 'loading';
      armTimeout(generation.value);
    }
  };

  /**
   * 建立订阅（只订阅一次），并把当前的 origin + generation 交给主进程做 frame 匹配。
   *
   * <p>桌面端缺失（Web 开发模式）时静默跳过：页面仍能加载，只是没有主进程诊断。</p>
   */
  const ensureSubscription = (): void => {
    const bridge = getProjectPageBridge();
    if (!bridge) {
      return;
    }
    if (!unsubscribe) {
      try {
        unsubscribe = bridge.onEvent(applyDiagnosticEvent);
      } catch {
        unsubscribe = undefined;
      }
    }
    void Promise.resolve(
      bridge.watch({origin: committedOrigin.value, generation: generation.value}),
    ).catch(() => undefined);
  };

  /**
   * 发起一次新的加载尝试：换代 → 换 iframe 实例 → 起超时计时器 → 重新订阅。
   *
   * @param url 已校验通过的完整地址。
   * @param origin 该地址的 origin。
   */
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
    ensureSubscription();
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
    releaseSubscription();
    generation.value += 1;
    committedUrl.value = '';
    committedOrigin.value = '';
    loadState.value = 'idle';
    addressError.value = '';
    failureDetail.value = '';
    failureCode.value = 0;
    open.value = false;
  };

  const handleFrameLoad = (): void => {
    if (!committedUrl.value) {
      return;
    }
    // iframe 的 load 事件是弱证据：被拒绝嵌入 / 连接失败时它同样会触发，
    // 因此同一代内已确认失败时不覆盖失败结论。
    applyDiagnosticEvent({type: 'did-finish-load', generation: generation.value});
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
    handleFrameLoad,
    applyDiagnosticEvent,
  };

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      close();
    });
  }

  return api;
}
