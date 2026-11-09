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

/** 会话级审计快照的只读查询。 */
export class TokenAuditAPI {
  static async tokenAudit(sessionId: number | string | null | undefined): Promise<Result<SessionTokenAuditVO>> {
    return http.get<unknown, Result<SessionTokenAuditVO>>(tokenAuditPath(sessionId));
  }
}

