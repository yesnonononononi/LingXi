import http from './interceptor';
import type { Result } from './types';
import type { ChecklistSnapshot } from '../types/checklist';

export const ChecklistAPI = {
  /**
   * 常驻展示口径：会话最近一份清单，**包含已软删**。
   *
   * 与模型的「当前可继续清单」不是一回事：那个口径跳过 DELETED，用来决定还能不能接着干活；
   * 这个口径决定胶囊会不会在删除后凭空消失，用户需要它来审计。
   */
  latest(sessionId: string, signal?: AbortSignal): Promise<Result<ChecklistSnapshot | null>> {
    return http.get('/checklist/latest', { params: { sessionId }, signal });
  },
};
