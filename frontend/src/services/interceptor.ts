import axios from 'axios';
import type { AxiosError } from 'axios';
import { isOk } from '../utils/api';

/**
 * 可区分的 API 错误类型。
 *
 * 契约来源：docs/frontend-backend-contract.md §7。
 * - `forbidden`：HTTP 403 —— 越权 **或** 资源不存在（后端两者 code 同为 403，无法区分，不臆造细分）
 * - `notFound` ：HTTP 404 —— 端点不存在（已下线接口）
 * - `server`   ：HTTP 5xx —— 服务端故障
 * - `business` ：HTTP 200 + `Result.code` 非成功 —— 普通业务错误（后端无结构化业务码）
 * - `network`  ：无 HTTP 响应（连接失败 / 超时）
 * - `unknown`  ：其余未分类的 HTTP 状态
 *
 * 本地单实例（HC-1）无鉴权体系：**不存在 401**，故不为其编写分支。
 */
export type ApiErrorKind = 'forbidden' | 'notFound' | 'server' | 'business' | 'network' | 'unknown';

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
      return '无权限访问该资源';
    case 'notFound':
      return '接口不存在';
    case 'server':
      return '服务繁忙，请稍后重试';
    case 'network':
      return '网络连接失败，请稍后重试';
    case 'business':
      return '操作失败，请稍后重试';
    default:
      return '请求失败，请稍后重试';
  }
}

/** 把 axios 抛出的错误归一为带分类的 ApiError。 */
function toApiError(error: unknown): ApiError {
  const axiosError = error as AxiosError<{ errMsg?: string }> | undefined;
  const response = axiosError?.response;
  if (!response) {
    const message = error instanceof Error && error.message ? error.message : '网络连接失败，请稍后重试';
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

// 创建 axios 实例
// 本地单实例（HC-1）：无认证头、无 401 跳转；仅保留统一解包 response.data。
const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
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
