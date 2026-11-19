/**
 * browser_wait：等待选择器可见 / 文本出现 / 固定时长。
 */

const {normalizeInt, normalizeText} = require('../args.cjs');
const {TOOL_ERROR, toolError} = require('../errors.cjs');

const MAX_WAIT_MS = 15000;
const POLL_INTERVAL_MS = 200;

module.exports = {
  name: 'browser_wait',
  method: 'wait',
  description: 'Wait for a visible selector, page text, or a fixed delay in milliseconds (useful for SPA async updates).',
  inputSchema: {
    type: 'object',
    properties: {
      selector: {type: 'string', description: 'Optional CSS selector to wait for until visible.'},
      text: {type: 'string', description: 'Optional text substring to wait for in page body.'},
      ms: {type: 'integer', minimum: 1, maximum: MAX_WAIT_MS, description: 'Fixed delay in milliseconds (used when selector and text are omitted, max 15000).'},
      timeoutMs: {type: 'integer', minimum: 1, maximum: MAX_WAIT_MS, description: 'Maximum wait timeout in milliseconds (default 10000, max 15000).'},
      tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
    },
  },

  async run(host, args) {
    const rawSelector = normalizeText(args.selector);
    const rawText = normalizeText(args.text);
    const fixedMs = normalizeInt(args.ms, {fallback: 0, min: 1, max: MAX_WAIT_MS});
    const maxWait = normalizeInt(args.timeoutMs, {fallback: 10000, min: 1, max: MAX_WAIT_MS});

    const state = await host.acquireState();
    const tab = host.resolveTab(state, normalizeText(args.tabId));

    return host.withAgentControl(tab, async () => {
      if (!rawSelector && !rawText) {
        const delayMs = fixedMs || 1000;
        await host.sleep(delayMs);
        return {ok: true, waitedMs: delayMs, tabId: tab.id, url: tab.url, title: tab.title};
      }

      const startedAt = Date.now();
      const deadline = startedAt + maxWait;
      while (Date.now() < deadline) {
        const status = await host.runScript(tab, 'wait-check', {rawSelector, rawText});
        if (status && status.error) {
          throw toolError(TOOL_ERROR.INVALID_ARGUMENT, status.error);
        }
        if (status && status.matched) {
          return {
            ok: true,
            waitedMs: Date.now() - startedAt,
            tabId: tab.id,
            url: status.url || tab.url,
            title: status.title || tab.title,
          };
        }
        await host.sleep(POLL_INTERVAL_MS);
      }
      throw toolError(
        TOOL_ERROR.WAIT_TIMEOUT,
        `等待超时（${maxWait}ms）未满足条件: ${rawSelector || rawText}。`
          + '可以先 browser_screenshot 或 browser_query 看看页面停在哪一步',
      );
    });
  },
};
