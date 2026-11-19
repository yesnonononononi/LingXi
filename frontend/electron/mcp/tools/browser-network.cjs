/**
 * browser_network：读已捕获的请求列表（含响应体预览）。
 */

const {normalizeBoolean, normalizeInt, normalizeText} = require('../args.cjs');
const {MAX_LOG_ENTRIES, MAX_DETAIL_BODY_LENGTH, DEFAULT_BODY_PREVIEW_LENGTH, formatNetworkEntrySummary} = require('../logs.cjs');

module.exports = {
  name: 'browser_network',
  method: 'network',
  description: 'Read captured HTTP/XHR/Fetch network requests from the built-in browser tab, including request/response headers, contentType, an assigned request id, and a truncated response body preview. Use browser_network_detail with that id to inspect the full request/response body.',
  inputSchema: {
    type: 'object',
    properties: {
      onlyErrors: {type: 'boolean', description: 'Return only failed requests (HTTP >= 400 or network error). Defaults to false.'},
      urlContains: {type: 'string', description: 'Optional case-insensitive URL substring filter.'},
      limit: {type: 'integer', minimum: 1, maximum: MAX_LOG_ENTRIES, description: 'Maximum entries to return (1-200). Defaults to 50.'},
      clear: {type: 'boolean', description: 'Clear buffered network entries after reading. Defaults to false.'},
      includeHeaders: {type: 'boolean', description: 'Include requestHeaders and responseHeaders on each entry. Defaults to true.'},
      bodyPreviewLength: {type: 'integer', minimum: 0, maximum: MAX_DETAIL_BODY_LENGTH, description: 'Maximum characters of response body preview to include per entry (0 to omit). Defaults to 300.'},
      tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
    },
  },

  async run(host, args) {
    const state = await host.acquireState();
    const tab = host.resolveTab(state, normalizeText(args.tabId));
    const maxItems = normalizeInt(args.limit, {fallback: 50, min: 1, max: MAX_LOG_ENTRIES});
    const previewLength = normalizeInt(args.bodyPreviewLength, {fallback: DEFAULT_BODY_PREVIEW_LENGTH, min: 0, max: MAX_DETAIL_BODY_LENGTH});
    const needle = normalizeText(args.urlContains).toLowerCase();

    let filtered = host.logs(tab).network;
    if (normalizeBoolean(args.onlyErrors, false)) {
      filtered = filtered.filter(entry => !entry.ok || entry.statusCode >= 400 || Boolean(entry.error));
    }
    if (needle) {
      filtered = filtered.filter(entry => String(entry.url || '').toLowerCase().includes(needle));
    }
    const selected = filtered.slice(-maxItems);
    // 响应体是异步抓的，读之前等这一批落定，否则模型会看到「有 bodyLength 没 body」
    await Promise.allSettled(selected.map(entry => entry._bodyPromise).filter(Boolean));

    const entries = selected.map(entry => formatNetworkEntrySummary(entry, {
      includeHeaders: args.includeHeaders !== false,
      bodyPreviewLength: previewLength,
    }));
    if (normalizeBoolean(args.clear, false)) tab.networkLogs = [];

    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      totalCount: filtered.length,
      entries,
      truncated: filtered.length > entries.length,
    };
  },
};
