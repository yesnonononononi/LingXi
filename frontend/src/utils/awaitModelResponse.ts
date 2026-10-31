/**
 * 「执行命令 → 模型下一轮响应」空窗占位的判据（文案：正在等待模型响应）。
 *
 * <p><b>窗口语义</b>：工具已经跑完、下一轮模型的首个 token 还没到。此时
 * {@code processParts} 非空（过程区只剩一条折叠标题）、正文为空、
 * {@code bodyVisible} 为假 —— 界面上原本一个状态提示都没有，用户会以为卡死。
 * 这条判据只描述这一个窗口，因此对「什么时候**不**显示」要求得非常死：宁可漏显示，
 * 也不能在工具执行中、重试中、已有正文时误报。</p>
 *
 * <p><b>为什么单独成模块</b>：它是一个纯函数，组件只负责把既有派生值喂进来。
 * 放在模板里写成一条长表达式就无法逐条证明「哪些情况一定不显示」，回归用例也没有落点。</p>
 */
export interface AwaitModelResponseState {
  /** 消息是否处于实时思考态（历史重建的消息恒为 false）。 */
  isThinking?: boolean;
  /** 正文（含流式增量）。 */
  content?: string;
  /** 过程区分段数量（{@code processParts.length}）。 */
  processPartCount: number;
  /** 复用 {@code ChatMessageItem.isTurnRunning}：轮次仍在运行的权威判据。 */
  isTurnRunning: boolean;
  /** 复用 {@code ChatMessageItem.processIsOngoing}：轮次摘要未终结。 */
  processIsOngoing: boolean;
  /** 复用 {@code ChatMessageItem.hasPendingTool}：是否还有工具停在调用中 / 待定。 */
  hasPendingTool: boolean;
  isComplete?: boolean;
  failed?: boolean;
  cancelled?: boolean;
  isSuspended?: boolean;
  /** 是否存在模型重试提示（{@code message.modelRetry}）。 */
  hasModelRetry: boolean;
}

/**
 * 是否展示「正在等待模型响应」占位。
 *
 * <p>每一条守卫都对应一个必须排除的误报场景，顺序按「最便宜且最强」排：</p>
 *
 * @param state 全部来自组件既有派生值，函数本身不感知 Vue
 * @returns true = 确实处在「工具已跑完、模型下一句未到」的空窗
 */
export function resolveAwaitModelResponse(state: AwaitModelResponseState): boolean {
  // 1. 必须是实时思考态：reducer 在 EXECUTION_STARTED 与每次工具活动后都会置 true，
  //    而历史消息从存储重建时永远没有这个标记 —— 这一条同时把历史轮次整片挡在外面。
  if (state.isThinking !== true) {
    return false;
  }
  // 2. 轮次必须仍在运行：复用 isTurnRunning / processIsOngoing，不另起一套判据体系。
  if (!state.isTurnRunning || !state.processIsOngoing) {
    return false;
  }
  // 3. 终态一律不显示：已结束 / 失败 / 取消 / 挂起的轮次没有「等待」可言。
  if (state.isComplete === true || state.failed === true || state.cancelled === true || state.isSuspended === true) {
    return false;
  }
  // 4. 模型重试提示优先：重试期间唯一的提示是 ModelRetryNotice，
  //    再叠一条「等待模型响应」会给出两个互相矛盾的结论。
  if (state.hasModelRetry) {
    return false;
  }
  // 5. 工具还在执行：该显示的是工具行自己的进行态，此时说「等待模型」是错的。
  if (state.hasPendingTool) {
    return false;
  }
  // 6. 正文已出现（流式增量或最终正文都算）：用户已经能看到内容，占位是噪音。
  if ((state.content ?? '').trim().length > 0) {
    return false;
  }
  // 7. 过程区必须有内容：过程区为空时沿用既有的 chat.message.thinking 占位，
  //    两条提示互斥，绝不出现「思考中 + 等待模型响应」并列。
  return state.processPartCount > 0;
}
