/**
 * 控制台/网络日志的数据加工：级别归一、环形缓冲、条目摘要。
 *
 *纯函数，不碰 Electron API，因此可以直接单测。采集端（project-page-preview）
 * 与读取端（console/network 工具）共用这一份，避免字段口径两边各写一遍。
 */

const MAX_LOG_ENTRIES = 200;
const DEFAULT_BODY_PREVIEW_LENGTH = 300;
const DEFAULT_DETAIL_BODY_LENGTH = 8000;
const MAX_DETAIL_BODY_LENGTH = 32000;
const MAX_STORED_RESPONSE_BODY_CHARS = 256 * 1024;

const CONSOLE_LEVEL_NAMES = Object.freeze(['verbose', 'info', 'warning', 'error']);

/** 控制台级别归一：兼容数字等级与 log/debug/warn 别名。 */
function normalizeConsoleLevel(level) {
  if (typeof level === 'string') {
    const lower = level.trim().toLowerCase();
    if (lower === 'warn') return 'warning';
    if (lower === 'log' || lower === 'debug') return 'info';
    if (CONSOLE_LEVEL_NAMES.includes(lower)) return lower;
  }
  if (typeof level === 'number' && level >= 0 && level < CONSOLE_LEVEL_NAMES.length) {
    return CONSOLE_LEVEL_NAMES[level];
  }
  return 'info';
}

/** 环形缓冲：超出上限丢最旧的。 */
function appendRingBuffer(list, item, max = MAX_LOG_ENTRIES) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

/** 响应头归一：键转小写，数组值拼成逗号串。 */
function normalizeHeaders(rawHeaders) {
  if (!rawHeaders || typeof rawHeaders !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    const normalizedKey = String(key).trim().toLowerCase();
    if (!normalizedKey) continue;
    if (Array.isArray(value)) result[normalizedKey] = value.map(item => String(item)).join(', ');
    else if (value !== undefined && value !== null) result[normalizedKey] = String(value);
  }
  return result;
}

/** content-type 优先取响应头，其次用 CDP 给的 mimeType。 */
function resolveContentType(headers, fallbackMime = '') {
  if (headers && typeof headers['content-type'] === 'string' && headers['content-type']) {
    return headers['content-type'];
  }
  return typeof fallbackMime === 'string' ? fallbackMime : '';
}

/**
 * 网络条目摘要。
 *
 *`bodyCaptured` 必须始终出现：模型要能区分「响应体真的是空」和「这一条没抓到 body」。
 * 旧实现两种情况都只给一个空字符串，模型只能瞎猜。
 */
function formatNetworkEntrySummary(entry, {includeHeaders = true, bodyPreviewLength = DEFAULT_BODY_PREVIEW_LENGTH} = {}) {
  const summary = {
    id: entry.id || '',
    method: entry.method,
    url: entry.url,
    resourceType: entry.resourceType,
    statusCode: entry.statusCode,
    ok: entry.ok,
    durationMs: entry.durationMs,
    error: entry.error,
    timestamp: entry.timestamp,
    contentType: entry.contentType || resolveContentType(entry.responseHeaders),
    bodyCaptured: Boolean(entry.bodyCaptured),
  };
  if (!entry.bodyCaptured && entry.bodyUnavailableReason) {
    summary.bodyUnavailableReason = entry.bodyUnavailableReason;
  }
  if (includeHeaders) {
    summary.requestHeaders = entry.requestHeaders || {};
    summary.responseHeaders = entry.responseHeaders || {};
  }
  if (entry.bodyCaptured && bodyPreviewLength > 0 && entry.bodyLength > 0) {
    if (entry.base64Encoded) {
      summary.bodyPreview = `[binary base64, ${entry.bodyLength} chars]`;
      summary.bodyLength = entry.bodyLength;
      summary.bodyTruncated = false;
    } else {
      const body = typeof entry.responseBody === 'string' ? entry.responseBody : '';
      summary.bodyPreview = body.slice(0, bodyPreviewLength);
      summary.bodyLength = entry.bodyLength;
      summary.bodyTruncated = entry.bodyLength > bodyPreviewLength;
    }
  }
  return summary;
}

module.exports = {
  MAX_LOG_ENTRIES,
  CONSOLE_LEVEL_NAMES,
  DEFAULT_BODY_PREVIEW_LENGTH,
  DEFAULT_DETAIL_BODY_LENGTH,
  MAX_DETAIL_BODY_LENGTH,
  MAX_STORED_RESPONSE_BODY_CHARS,
  normalizeConsoleLevel,
  appendRingBuffer,
  normalizeHeaders,
  resolveContentType,
  formatNetworkEntrySummary,
};
