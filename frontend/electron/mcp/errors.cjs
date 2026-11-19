/**
 * MCP 工具错误。
 *
 *工具失败的读者是模型，不是终端用户：文案要说清「哪里不对、下一步怎么做」，
 * 并带一个稳定 code，模型才能区分「ref 失效要重新 query」和「等待超时」。
 */

const TOOL_ERROR = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  UNSUPPORTED_KEY: 'UNSUPPORTED_KEY',
  REF_STALE: 'REF_STALE',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  WAIT_TIMEOUT: 'WAIT_TIMEOUT',
  NAVIGATION_TIMEOUT: 'NAVIGATION_TIMEOUT',
  TAB_UNAVAILABLE: 'TAB_UNAVAILABLE',
  DESIGN_UNAVAILABLE: 'DESIGN_UNAVAILABLE',
});

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** 造一条带 code 的工具错误。 */
function toolError(code, message) {
  return new ToolError(code, message);
}

/** 渲染给模型看的文本：带 code 前缀，方便模型按 code 分支。 */
function describeForModel(error) {
  if (error instanceof ToolError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把底层异常归一成带 code 的工具错误。
 *
 * 桥接器、页面脚本这些下层只知道「失败了」，不知道调用方是模型；
 * 不补 code 模型就没法区分该重试还是该换路子。
 */
function asToolError(code, error) {
  if (error instanceof ToolError) return error;
  return new ToolError(code, error instanceof Error ? error.message : String(error));
}

module.exports = {TOOL_ERROR, ToolError, toolError, describeForModel, asToolError};
