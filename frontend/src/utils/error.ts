/**
 * 统一错误信息解析工具
 *
 * 契约来源：
 *   - REST：com.summit.ddd.application.vo.Result 的错误文案恒在 `errMsg`。
 *   - SSE ：com.summit.core.conversation.event.ExecutionErrorEvent 的文案在 `errMsg`（补充在 `extraDes`）。
 *   - 前端本地：JS 原生 Error 使用 `message`（axios/fetch 抛出的对象亦然）。
 * 因此只认这两个字段，其余历史别名（error/err/msg）后端从不产生，已移除。
 */

const ERROR_FIELD_KEYS = ['errMsg', 'message'] as const;
const MAX_UNWRAP_DEPTH = 5;
const FALLBACK_MESSAGE = '执行异常';

/** 按别名清单取出第一个非空错误字段 */
function pickErrorField(source: Record<string, any>): unknown {
  for (const key of ERROR_FIELD_KEYS) {
    const value = source[key];
    if (value === null || value === undefined || value === '') continue;
    return value;
  }
  return undefined;
}

export function extractErrorMessage(rawError: any): string {
  if (rawError === null || rawError === undefined) {
    return FALLBACK_MESSAGE;
  }

  // 对象形态：继续向下找第一个错误字段
  if (typeof rawError === 'object') {
    const nested = pickErrorField(rawError as Record<string, any>);
    if (nested !== undefined) {
      return extractErrorMessage(nested);
    }
    try {
      return JSON.stringify(rawError);
    } catch {
      return String(rawError);
    }
  }

  let text = String(rawError).trim();
  if (!text) return FALLBACK_MESSAGE;

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const trimmed = text.trim();
    const isJsonLike =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (!isJsonLike) break;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      break;
    }

    if (typeof parsed === 'string') {
      text = parsed;
      continue;
    }

    if (parsed && typeof parsed === 'object') {
      const nested = pickErrorField(parsed);
      if (nested !== undefined) {
        text = String(nested);
        continue;
      }
    }
    break;
  }

  return text.trim() || FALLBACK_MESSAGE;
}

const DEFAULT_USER_FACING_ERROR = '操作失败，请稍后重试';

/**
 * 把后端原始错误文案（`Result.errMsg` 等）转换为产品化文案。
 *
 * 契约来源：docs/frontend-backend-contract.md §7 —— 禁止把后端 `errMsg` 原样渲染给用户
 * （可能是英文、内部错误码或堆栈片段），统一产品化文案；原始文案仅写入诊断日志，不进入 UI。
 *
 * 说明：本函数**不**解析原始文案内容，只做「吞掉原文 + 返回兜底」。错误分类应由调用方依据
 * 真实 HTTP 状态码 / `Result.code` 决定（§7），并在 `fallback` 中给出对应文案。
 */
export function toUserFacingError(rawError: unknown, fallback: string = DEFAULT_USER_FACING_ERROR): string {
  if (rawError !== null && rawError !== undefined && String(rawError).trim() !== '') {
    console.warn('[后端错误] 原始错误文案不直接展示给用户，仅记录用于诊断:', rawError);
  }
  return fallback;
}
