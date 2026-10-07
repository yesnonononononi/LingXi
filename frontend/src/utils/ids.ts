/**
 * 会话 ID 的临时态与持久态约定。
 *
 * 收敛原因：前端用 `temp-<时间戳>` 表示"尚未入库"的会话，
 * 此前 `startsWith('temp-')` 与"纯数字即真实 ID"的判断散落在 4 处以上，
 * 字符串协议暴露在业务代码里，一旦命名变化就会静默失效。
 */

const TEMP_SESSION_PREFIX = 'temp-';

/** 创建一个本地临时会话 ID（尚未在后端落库） */
export function createTempSessionId(): string {
  // 复用 createLocalId 的自增种子，避免同一毫秒内创建多个会话时 ID 碰撞；
  // 结果形如 `temp-<时间戳>-<序号>`，仍以 TEMP_SESSION_PREFIX 开头（isTempSessionId 依赖该前缀）。
  return createLocalId(TEMP_SESSION_PREFIX.replace(/-$/, ''));
}

/** 是否为本地临时会话 ID（未入库） */
export function isTempSessionId(id?: string | number | null): boolean {
  if (id === null || id === undefined) return false;
  return String(id).startsWith(TEMP_SESSION_PREFIX);
}

/**
 * 是否为后端已落库的会话 ID。
 *
 * 契约来源：docs/frontend-backend-contract.md §1。
 * 会话 ID **恒为雪花数字字符串**：`SessionVO.id` 标注 `@JsonSerialize(using = ToStringSerializer.class)`，
 * 且 `AgentEventListener` 注释「必须以字符串写入 —— 雪花 ID 以 JSON 数字下发到前端后，JS 解析即丢失精度，
 * 会话会被绑定到一个不存在的 ID 上」。故「已落库」判定为纯数字字符串 `/^\d+$/`，临时会话用 `temp-` 前缀。
 * ⚠️ 后端若改为 UUID，需同步更新本契约与判定。
 */
export function isPersistedSessionId(id?: string | number | null): boolean {
  if (id === null || id === undefined) return false;
  const text = String(id).trim();
  return /^\d+$/.test(text) && text !== '0';
}

/** 传给后端的会话 ID：临时会话或无效 ID 要传 null 以触发后端自动初始化 */
export function toServerSessionId(id?: string | number | null): string | number | null {
  if (id === null || id === undefined) return null;
  const text = String(id).trim();
  if (isTempSessionId(text) || text === '0' || text === '') return null;
  return isPersistedSessionId(text) ? id : null;
}

/** 生成稳定的本地唯一 ID（用于消息、工具调用等纯前端实体） */
let idSeed = 0;
export function createLocalId(prefix: string): string {
  idSeed += 1;
  return `${prefix}-${Date.now()}-${idSeed}`;
}
