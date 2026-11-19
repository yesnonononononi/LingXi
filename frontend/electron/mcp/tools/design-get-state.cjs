/**
 * design_get_state：读 Design 画布的绑定路径、选中元素、计算样式与未解决批注。
 */

const {TOOL_ERROR, toolError} = require('../errors.cjs');

module.exports = {
  name: 'design_get_state',
  description: 'Read the active Design Canvas state: bound workspace HTML file path, current viewport, selected element selector & computed layout/style summary, CSS tweak variables, and unresolved design comments.',
  inputSchema: {type: 'object', properties: {}},

  async run(host) {
    const bridge = host.designBridge;
    if (!bridge) throw toolError(TOOL_ERROR.DESIGN_UNAVAILABLE, 'Design 画布桥接器未启用');
    return bridge.getState();
  },
};
