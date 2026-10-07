import http from './interceptor';
import type { Result } from './types';
import type { UserConfigVO } from '../types/chat';

/** 4.5 通用配置 API (对应后端 UserConfigController) */
export class UserConfigAPI {
  static async current(): Promise<Result<UserConfigVO>> {
    return http.get<any, Result<UserConfigVO>>('/config/current');
  }

  /** 更新单例本地设置（如选中的模型 modelId）；未传字段保持原值。 */
  static async updateCurrent(payload: Partial<UserConfigVO>): Promise<Result<void>> {
    return http.post<any, Result<void>>('/config/current/update', payload);
  }
}
