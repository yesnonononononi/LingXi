/** 消息角色定义 */
export type MessageRole = 'user' | 'assistant' | 'system';

/** 对话执行模式 - plan: 先规划再执行 - auto: 自动选择最优策略 */
export type ChatMode = 'plan' | 'auto';

/** 思维链步骤接口 (体现后端 CoT / 思维链亮点) */
export interface ThoughtStep {
  id: string;
  title: string;          // 步骤名称，如 "检索知识库", "Thought for"
  content: string;        // 步骤详细思考内容
  status: 'running' | 'success' | 'failed';
  durationMs?: number;    // 后端执行耗时
  order?: number;         // 执行时间线顺序
  timestamp?: number;
}

/** Agent 工具调用日志 (体现后端 Tool Calling / Function Calling 亮点) */
export interface ToolCallTrace {
  id: string;
  toolName: string;          // 工具名称，如 "pwsh", "web_search", "read_file"
  query?: string;            // 调用输入参数
  args?: any;                // 结构化输入参数对象
  result?: string;           // 工具返回的原始数据或状态
  /**
   * 执行状态。`calling` 为本地「已请求、等待结果」态；其余来自
   * `utils/toolMeta.ts#resolveToolExecutionStatus` 的四态映射（success/failed/pending/unknown）。
   * `pending` 表示挂起待人工决策，`unknown` 表示状态未知 —— 二者**不得**显示为成功或失败。
   */
  status: 'calling' | 'success' | 'failed' | 'pending' | 'unknown';
  description?: string;      // 描述或操作意图，如 "List top-level files in workspace"
  target?: string;           // 目标文件或参数，如 "README.md"
  command?: string;          // 终端命令详情
  workDir?: string;          // 工作空间或目录名
  category?: string;         // 分类：Pwsh / 读取 / 写入 / 思考 / 子代理
  subAgentId?: string | number;   // 子代理 ID
  subAgentName?: string;         // 子代理名称，如 "数学专家 (MathSpecialist)"
  subSessionId?: string | number;// 关联的子会话 ID
  subTask?: string;              // 委派的具体任务描述
  subPrompt?: string;            // Commander 提供的补充提示词
  plusLines?: number;            // 文件变更添加行数 (+N)
  minusLines?: number;           // 文件变更删除行数 (-N)
  order?: number;                // 执行时间线顺序
  timestamp?: number;
}

/** 计划检查点 (对应后端 SsePlanEventPublisher.TaskSnapshot；批准后由 create_task_manifest 铺开) */
export interface PlanTaskItem {
  id?: string;
  title?: string;
  /** 后端 TaskStatus：TODO / DOING / BLOCKED / DONE */
  status?: 'TODO' | 'DOING' | 'BLOCKED' | 'DONE' | string;
  /** 后端已下发的中文状态文案 */
  statusLabel?: string;
  description?: string;
  dependencies?: string[];
  priority?: number | null;
  acceptance?: string;
}

/**
 * 统一互动卡片数据（由聚合 ToolCallVO 派生）。
 *
 * <p>重构后前端**唯一**卡片形态：历史（消息分页 TOOL 行的 `toolCall`）与实时
 * （收到 CARD_PENDING 后拉取 `GET /tool-call/{toolCallId}`）两条路径产出**同一形状**。</p>
 *
 * <p>渲染分派依据 `kind`（= `toolCall.content.kind`，唯一判别字段）；是否可审批依据
 * `pending`（后端**权威下发**的 `ToolCallVO.pending`，等价于 `type==='PROMISE' && status==='pending'`，
 * 前端**直接读该字段**、禁止自行用 `status` 推断）；
 * 结论/异常一律读 `outcome`（= `toolCall.rawOutput.outcome`），禁止字符串嗅探
 * （旧 `[rejected]` 前缀已消亡）；缺失 = 状态未知，**禁止默认成功**。</p>
 */
