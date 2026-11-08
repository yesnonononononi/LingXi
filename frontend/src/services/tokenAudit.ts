import http from './interceptor';
import type {Result} from './types';
import type {SessionTokenAuditVO} from '../types/tokenAudit';

/**
 * 会话用量审计 API（对应后端 `SessionController#tokenAudit`）。
 *
 * <p>只封装一次只读查询：面板打开 / 点「刷新」时各拉一次，不做轮询 ——
 * 实时上下文由既有 SSE 上下文用量事件负责，这里只取快照口径。</p>
 */
export class TokenAuditAPI {
  /**
   * 拉取指定会话的用量审计数据。
   *
   * @param sessionId 会话 ID（雪花 ID，按字符串透传，禁止 Number() 强转）
   * @returns 统一响应包装；`data` 缺失表示后端没有可展示内容，调用方必须按「无数据」处理
   * @throws {Error} `sessionId` 为空时立即抛错，不发无意义请求
   * @throws {ApiError} 网络/HTTP/业务错误由响应拦截器统一 reject
   */
  static async tokenAudit(sessionId: number | string | null | undefined): Promise<Result<SessionTokenAuditVO>> {
    if (sessionId === null || sessionId === undefined || String(sessionId).trim() === '') {
      throw new Error('TokenAuditAPI.tokenAudit: sessionId is required');
    }
    const encoded = encodeURIComponent(String(sessionId).trim());
    return http.get<any, Result<SessionTokenAuditVO>>(`/session/${encoded}/token-audit`);
  }
}

