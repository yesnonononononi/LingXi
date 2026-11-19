/**
 * browser_navigate：打开地址或前进/后退/刷新。
 *
 *写工具的约定：`run(host, args)` 只做参数归一与顺序编排，页面/标签能力全部经 host，
 * 这样单个工具可以在没有 Electron 的环境里用假 host 单测。
 */

const {normalizeBoolean, normalizeEnum, normalizeInt, normalizeText} = require('../args.cjs');
const {TOOL_ERROR, toolError} = require('../errors.cjs');

const ACTIONS = ['goto', 'back', 'forward', 'reload'];
const MAX_WAIT_MS = 30000;

module.exports = {
  name: 'browser_navigate',
  method: 'navigate',
  description: 'Navigate the built-in desktop browser: open a URL (goto) or go back, forward, or reload.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {type: 'string', enum: ACTIONS, description: 'Navigation action. Defaults to goto.'},
      url: {type: 'string', description: 'Target http/https URL (required when action is goto).'},
      tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
      newTab: {type: 'boolean', description: 'Whether to open in a new tab (only for goto). Defaults to false.'},
      waitUntilLoad: {type: 'boolean', description: 'Wait for page load completion. Defaults to true.'},
      waitTimeoutMs: {type: 'integer', minimum: 1, maximum: MAX_WAIT_MS, description: 'Load wait timeout in milliseconds (max 30000).'},
    },
    // url 只对 goto 必填：写成顶层 required 会让 back/forward/reload 被严格客户端拒掉，
    // 所以这条约束放在 run 里校验
  },

  async run(host, args) {
    const action = normalizeEnum(args.action, ACTIONS, 'goto');
    const tabId = normalizeText(args.tabId);
    const waitUntilLoad = normalizeBoolean(args.waitUntilLoad, true);
    const waitTimeoutMs = normalizeInt(args.waitTimeoutMs, {fallback: 15000, min: 1, max: MAX_WAIT_MS});

    if (action !== 'goto') {
      const state = await host.acquireState();
      const tab = host.resolveTab(state, tabId);
      return host.withAgentControl(tab, async () => {
        state.activeTabId = tab.id;
        host.navigateHistory(state, tab, action);
        return this.describe(tab, action, waitUntilLoad ? await host.waitForTabLoad(tab, waitTimeoutMs) : null);
      });
    }

    const url = normalizeText(args.url);
    if (!url) {
      throw toolError(TOOL_ERROR.INVALID_ARGUMENT, 'action=goto 时必须提供 url');
    }
    const state = await host.acquireState();
    const tab = normalizeBoolean(args.newTab, false) ? host.createTab(state) : host.resolveTab(state, tabId);
    if (!tab.url) tab.openedByAgent = true;

    return host.withAgentControl(tab, async () => {
      state.activeTabId = tab.id;
      const loadPromise = waitUntilLoad ? host.waitForTabLoad(tab, waitTimeoutMs) : null;
      host.loadUrl(state, tab, url);
      const loadResult = loadPromise ? await loadPromise : null;
      return this.describe(tab, 'goto', loadResult);
    });
  },

  /** 回给模型的状态摘要；加载结果是可选的（不等加载时只有当前状态）。 */
  describe(tab, action, loadResult) {
    return {
      action,
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      loadState: (loadResult && loadResult.loadState) || tab.loadState,
      errorCode: (loadResult && loadResult.errorCode) || tab.errorCode || 0,
      errorDescription: (loadResult && loadResult.errorDescription) || tab.errorDescription || '',
    };
  },
};
