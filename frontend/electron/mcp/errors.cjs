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
 * 下层如果自己带了更精确的 code（如 TARGET_NOT_FOUND），优先用它；
 * 没带才落到调用方给的兜底 code。
 */
function asToolError(code, error) {
  if (error instanceof ToolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const specific = error && typeof error.code === 'string' && error.code ? error.code : code;
  return new ToolError(specific, message);
}

module.exports = {TOOL_ERROR, ToolError, toolError, describeForModel, asToolError};
