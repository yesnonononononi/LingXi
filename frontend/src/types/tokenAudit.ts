/**
 * 「用量审计」面板的后端契约类型。
 *
 * <p>契约来源：`GET /session/{id}/token-audit` → `Result&lt;SessionTokenAuditVO&gt;`。
 * 字段命名、层级、可空性与后端 VO 一一对应，前端<b>不得</b>自行增删或改名。</p>
 *
 * <p>三条渲染铁律（类型层面同样要守）：</p>
 * <ol>
 *   <li>`null` / `undefined` 表示「不知道」，**不等于 0**。字段缺失时整行不渲染。</li>
 *   <li>调用次数（`callCount`）**已从契约移除，后端不再下发**：前端不得声明、读取或渲染它。
 *       需要「N 项」时取明细数组长度，需要「N 类」时取存在的分组个数。</li>
 *   <li>所有数值与百分比一律取后端算好的字段，前端不做除法/减法；
 *       仅允许把 ratio 乘 100 转成百分数文本、以及直接用 ratio 当进度条宽度。</li>
 * </ol>
 */

/** 快照采集状态。决定面板渲染哪一档内容。 */
export type TokenAuditDisplayState = 'NOT_COLLECTED' | 'CAPTURING' | 'COLLECTED' | 'FAILED';

/** 消息分项类型：系统 / 用户 / 模型 / 工具返回。 */
export type TokenAuditCategoryType = 'SYSTEM' | 'USER' | 'AI' | 'TOOL';

/** 工具来源分组：普通工具 / MCP / Skill。 */
export type TokenAuditToolGroupKind = 'MCP' | 'SKILL' | 'ORDINARY';

/** 「token 数 + 占比」的最小取值对（工具定义小节等复用）。 */
export interface TokenAuditAmountVO {
  /** 该组占用的 token 数。 */
  tokens: number;
  /** 占比（0..1），后端已按所属口径算好；缺失表示「不知道」。 */
  ratio?: number | null;
}

/** 单个工具的 token 占用。 */
export interface TokenAuditToolItemVO extends TokenAuditAmountVO {
  /** 工具机器名（如 `search_web`），原样展示，不做展示名映射。 */
  toolName: string;
  /** 入参 token，只读说明字段，不参与任何求和。 */
  argumentTokens?: number | null;
  /** 出参 token，只读说明字段，不参与任何求和。 */
  outputTokens?: number | null;
}

/** 工具来源分组（普通工具 / MCP / Skill）。 */
export interface TokenAuditToolGroupVO extends TokenAuditAmountVO {
  /** 分组种类，决定「N 项」以外的展示文案。 */
  groupKind: TokenAuditToolGroupKind;
  /** 组内工具明细；缺失或空数组表示没有明细可展开。 */
  items?: TokenAuditToolItemVO[] | null;
}

/** 工具返回消息（TOOL 分项）的二级构成。 */
export interface TokenAuditToolBreakdownVO extends TokenAuditAmountVO {
  /** MCP 工具分组；`null`/`undefined` 表示不存在该来源，不渲染。 */
  mcp?: TokenAuditToolGroupVO | null;
  /** Skill 工具分组；`null`/`undefined` 表示不存在该来源，不渲染。 */
  skill?: TokenAuditToolGroupVO | null;
  /** 普通工具分组；`null`/`undefined` 表示不存在该来源，不渲染。 */
  ordinary?: TokenAuditToolGroupVO | null;
}

/** 消息构成里的单个分项（后端恒返回 4 条：SYSTEM / USER / AI / TOOL）。 */
export interface TokenAuditCategoryVO extends TokenAuditAmountVO {
  /** 分项类型。 */
  type: TokenAuditCategoryType;
  /** 是否可展开（仅 TOOL 分项为 true）。 */
  expandable: boolean;
}

/** 「其他消息」（请求开销）小节。 */
export interface TokenAuditRequestOverheadVO extends TokenAuditAmountVO {
  /** 项数，即「其他消息 N 项」里的 N。**必须取此字段，不得用数组长度替代**。 */
  itemCount: number;
  /** 内核工具定义占用。 */
  toolDefinition?: TokenAuditAmountVO | null;
  /** MCP 工具定义占用。 */
  mcpToolDefinition?: TokenAuditAmountVO | null;
  /** 请求框架残差（不单独成行，仅备查）。 */
  framingResidualTokens?: number | null;
}

/**
 * 对账信息（后端 `TokenAuditReconciliationVO`）。
 *
 * <p>面板不渲染这些字段（设计稿没有对应行），仅作契约登记，保留索引签名以便后端演进时前端不炸。</p>
 */
export interface TokenAuditReconciliationVO {
  /** 快照总量（框架口径）。 */
  totalTokens?: number | null;
  /** 四类消息之和。 */
  messagesTokens?: number | null;
  /** 其他消息（请求开销）总量。 */
  requestOverheadTokens?: number | null;
  /** 工具入参被消息体重复计入的部分。 */
  argumentOverlapTokens?: number | null;
  /** 工具分组对账残差。 */
  toolGroupingDrift?: number | null;
  /** 内核工具定义总量。 */
  toolDefinitionTokens?: number | null;
  /** MCP 工具定义总量。 */
  mcpToolDefinitionTokens?: number | null;
  /** 请求框架残差。 */
  framingResidualTokens?: number | null;
  /** 后端后续新增字段的逃生舱。 */
  [key: string]: unknown;
}

/** 会话用量审计聚合视图对象。 */
export interface SessionTokenAuditVO {
  /** 会话 ID（雪花 ID，按字符串透传，禁止 Number() 强转）。 */
  sessionId: string;
  /** 采集状态，驱动整块渲染分支。 */
  displayState: TokenAuditDisplayState;
  /** 当前上下文实时总量。 */
  liveTotalTokens?: number | null;
  /** 当前上下文上限。 */
  liveMaxTokens?: number | null;
  /** 实时占用比（0..1，后端已算好，前端不得重算）。 */
  liveRatio?: number | null;
  /** 剩余可用 token。 */
  remainingTokens?: number | null;
  /** 剩余占比（0..1）。 */
  remainingRatio?: number | null;
  /** 快照总量。 */
  totalTokens?: number | null;
  /** 快照与实时的差额。 */
  driftTokens?: number | null;
  /** 采集时刻（ISO 8601，可能是字符串也可能是 epoch 数值）。 */
  capturedAt?: string | number | null;
  /** 采集失败原因（仅 `FAILED` 态有值）。 */
  failReason?: string | null;
  /** 消息构成分项，后端恒返回 4 条。 */
  messages?: TokenAuditCategoryVO[] | null;
  /** 消息构成总量（各分项之和，后端算好）。 */
  messagesTotalTokens?: number | null;
  /** 工具返回消息的二级构成。 */
  tools?: TokenAuditToolBreakdownVO | null;
  /** 其他消息（请求开销）。 */
  requestOverhead?: TokenAuditRequestOverheadVO | null;
  /** 对账信息。 */
  reconciliation?: TokenAuditReconciliationVO | null;
}
