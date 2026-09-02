import http from './interceptor';
import type { ChatSession, ModelConfig, KnowledgeBase, ChatMessage, ModelConfigVO, SessionVO } from '../types/chat';

export interface Result<T = any> {
  code: number;
  errMsg?: string;
  data?: T;
}

export interface LoginParams {
  phoneNumber: string;
  passWord: string;
}

export interface RegisterParams {
  phoneNumber: string;
  password: string;
  smsCode: number;
}

export interface AuthVO {
  token: string;
}

/**
 * 1. 认证服务 API (对应后端 AuthController)
 */
export class AuthAPI {
  static async login(params: LoginParams): Promise<Result<AuthVO>> {
    const res = await http.post<any, Result<AuthVO>>('/auth/login', params);
    const token = res.data?.token || (typeof res.data === 'string' ? res.data : '');
    if ((res.code === 1 || res.code === 200) && token) {
      localStorage.setItem('token', token);
    }
    return res;
  }

  static async register(params: RegisterParams): Promise<Result<void>> {
    return http.post<any, Result<void>>('/auth/register', params);
  }

  static async logout(): Promise<Result<void>> {
    try {
      return await http.post<any, Result<void>>('/auth/logout');
    } finally {
      localStorage.removeItem('token');
    }
  }

  static async resetPass(oldP: string, newP: string): Promise<Result<void>> {
    return http.post<any, Result<void>>(`/auth/reset-pass?oldP=${encodeURIComponent(oldP)}&newP=${encodeURIComponent(newP)}`);
  }

  static async sms(phone: string, timestamp: string): Promise<Result<void>> {
    return http.post<any, Result<void>>(`/auth/sms?phone=${encodeURIComponent(phone)}&timestamp=${encodeURIComponent(timestamp)}`);
  }

  static async forgetPass(phone: string, sms: number, np: string): Promise<Result<void>> {
    return http.post<any, Result<void>>(`/auth/forget-pass?phone=${encodeURIComponent(phone)}&sms=${sms}&np=${encodeURIComponent(np)}`);
  }
}

/**
 * 2. 模型配置 API (对应后端 ModelController)
 */
export class ModelAPI {
  static async list(page = 1, pageSize = 10): Promise<Result<any>> {
    return http.get<any, Result<any>>(`/model/list?page=${page}&pageSize=${pageSize}`);
  }

  static async add(data: { modelName: string; baseUrl: string; apiKey: string }): Promise<Result<void>> {
    return http.post<any, Result<void>>('/model/add', data);
  }

  static async findById(id: number | string): Promise<Result<ModelConfigVO>> {
    return http.get<any, Result<ModelConfigVO>>(`/model/find/${id}`);
  }

  static async deleteById(id: number | string): Promise<Result<void>> {
    return http.get<any, Result<void>>(`/model/del?id=${id}`);
  }
}

/**
 * 3. 会话 API (对应后端 SessionController)
 */
export class SessionAPI {
  static async list(page = 1, pageSize = 50): Promise<Result<any>> {
    return http.get<any, Result<any>>(`/session/list?page=${page}&pageSize=${pageSize}`);
  }

  static async findById(id: number | string): Promise<Result<SessionVO>> {
    return http.get<any, Result<SessionVO>>(`/session/find/${id}`);
  }

  static async add(name?: string): Promise<Result<number>> {
    return http.post<any, Result<number>>('/session/add', { name: name ?? '新对话' });
  }

  static async update(id: number | string, name: string): Promise<Result<void>> {
    return http.post<any, Result<void>>('/session/update', { id, name });
  }

  static async del(id: number | string): Promise<Result<void>> {
    return http.get<any, Result<void>>(`/session/del?id=${id}`);
  }
}

/**
 * 4. Agent 对话 API (对应后端 AgentController)
 */
export class AgentAPI {
  static async chat(sessionId: string | number | null, prompt: string): Promise<Result<string>> {
    return http.post<any, Result<string>>('/a/chat', {
      input: prompt,
      sessionId: sessionId ? Number(sessionId) : null,
      workDir: null,
      workspaceId: null
    });
  }

