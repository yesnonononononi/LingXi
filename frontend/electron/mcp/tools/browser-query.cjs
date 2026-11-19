/**
 * browser_query：列出可见交互元素与其稳定 ref。
 */

const {normalizeInt, normalizeText} = require('../args.cjs');

const MAX_ITEMS = 100;

module.exports = {
  name: 'browser_query',
  method: 'query',
  description: 'Inspect visible interactive elements (including stable snapshot ref IDs like "e1", roles, states, values, labels, viewport visibility, selector hints, text) and page text excerpt.',
  inputSchema: {
    type: 'object',
    properties: {
      selector: {type: 'string', description: 'Optional CSS selector filter. Defaults to common interactive elements.'},
      limit: {type: 'integer', minimum: 1, maximum: MAX_ITEMS, description: 'Maximum elements to return (1-100). Defaults to 40.'},
      tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
    },
  },

  async run(host, args) {
    const state = await host.acquireState();
    const tab = host.resolveTab(state, normalizeText(args.tabId));
    const result = await host.withAgentControl(tab, () => host.runScript(tab, 'query', {
      customSelector: normalizeText(args.selector),
      maxItems: normalizeInt(args.limit, {fallback: 40, min: 1, max: MAX_ITEMS}),
      defaultSelector: host.defaultInteractiveSelector,
    }));
    return {...result, tabId: tab.id};
  },
};
