/**
 * design_resolve_comment：把某条（或全部）Design 批注标为已解决。
 */

const {normalizeBoolean, normalizeText} = require('../args.cjs');
const {TOOL_ERROR, toolError} = require('../errors.cjs');

module.exports = {
  name: 'design_resolve_comment',
  description: 'Mark a Design Canvas comment (by commentId) or all unresolved comments (all: true) as resolved after applying design changes.',
  inputSchema: {
    type: 'object',
    properties: {
      commentId: {type: 'string', description: 'Target comment ID from design_get_state.'},
      all: {type: 'boolean', description: 'Set true to resolve all unresolved comments at once.'},
    },
  },

  async run(host, args) {
    const bridge = host.designBridge;
    if (!bridge) throw toolError(TOOL_ERROR.DESIGN_UNAVAILABLE, 'Design 画布桥接器未启用');
    const commentId = normalizeText(args.commentId);
    const all = normalizeBoolean(args.all, false);
    if (!all && !commentId) {
      throw toolError(TOOL_ERROR.INVALID_ARGUMENT, 'commentId 与 all=true 至少提供一项');
    }
    return bridge.resolveComment({commentId, all});
  },
};
