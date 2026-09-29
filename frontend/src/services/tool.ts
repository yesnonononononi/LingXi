import http from './interceptor';
import type { Result } from './types';
import type { ToolVO } from '../types/chat';

/**
 * 工具管理 API (对应后端 ToolController)
 */
export class ToolAPI {
  /** 获取可用工具列表 (GET /tools/list) */
  static async list(): Promise<Result<ToolVO[]>> {
    return http.get<any, Result<ToolVO[]>>('/tools/list');
  }
}
