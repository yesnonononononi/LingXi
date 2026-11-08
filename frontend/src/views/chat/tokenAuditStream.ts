import {ref} from 'vue';
import type {SessionTokenAuditVO, TokenAuditDisplayState} from '../../types/tokenAudit';

/**
 * 用量审计快照的实时存储（纯响应式，无 DOM、无副作用外部依赖）。
 *
 * <p><b>为什么需要它</b>：面板的数据有两个来源 —— 打开时的 `GET /session/{id}/token-audit`
 * 与会话级流上的 `token_audit_snapshot` 推送。两者 payload **完全同构**，所以这里既做「最新推送的
 * 落点」，也做「两条来源的统一解析入口」（{@link normalizeTokenAuditSnapshot}），
 * 面板因此只有一份解析与渲染逻辑。</p>
 *
 * <p><b>键</b>：一律按字符串 sessionId 存储 —— 雪花 ID 超出 JS 安全整数范围，数值键会撞精度。
 * 后端按<b>根会话</b>推送（看子会话时该帧也落根会话的流），所以键就是根会话 id。</p>
 *
 * <p><b>语义边界</b>：本模块只回答「这个会话最新收到的快照是什么」。它不判断新鲜度、
 * 不做合并、更不替 GET 兜底 —— 谁新谁旧由调用方用 {@link resolveDisplayedSnapshot} 的规则决定。</p>
 */

/** 一条推送记录：最新快照 + 到达时刻（毫秒时间戳）。 */
export interface TokenAuditStreamEntry {
  /** 已归一化的快照，与 GET 的 `data` 同构。 */
  snapshot: SessionTokenAuditVO;
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
 * 统一解析入口：GET 的 `data` 与 SSE 推送的事件体都走这里。
 *
 * <p>职责只有三件，且都是「形状归一」，不做任何业务判断：</p>
 * <ol>
 *   <li>非对象直接判废（返回 null），避免 `undefined.xxx` 把面板打崩；</li>
 *   <li>确定会话归属：**以事件体自带的 `sessionId` 为准**，缺失时回退调用方给的兜底 id；
 *       两者都没有则判废 —— 归属不明的快照宁可丢弃，也不能挂到别的会话上；</li>
 *   <li>把 SSE 帧里由传输层补齐的判别式 `type` 剔除，让两条来源形状完全一致；
 *       `displayState` 非法/缺失时按 `NOT_COLLECTED` 兜底。</li>
 * </ol>
 *
 * <p>⚠️ 缺失的数值字段**不做补零**：`null` 表示「不知道」，补 0 会画出误导性的构成图。</p>
 *
 * @param raw 原始 payload（未知形状）
 * @param fallbackSessionId 事件不带归属时的兜底会话 ID（通常是当前根会话）
 * @returns 归一化后的快照；无法归属或形状非法时返回 null
 */
export function normalizeTokenAuditSnapshot(
  raw: unknown,
  fallbackSessionId?: number | string | null
): SessionTokenAuditVO | null {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const sessionId = toKey(candidate.sessionId as number | string | null | undefined) ?? toKey(fallbackSessionId);
  if (sessionId === null) return null;
  const copy: Record<string, unknown> = {...candidate};
  // SSE 帧的事件体被传输层补了判别式 `type`；GET 的 data 没有。统一剔除。
  delete copy.type;
  const rawState = typeof copy.displayState === 'string' ? copy.displayState.trim() : '';
  const displayState = (KNOWN_DISPLAY_STATES as readonly string[]).includes(rawState)
    ? (rawState as TokenAuditDisplayState)
    : 'NOT_COLLECTED';
  // 解析边界的一次断言：上游是任意外部输入，字段级校验交给下游纯函数（缺字段即整行不渲染）。
  return {...copy, sessionId, displayState} as unknown as SessionTokenAuditVO;
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
): SessionTokenAuditVO | null {
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
 * 丢弃某会话的推送记录（手动刷新时用：让「立即重取」的 GET 结果成为展示源）。
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
 * <p>手动刷新会先丢弃推送记录再 GET，因此「刚重取的数据」不会被旧推送立刻盖掉；
 * 下一次推送到达后再接管（这正是实时面板想要的语义）。</p>
 *
 * @param stream 该会话的推送记录
 * @param fetched 最近一次 GET 的结果
 * @returns 应当渲染的快照；两者都没有返回 null
 */
export function resolveDisplayedSnapshot(
  stream: TokenAuditStreamEntry | null | undefined,
  fetched: SessionTokenAuditVO | null | undefined
): SessionTokenAuditVO | null {
  return stream?.snapshot ?? fetched ?? null;
}
