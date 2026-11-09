import http from './interceptor';
import type {Result} from './types';
import type {SessionTokenAuditVO} from '../types/tokenAudit';

function tokenAuditPath(sessionId: number | string | null | undefined): string {
  if (sessionId === null || sessionId === undefined || String(sessionId).trim() === '') {
    throw new Error('会话 ID 不能为空');
  }
  const encoded = encodeURIComponent(String(sessionId).trim());
  return `/session/${encoded}/token-audit`;
}

/** 查询会话快照和按需重新审计使用同一份响应。 */
export class TokenAuditAPI {
  static async tokenAudit(sessionId: number | string | null | undefined): Promise<Result<SessionTokenAuditVO>> {
    return http.get<unknown, Result<SessionTokenAuditVO>>(tokenAuditPath(sessionId));
  }

  static async refresh(sessionId: number | string | null | undefined): Promise<Result<SessionTokenAuditVO>> {
    return http.post<unknown, Result<SessionTokenAuditVO>>(`${tokenAuditPath(sessionId)}/refresh`);
  }
}

