import type { 
  ChatSession, 
  ChatMessage, 
  KnowledgeBase, 
  AgentTool, 
  ModelConfig
} from '../types/chat';

// API 接口路由与中文描述定义 (Map 常量在 TS 最顶层)
export const API_ROUTES = new Map<string, string>([
  ['LOGIN', '/api/auth/login: 用户登录接口，支持手机号/邮箱及密码验证'],
  ['REGISTER', '/api/auth/register: 用户注册接口，支持账号注册与协议绑定'],
  ['FETCH_SESSIONS', '/api/chat/sessions: 获取用户历史开发会话列表'],
  ['CREATE_SESSION', '/api/chat/session/create: 初始化新协作通道，按 Agent 智能指派模式创建'],
  ['DELETE_SESSION', '/api/chat/session/delete: 销毁指定开发协作通道'],
  ['SEND_MESSAGE', '/api/chat/message/send: 发送开发需求或错误日志，触发多 Agent 协同推理流'],
  ['SWITCH_BRANCH', '/api/chat/message/branch: 切换历史决策分支，后端进行有向无环图分支重构']
]);

// 模拟知识库数据
const MOCK_KNOWLEDGE_BASES: KnowledgeBase[] = [
  { id: 'kb-dev-docs', name: '企业微服务高并发技术规范.pdf', description: '包含高并发框架架构、分布式事务配置及接口标准', documentCount: 12 },
  { id: 'kb-finance-2026', name: '私有化部署网络防火墙白名单.xlsx', description: '包含各业务板块部署环境、白名单安全端口', documentCount: 5 },
  { id: 'kb-agent-design', name: '多Agent协同网络编排与DAG流水线.md', description: '详细阐述 DevOps 联合协作与多角色上下文流转', documentCount: 8 }
];

// 模拟工具列表数据
const MOCK_TOOLS: AgentTool[] = [
  { id: 'tool-web-search', name: 'Google Search', description: '实时检索网页数据，获取最新动态', icon: 'GlobeAltIcon' },
  { id: 'tool-python-sandbox', name: 'Python Sandbox', description: '隔离的安全代码沙箱，支持执行任意 Python 进行数学计算与数据分析', icon: 'CommandLineIcon' },
  { id: 'tool-vector-db', name: 'Vector DB Retriever', description: '向量数据库语义召回，用于获取知识库上下文', icon: 'DatabaseIcon' }
];

// 模拟开发项目组 Agent 角色配置 (代替原有的土气模型配置)
const MOCK_MODELS: ModelConfig[] = [
  { id: 'agent-frontend', name: '前端开发专家 (Frontend Agent)', description: '精通 Vue3/React 优化、TS类型校验、TailwindCSS 布局与 CSS 动效优化', category: 'speed' },
  { id: 'agent-backend', name: '后端架构师 (Backend Agent)', description: '精专高并发微服务、混合 RAG 重排检索、Docker 沙盒执行及缓存策略', category: 'intelligence' },
  { id: 'agent-devops', name: '云原生运维专家 (DevOps Agent)', description: '精通 Docker 部署、CI/CD 状态机编排、K8s 自动化调度与池化冷启动预热', category: 'specialized' },
  { id: 'agent-qa', name: '测试开发工程师 (QA Agent)', description: '专精自动化测试、高并发性能压测、漏洞扫描及基准测试编写', category: 'specialized' },
  { id: 'agent-pm', name: '需求与实施专家 (PM Agent)', description: '擅长私有化部署规划、企业数据脱敏、交付需求对齐及交付链路监控', category: 'speed' }
];

