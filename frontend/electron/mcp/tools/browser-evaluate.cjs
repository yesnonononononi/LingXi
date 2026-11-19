/**
 * browser_evaluate：在页面里求值一个表达式（或函数体）。
 *
 *返回解析后的值，不再把 JSON 字符串塞进字段里——旧实现让模型拿到
 * `"result":"\"ok\""`，得解析两次。
 */

const {normalizeText} = require('../args.cjs');
const {TOOL_ERROR, toolError} = require('../errors.cjs');

module.exports = {
  name: 'browser_evaluate',
  method: 'evaluate',
  description: 'Evaluate a JavaScript expression in the built-in browser page and return its JSON-serialized result (useful for inspecting computed styles, DOM state, or app store).',
  inputSchema: {
    type: 'object',
    properties: {
      expression: {type: 'string', description: 'JavaScript expression or function body to evaluate in the page context.'},
      tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
    },
    required: ['expression'],
  },

  async run(host, args) {
    const code = normalizeText(args.expression);
    if (!code) {
      throw toolError(TOOL_ERROR.INVALID_ARGUMENT, 'expression 不能为空');
    }
    const state = await host.acquireState();
    const tab = host.resolveTab(state, normalizeText(args.tabId));
    const result = await host.withAgentControl(tab, () => host.runScript(tab, 'evaluate', {code}));
    if (!result || !result.ok) {
      throw toolError(TOOL_ERROR.INVALID_ARGUMENT, (result && result.error) || '脚本求值失败');
    }

    let value;
    try {
      value = JSON.parse(result.json);
    } catch {
      // 截断后的 JSON 不是合法文本，原样交给模型
      value = result.json;
    }
    return {
      ok: true,
      type: result.valueType,
      value,
      truncated: Boolean(result.truncated),
      tabId: tab.id,
      url: result.url || tab.url,
      title: result.title || tab.title,
    };
  },
};
