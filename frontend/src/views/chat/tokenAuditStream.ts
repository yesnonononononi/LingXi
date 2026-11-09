import {ref} from 'vue';
import type {
  SessionTokenAuditSnapshot,
  TokenAuditAmount,
  TokenAuditCategory,
  TokenAuditCategoryType,
  TokenAuditDisplayState,
  TokenAuditRequestOverhead,
  TokenAuditToolBreakdown,
  TokenAuditToolGroup,
  TokenAuditToolGroupKind,
  TokenAuditToolItem,
} from '../../types/tokenAudit';

/**
 * 用量审计快照的实时存储 + 唯一解析入口（纯响应式，无 DOM）。
 *
 * <p><b>为什么需要它</b>：面板的数据有两个来源 —— 打开时的 `GET /session/{id}/token-audit`
 * 与会话级流上的 `token_audit_snapshot` 推送。两者 payload **完全同构**，所以这里既做「最新推送的
 * 落点」，也做「两条来源的统一解析入口」（{@link normalizeTokenAuditSnapshot}），
 * 面板因此只有一份解析与渲染逻辑。</p>
 *
 * <p><b>键</b>：一律按字符串 sessionId 存储 —— 雪花 ID 超出 JS 安全整数范围，数值键会撞精度。
 * 后端按<b>根会话</b>推送（看子会话时该帧也落根会话的流），所以键就是快照自带的会话 id。</p>
 *
 * <p><b>语义边界</b>：本模块只回答「这个会话最新收到的快照是什么」。它不判断新鲜度、
 * 不做合并、更不替 GET 兜底 —— 谁新谁旧由调用方用 {@link resolveDisplayedSnapshot} 的规则决定。</p>
 */

/** 一条推送记录：最新快照 + 到达时刻（毫秒时间戳）。 */
export interface TokenAuditStreamEntry {
  /** 已归一化的快照，与 GET 的 `data` 同构。 */
  snapshot: SessionTokenAuditSnapshot;
  /** 到达时刻（`Date.now()`）。用于排查「这条是刚推的还是旧的」。 */
  receivedAt: number;
}

/** 后端定义的全部采集状态；其它取值一律按「未采集」兜底，绝不臆造「已采集」。 */
const KNOWN_DISPLAY_STATES: readonly TokenAuditDisplayState[] = [
  'NOT_COLLECTED',
  'CAPTURING',
  'COLLECTED',
  'FAILED',
];

/** 已知消息分项类型（非法取值整条丢弃，不渲染成「未知类别」）。 */
const KNOWN_CATEGORY_TYPES: readonly TokenAuditCategoryType[] = ['SYSTEM', 'USER', 'ATTACHMENT', 'AI', 'TOOL'];

/** 已知工具来源分组（非法取值整组丢弃）。 */
const KNOWN_TOOL_GROUP_KINDS: readonly TokenAuditToolGroupKind[] = ['ORDINARY', 'MCP', 'SKILL'];

/**
 * 纯数字字符串判定：只认十进制整数/小数，可带正负号，两侧允许空白。
 *
 * <p>刻意<b>不</b>接受 `"1e5"`、`"0x10"`、`"12px"`、`""`、`"abc"`：这些都不是后端会给出的
 * 数值序列化形态，一旦放过就等于替后端猜数据。`Number("")` 是 0、`Number("abc")` 是 NaN 的坑也在此避开。</p>
 */