export interface PromptCardData {
  /**
   * 卡片形态：`PLAN` / `CHOICE` / `COMMAND`（= `toolCall.content.kind`）。
   * `UNAVAILABLE` 表示 `content.kind` 缺失/非法（后端 `fromName()` 识别不了返回 `null`）——
   * 渲染为「状态不可用」，**绝不**回落成 `COMMAND`（否则语义未知的卡片会被渲染成带「批准并执行」按钮的命令审批卡）。
   */
  kind: 'PLAN' | 'CHOICE' | 'COMMAND' | 'UNAVAILABLE';
  /** 决策锚点：tool_call.id / 模型 call_id */
  toolCallId: string;
  /** 归属会话（= session.id）；提交决策时回传 */
  conversationId?: string;
  /** 卡片标题（PLAN 计划标题 / CHOICE 问题 / COMMAND 命令审批） */
  title: string;
  /** 卡片正文：PLAN 为计划书 Markdown；CHOICE 为问题正文；COMMAND 为命令 */
  content: string;
  /** CHOICE：候选答案；空数组表示只需自由输入 */
  options?: string[];
  /** COMMAND：执行工作目录 / shell 类型 / 原始命令 */
  workDir?: string;
  shell?: string;
  command?: string;
  /** 生命周期：pending / in_progress / completed */
  status: 'pending' | 'in_progress' | 'completed';
  /** ★ 唯一可审批判定（后端权威） */
  pending: boolean;
  /** 结论/异常（raw_output.outcome）：APPROVED/REJECTED/ANSWERED/CANCELLED/SUCCEEDED/FAILED/TIMED_OUT */
  outcome?: string;
  /** 已决断时的用户答复原文 */
  answer?: string;
  /** COMMAND 批准后的命令输出 */
  stdout?: string;
  exitCode?: number;
  /** tool_call 缺行 / content 解析失败时的诚实降级标记 */
  unavailable?: boolean;
  /** PLAN 批准后后端下发的任务清单（可空；仅供任务进度卡展示） */
  tasks?: PlanTaskItem[];
}

/** 轮次 Token 统计信息 (对应后端 ExecutionCompleteEvent.TokenInfo) */
export interface TokenInfo {
  inputTokenCount?: number;
  outputTokenCount?: number;
  totalTokenCount?: number;
}

/** 文件编辑记录 (对应后端 FileEditEvent) */
export interface FileEditRecord {
  turnId?: string;
  recordId?: any;
  filePath: string;
  oldContent?: string;
  newContent?: string;
  plusLines?: number;
  minusLines?: number;
}

/** 上下文窗口用量及压缩指标 (对应后端 ContextUpdateEvent) */
export interface ContextUsageData {
  phase?: 'UPDATE' | 'SQUEEZE_STARTED' | 'SQUEEZE_COMPLETED' | string;
  tokenCount?: number;
  maxTokens?: number;
  ratio?: number;
  message?: string;
}

/** 子 Agent 委派建立的会话映射。 */
export interface SubAgentSessionCreatedData {
  rootSessionId: string | number;
  subSessionId: string | number;
  agentId?: string | number;
  agentName?: string;
  task?: string;
  toolCallId?: string;
}

/** 规范的 Agent 运行时事件类型 (对齐后端 com.summit.core.conversation.event.RuntimeEventType) */
export type RuntimeEventType =
  | 'EXECUTION_STARTED'
  | 'EXECUTION_COMPLETED'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_CANCELLED'
  | 'EXECUTION_RESUMED'
  | 'PARTIAL_TEXT'
  | 'COMPLETE_TEXT'
  | 'PARTIAL_THINKING'
  | 'AI_MESSAGE'
  | 'TOOL_CALL'
  | 'TOOL_COMPLETED'
  | 'FILE_EDIT'
  | 'CONTEXT_UPDATE'
  | 'CARD_PENDING'
  | 'PLAN_UPDATE'
  | 'SUB_AGENT_SESSION_CREATED';

