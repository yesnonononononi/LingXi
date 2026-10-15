import http from './interceptor';
import type { Result } from './types';
import type { SandboxServiceStatus } from '../types/chat';

/** 资源查询不执行命令，检查接口会实际验证隔离。 */
export class SandboxAPI {
  static async status(): Promise<Result<SandboxServiceStatus>> {
    return http.get<any, Result<SandboxServiceStatus>>('/sandbox/service/status');
  }
  static async check(): Promise<Result<SandboxServiceStatus>> {
    return http.post<any, Result<SandboxServiceStatus>>('/sandbox/service/check', null, { timeout: 120_000 });
  }
}
