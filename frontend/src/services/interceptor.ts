import type {AxiosError} from 'axios';
import axios from 'axios';
import {isOk} from '../utils/api';
import {getApiBaseUrl} from '../utils/apiConfig';
import {t} from '../i18n';

/**
 * 可区分的 API 错误类型。
 *
 * 契约来源：docs/frontend-backend-contract.md §7。
 * - `forbidden`：HTTP 403 —— 越权 **或** 资源不存在（后端两者 code 同为 403，无法区分，不臆造细分）
 * - `notFound` ：HTTP 404 —— 端点不存在（已下线接口）
 * - `server`   ：HTTP 5xx —— 服务端故障
 * - `business` ：HTTP 200 + `Result.code` 非成功 —— 普通业务错误（后端无结构化业务码）
 * - `network`  ：无 HTTP 响应（连接失败 / 服务不可达）
 * - `timeout`  ：请求在预算内没有响应（axios `ECONNABORTED` / `ETIMEDOUT`）
 * - `unknown`  ：其余未分类的 HTTP 状态
 *
 * <p><b>为什么把 `timeout` 单列</b>：超时与服务不可达对用户是两件事。前者服务端**大概率还在干活**
 * （整树删除、整库清空这类成本随数据规模增长的写操作尤其如此），把它糊成「网络连接失败」
 * 会让用户以为什么都没发生，于是反复点。分类分开后文案才能说清事实。</p>
 *
 * 本地单实例（HC-1）无鉴权体系：**不存在 401**，故不为其编写分支。
 */
export type ApiErrorKind = 'forbidden' | 'notFound' | 'server' | 'business' | 'network' | 'timeout' | 'unknown';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: number;
  /** 后端原始 `errMsg`：**仅限日志排查**，不得渲染给用户（见 {@link describeKind}）。 */
  readonly rawMessage?: string;

  constructor(
    kind: ApiErrorKind,
    message: string,
    options: { status?: number; code?: number; rawMessage?: string } = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = options.status;
    this.code = options.code;
    this.rawMessage = options.rawMessage;
  }
}

/** 按真实 HTTP 状态码分类（不臆造后端未定义的细分）。 */
export function classifyHttpStatus(status?: number): ApiErrorKind {
  if (status === undefined) return 'network';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * 按 `Result.code` 分类业务错误：仅当 code 非成功时返回 `business` 错误，否则返回 null。
 * 后端业务异常走 HTTP 200 + `Result.error(msg)`，错误文案在 `errMsg`（默认 code、无结构化业务码）。
 */
export function classifyResult(
  res: { code?: number | string | null; errMsg?: string } | null | undefined
): ApiError | null {
  if (!res || isOk(res.code)) return null;
  return new ApiError('business', describeKind('business'), {
    code: typeof res.code === 'number' ? res.code : undefined,
    // 后端原始 errMsg 不对外呈现，仅保留用于排查。
    rawMessage: res.errMsg?.trim() || undefined,
  });
}

/**
 * 按错误分类产出**面向用户的**文案。
 *
 * 契约来源：docs/frontend-backend-contract.md §7。后端 `errMsg` 可能是英文、内部错误码
 * 甚至堆栈片段，**不得**原样渲染给用户。因此 HTTP 错误一律按分类文案呈现，
 * 后端原始文案另存于 {@link ApiError.rawMessage}（仅供日志排查）。
 */
export function describeKind(kind: ApiErrorKind): string {
  switch (kind) {
    case 'forbidden':
      return t('error.noPermission');
    case 'notFound':
      return t('error.apiNotExist');
    case 'server':
      return t('error.serverBusy');
    case 'network':
      return t('error.networkFailed');
    case 'timeout':
      return t('error.requestTimeout');
    case 'business':
      return t('error.defaultUserFacing');
    default:
      return t('error.requestFailed');
  }
}

/**
 * 取「可以给用户看的失败文案」。
 *
 * <p>契约 §7 说后端 `errMsg` 不得原样渲染 —— 它可能是英文、内部错误码甚至堆栈片段。
 * 但项目公约同时要求**业务异常消息必须是中文业务文案**（「会话仍在执行中，请先停止后再删除」
 * 这类）。两者不冲突的判据就是语言特征：含中文才认为是写给用户的业务提示，直接回显；
 * 其余一律走分类文案，内部细节只进控制台。</p>
 *
 * @param error 任意失败对象（通常是 {@link ApiError}）
 * @param fallback 没有可用文案时的兜底（调用方自己的场景文案）
 * @returns 面向用户的提示文案
 */
export function resolveUserFacingMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const raw = (error.rawMessage ?? '').trim();
    if (raw && CJK_PATTERN.test(raw)) return raw;
    return describeKind(error.kind);
  }
  return fallback;
}

