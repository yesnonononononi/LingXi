/**
 * 时间戳解析的唯一实现。
 *
 * 收敛原因：后端时间字段既有数字时间戳也有 ISO 字符串，
 * 各处在 `new Date(x).getTime()` 之后有的校验 NaN 有的不校验，
 * 且解析失败时普遍用 `Date.now()` 冒充，导致历史记录被排到最新位置。
 */

/** 解析时间戳；失败返回 null，由调用方决定降级方式 */
export function parseTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // 纯数字字符串按毫秒时间戳处理，避免 new Date('1712345678901') 被当成非法日期
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    const t = new Date(trimmed).getTime();
    return Number.isNaN(t) ? null : t;
  }

  return null;
}

/** 解析时间戳；失败时返回调用方给定的 fallback */
export function parseTimestampOr(value: unknown, fallback: number): number {
  return parseTimestamp(value) ?? fallback;
}