// 模拟历史会话数据
const MOCK_SESSIONS: ChatSession[] = [
  {
    id: 'session-1',
    title: 'Vue 3 多层微前端状态隔离',
    createdAt: Date.now() - 3600000 * 24, // 1天前
    updatedAt: Date.now() - 3600000 * 23,
    modelId: 'agent-frontend',
    knowledgeBaseId: 'kb-dev-docs',
    activeTools: ['tool-web-search', 'tool-vector-db'],
    messages: [
      {
        id: 'msg-1-1',
        role: 'user',
        content: '微前端沙箱下，如何实现子应用 Pinia 状态的完全隔离，同时支持父应用进行事件穿透？',
        timestamp: Date.now() - 3600000 * 23 - 300000
      },
      {
        id: 'msg-1-2',
        role: 'assistant',
        model: '前端开发专家 (Frontend Agent)',
        content: '在微前端架构中实现状态隔离通常依靠 CustomElement 沙箱或 Proxy 拦截。以下是我的最佳实践设计：\n\n### 1. 作用域隔离设计\n为子应用独立实例化 Pinia。在挂载子应用时，不要将父应用的全局 store 挂载到子 context。\n\n```typescript\n// 子应用入口 main.ts\nimport { createPinia } from \'pinia\';\nconst pinia = createPinia();\napp.use(pinia);\n```\n\n### 2. 父子通信与事件穿透\n推荐通过 CustomEvent 原生总线，在 window.rawWindow（若在 qiankun 沙箱下）上派发隔离事件。这比强行修改 store 的指向更干净、性能更好。',
        timestamp: Date.now() - 3600000 * 23,
        thoughtSteps: [
          { id: 't-1', title: '前端意图分析', content: '分析子应用 Pinia 状态树冲突场景，确认作用域隔离级别。', status: 'success', durationMs: 120 }
        ],
        toolCalls: [],
        citations: []
      }
    ]
  }
];

export class ChatApiService {
  private sessions: ChatSession[] = [...MOCK_SESSIONS];

  /**
   * 用户登录验证 (调用专门的 API 层 Map 常量进行认证)
   */
  async login(account: string, password: string): Promise<boolean> {
    return new Promise((resolve) => {
      setTimeout(() => {
        console.log(`[API CALL] POST ${API_ROUTES.get('LOGIN')} - 登录验证成功。 账号: ${account}, 验证密码长度: ${password.length}`);
        resolve(true);
      }, 400);
    });
  }

  /**
   * 用户注册验证
   */
  async register(account: string, password: string): Promise<boolean> {
    return new Promise((resolve) => {
      setTimeout(() => {
        console.log(`[API CALL] POST ${API_ROUTES.get('REGISTER')} - 账号注册成功。 账号: ${account}, 注册密码长度: ${password.length}`);
        resolve(true);
      }, 400);
    });
  }

