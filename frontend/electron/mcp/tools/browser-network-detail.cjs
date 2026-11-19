/**
 * browser_network_detail：按 request id 读完整请求/响应，响应体支持分页。
 */

const {normalizeInt, normalizeText} = require('../args.cjs');
const {TOOL_ERROR, toolError} = require('../errors.cjs');
const {DEFAULT_DETAIL_BODY_LENGTH, MAX_DETAIL_BODY_LENGTH, resolveContentType} = require('../logs.cjs');

module.exports = {
  name: 'browser_network_detail',
  method: 'networkDetail',
  description: 'Read full request/response headers, request body, and response body for a specific captured request ID returned by browser_network.',
  inputSchema: {
    type: 'object',
    properties: {
      requestId: {type: 'string', description: 'Target request ID returned by browser_network (e.g. "req-1").'},
      offset: {type: 'integer', minimum: 0, description: 'Character offset into the response body for pagination. Defaults to 0.'},
      maxLength: {type: 'integer', minimum: 1, maximum: MAX_DETAIL_BODY_LENGTH, description: 'Maximum characters of response body to return (1-32000). Defaults to 8000.'},
      tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
    },
    required: ['requestId'],
  },

  async run(host, args) {
    const requestId = normalizeText(args.requestId);
    if (!requestId) {
      throw toolError(TOOL_ERROR.INVALID_ARGUMENT, 'requestId 不能为空，请先用 browser_network 取 id');
    }
    const state = await host.acquireState();
    const tab = host.resolveTab(state, normalizeText(args.tabId));
    const entry = host.logs(tab).network.find(item => item.id === requestId);
    if (!entry) {
      throw toolError(TOOL_ERROR.TARGET_NOT_FOUND, `未找到请求记录: ${requestId}，可能已被 clear 清掉`);
    }
    if (entry._bodyPromise) {
      await Promise.allSettled([entry._bodyPromise]);
    }

    const offset = normalizeInt(args.offset, {fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER});
    const maxLength = normalizeInt(args.maxLength, {fallback: DEFAULT_DETAIL_BODY_LENGTH, min: 1, max: MAX_DETAIL_BODY_LENGTH});
    const storedBody = typeof entry.responseBody === 'string' ? entry.responseBody : '';
    const responseBody = storedBody.slice(offset, offset + maxLength);
    const totalBodyLength = Number.isFinite(entry.bodyLength) ? entry.bodyLength : storedBody.length;

    return {
      tabId: tab.id,
      id: entry.id,
      method: entry.method,
      url: entry.url,
      resourceType: entry.resourceType,
      statusCode: entry.statusCode,
      ok: entry.ok,
      durationMs: entry.durationMs,
      error: entry.error,
      timestamp: entry.timestamp,
      contentType: entry.contentType || resolveContentType(entry.responseHeaders),
      requestHeaders: entry.requestHeaders || {},
      responseHeaders: entry.responseHeaders || {},
      requestBody: entry.requestBody || '',
      bodyCaptured: Boolean(entry.bodyCaptured),
      bodyUnavailableReason: entry.bodyCaptured ? '' : (entry.bodyUnavailableReason || ''),
      responseBody,
      totalBodyLength,
      offset,
      truncated: offset + responseBody.length < totalBodyLength,
      base64Encoded: Boolean(entry.base64Encoded),
    };
  },
};