/** 结构化 SSE 流事件定义 */
export interface AgentStreamEvent {
  type?: RuntimeEventType | string;
  id?: string | number;
  meta?: {
    id?: string;
    modelName?: string;
    finishReason?: 'STOP' | 'LENGTH' | 'TOOL_EXECUTION' | 'CONTENT_FILTER' | 'OTHER' | string;
  };
  /** 互动快照行 session_message.id */
  sessionMessageId?: string | number;
  /** CARD_PENDING 事件：待处理卡片的 tool_call.id，前端据此拉取 ToolCallVO */
  toolCallId?: string;
  /** CARD_PENDING 事件：卡片形态 PLAN / CHOICE / COMMAND（仅通知用，权威源为 tool_call 行） */
  cardKind?: string;
  title?: string;
  description?: string;
  planText?: string;
  sessionId?: string | number;
  /** 事件权威归属根会话 id（JSON 顶层，sse.ts spread 无损透传；CARD_PENDING 直判归属用，缺失走既有映射兜底） */
  rootSessionId?: string | null;
  agentId?: string;
  executionId?: string;
  requestId?: string;
  content?: string;
  text?: string;
  thinking?: string;
  tokenInfo?: TokenInfo;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  delta?: string;
  message?: string;
  toolName?: string;
  args?: any;
  result?: any;
  output?: any;
  resultStatus?: 'STARTED' | 'COMPLETED' | 'REJECTED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED' | string;
  suspensionId?: string;
  /** 后端错误载荷里的简写字段 */
  err?: string;
  toolExecutionId?: string;
  timeoutSeconds?: number;
  // File edit
  turnId?: string;
  recordId?: any;
  filePath?: string;
  oldContent?: string;
  newContent?: string;
  plusLines?: number;
  minusLines?: number;
  // Context update
  phase?: string;
  usage?: {
    tokenCount?: number;
    maxTokens?: number;
    ratio?: number;
  };
  // Error
  errMsg?: string;
  error?: string;
  extraDes?: string;
  timestamp?: number;
  data?: any;
}

export interface AiMessageItem {
  id?: string;
  text?: string;
  thinking?: string;
  timestamp?: number;
  order?: number;
}

/** 执行时序时间线单项 (按时间线交替排列思考与工具调用) */
export interface ProcessTimelineItem {
  id: string;
  type: 'thought' | 'intermediate_ai' | 'tool' | 'sub_agent';
  order: number;
  step?: ThoughtStep;
  message?: AiMessageItem;
  tool?: ToolCallTrace;
  subAgents?: ToolCallTrace[];
}

/** 单条消息接口 (支持多分支对话) */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;

  /**
   * 产生本条消息的执行 id（字符串；**旧数据为 null = 归属未知**）。
   *
   * <p>回答组以 executionId 为唯一键：同 executionId 的连续消息归为同一组，
   * executionId 变化必须拆组，绝不能跨执行合并；null 的旧数据按 USER 边界降级，
   * 且**不得伪造任何统计**。</p>
   */
  executionId?: string | null;

  // 消息模型标识
  model?: string;
  thoughtSteps?: ThoughtStep[];     // 思维链思考轨迹
  toolCalls?: ToolCallTrace[];       // 工具调用日志
  aiMessages?: AiMessageItem[];      // 运行时收到的所有 AI 轮次消息
  processTimeline?: ProcessTimelineItem[]; // 严格时序混合时间线
  fileEdits?: FileEditRecord[];      // 文件修改记录
  contextUsage?: ContextUsageData;   // 上下文用量与压缩状态
  isCompressingContext?: boolean;    // 是否正在压缩上下文中
  isThinking?: boolean;              // 是否正在思考中
  isExploring?: boolean;             // 是否正在探索中（发送消息到第一个工具调用之间）
  isComplete?: boolean;              // 会话/轮次是否已结束
  durationMs?: number;               // 轮次总耗时毫秒
  /**
   * 统一互动卡片（由 ToolCallVO 派生的同一形状）。
   *
   * <p>历史（TOOL 行 `toolCall`）与实时（CARD_PENDING → `GET /tool-call/{id}`）
   * 两条路径都写入本字段，渲染与决策逻辑因此完全一致。</p>
   */
  promptCard?: PromptCardData;
  promptCards?: PromptCardData[];
  tokens?: number;                   // 消耗 token 数
  tokenInfo?: TokenInfo;             // 真实 token 计数明细
  executionError?: string;           // 执行异常信息
  sendError?: string;                // 发送或流式异常信息
  imageUrl?: string;                 // 用户上传/携带的图片 URL 或 Base64 Data URL
  imageFile?: File;                  // 用户上传的本地文件对象 (用于重发)

  // 对话多分支相关
  branches?: string[];               // 该节点下的替代消息文本列表
  activeBranchIndex?: number;        // 当前激活的分支索引
}

