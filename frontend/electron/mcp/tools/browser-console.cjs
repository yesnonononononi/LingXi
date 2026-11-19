/**
 * browser_console：读页面控制台日志。
 */

const {normalizeBoolean, normalizeInt, normalizeText} = require('../args.cjs');
const {MAX_LOG_ENTRIES, normalizeConsoleLevel} = require('../logs.cjs');

module.exports = {
  name: 'browser_console',
  method: 'console',
  description: 'Read captured browser console logs (errors, warnings, info) from the built-in browser tab for debugging.',
  inputSchema: {
    type: 'object',
    properties: {
      level: {type: 'string', enum: ['all', 'error', 'warning', 'info', 'verbose'], description: 'Optional log level filter. Defaults to all.'},
      limit: {type: 'integer', minimum: 1, maximum: MAX_LOG_ENTRIES, description: 'Maximum entries to return (1-200). Defaults to 50.'},
      clear: {type: 'boolean', description: 'Clear buffered logs after reading. Defaults to false.'},
      tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
    },
  },

  async run(host, args) {
    const state = await host.acquireState();
    const tab = host.resolveTab(state, normalizeText(args.tabId));
    const maxItems = normalizeInt(args.limit, {fallback: 50, min: 1, max: MAX_LOG_ENTRIES});
    const rawLevel = normalizeText(args.level).toLowerCase();
    const filterLevel = rawLevel && rawLevel !== 'all' ? normalizeConsoleLevel(rawLevel) : '';

    const source = host.logs(tab).console;
    const filtered = filterLevel ? source.filter(entry => entry.level === filterLevel) : source;
    const entries = filtered.slice(-maxItems);
    // clear 清的是整个缓冲：按级别过滤后清空会让没被看到的级别一起消失，这里显式说明
    if (normalizeBoolean(args.clear, false)) tab.consoleLogs = [];

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
