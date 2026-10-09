/** 比较仅用于同一轮次，模型响应身份按整数比较，块内位置由后端给出。 */
export interface ResponsePosition {
  responseId?: string | null;
  order?: number;
}

export function compareResponsePosition(left: ResponsePosition, right: ResponsePosition): number {
  if (left.responseId && right.responseId && left.responseId !== right.responseId) {
    const a = BigInt(left.responseId);
    const b = BigInt(right.responseId);
    if (a !== b) return a < b ? -1 : 1;
  }
  return (left.order ?? Infinity) - (right.order ?? Infinity);
}
