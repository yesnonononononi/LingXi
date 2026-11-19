/**
 * browser_scroll：整页或指定容器按方向滚动。
 */

const {normalizeEnum, normalizeInt, normalizeText} = require('../args.cjs');
const {TOOL_ERROR, toolError} = require('../errors.cjs');

const DIRECTIONS = ['down', 'up', 'top', 'bottom'];
const MAX_SCROLL_PX = 100000;

module.exports = {
  name: 'browser_scroll',
  method: 'scroll',
  description: 'Scroll the page or a specific scrollable container (down, up, top, bottom, or by pixel amount).',
  inputSchema: {
    type: 'object',
    properties: {
      direction: {type: 'string', enum: DIRECTIONS, description: 'Scroll direction. Defaults to down.'},
      amount: {type: 'integer', minimum: 1, maximum: MAX_SCROLL_PX, description: 'Optional pixel offset for up/down scrolling. Defaults to 80% of viewport height.'},
      selector: {type: 'string', description: 'Optional CSS selector of a target container or element to scroll.'},
      tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
    },
  },

  async run(host, args) {
    const state = await host.acquireState();
    const tab = host.resolveTab(state, normalizeText(args.tabId));
    const result = await host.withAgentControl(tab, () => host.runScript(tab, 'scroll', {
      direction: normalizeEnum(args.direction, DIRECTIONS, 'down'),
      px: normalizeInt(args.amount, {fallback: 0, min: 1, max: MAX_SCROLL_PX}),
      selector: normalizeText(args.selector),
    }));
    if (!result || !result.ok) {
      throw toolError(TOOL_ERROR.TARGET_NOT_FOUND, (result && result.error) || '滚动页面失败');
    }
    return {...result, tabId: tab.id};
  },
};
