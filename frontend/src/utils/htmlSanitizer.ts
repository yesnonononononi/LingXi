/**
 * 网页 HTML 过滤与长度校验：用于 Show with Agent 随页面附带 HTML 上下文前的清洗与拦截。
 */

/** 与后端 SessionMessage.MAX_INPUT_LENGTH (100_000) 对齐，为提示词与文档包装预留 10K 余量。 */
export const MAX_SHOW_WITH_AGENT_HTML_CHARS = 90_000;
export const MAX_CHAT_INPUT_CHARS = 100_000;

export interface HtmlValidationResult {
  valid: boolean;
  charCount: number;
  limit: number;
}

/**
 * 过滤脚本、样式、注释、内联事件与 Base64 资源，保留页面结构与文本内容。
 */
export function sanitizePageHtml(rawHtml: string): string {
  if (!rawHtml) return '';
  return rawHtml
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '<svg/>')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/data:[^"'\s>]+;base64,[A-Za-z0-9+/=]+/gi, 'data:base64-omitted')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function validateShowWithAgentHtml(
  cleanedHtml: string,
  limit = MAX_SHOW_WITH_AGENT_HTML_CHARS,
): HtmlValidationResult {
  const charCount = cleanedHtml.length;
  return {
    valid: charCount <= limit,
    charCount,
    limit,
  };
}