/** 聊天会话接口 */
export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modelId: string | number;          // 绑定的模型配置
  activeTools: string[];             // 开启的工具列表
  messages: ChatMessage[];
  workspaceId?: number | string;     // 关联的工作空间ID
  workDir?: string;                  // 工作目录 (workDir)
  teamId?: string | null;            // 绑定的协作团队 ID（未绑定为 null；后端 JSON 序列化为字符串）
  totalTokens?: number;              // 总 token 数
  inputTokens?: number;              // 输入 token 数
  outputTokens?: number;             // 输出 token 数
  agentId?: number | string;         // 关联的 Agent ID
  rootSessionId?: number | string;   // 关联的根会话 ID
  hasMoreMessages?: boolean;         // 游标分页：是否还有更多消息
  nextMessageCursor?: string | null; // 游标分页：下一页游标
  subSessions?: SubSessionVO[];      // 团队模式下委派产生的子会话列表
  /**
   * 本会话已加载的执行摘要表：键 = executionId 字符串。
   *
   * <p>由消息分页接口每页额外返回的 executions 字典逐页 union 合并（键为 executionId，
   * 后到的覆盖先到的 —— 更新的快照更准确）。缺失或空对象表示本会话暂无执行摘要
   * （旧数据 / 未采集），**不是**「用量为 0」。</p>
   */
  executions?: Record<string, ExecutionSummary>;
}


/**
 * 子会话展示态：由后端 runStatus + lastOutcome 派生，前端不再接收后端生命周期枚举。
 * 唯一定义处；映射函数见 {@link ./utils/subSessionStatus}。
 */
export type SubItemStatus = 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled' | 'idle' | 'unknown';

/** 子会话 = 会话树里除根会话外的节点；沿用旧命名，各展示组件无需改动 */
export interface SubSessionVO extends SessionVO {
  // 前端补充的展示数据，不属于后端会话元数据。
  agentName?: string;
  agentDescription?: string;
  task?: string;
  messages?: ChatMessage[];
}

/** 会话树 (对应后端 SessionTreeVO)：平铺列表 + 真正的根会话 id */
export interface SessionTreeVO {
  rootSessionId: string | number;
  sessions: SessionVO[];
}