/** 中文（含扩展区）判定：后端业务文案的语言特征，用于把内部异常文案挡在用户视野之外。 */
const CJK_PATTERN = /[\u4e00-\u9fff]/;

/** axios 在「预算内没有响应」时抛出的错误码（`timeout` 与 `transitional.clarifyTimeoutError` 两种形态）。 */
const TIMEOUT_ERROR_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT']);

/** 是否属于「请求超时」而非「连不上」。axios 两种成因都无 `response`，只能靠错误码区分。 */
function isTimeoutError(error: unknown): boolean {
  const axiosError = error as AxiosError | undefined;
  if (axiosError?.code) return TIMEOUT_ERROR_CODES.has(axiosError.code);
  return error instanceof Error && /timeout/i.test(error.message);
}

/** 把 axios 抛出的错误归一为带分类的 ApiError。 */
export function toApiError(error: unknown): ApiError {
  const axiosError = error as AxiosError<{ errMsg?: string }> | undefined;
  const response = axiosError?.response;
  if (!response) {
    if (isTimeoutError(error)) {
      return new ApiError('timeout', describeKind('timeout'));
    }
    const message = error instanceof Error && error.message ? error.message : t('error.networkFailed');
    return new ApiError('network', message);
  }
  const kind = classifyHttpStatus(response.status);
  const errMsg = response.data?.errMsg;
  return new ApiError(kind, describeKind(kind), {
    status: response.status,
    // 后端原始文案不对外呈现，仅保留用于排查。
    rawMessage: errMsg && errMsg.trim() ? errMsg.trim() : undefined,
  });
}

/**
 * 交互式请求的默认预算（毫秒）。
 *
 * <p><b>这不是「所有请求」的预算</b>，而是「点一下就该有反应」的请求的预算：列表、详情、
 * 单行写操作。这里之所以要写明，是因为历史上一刀切的 10s 曾把整树删除 / 整库清空
 * （成本随数据规模线性增长）打成「删除失败，请重试」，而服务端其实已经删完了。</p>
 *
 * <p>成本会随数据规模增长的写操作，<b>必须</b>在 service 层按操作显式声明自己的预算
 * （例如 `session.ts` 的整树删除与整库清空、`agent.ts` 的上下文压缩、`mcp.ts` 的连接探测），
 * 并在注释里说明量级依据。判断标准：耗时是否取决于库里现有多少数据，而不是取决于用户这一次
 * 点了什么。</p>
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

// 创建 axios 实例
// 本地单实例（HC-1）：无认证头、无 401 跳转；支持动态服务地址寻址（桌面端直连、Web走配置或代理）。
// 不设默认 Content-Type：由 axios 按请求体类型自行判定。
// 若在此写死 application/json，axios 会把 FormData 拍平成 JSON 字符串（见其 transformRequest），
// 导致 chat 端点的 multipart 请求变成 application/json，命中后端的 consumes 断言失败。
// 同理，也不得手动指定 multipart/form-data：boundary 由浏览器生成，写死会丢 boundary。
const http = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: DEFAULT_REQUEST_TIMEOUT_MS,
});

// 请求拦截器：保证每次请求动态匹配当前最新配置的 baseURL
http.interceptors.request.use((config) => {
  config.baseURL = getApiBaseUrl();
  return config;
});

// 响应拦截器：统一解包，调用方拿到的直接是 {code, data, errMsg}；
// 失败统一 reject 一个带 `kind` 的 ApiError，调用方据此区分 403/404/500/网络。
http.interceptors.response.use(
  (response) => {
    return response.data;
  },
  (error) => {
    return Promise.reject(toApiError(error));
  }
);

export default http;