  /**
   * 获取所有会话列表
   */
  async fetchSessions(): Promise<ChatSession[]> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(this.sessions);
      }, 300);
    });
  }

  /**
   * 获取可选知识库列表
   */
  async fetchKnowledgeBases(): Promise<KnowledgeBase[]> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(MOCK_KNOWLEDGE_BASES);
      }, 200);
    });
  }

  /**
   * 获取可用工具列表
   */
  async fetchAvailableTools(): Promise<AgentTool[]> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(MOCK_TOOLS);
      }, 200);
    });
  }

  /**
   * 获取可用模型配置
   */
  async fetchModels(): Promise<ModelConfig[]> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(MOCK_MODELS);
      }, 200);
    });
  }

  /**
   * 创建新会话
   */
  async createNewSession(modelId: string, knowledgeBaseId?: string, tools: string[] = []): Promise<ChatSession> {
    const newSession: ChatSession = {
      id: `session-${Date.now()}`,
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      modelId,
      knowledgeBaseId,
      activeTools: tools,
      messages: []
    };
    this.sessions.unshift(newSession);
    return newSession;
  }

  /**
   * 删除会话
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const index = this.sessions.findIndex(s => s.id === sessionId);
    if (index !== -1) {
      this.sessions.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * 发送消息并流式模拟返回结果 (通过 onProgress 回调函数提供多步骤与打字机效果)
   */
  async sendMessageStream(
    sessionId: string,
    userText: string,
    onProgress: (msg: ChatMessage) => void
  ): Promise<void> {
    const session = this.sessions.find(s => s.id === sessionId);
    if (!session) throw new Error('Session not found');

    // 1. 添加用户消息
    const userMsgId = `msg-user-${Date.now()}`;
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: userText,
      timestamp: Date.now(),
      branches: [userText],
      activeBranchIndex: 0
    };
    session.messages.push(userMsg);
    session.updatedAt = Date.now();
    
    // 如果会话还是默认标题，自动生成标题
    if (session.title === '新对话') {
      session.title = userText.length > 15 ? userText.substring(0, 15) + '...' : userText;
    }

    // 2. 创建一个初始的 Assistant 占位消息
    const assistantMsgId = `msg-agent-${Date.now()}`;
    const targetModel = MOCK_MODELS.find(m => m.id === session.modelId)?.name || '后端架构师 (Backend Agent)';
    
    const responseMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      model: targetModel,
      content: '',
      timestamp: Date.now(),
      isThinking: true,
      thoughtSteps: [],
      toolCalls: [],
      citations: []
    };
    
    session.messages.push(responseMsg);
    onProgress({ ...responseMsg });

    // 模拟后端执行周期的辅助函数
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    // 阶段 A: 智能路由与分析规划
    responseMsg.thoughtSteps!.push({
      id: 'step-plan',
      title: '开发意图识别与路由',
      content: `解析开发指令: "${userText}"。根据技术栈类型，DevSquad 控制台已智能分发至相应开发节点 [${targetModel}] 并初始化规划网络。`,
      status: 'running'
    });
    onProgress({ ...responseMsg });
    await sleep(800);
    
    responseMsg.thoughtSteps![0].status = 'success';
    responseMsg.thoughtSteps![0].durationMs = 800;

    // 阶段 B: 知识库检索 (如果配置了知识库，或者启用了检索工具)
    const hasRAG = !!session.knowledgeBaseId || session.activeTools.includes('tool-vector-db');
    if (hasRAG) {
      const kbName = MOCK_KNOWLEDGE_BASES.find(k => k.id === session.knowledgeBaseId)?.name || '企业公共开发库';
      responseMsg.thoughtSteps!.push({
        id: 'step-rag',
        title: '向量检索与混合重排',
        content: `开始查询向量数据库 [${kbName}]，提取 Top-10 语义切片，并结合 BGE-Reranker-Large 重排引擎进行交叉评分。`,
        status: 'running'
      });
      responseMsg.toolCalls!.push({
        id: 'tool-vector',
        toolName: 'Vector DB Retriever',
        query: userText,
        status: 'calling'
      });
      onProgress({ ...responseMsg });
      await sleep(1200);

      responseMsg.thoughtSteps![1].status = 'success';
      responseMsg.thoughtSteps![1].durationMs = 1200;
      
      const tc = responseMsg.toolCalls!.find(t => t.toolName === 'Vector DB Retriever');
      if (tc) {
        tc.status = 'success';
        tc.result = `召回 2 条高可信开发文档切片，重排最高分: 0.941`;
      }
      
      // 填充 RAG 引用
      responseMsg.citations = [
        {
          id: 'cite-1',
          sourceName: kbName,
          content: `【后端系统配置规范第 23 条】为了支持混合检索下的实时会话管理，后端利用 Redis Hash 存储消息树，其中 key 为 session_id，field 为 message_id。分支结构采用子节点列表的形式嵌套，以保障多路查询的时间复杂度为 O(1)。`,
          score: 0.94,
          chunkIndex: 82
        },
        {
          id: 'cite-2',
          sourceName: kbName,
          content: `【Agent 工具轨迹协议规范】在流式输出协议中，后端遵循特定 JSON schema：{"type": "tool_use", "name": "...", "input": "..."}。前端解析此事件并挂起回答流，转而渲染 ToolTrace 卡片。`,
          score: 0.88,
          chunkIndex: 12
        }
      ];
      onProgress({ ...responseMsg });
    }

    // 阶段 C: 工具链执行 (如果启用了其他工具，如沙盒或搜索)
    const hasSearch = session.activeTools.includes('tool-web-search');
    const hasSandbox = session.activeTools.includes('tool-python-sandbox') || userText.toLowerCase().includes('python') || userText.includes('代码') || userText.includes('斐波那契');
    
    if (hasSearch || hasSandbox) {
      const stepIdx = responseMsg.thoughtSteps!.length;
      responseMsg.thoughtSteps!.push({
        id: `step-tool-${stepIdx}`,
        title: hasSandbox ? '执行沙盒编译' : '联网开发资料检索',
        content: hasSandbox 
          ? '检测到算法调试或计算请求，正在拉起安全的隔离代码沙箱容器，分配资源限额。' 
          : '检测到时效性较强的开发规范查询，向 Google 开发者引擎发送搜索请求。',
        status: 'running'
      });
      responseMsg.toolCalls!.push({
        id: `tc-${stepIdx}`,
        toolName: hasSandbox ? 'Python Sandbox' : 'Google Search',
        query: hasSandbox ? 'def run(): ...' : userText,
        status: 'calling'
      });
      onProgress({ ...responseMsg });
      await sleep(1500);

      responseMsg.thoughtSteps![stepIdx].status = 'success';
      responseMsg.thoughtSteps![stepIdx].durationMs = 1500;
      
      const tc = responseMsg.toolCalls!.find(t => t.id === `tc-${stepIdx}`);
      if (tc) {
        tc.status = 'success';
        tc.result = hasSandbox 
          ? `[Stdout] Subprocess executed. ExitCode: 0.\nOutput: Fibonacci(30) = 832040\nExecution Time: 12.4ms` 
          : `已检索到相关开发文档: "2026年微前端沙箱隔离机制规范"，爬取 3 篇相关文本段落。`;
      }
      onProgress({ ...responseMsg });
    }

    // 阶段 D: 模型推理与打字机输出最终回答
    responseMsg.isThinking = false; // 结束思考动画
    
    // 根据输入动态准备 Mock 回复文本
    let responseText = '';
    if (hasRAG) {
      responseText = `基于已挂载的企业开发规范及网络白名单切片，DevSquad 研发组前端专家、后端架构师及运维专家联合评估如下：\n\n1. **前端类型隔离 (Frontend Agent)**：在微前端沙箱中独立实例化 Pinia store，避免全局 window 变量污染，并提供安全隔离的事件穿透总线。\n2. **混合检索重排建议 (Backend Agent)**：对召回文件进行 BM25 + Dense 双路检索，并由 Cross-Encoder Reranker 精排合并，保证重排后切片的语义紧密性与生成准确性。\n3. **防火墙安全白名单 (DevOps Agent)**：通过 K8s Ingress 控制会话端口白名单，并在 Docker 容器网络层面作安全路由拦截。`;
    } else if (hasSandbox) {
      responseText = `测试开发工程师 (QA Agent) 已成功调用安全的 Python 执行沙箱计算完毕：\n\n- **计算斐波那契数列结果**：第 30 项的值为 **832040**。\n- **性能基准评估**：沙箱环境隔离度 100%。在预热容器池内，执行冷启动耗时仅为 **12.4ms**，测试通过无任何安全溢出或内存泄漏异常。`;
    } else {
      responseText = `您好！欢迎使用 **DevSquad 研发项目组协同终端**。\n\n本控制台为您拉起了一支高效的 Agent 软件开发小组，成员包括：\n- 💻 **前端开发专家**：负责响应式的微圆角布局、双主题色彩适配。\n- ⚙️ **后端架构师**：提供混合 RAG 搜索引擎、BM25 重排以及代码沙箱执行器。\n- ☸️ **云原生运维专家**：管理隔离 Docker 沙盒容器池的动态预热。\n- 🧪 **测试开发工程师**：执行代码性能基准压测与安全性扫描。\n- 📁 **产品与实施专家**：负责私有化部署规划与企业 RAG 数据导入。\n\n您可以输入“请写一段 Vue3 树状组件 the TypeScript 类型定义”或“测试这段 Python 排序算法的性能”来激活对应的 Agent 进行答复。`;
    }

    // 打字机流式输出
    let currentLen = 0;
    const speed = 15; // 每次输出字符数
    const interval = 30; // 时间间隔
    
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        currentLen += speed;
        if (currentLen >= responseText.length) {
          responseMsg.content = responseText;
          clearInterval(timer);
          onProgress({ ...responseMsg });
          resolve();
        } else {
          responseMsg.content = responseText.substring(0, currentLen) + '█';
          onProgress({ ...responseMsg });
        }
      }, interval);
    });
  }

  /**
   * 模拟切换消息的分支 (后端树状历史分支切换)
   */
  async switchMessageBranch(
    sessionId: string,
    messageId: string,
    branchIndex: number
  ): Promise<ChatMessage | null> {
    const session = this.sessions.find(s => s.id === sessionId);
    if (!session) return null;

    const msg = session.messages.find(m => m.id === messageId);
    if (!msg || !msg.branches) return null;

    msg.activeBranchIndex = branchIndex;
    msg.content = msg.branches[branchIndex];
    
    // 实际项目中，切换分支会导致后续的所有助理回复重新生成
    // 这里我们仅更新消息内容，并在 Mock 中返回更新后的消息
    return msg;
  }
}

export const chatApi = new ChatApiService();
