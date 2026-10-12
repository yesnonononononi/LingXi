import type { TokenInfo } from '../types/Event';
import type { ChatMessage, ChatTurn } from '../types/chat';

/** 轮次存在时以其为准，避免把另一份气泡统计混进权威摘要。 */
export function resolveTokenUsage(turn: ChatTurn | null | undefined, message: ChatMessage): TokenInfo | null {
  if (turn) {
    return {
      inputTokenCount: turn.inputTokens,
      outputTokenCount: turn.outputTokens,
      totalTokenCount: turn.totalTokens,
      cacheTokens: turn.cacheTokens,
      reasoningTokens: turn.reasoningTokens,
    };
  }
  return message.tokenInfo ?? (message.tokens != null ? { totalTokenCount: message.tokens } : null);
}

/** 缓存与推理已包含在输入、输出内，不能再次计入总量。 */
export function resolveTotalTokens(usage: TokenInfo | null): number | null {
  if (usage?.totalTokenCount != null) return usage.totalTokenCount;
  if (usage?.inputTokenCount != null && usage.outputTokenCount != null) {
    return usage.inputTokenCount + usage.outputTokenCount;
  }
  return null;
}
