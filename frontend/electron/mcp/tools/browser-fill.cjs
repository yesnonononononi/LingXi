/**
 * browser_fill：给输入框/文本域/下拉框填值，必要时提交。
 *
 *优先原生输入通道（isTrusted，React 受控组件才认），拿不到时退 CDP，
 * 再拿不到才走页面脚本写值。提交语义两条路径统一走 submit 脚本。
 */

const {normalizeBoolean, normalizeInt, normalizeText} = require('../args.cjs');
const {TOOL_ERROR, toolError} = require('../errors.cjs');

module.exports = {
  name: 'browser_fill',
  method: 'fill',
  description: 'Fill text into an input, textarea, contenteditable, or select an option in a <select> by ref (from browser_query) or CSS selector.',
  inputSchema: {
    type: 'object',
    properties: {
      ref: {type: 'string', description: 'Optional element ref returned by the latest browser_query snapshot (e.g. "e2").'},
      selector: {type: 'string', description: 'Optional CSS selector matching the input/select element (required if ref is omitted).'},
      value: {type: 'string', description: 'Text value to fill (or option value/label for <select>).'},
      index: {type: 'integer', minimum: 0, description: 'Zero-based index when multiple visible elements match. Defaults to 0.'},
      clear: {type: 'boolean', description: 'Clear existing content before filling. Defaults to true.'},
      submit: {type: 'boolean', description: 'Dispatch Enter key and submit enclosing form after filling. Defaults to false.'},
      tabId: {type: 'string', description: 'Optional tab ID. Defaults to the active tab.'},
    },
    required: ['value'],
  },

  async run(host, args) {
    const rawRef = normalizeText(args.ref);
    const selector = normalizeText(args.selector);
    if (!rawRef && !selector) {
      throw toolError(TOOL_ERROR.INVALID_ARGUMENT, 'ref 与 selector 不能同时为空');
    }
    const textValue = args.value === undefined || args.value === null ? '' : String(args.value);
    const clear = normalizeBoolean(args.clear, true);
    const submit = normalizeBoolean(args.submit, false);
    const target = {
      rawRef,
      selector,
      index: normalizeInt(args.index, {fallback: 0, min: 0, max: 10000}),
      textValue,
      clear,
      submit,
    };

    const state = await host.acquireState();
    const tab = host.resolveTab(state, normalizeText(args.tabId));
    const navWatch = submit ? host.beginNavigationWatch(tab) : null;

    const result = await host.withAgentControl(tab, async () => {
      const prepared = await host.runScript(tab, 'fill-prepare', target);
      if (!prepared || !prepared.ok) {
        throw toolError(TOOL_ERROR.TARGET_NOT_FOUND, (prepared && prepared.error) || '填充元素失败');
      }
      // select 由页面脚本直接改完值，原生输入通道对下拉无效
      if (prepared.handled) return prepared;

      let read;
      if (host.canInsertText(tab)) {
        host.focusContents(tab);
        if (clear && textValue === '') {
          if (!prepared.isEmptyBefore) host.deleteContent(tab);
        } else if (textValue !== '') {
          await host.insertText(tab, textValue);
        }
        read = await host.runScript(tab, 'fill-read', target);
        // 面板收起时 insertText 会被 Chromium 吞掉，回读为空就用 CDP 补一次
        if (textValue !== '' && read && read.ok && read.valueLength === 0 && host.canCdpInsert(tab)) {
          await host.cdpInsertText(tab, textValue);
          read = await host.runScript(tab, 'fill-read', target);
        }
      } else {
        read = await host.runScript(tab, 'fill-type', target);
      }
      if (!read || !read.ok) {
        throw toolError(TOOL_ERROR.TARGET_NOT_FOUND, (read && read.error) || '填充元素失败');
      }
      if (submit) {
        if (host.canInsertText(tab)) host.pressEnter(tab);
        await host.runScript(tab, 'submit', target);
      }
      return read;
    });

    const navigation = navWatch ? await navWatch.settle() : null;
    return {
      ...result,
      tabId: tab.id,
      url: (navigation && navigation.url) || tab.url,
      title: (navigation && navigation.title) || tab.title,
      navigated: Boolean(navigation && navigation.navigated),
    };
  },
};
