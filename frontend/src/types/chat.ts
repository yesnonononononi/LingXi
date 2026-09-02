/**
 * 消息角色定义
 */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * 思维链步骤接口 (体现后端 CoT / 思维链亮点)
 */
export interface ThoughtStep {
  id: string;
  title: string;          // 步骤名称，如 "检索知识库", "生成推理"
  content: string;        // 步骤详细思考内容
  status: 'running' | 'success' | 'failed';
  durationMs?: number;    // 后端执行耗时
}

/**
 * Agent 工具调用日志 (体现后端 Tool Calling / Function Calling 亮点)
 */
export interface ToolCallTrace {
  id: string;
  toolName: string;       // 工具名称，如 "web_search", "python_sandbox"
  query?: string;         // 调用输入参数
  result?: string;        // 工具返回的原始数据或状态
  status: 'calling' | 'success' | 'failed';
}

/**
 * RAG 召回引用卡片 (体现后端混合检索与重排亮点)
 */
export interface RAGCitation {
  id: string;
  sourceName: string;     // 来源文件名，如 "2026年Q2财报.pdf"
  content: string;        // 被召回并作为上下文的文本片段
  score: number;          // 匹配度/重排得分 (如 0.92)
  chunkIndex: number;     // 文本切片索引
}

/**
 * 单条消息接口 (支持多分支对话)
 */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  
  // 后端亮点相关字段
  model?: string;                   // 实际路由并处理的消息模型，例如 "Gemini 1.5 Pro"
  thoughtSteps?: ThoughtStep[];     // 思维链思考轨迹
  toolCalls?: ToolCallTrace[];       // 工具调用日志
  citations?: RAGCitation[];         // RAG 知识库引用
  isThinking?: boolean;              // 是否正在思考中
  
  // 对话多分支相关 (后端树状历史管理亮点)
  branches?: string[];               // 该节点下的替代消息文本列表 (例如用户编辑了上一条消息，分叉出多个回复)
  activeBranchIndex?: number;        // 当前激活的分支索引
}

/**
 * 聊天会话接口
 */
export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modelId: string | number;          // 绑定的模型配置
  knowledgeBaseId?: string;          // 绑定的知识库ID
  activeTools: string[];             // 开启的工具列表
  messages: ChatMessage[];
}

/**
 * 后端外挂知识库 (体现后端 RAG 亮点)
 */
export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  documentCount: number;
}

/**
 * 后端可用工具/插件 (体现后端 Agent 亮点)
 */
export interface AgentTool {
  id: string;
  name: string;
  description: string;
  icon: string;
}

/**
 * 模型配置接口 (体现后端智能路由与配置)
 */
export interface ModelConfig {
  id: string | number;
  name: string;
  modelName?: string;
  description?: string;
  category?: 'speed' | 'intelligence' | 'specialized';
  baseUrl?: string;
  apiKey?: string;
}

/**
 * 后端 ModelConfigVO 领域实体
 */
export interface ModelConfigVO {
  id?: number | string;
  modelName?: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * 后端会话消息 VO（对应 SessionMessageVO）
 */
export interface SessionMessageVO {
  role: string;
  text: string;
}

/**
 * 后端会话 VO（对应 SessionVO）
 */
export interface SessionVO {
  id?: number | string;
  name?: string;
  messages?: SessionMessageVO[];
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  systemMessage?: string;
}
