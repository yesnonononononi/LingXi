/**
 * browser_tabs：列出、激活与关闭标签页。
 *
 *这三个动作不参与人工接管挂起（用户接管期间仍应能查看/关闭标签），
 * 与页面操作型工具的区别在这里显式写明，避免下一个维护者以为漏了。
 */

const {normalizeEnum, normalizeText} = require('../args.cjs');
const {TOOL_ERROR, toolError} = require('../errors.cjs');

const ACTIONS = ['list', 'activate', 'close'];

module.exports = {
  name: 'browser_tabs',
  description: 'List, activate, or close tabs in the built-in browser.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {type: 'string', enum: ACTIONS, description: 'Tab operation. Defaults to list.'},
      tabId: {type: 'string', description: 'Target tab ID for activate or close.'},
    },
  },

  async run(host, args) {
    const action = normalizeEnum(args.action, ACTIONS, 'list');
    const tabId = normalizeText(args.tabId);
    if (action === 'list') {
      return host.listTabs();
    }
    if (!tabId) {
      throw toolError(TOOL_ERROR.INVALID_ARGUMENT, `action=${action} 时必须提供 tabId`);
    }
    const state = await host.acquireState();
    if (action === 'activate') {
      return host.activateTab(state, host.requireTab(state, tabId));
    }
    return host.closeTab(state, host.requireTab(state, tabId));
  },
};