/** 模型配置接口 (对齐后端真实模型配置列表) */
export interface ModelConfig {
  id: string | number;
  name: string;
  modelName?: string;
  description?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** 后端 ModelConfigVO 领域实体 */
export interface ModelConfigVO {
  id?: number | string;
  modelName?: string;
  baseUrl?: string;
  /** 前 20% + *** + 后 20% 的只读展示值，不可作为新密钥提交 */
  apiKey?: string;
  /** 密钥是否已配置（三态展示：已配置 / 未配置） */
  credentialConfigured?: boolean;
  /** 模型提供方标识（如 DEEPSEEK / OPENAI / CUSTOM）；后端 ModelConfigVO 已下发该字段 */
  provider?: string;
  /** 请求超时时间；后端为 Duration，序列化形态由后端决定 */
  timeout?: string | number;
  returnThinking?: boolean;
  sendThinking?: boolean;
}

/**
 * 聚合工具调用视图（对应后端 ToolCallVO）—— 卡片唯一权威数据源。
 *
 * <p>`id`/`conversationId`/`sessionMessageId`/`executionId` 均为字符串
 * （后端 JsonConfig 全局 Long→String）；`content`/`rawInput`/`rawOutput`/`metaData`
 * 后端已解析为对象，前端直接用。</p>
 */
export interface ToolCallVO {
  id?: string;
  conversationId?: string;
  sessionMessageId?: string;
  executionId?: string;
  /** 原始工具名（仅展示，不作卡片判别依据） */
  toolName?: string;
  /** 调用类型：PROMISE（人工在环）/ EXECUTE（框架直通） */
  type?: 'PROMISE' | 'EXECUTE' | string;
  /** 生命周期：pending / in_progress / completed */
  status?: 'pending' | 'in_progress' | 'completed' | string;
  /** 卡片标题 */
  title?: string;
  /** 多态内容块：{kind:'PLAN'|'CHOICE'|'COMMAND', ...} */
  content?: any;
  /** 输入载荷：{args, answers?} */
  rawInput?: any;
  /** 输出载荷：{outcome, answer?, stdout?, exitCode?, reason?} */
  rawOutput?: any;
  /** 扩展元数据 _meta */
  metaData?: any;
  /** ★ 唯一可审批判定：type==='PROMISE' && status==='pending' */
  pending?: boolean;
  createdAt?: string | number;
  updatedAt?: string | number;
}

/** 模型请求视图里的工具调用（对应后端 ModelToolCallVO：{id,name,arguments}） */
export interface ModelToolCallVO {
  id?: string;
  name?: string;
  /** 调用参数：JSON 字符串 */
  arguments?: string;
}

/**
 * 一次执行的摘要（对应后端 ExecutionSummaryVO）。
 *
 * <p><b>一次执行 = 一个 executionId</b>：主会话中一次新提问；子会话中一次新委派。
 * 审批后继续、暂停后恢复都**沿用同一个 executionId**，SSE 重新订阅**不创建**新执行。</p>
 *
 * <p><b>null 语义（禁止当作 0）</b>：项目全局把 Long 序列化成字符串（防雪花 ID 精度丢失），
 * 但统计量被后端专门覆盖为真正的 JSON 数字，且**可能为 null**：
 * `inputTokens` / `outputTokens` / `totalTokens` 为 null 表示「未采集到」；
 * `elapsedMs` 为 null 表示 `startedAt` 缺失、无法计算；`completedAt` 为 null 表示执行尚未结束。
 * 展示层遇到 null 一律显示「暂无统计」或隐藏，**绝不能显示成 0**。</p>
 */
export interface ExecutionSummary {
  /** 执行主键（字符串，雪花 ID 全局 Long→String 序列化） */
  executionId: string;
  status: 'CREATED' | 'RUNNING' | 'SUSPENDED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  /** 模型名；可能为 null（未采集）—— 为空时展示层隐藏模型项 */
  modelName?: string | null;
  /** 模型提供方；可能为 null */
  modelProvider?: string | null;
  /** 输入 token；null = 未采集到（≠ 0） */
  inputTokens?: number | null;
  /** 输出 token；null = 未采集到（≠ 0） */
  outputTokens?: number | null;
  /** 总 token；null = 未采集到（≠ 0） */
  totalTokens?: number | null;
  /** 开始时间；可能为 null */
  startedAt?: string | null;
  /** 完成时间；null = 尚未结束 */
  completedAt?: string | null;
  /**
   * 总历时（毫秒），**包含暂停与等待审批的时间**；`startedAt` 为 null 时为 null。
   * 状态为进行中（CREATED/RUNNING/SUSPENDED）时，这是「截至查询时刻」的已历时，不是最终值。
   */
  elapsedMs?: number | null;
}

/** 后端会话消息 VO（对应 SessionMessageVO） */
export interface SessionMessageVO {
  id?: number | string;
  /**
   * 产生本条消息的执行 id（字符串；**旧数据为 null = 归属未知**）。
   * 回答组以此字段为唯一分组键。
   */
  executionId?: string | null;
  /** USER / AI / TOOL / SYSTEM / ERROR（ERROR = 执行失败标注行，text 为纯文本失败文案） */
  type?: string;
  /** USER、SYSTEM、ERROR 正文；AI 回复正文 */
  text?: string;
  /** 结构化思考内容 */
  thinking?: string;
  /** AI 发起的工具调用（模型请求视图） */
  toolCalls?: ModelToolCallVO[];
  /** TOOL：回指的调用 id（call_id），与 AI 消息 toolCalls[].id 同源，用于精确匹配请求与结果 */
  toolCallId?: string;
  /** TOOL：聚合工具调用（含 type/status/title/content/rawInput/rawOutput/metaData/pending）；缺行时为 null */
  toolCall?: ToolCallVO | null;
  createTime?: string | number;
}

/** 游标分页响应 VO（对应 SessionMessagePageVO） */
export interface SessionMessagePageVO {
  records?: SessionMessageVO[];
  /** 本页命中的 tool_call 行数 */
  toolCallCount?: number;
  /**
   * 本页消息涉及的执行摘要字典：键 = executionId 字符串；无执行时是 `{}` 或缺失。
   * 与 records 同页返回，供前端把持久化的 token / 模型 / 耗时 / 状态绑定到回答组。
   */
  executions?: Record<string, ExecutionSummary> | null;
  nextCursor?: string | null;
  hasMore?: boolean;
}

/**
 * 后端会话 VO（对应 SessionVO）。
 * 注意：后端列表接口只返回会话元数据，不含消息正文，
 * 消息一律走 GET /session/{id}/messages 游标分页。
 */
export interface SessionVO {
  id: number | string;
  name?: string;
  agentId?: number | string;
  rootSessionId?: number | string;
  createTime?: string | number;
  updateTime?: string | number;
  /** 仅树查询返回消息条数；缺失表示未查询。 */
  messageCount?: number;
  teamId?: string | null;
  workspaceId?: number | string;
  workDir?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** 展示状态组合（后端唯一来源）：进行中状态 IDLE | RUNNING | SUSPENDED。 */
  runStatus?: 'IDLE' | 'RUNNING' | 'SUSPENDED';
  /** 展示状态组合：最近一次已终结执行结果 COMPLETED | FAILED | CANCELLED；从未终结为 null。 */
  lastOutcome?: 'COMPLETED' | 'FAILED' | 'CANCELLED' | null;
}

/**
 * 工作空间视图对象 (对应后端 WorkspaceVO)。
 *
 * 契约来源：docs/frontend-backend-contract.md §5 —— 后端 `WorkspaceVO` **不含 `type`**
 * （注释：「不含 type / port / image：这三项描述的是『怎么跑』而非『工作空间是什么』」，
 * `20260926_drop_workspace_type.sql` 已删列）。环境类型统一从 `userConfigs[].type` 读取。
 */
export interface WorkspaceVO {
  id?: number | string;
  name?: string;
  workDir?: string;
  hostDir?: string;
  port?: string;
  image?: string;
}

/** 沙箱/本地：用户级配置，不由单个工作空间指定；取值为后端 WorkspaceType 枚举名 */
export type WorkspaceEnvType = 'SAND_BOX' | 'LOCAL' | 'NONE';

/** 会话访问档位：对应后端 UserConfig.AccessMode */
export type AgentAccessMode = 'IN_WORKSPACE' | 'READ_ONLY_IN_WORKSPACE' | 'OUT_OF_WORKSPACE';

/** 命令放行档位：对应后端 UserConfig.CommandPolicy (DANGEROUS_BLOCK | PRE_EXEC_CONFIRM | FULL_ACCESS) */
export type CommandApprovalPolicyType = 'DANGEROUS_BLOCK' | 'PRE_EXEC_CONFIRM' | 'FULL_ACCESS';

/** 通用配置视图对象 (对应后端 UserConfigVO) */
export interface UserConfigVO {
  id?: number | string;
  type?: WorkspaceEnvType | string;
  modelId?: number | string;
  /** 命令放行档位：FULL_ACCESS / PRE_EXEC_CONFIRM / DANGEROUS_BLOCK（空值表示沿用缺省） */
  commandApprovalPolicy?: CommandApprovalPolicyType | string;
  /** 会话访问档位：IN_WORKSPACE / READ_ONLY_IN_WORKSPACE / OUT_OF_WORKSPACE（空值表示沿用缺省） */
  accessMode?: AgentAccessMode | string;
  /** 提醒"还有未完成任务"的次数上限（0-20，缺省 3） */
  planMaxReminders?: number;
  /** 模型最大 Token 数；空值表示沿用模型/框架缺省 */
  maxTokens?: number;
  /** 思考深度/推理等级：low/none/medium/high/xhigh/max；空值表示沿用缺省 */
  reasoningEffort?: string;
}

/** 工作空间请求体 (对应后端 WorkspaceRequest) */
export interface WorkspaceRequest {
  name?: string;
  hostDir: string;
}

/** 后端通用分页结构 (com.summit.ddd.application.vo.PageResult) */
export interface PageResult<T> {
  current: number;
  pageSize: number;
  total: number;
  records: T[];
}

/** 模型配置读写载荷 (对齐后端 ModelConfigRequest) */
export interface ModelConfigPayload {
  id?: number | string;
  modelName: string;
  baseUrl: string;
  /**
   * 三态语义（§6-6）：带值 = 新增/替换密钥；**留空（不传）= 保留已有密钥**。
   * 清除走独立端点 DELETE /settings/model/credential，禁用空串/null 表达清除。
   */
  apiKey?: string;
}

/** OpenAI 单个模型元数据对象 (对齐标准 /models 响应格式) */
export interface OpenAIModelItem {
  id: string;
  object?: 'model' | string;
  created?: number;
  owned_by?: string;
  shutdown_date?: string | null;
  [key: string]: any;
}

/** OpenAI 获取模型列表通用响应结构 (GET /v1/models) */
export interface OpenAIModelListResponse {
  object?: 'list' | string;
  data: OpenAIModelItem[];
}

/** Agent 视图对象 (对应后端 AgentVO) */
export interface AgentVO {
  id: number | string;
  name: string;
  modelId?: number | string;
  toolList?: string[];
  prompt?: string;
  description?: string;
  status?: number;
}

/** Team 视图对象 (对应后端 TeamVO) */
export interface TeamVO {
  id: number | string;
  name: string;
  commanderAgentId?: number | string;
  commanderName?: string;
  description?: string;
  agents?: AgentVO[];
}

/** Team 创建请求 */
export interface CreateTeamRequest {
  name: string;
  commanderAgentId: number | string;
  agentIds: (number | string)[];
  description?: string;
}


/** Team 更新请求 */
export interface UpdateTeamRequest {
  id: number | string;
  name?: string;
  commanderAgentId?: number | string;
  agentIds?: (number | string)[];
  description?: string;
}

/** Agent 创建请求 */
export interface CreateAgentRequest {
  name: string;
  modelId: number | string;
  prompt: string;
  description?: string;
  toolList?: string[];
  status?: number;
}

/** 工具视图对象 (对应后端 ToolVO) */
export interface ToolVO {
  name: string;
  description?: string;
  readOnly?: boolean;
}

/* ------------------------------------------------------------------ */
/* MCP 服务                                                             */
/* ------------------------------------------------------------------ */

/**
 * MCP 传输方式。
 * 契约来源：com.summit.dp.mcp.domain.model.Mcp 的 TRANSPORT_* 常量，
 * 与框架侧 McpClientFactory 选择 builder 的取值一致。
 */
export const MCP_TRANSPORTS = ['streamable-http', 'sse', 'stdio'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/**
 * stdio 传输的环境限制提示。
 *
 * stdio 由宿主进程直接 spawn 子进程，不做 shell 解析：argv 逐段传给 `ProcessBuilder`/`CreateProcess`，
 * 因此宿主 PATH 里没有对应的可执行文件时子进程起不来，该服务的工具会静默消失（后端只 warn 降级）。
 * Windows 上尤其要注意 `npx` 是无扩展名的 sh 脚本，只有 `npx.cmd` 能被直接启动 —— 这是最常见的踩坑点。
 *
 * 列表卡片与编辑表单共用同一份文案，避免两处漂移。
 */
export const MCP_STDIO_ENV_HINT =
  'stdio 由宿主进程直接启动子进程（不做 shell 解析），要求当前机器的 PATH 中存在对应可执行文件，否则该服务将无法连接、其工具会静默丢失。'
  + 'Windows 上注意：`npx` 是无扩展名的脚本无法直接启动，启动命令请写 `npx.cmd`。';

/**
 * 请求头脱敏掩码。
 * 契约来源：com.summit.dp.mcp.application.vo.McpVO.MASKED_VALUE。
 * 视图层返回的每个 header 值都是它；原样回传即表示「不改动」，后端会保留库中原值。
 */
export const MCP_HEADER_MASKED_VALUE = '__MCP_HEADER_UNCHANGED__';

/** MCP 视图对象 (对应后端 McpVO) */
export interface McpVO {
  id: number | string;
  name: string;
  transport?: string;
  /** http 系传输的端点；stdio 传输为空 */
  url?: string;
  /** 脱敏后的请求头；值恒为 MCP_HEADER_MASKED_VALUE */
  headers?: Record<string, string>;
  /** stdio 启动命令（argv 风格）；仅 stdio 传输非空 */
  command?: string[];
  /** 脱敏后的 stdio 环境变量；仅 stdio 传输非空 */
  env?: Record<string, string>;
  toolNamePrefix?: string;
  /** 初始化超时，毫秒 */
  initializationTimeout?: number;
  /** 执行超时，毫秒 */
  executionTimeout?: number;
  maxOutput?: number;
  /** 1 = 启用，0 = 停用 */
  status?: number;
  createAt?: string;
  updateAt?: string;
}

/** MCP 新增/更新请求 (对应后端 McpRequest) */
export interface McpRequest {
  id?: number | string;
  name?: string;
  transport?: string;
  url?: string;
  headers?: Record<string, string>;
  /** stdio 启动命令（argv 风格） */
  command?: string[];
  /** stdio 环境变量；值等于 MCP_HEADER_MASKED_VALUE 表示保持库中原值 */
  env?: Record<string, string>;
  toolNamePrefix?: string;
  initializationTimeout?: number;
  executionTimeout?: number;
  maxOutput?: number;
  status?: number;
}

