import http from './interceptor';
import type { ChatSession, ModelConfig, KnowledgeBase, ChatMessage } from '../types/chat';

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

export class AuthAPI {
  /**
   * 用户登录接口 (使用 axios 拦截器及统一报错/Token注入)
   */
  static async login(params: LoginParams): Promise<Result<AuthVO>> {
    const res = await http.post<any, Result<AuthVO>>('/auth-user/login', params);
    if (res.code === 200 && res.data?.token) {
      localStorage.setItem('token', res.data.token);
    }
    return res;
  }

  /**
   * 用户注册接口
   */
  static async register(params: RegisterParams): Promise<Result<void>> {
    return http.post<any, Result<void>>('/auth-user/register', params);
  }

  /**
   * 用户登出接口
   */
  static async logout(): Promise<Result<void>> {
    try {
      return await http.post<any, Result<void>>('/auth-user/logout');
    } finally {
      localStorage.removeItem('token');
    }
  }

  /**
   * 重置密码接口
   */
  static async resetPass(oldP: string, newP: string): Promise<Result<void>> {
    return http.post<any, Result<void>>('/auth-user/reset-pass', { oldP, newP });
  }
}

// 保留 chatApi 供底层 AI 对话服务使用
export const chatApi = {
  async fetchModels(): Promise<ModelConfig[]> {
    return [
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', description: 'Google 高级推理模型', category: 'intelligence' },
      { id: 'agent-backend', name: 'Agent 智能后端模型', description: '深度思考与工具调用模型', category: 'specialized' },
      { id: 'gpt-4o', name: 'GPT-4o', description: '全能高速模型', category: 'speed' }
    ];
  },
  async fetchKnowledgeBases(): Promise<KnowledgeBase[]> {
    return [
      { id: 'kb-default', name: '灵犀默认系统知识库', description: '基础系统文档', documentCount: 12 },
      { id: 'kb-finance', name: '2026 财报与商业分析库', description: '财报分析库', documentCount: 5 }
    ];
  },
  async fetchSessions(): Promise<ChatSession[]> {
    return [];
  },
  async createNewSession(modelId: string, knowledgeBaseId?: string, activeTools: string[] = []): Promise<ChatSession> {
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
  },
  async deleteSession(_id: string): Promise<boolean> {
    return true;
  },
  async sendMessageStream(
    _sessionId: string, 
    _content: string, 
    _onProgress: (msg: ChatMessage) => void
  ): Promise<void> {
    // 模拟消息流返回
  },
  async switchMessageBranch(_sessionId: string, _messageId: string, _index: number): Promise<ChatMessage | null> {
    return null;
  }
};