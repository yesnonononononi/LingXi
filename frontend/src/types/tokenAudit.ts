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
 *   <li>所有分项计数与百分比一律取框架给出的字段，前端不做除法/减法；
 *       仅允许把 ratio 乘 100 转成百分数文本、以及直接用 ratio 当进度条宽度。</li>
 * </ol>
 *
 * <p><b>两族类型，别混用</b>：</p>
 * <ul>
 *   <li>带 {@code VO} 后缀的一族是<b>原始载荷</b>（{@link SessionTokenAuditVO} 等）。它们的数值字段声明为
 *       {@link TokenAuditNumeric}，因为项目全局 Jackson 配置会把 {@code Long} 序列化成<b>字符串</b>
 *       （`{"liveTotalTokens": "148200"}`），而 `sessionId` 这类雪花 ID 永远只能是字符串。这是线上真实契约。</li>
 *   <li>不带 {@code VO} 后缀的一族是<b>已归一</b>类型（{@link SessionTokenAuditSnapshot} 等）。数值字段一律
 *       `number | null`，只由 {@code normalizeTokenAuditSnapshot} 产出，是渲染层唯一该消费的形状。</li>
 * </ul>
 * <p>两族之间的唯一通道是 `views/chat/tokenAuditStream.ts` 的 `normalizeTokenAuditSnapshot`：
 * 渲染层若直接吃原始载荷，就会重演「字符串被当成未知 → 整行消失」的事故。</p>
 */

/**
 * 数值语义字段在**原始载荷**里的形态。
 *
 * <p>`number`（Jackson 未特殊处理）与纯数字字符串（`Long`/`BigDecimal` 被序列化成字符串）都合法；
 * `null`/`undefined` 表示后端没给值。归一化时纯数字串转数值，其余一律收敛为 `null`（未知，不猜 0）。</p>
 */
export type TokenAuditNumeric = number | string | null | undefined;

/** `CAPTURING` 表示已采集快照与当前上下文总量有差额。 */
export type TokenAuditDisplayState = 'NOT_COLLECTED' | 'CAPTURING' | 'COLLECTED' | 'FAILED';

/** 消息分项类型：系统 / 用户 / 模型 / 工具返回。 */
export type TokenAuditCategoryType = 'SYSTEM' | 'USER' | 'ATTACHMENT' | 'AI' | 'TOOL';

/** 工具来源分组：普通工具 / MCP / Skill。 */
export type TokenAuditToolGroupKind = 'MCP' | 'SKILL' | 'ORDINARY';

/** 「token 数 + 占比」的最小取值对（工具定义小节等复用）。**原始载荷**，数值可能是字符串。 */
export interface TokenAuditAmountVO {
  /** 该组占用的 token 数。`Long` 可能被序列化成字符串，归一化时统一收敛。 */
  tokens?: TokenAuditNumeric;
  /** 占比（0..1），后端已按所属口径算好；缺失表示「不知道」。 */
  ratio?: TokenAuditNumeric;
}

/** 单个工具的 token 占用。 */
export interface TokenAuditToolItemVO {
  tokens?: TokenAuditNumeric;
  /** 工具机器名（如 `search_web`），原样展示，不做展示名映射。 */
  toolName: string;
  /** 入参 token，只读说明字段，不参与任何求和。 */
  argumentTokens?: TokenAuditNumeric;
  /** 出参 token，只读说明字段，不参与任何求和。 */
  outputTokens?: TokenAuditNumeric;
}

/** 工具来源分组（普通工具 / MCP / Skill）。 */
export interface TokenAuditToolGroupVO extends TokenAuditAmountVO {
  /** 分组种类，决定展示文案。 */
  groupKind: TokenAuditToolGroupKind;
}

/** 工具返回消息（TOOL 分项）的二级构成。 */
export interface TokenAuditToolBreakdownVO extends TokenAuditAmountVO {
  /** MCP 工具分组；`null`/`undefined` 表示不存在该来源，不渲染。 */
  mcp?: TokenAuditToolGroupVO | null;
  /** Skill 工具分组；`null`/`undefined` 表示不存在该来源，不渲染。 */
  skill?: TokenAuditToolGroupVO | null;
  /** 普通工具分组；`null`/`undefined` 表示不存在该来源，不渲染。 */
  ordinary?: {items?: TokenAuditToolItemVO[] | null} | null;
}

/** 消息构成里的单个分项（仅包含框架成功给出的 SYSTEM / USER / ATTACHMENT / AI / TOOL）。 */
export interface TokenAuditCategoryVO extends TokenAuditAmountVO {
  /** 分项类型。 */
  type: TokenAuditCategoryType;
  /** 是否可展开（仅 TOOL 分项为 true）。 */
  expandable: boolean;
}

/** 「其他消息」（请求开销）小节。 */
export interface TokenAuditRequestOverheadVO {
  /** 项数，即「其他消息 N 项」里的 N。**必须取此字段，不得用数组长度替代**。 */
  itemCount?: TokenAuditNumeric;
  /** 内核工具定义占用。 */
  toolDefinition?: TokenAuditAmountVO | null;
  /** MCP 工具定义占用。 */
  mcpToolDefinition?: TokenAuditAmountVO | null;
}

