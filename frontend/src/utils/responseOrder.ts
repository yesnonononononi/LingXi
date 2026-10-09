/** 新响应用框架身份，旧 UUID 历史保留后端给出的序号。比较仅用于同一轮次。 */
export interface ResponsePosition {
  responseId?: string | null;
  order?: number;
}

export function compareResponsePosition(left: ResponsePosition, right: ResponsePosition): number {
  const leftOrdered = !!left.responseId && /^[0-9]+$/.test(left.responseId);
  const rightOrdered = !!right.responseId && /^[0-9]+$/.test(right.responseId);
  if (leftOrdered && rightOrdered) {
    const a = BigInt(left.responseId!);
    const b = BigInt(right.responseId!);
    if (a !== b) return a < b ? -1 : 1;
  } else if (leftOrdered !== rightOrdered) {
    return leftOrdered ? 1 : -1;
  }
  return (left.order ?? Infinity) - (right.order ?? Infinity);
}
