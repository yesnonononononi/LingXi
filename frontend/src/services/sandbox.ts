import http from './interceptor';
import type { Result } from './types';
import type { SandboxServiceStatus } from '../types/chat';

/** 查询配置并检查基础运行能力，不探测项目目录。 */
export class SandboxAPI {
  static async status(): Promise<Result<SandboxServiceStatus>> {
    return http.get<any, Result<SandboxServiceStatus>>('/sandbox/service/status');
  }
  static async check(): Promise<Result<SandboxServiceStatus>> {
    return http.post<any, Result<SandboxServiceStatus>>('/sandbox/service/check', null, { timeout: 120_000 });
  }
}