/** 会话用量审计聚合视图对象。**原始载荷**：数值字段可能是字符串。 */
export interface SessionTokenAuditVO {
  /** 会话 ID（雪花 ID，按字符串透传，禁止 Number() 强转）。 */
  sessionId: string;
  /** 采集状态，驱动整块渲染分支。 */
  displayState: TokenAuditDisplayState;
  /** 当前上下文实时总量。 */
  liveTotalTokens?: TokenAuditNumeric;
  /** 当前上下文上限。 */
  liveMaxTokens?: TokenAuditNumeric;
  /** 实时占用比（0..1，后端已算好，前端不得重算）。 */
  liveRatio?: TokenAuditNumeric;
  /** 剩余可用 token。 */
  remainingTokens?: TokenAuditNumeric;
  /** 剩余占比（0..1）。 */
  remainingRatio?: TokenAuditNumeric;
  /** 快照总量。 */
  totalTokens?: TokenAuditNumeric;
  /** 快照与实时的差额。 */
  driftTokens?: TokenAuditNumeric;
  /** 采集时刻（ISO 8601，可能是字符串也可能是 epoch 数值）。 */
  capturedAt?: string | number | null;
  /** 采集失败原因（仅 `FAILED` 态有值）。 */
  failReason?: string | null;
  /** 框架成功给出的消息分项。 */
  messages?: TokenAuditCategoryVO[] | null;
  /** 工具返回消息的二级构成。 */
  tools?: TokenAuditToolBreakdownVO | null;
  /** 其他消息（请求开销）。 */
  requestOverhead?: TokenAuditRequestOverheadVO | null;
}

/* ------------------------------------------------------------------ */
/* 已归一类型：只由 normalizeTokenAuditSnapshot 产出，渲染层唯一消费形状  */
/* ------------------------------------------------------------------ */

/**
 * 「token 数 + 占比」的**已归一**形态：数值字段一律 `number | null`。
 *
 * <p>注意 `tokens` 允许为 `null`（后端没给）而对象本身仍保留 —— 行是否渲染由渲染层的
 * `isRenderableAmount` 判断。这样「分组存在但 token 未知」不会被误当成「分组不存在」，
 * `itemCount` 之类的兄弟字段也不会跟着丢失。</p>
 */
export interface TokenAuditAmount {
  /** 该组占用的 token 数；`null` = 不知道（不是 0）。 */
  tokens: number | null;
  /** 占比（0..1）；`null` = 不知道。 */
  ratio: number | null;
}

/** 单个工具的 token 占用（已归一）。 */
export interface TokenAuditToolItem {
  tokens: number | null;
  /** 工具机器名。 */
  toolName: string;
  /** 入参 token；`null` = 不知道。 */
  argumentTokens: number | null;
  /** 出参 token；`null` = 不知道。 */
  outputTokens: number | null;
}

/** 工具来源分组（已归一）。 */
export interface TokenAuditToolGroup extends TokenAuditAmount {
  /** 分组种类。 */
  groupKind: TokenAuditToolGroupKind;
}

/** 工具返回消息的二级构成（已归一）。 */
export interface TokenAuditToolBreakdown extends TokenAuditAmount {
  /** MCP 分组；`null` = 该来源不存在。 */
  mcp: TokenAuditToolGroup | null;
  /** Skill 分组；`null` = 该来源不存在。 */
  skill: TokenAuditToolGroup | null;
  /** 普通工具分组；`null` = 该来源不存在。 */
  ordinary: {items: TokenAuditToolItem[] | null} | null;
}

/** 消息构成里的单个分项（已归一）。 */
export interface TokenAuditCategory extends TokenAuditAmount {
  /** 分项类型。 */
  type: TokenAuditCategoryType;
  /** 是否可展开（仅 TOOL 分项为 true）。 */
  expandable: boolean;
}

/** 「其他消息」（请求开销）小节（已归一）。 */
export interface TokenAuditRequestOverhead {
  /** 「其他消息 N 项」里的 N（取后端字段，不用数组长度替代）。 */
  itemCount: number | null;
  /** 内核工具定义占用。 */
  toolDefinition: TokenAuditAmount | null;
  /** MCP 工具定义占用。 */
  mcpToolDefinition: TokenAuditAmount | null;
}

/**
 * 会话用量审计聚合视图对象（**已归一**）。
 *
 * <p>渲染层只认这个类型：所有数值字段都是 `number | null`，`sessionId` 永远是字符串
 * （雪花 ID 不得转数值）。它只能由 `normalizeTokenAuditSnapshot` 产出。</p>
 */
export interface SessionTokenAuditSnapshot {
  /** 会话 ID（字符串，雪花精度安全）。 */
  sessionId: string;
  /** 采集状态。 */
  displayState: TokenAuditDisplayState;
  /** 当前上下文实时总量。 */
  liveTotalTokens: number | null;
  /** 当前上下文上限。 */
  liveMaxTokens: number | null;
  /** 实时占用比（0..1）。 */
  liveRatio: number | null;
  /** 剩余可用 token。 */
  remainingTokens: number | null;
  /** 剩余占比（0..1）。 */
  remainingRatio: number | null;
  /** 快照总量。 */
  totalTokens: number | null;
  /** 快照与实时的差额。 */
  driftTokens: number | null;
  /** 采集时刻（ISO 字符串或 epoch 数值，原样保留，由展示层解析）。 */
  capturedAt: string | number | null;
  /** 采集失败原因。 */
  failReason: string | null;
  /** 消息构成分项。 */
  messages: TokenAuditCategory[] | null;
  /** 工具返回消息的二级构成。 */
  tools: TokenAuditToolBreakdown | null;
  /** 其他消息（请求开销）。 */
  requestOverhead: TokenAuditRequestOverhead | null;
}
