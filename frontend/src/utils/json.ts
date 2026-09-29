/**
 * JSON 解析与"可能是字符串也可能是对象"载荷的统一处理。
 *
 * 收敛原因：工具参数 args、工具返回 result/output、审批 payload 在后端
 * 既可能下发 JSON 字符串也可能下发对象，各组件各自 `try { JSON.parse } catch {}`
 * 导致异常被静默吞掉、结构变更无法被发现。
 */

/**
 * 解析 JSON 字符串；失败时返回 fallback 并输出告警，不再静默吞掉。
 */
export function parseJsonSafe<T>(raw: unknown, fallback: T, label = 'JSON'): T {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    console.warn(`[${label}] JSON 解析失败，已回退默认值:`, err);
    return fallback;
  }
}

/**
 * 把"可能是 JSON 字符串、也可能是对象"的输入统一成对象。
 * 非对象输入返回 fallback。
 *
 * 适用场景：**SSE 事件来源**的载荷（`ToolCallStartEvent.args` / `ToolCallEndEvent.output` /
 * `ModelToolCallVO.arguments`）框架声明为 `String`，需要做字符串解析。
 * ⚠️ `ToolCallVO.content/rawInput/rawOutput/metaData` 是后端**已解析的对象**，请改用 `asObject`，
 * 不要再走这里做字符串解析（契约 §2/§3 两个数据源形态不同，不可混用）。
 */
export function toObject(raw: unknown, fallback: Record<string, any> = {}): Record<string, any> {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw === 'string') {
    const parsed = parseJsonSafe<any>(raw, null, 'toObject');
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return fallback;
}

/**
 * 严格对象判定：仅当输入已是对象时返回，否则返回 null。
 *
 * 用于 `ToolCallVO.content/rawInput/rawOutput/metaData`（后端已解析的 `JsonNode`）：
 * 契约 §3 明确这些字段「已是解析后的 JSON 对象，解析失败时为 `null`（降级为『状态不可用』）」，
 * 因此前端**不得**再做字符串 `JSON.parse`，字符串输入一律视为非法（null）。
 */
export function asObject(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  return null;
}

/**
 * 把任意值转成展示用文本。
 * 字符串原样返回；对象/数组序列化；null/undefined 返回空串。
 */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 按优先级从对象中读取第一个非空字段。
 *
 * 契约来源：docs/frontend-backend-contract.md §4 —— 后端参数类（`tools/baseTools/arguments/*`）
 * 字段名**规范且唯一**（`command`/`intention`、`path`、`task`/`prompt`、`question`、`title`、`query` 等），
 * 后端**不存在** `CommandLine`/`cmd`/`AbsolutePath`/`TargetFile`/`filename` 等别名。
 * 调用方应只传规范字段名；命中缺失时应 `console.warn('[契约漂移] ...')`，不得静默取空。
 */
export function pickField(source: unknown, keys: readonly string[]): string {
  if (!source || typeof source !== 'object') return '';
  const obj = source as Record<string, any>;
  for (const key of keys) {
    const value = obj[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return typeof value === 'string' ? value : toText(value);
  }
  return '';
}

/** 按优先级从对象中读取第一个数组字段 */
export function pickArrayField(source: unknown, keys: readonly string[]): any[] {
  const obj = toObject(source, {});
  for (const key of keys) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  return [];
}

/** 读取第一个非空值 */
export function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = typeof value === 'string' ? value : toText(value);
    if (text.trim()) return text;
  }
  return '';
}
