/**
 * browser_click：按 ref / selector / 文本点击或悬停。
 *
 *点击可能触发导航，因此动作后给一个短静默窗口等导航起头（P1：旧实现直接返回点击
 * 瞬间的旧 URL，等于对模型撒谎），返回体统一带 loadState。
 */

const {normalizeBoolean, normalizeInt, normalizeText} = require('../args.cjs');
const {TOOL_ERROR, toolError} = require('../errors.cjs');

module.exports = {
  name: 'browser_click',
  method: 'click',
  description: 'Click (or hover over) an element in the built-in browser page by ref (from browser_query), CSS selector (supports .className, #id), and/or visible text.',
  inputSchema: {
    type: 'object',
    properties: {
      ref: {type: 'string', description: 'Optional element ref returned by the latest browser_query snapshot (e.g. "e3"). Preferred for reliable targeting.'},
      selector: {type: 'string', description: 'Optional CSS selector (e.g. ".submit-btn", "#login", "button").'},
      text: {type: 'string', description: 'Optional visible text substring to match clickable elements (useful when classes are obfuscated or Tailwind-based).'},
      index: {type: 'integer', minimum: 0, description: 'Zero-based index when multiple visible elements match. Defaults to 0.'},
      hoverOnly: {type: 'boolean', description: 'Move mouse over the element without clicking (triggers CSS :hover and mouseenter/mouseover for dropdown menus or tooltips). Defaults to false.'},
      waitForNavigation: {type: 'boolean', description: 'Wait briefly for a navigation started by this click before returning. Defaults to true.'},
      tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
    },
  },

  async run(host, args) {
    const rawRef = normalizeText(args.ref);
    const rawSelector = normalizeText(args.selector);
    const rawText = normalizeText(args.text);
    if (!rawRef && !rawSelector && !rawText) {
      throw toolError(TOOL_ERROR.INVALID_ARGUMENT, 'ref、selector 与 text 不能同时为空');
    }
    const shouldHoverOnly = normalizeBoolean(args.hoverOnly, false);
    const shouldWaitNavigation = normalizeBoolean(args.waitForNavigation, true);
    const scriptArgs = {
      rawRef,
      rawSelector,
      rawText,
      targetIndex: normalizeInt(args.index, {fallback: 0, min: 0, max: 10000}),
      hoverOnly: shouldHoverOnly,
      defaultClickSelector: host.defaultClickSelector,
    };

    const state = await host.acquireState();
    const tab = host.resolveTab(state, normalizeText(args.tabId));

    const navWaiter = shouldWaitNavigation && !shouldHoverOnly ? host.beginNavigationWatch(tab) : null;
    const result = await host.withAgentControl(tab, async () => {
      const res = await host.runScript(tab, 'click', scriptArgs);
      if (res && res.ok && shouldHoverOnly) {
        // 合成 mouseover 骗不过 CSS :hover，补一发原生鼠标移动
        await host.dispatchHover(tab, res.centerX, res.centerY);
      }
      return res;
    });
    if (!result || !result.ok) {
      throw toolError(TOOL_ERROR.TARGET_NOT_FOUND, (result && result.error) || '点击元素失败');
    }

    const navigation = navWaiter ? await navWaiter : null;
    return {
      ...result,
      tabId: tab.id,
      url: (navigation && navigation.url) || result.currentUrl || tab.url,
      title: (navigation && navigation.title) || result.currentTitle || tab.title,
      loadState: (navigation && navigation.loadState) || tab.loadState,
      navigated: Boolean(navigation && navigation.navigated),
    };
  },
};