const NUMERIC_STRING_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * 把「数值语义字段」的任一线上形态收敛为 `number | null`。
 *
 * <p><b>为什么必需</b>：项目全局 Jackson 配置会把 `Long`/`BigDecimal` 序列化成字符串
 * （`{"liveTotalTokens": "148200"}`），而后端把字段类型改成 `Integer` 只解决当下两个字段 ——
 * `sessionId` 这类雪花 ID 永远只能是字符串，同一个 payload 里「数字是字符串」会长期存在。
 * 前端解析边界必须容得下两种形态，否则表现就是「数字凭空消失、整行不渲染」。</p>
 *
 * <p>规则：`number` 有限值原样保留；纯数字字符串转 `number`；其余（`""`、`"abc"`、`"1e5"`、
 * `null`、`undefined`、`NaN`、`Infinity`、布尔、对象）一律 `null`，即「未知」——
 * <b>绝不猜 0</b>，0 是「真的没有占用」，与「不知道」语义相反。</p>
 *
 * @param value 原始值（未知形状）
 * @returns 有限数值，或 null（未知）
 */
export function toTokenAuditNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || !NUMERIC_STRING_PATTERN.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 取一个自有的对象字段（拒绝原型链上的噪声）。 */
const readField = (source: Record<string, unknown>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;

/** 值是否为可当对象读取的普通对象。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);

/**
 * 归一出「token 数 + 占比」对象。
 *
 * <p>对象不存在/形状非法 → `null`（表示该小节不存在）。对象存在但 `tokens` 未知 → 仍返回对象
 * （`tokens: null`），因为「存在但数值未知」与「不存在」在渲染上含义不同：前者由 `isRenderableAmount`
 * 判定不渲染该行，但兄弟字段（如 `itemCount`）仍然有效。</p>
 *
 * @param raw 原始值
 * @returns 已归一对象，或 null
 */
const normalizeAmount = (raw: unknown): TokenAuditAmount | null => {
  if (!isRecord(raw)) return null;
  return {
    tokens: toTokenAuditNumber(readField(raw, 'tokens')),
    ratio: toTokenAuditNumber(readField(raw, 'ratio')),
  };
};

/** 归一出单个工具项。 */
const normalizeToolItem = (raw: unknown): TokenAuditToolItem | null => {
  if (!isRecord(raw)) return null;
  const toolName = readField(raw, 'toolName');
  if (typeof toolName !== 'string' || toolName.trim() === '') return null;
  return {
    toolName,
    tokens: toTokenAuditNumber(readField(raw, 'tokens')),
    argumentTokens: toTokenAuditNumber(readField(raw, 'argumentTokens')),
    outputTokens: toTokenAuditNumber(readField(raw, 'outputTokens')),
  };
};

/** 归出一个工具来源分组。 */
const normalizeToolGroup = (raw: unknown): TokenAuditToolGroup | null => {
  if (!isRecord(raw)) return null;
  const kind = readField(raw, 'groupKind');
  if (typeof kind !== 'string' || !(KNOWN_TOOL_GROUP_KINDS as readonly string[]).includes(kind)) return null;
  return {
    groupKind: kind as TokenAuditToolGroupKind,
    tokens: toTokenAuditNumber(readField(raw, 'tokens')),
    ratio: toTokenAuditNumber(readField(raw, 'ratio')),
  };
};

const normalizeOrdinaryTools = (raw: unknown): {items: TokenAuditToolItem[] | null} | null => {
  if (!isRecord(raw)) return null;
  const items = readField(raw, 'items');
  return {items: Array.isArray(items)
    ? items.map(normalizeToolItem).filter((item): item is TokenAuditToolItem => item !== null) : null};
};

/** 归出「工具返回消息」的二级构成。 */
const normalizeToolBreakdown = (raw: unknown): TokenAuditToolBreakdown | null => {
  if (!isRecord(raw)) return null;
  return {
    tokens: toTokenAuditNumber(readField(raw, 'tokens')),
    ratio: toTokenAuditNumber(readField(raw, 'ratio')),
    mcp: normalizeToolGroup(readField(raw, 'mcp')),
    skill: normalizeToolGroup(readField(raw, 'skill')),
    ordinary: normalizeOrdinaryTools(readField(raw, 'ordinary')),
  };
};

/** 归出单个消息分项。 */
const normalizeCategory = (raw: unknown): TokenAuditCategory | null => {
  if (!isRecord(raw)) return null;
  const type = readField(raw, 'type');
  if (typeof type !== 'string' || !(KNOWN_CATEGORY_TYPES as readonly string[]).includes(type)) return null;
  return {
    type: type as TokenAuditCategoryType,
    tokens: toTokenAuditNumber(readField(raw, 'tokens')),
    ratio: toTokenAuditNumber(readField(raw, 'ratio')),
    expandable: readField(raw, 'expandable') === true,
  };
};

/** 归出「其他消息」（请求开销）小节。 */
const normalizeRequestOverhead = (raw: unknown): TokenAuditRequestOverhead | null => {
  if (!isRecord(raw)) return null;
  return {
    itemCount: toTokenAuditNumber(readField(raw, 'itemCount')),
    toolDefinition: normalizeAmount(readField(raw, 'toolDefinition')),
    mcpToolDefinition: normalizeAmount(readField(raw, 'mcpToolDefinition')),
  };
};

/** 模块级单例：sessionId → 最新推送。整体替换 Map 以触发 Vue 响应式更新。 */
const entries = ref<Map<string, TokenAuditStreamEntry>>(new Map());

/**
 * 把 sessionId 归一成 Map 键：字符串、去空白；空值返回 null。
 *
 * @param sessionId 任意形态的会话 ID
 * @returns 非空字符串键，或 null
 */
const toKey = (sessionId: number | string | null | undefined): string | null => {
  if (sessionId === null || sessionId === undefined) return null;
  const key = String(sessionId).trim();
  return key === '' ? null : key;
};

/**
 * **唯一解析入口**：GET 的 `data` 与 SSE 推送的事件体都走这里，输出渲染层唯一消费的形状
 * （{@link SessionTokenAuditSnapshot}，数值字段一律 `number | null`）。
 *
 * <p>职责只有三件，且都是「形状归一」，不做任何业务判断：</p>
 * <ol>
 *   <li>非对象直接判废（返回 null），避免 `undefined.xxx` 把面板打崩；</li>
 *   <li>确定会话归属：**以事件体自带的 `sessionId` 为准**，缺失时回退调用方给的兜底 id；
 *       两者都没有则判废 —— 归属不明的快照宁可丢弃，也不能挂到别的会话上；</li>
 *   <li>把 SSE 帧里由传输层补齐的判别式 `type` 剔除；`displayState` 非法/缺失时按 `NOT_COLLECTED` 兜底；
 *       所有数值语义字段按 {@link toTokenAuditNumber} 统一收敛（字符串数字 → 数值，非数字 → null）。</li>
 * </ol>
 *
 * <p>⚠️ 缺失的数值字段**不做补零**：`null` 表示「不知道」，补 0 会画出误导性的构成图。</p>
 * <p>⚠️ `sessionId` 保持字符串：雪花 ID 超出 JS 安全整数范围，转数值会静默改 ID。</p>
 *
 * @param raw 原始 payload（未知形状）
 * @param fallbackSessionId 事件不带归属时的兜底会话 ID（通常是当前根会话）
 * @returns 归一化后的快照；无法归属或形状非法时返回 null
 */
export function normalizeTokenAuditSnapshot(
  raw: unknown,
  fallbackSessionId?: number | string | null
): SessionTokenAuditSnapshot | null {
  if (!isRecord(raw)) return null;
  const sessionId = toKey(readField(raw, 'sessionId') as number | string | null | undefined)
    ?? toKey(fallbackSessionId);
  if (sessionId === null) return null;
  const rawState = readField(raw, 'displayState');
  const displayState = typeof rawState === 'string'
    && (KNOWN_DISPLAY_STATES as readonly string[]).includes(rawState.trim())
    ? (rawState.trim() as TokenAuditDisplayState)
    : 'NOT_COLLECTED';
  const rawMessages = readField(raw, 'messages');
  const failReason = readField(raw, 'failReason');
  const capturedAtRaw = readField(raw, 'capturedAt');
  const capturedAt = typeof capturedAtRaw === 'string'
    ? capturedAtRaw
    : (typeof capturedAtRaw === 'number' && Number.isFinite(capturedAtRaw) ? capturedAtRaw : null);
  return {
    sessionId,
    displayState,
    liveTotalTokens: toTokenAuditNumber(readField(raw, 'liveTotalTokens')),
    liveMaxTokens: toTokenAuditNumber(readField(raw, 'liveMaxTokens')),
    liveRatio: toTokenAuditNumber(readField(raw, 'liveRatio')),
    remainingTokens: toTokenAuditNumber(readField(raw, 'remainingTokens')),
    remainingRatio: toTokenAuditNumber(readField(raw, 'remainingRatio')),
    totalTokens: toTokenAuditNumber(readField(raw, 'totalTokens')),
    driftTokens: toTokenAuditNumber(readField(raw, 'driftTokens')),
    capturedAt,
    failReason: typeof failReason === 'string' && failReason.trim() !== '' ? failReason : null,
    messages: Array.isArray(rawMessages)
      ? rawMessages.map(normalizeCategory).filter((item): item is TokenAuditCategory => item !== null)
      : null,
    tools: normalizeToolBreakdown(readField(raw, 'tools')),
    requestOverhead: normalizeRequestOverhead(readField(raw, 'requestOverhead')),
  };
}

/**
 * 记录一条推送快照（归一化 + 入库）。
 *
 * @param raw 原始 payload
 * @param fallbackSessionId 事件不带归属时的兜底会话 ID
 * @param receivedAt 到达时刻，默认取当前时间（可注入以便测试）
 * @returns 已入库的快照；无法归一化时返回 null（不覆盖既有记录）
 */
export function recordTokenAuditSnapshot(
  raw: unknown,
  fallbackSessionId?: number | string | null,
  receivedAt: number = Date.now()
): SessionTokenAuditSnapshot | null {
  const snapshot = normalizeTokenAuditSnapshot(raw, fallbackSessionId);
  if (!snapshot) return null;
  const next = new Map(entries.value);
  next.set(snapshot.sessionId, {snapshot, receivedAt});
  entries.value = next;
  return snapshot;
}

/**
 * 读取某会话的最新推送记录。
 *
 * @param sessionId 会话 ID（一般是根会话）
 * @returns 记录；从未推送过返回 null
 */
export function getTokenAuditStreamEntry(
  sessionId: number | string | null | undefined
): TokenAuditStreamEntry | null {
  const key = toKey(sessionId);
  if (key === null) return null;
  return entries.value.get(key) ?? null;
}

/**
 * 丢弃某会话的推送记录，让成功返回的接口快照成为展示源。
 *
 * @param sessionId 会话 ID
 * @returns 原本是否存在记录
 */
export function clearTokenAuditStreamEntry(sessionId: number | string | null | undefined): boolean {
  const key = toKey(sessionId);
  if (key === null || !entries.value.has(key)) return false;
  const next = new Map(entries.value);
  next.delete(key);
  entries.value = next;
  return true;
}

/** 清空全部推送记录（测试与「彻底重置」用）。 */
export function resetTokenAuditStream(): void {
  entries.value = new Map();
}

/**
 * 展示源选择规则：**推送优先，无推送回退 GET**。
 *
 * <p>面板收到接口结果后清除旧推送，请求期间收到的新推送仍然优先。</p>
 *
 * @param stream 该会话的推送记录
 * @param fetched 最近一次接口结果（已归一）
 * @returns 应当渲染的快照；两者都没有返回 null
 */
export function resolveDisplayedSnapshot(
  stream: TokenAuditStreamEntry | null | undefined,
  fetched: SessionTokenAuditSnapshot | null | undefined
): SessionTokenAuditSnapshot | null {
  return stream?.snapshot ?? fetched ?? null;
}