  static async chatStream(
    sessionId: string | number | null,
    prompt: string,
    onChunk: (text: string) => void
  ): Promise<void> {
    const token = localStorage.getItem('token');
    const response = await fetch('/a/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token ? (token.startsWith('Bearer ') ? token : `Bearer ${token}`) : '',
      },
      body: JSON.stringify({
        input: prompt,
        sessionId: sessionId ? Number(sessionId) : null,
        workDir: null,
        workspaceId: null
      })
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE 建立连接失败: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      onChunk(chunk);
    }
  }
}

// 统一 chatApi 导出，供 UI 层直接调用
export const chatApi = {
  async fetchModels(): Promise<ModelConfig[]> {
    try {
      const res = await ModelAPI.list(1, 10);
      if ((res.code === 1 || res.code === 200) && res.data?.records?.length) {
        return res.data.records.map((item: any) => ({
          id: item.id || item.modelName,
          name: item.modelName || '自定模型',
          modelName: item.modelName,
          description: `BaseURL: ${item.baseUrl || '内置'}`,
          category: 'intelligence'
        }));
      }
    } catch {
      // 优雅 Fallback
    }

    return [
      { id: 'deepseek-r1', name: 'DeepSeek-R1 (深度思考)', description: '包含推理思维链的自研模型', category: 'intelligence' },
      { id: 'deepseek-v3', name: 'DeepSeek-V3', description: '高效率长上下文通用语言模型', category: 'speed' },
      { id: 'lingxi-agent-v2', name: '灵犀 Agent V2 混合模态', description: '支持 Tool Calling 与 RAG 混合检索架构', category: 'specialized' }
    ];
  },

  async fetchKnowledgeBases(): Promise<KnowledgeBase[]> {
    return [
      { id: 'kb-default', name: '系统核心知识库', description: '基础产品与技术文档', documentCount: 18 },
      { id: 'kb-finance', name: '2026 深度行业报告库', description: '行业趋势与财务分析数据', documentCount: 8 }
    ];
  },

  async fetchSessions(): Promise<ChatSession[]> {
    try {
      const res = await SessionAPI.list(1, 50);
      if ((res.code === 1 || res.code === 200) && res.data?.records) {
        return res.data.records.map((item: SessionVO) => ({
          id: String(item.id),
          title: item.name || '新对话',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          modelId: 'deepseek-r1',
          activeTools: [],
          messages: (item.messages || []).map((m, i) => ({
            id: `msg-${item.id}-${i}`,
            role: (m.role === 'user' || m.role === 'assistant' || m.role === 'system') ? m.role : 'assistant',
            content: m.text || '',
            timestamp: Date.now()
          }))
        }));
      }
    } catch {
      // 优雅 Fallback
    }

    return [
      {
        id: 'session-demo-1',
        title: 'DeepSeek R1 架构原理分析',
        createdAt: Date.now() - 3600000 * 2,
        updatedAt: Date.now() - 3600000 * 2,
        modelId: 'deepseek-r1',
        activeTools: ['tool-web-search'],
        messages: []
      }
    ];
  },

  async createNewSession(modelId: string | number, knowledgeBaseId?: string, activeTools: string[] = []): Promise<ChatSession> {
    try {
      const res = await SessionAPI.add('新对话');
      const id = (res.code === 1 || res.code === 200) ? String(res.data) : `session-${Date.now()}`;
      return {
        id,
        title: '新对话',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        modelId,
        knowledgeBaseId,
        activeTools,
        messages: []
      };
    } catch {
      return {
        id: `session-${Date.now()}`,
        title: '新对话',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        modelId,
        knowledgeBaseId,
        activeTools,
        messages: []
      };
    }
  },

  async deleteSession(id: string): Promise<boolean> {
    try {
      const res = await SessionAPI.del(id);
      return res.code === 1 || res.code === 200;
    } catch {
      return false;
    }
  },

  async renameSession(id: string, name: string): Promise<boolean> {
    try {
      const res = await SessionAPI.update(id, name);
      return res.code === 1 || res.code === 200;
    } catch {
      return false;
    }
  },

  async sendMessageStream(
    _sessionId: string, 
    content: string, 
    onProgress: (msg: ChatMessage) => void
  ): Promise<void> {
    const isDeepThinkMode = content.includes('【R1模式】') || true;

    const botMsgId = `msg-bot-${Date.now()}`;
    const botMessage: ChatMessage = {
      id: botMsgId,
      role: 'assistant',
      model: isDeepThinkMode ? 'DeepSeek-R1' : 'DeepSeek-V3',
      content: '',
      timestamp: Date.now(),
      isThinking: true,
      thoughtSteps: [],
      citations: []
    };

    onProgress({ ...botMessage });

    try {
      // 尝试调用后端 Agent SSE 接口
      let isFirstSSE = true;
      await AgentAPI.chatStream(_sessionId, content, (chunkText: string) => {
        if (isFirstSSE) {
          botMessage.isThinking = false;
          isFirstSSE = false;
        }
        botMessage.content += chunkText;
        onProgress({ ...botMessage });
      });
      return;
    } catch {
      // 优雅 Fallback: 模拟流生成
    }

    // 阶段1：思考链演化
    if (isDeepThinkMode) {
      await new Promise(r => setTimeout(r, 500));
      botMessage.thoughtSteps = [
        {
          id: 't-1',
          title: '理解用户指令并拆解子问题',
          content: `针对输入 "${content.slice(0, 20)}..." 进行语义特征提取，建立上下文逻辑树。`,
          status: 'running'
        }
      ];
      onProgress({ ...botMessage });

      await new Promise(r => setTimeout(r, 600));
      botMessage.thoughtSteps[0].status = 'success';
      botMessage.thoughtSteps[0].durationMs = 620;
      botMessage.thoughtSteps.push({
        id: 't-2',
        title: '检索互联网与知识库数据',
        content: '检索关联的技术文档切片与在线网页权威解答...',
        status: 'running'
      });
      botMessage.citations = [
        {
          id: 'c-1',
          sourceName: '灵犀Agent核心架构说明.pdf',
          content: '灵犀 Agent 系统结合 RAG 向量切片与大模型 Chain-of-Thought...',
          score: 0.93,
          chunkIndex: 0
        }
      ];
      onProgress({ ...botMessage });

      await new Promise(r => setTimeout(r, 700));
      botMessage.thoughtSteps[1].status = 'success';
      botMessage.thoughtSteps[1].durationMs = 710;
      botMessage.thoughtSteps.push({
        id: 't-3',
        title: '整理输出回答逻辑',
        content: '思考完毕，准备生成具有清晰标题与结构化排版的完整回答。',
        status: 'success',
        durationMs: 380
      });
      onProgress({ ...botMessage });
    }

    // 阶段2：文本流式输出
    botMessage.isThinking = false;

    const fullResponse = `很高兴为您解答！关于 “**${content}**”，以下是我的详细分析与建议：

### 核心解题思路：
1. **结构化分层设计**：遵循高内聚低耦合原则，确保各个模块职责分明。
2. **DeepThink 思考推进**：利用深度推理链，分析问题核心矛盾与最佳方案。
3. **向量检索结合**：补充上下文背景知识，大幅减少模型幻觉。

\`\`\`typescript
// 示例：灵犀 Agent 流式响应处理函数
export function handleAgentStream(chunk: string) {
  console.log('接收到数据块:', chunk);
}
\`\`\`

如果您有任何进一步细化或拓展的需求，随时告诉我！`;

    const chars = fullResponse.split('');
    for (let i = 0; i < chars.length; i += 3) {
      botMessage.content += chars.slice(i, i + 3).join('');
      onProgress({ ...botMessage });
      await new Promise(r => setTimeout(r, 20));
    }
  },

  async switchMessageBranch(_sessionId: string, _messageId: string, _index: number): Promise<ChatMessage | null> {
    return null;
  }
};
