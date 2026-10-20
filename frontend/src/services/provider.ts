import http from './interceptor';
import type { Result } from './types';
import type { ProviderConfigVO, ProviderConfigPayload } from '../types/chat';

/**
 * 提供商配置预设 API（对应后端 ProviderConfigController）。
 *
 * <p>提供商是「同名模型来自不同来源」的区分依据；模型归属通过
 * {@code ModelAPI.add/update} 的 {@code providerConfigId} 写入。</p>
 */
export class ProviderAPI {
  static async list(): Promise<Result<ProviderConfigVO[]>> {
    return http.get<any, Result<ProviderConfigVO[]>>('/provider/list');
  }

  static async add(data: ProviderConfigPayload): Promise<Result<void>> {
    return http.post<any, Result<void>>('/provider/add', data);
  }

  static async update(data: ProviderConfigPayload): Promise<Result<void>> {
    return http.post<any, Result<void>>('/provider/update', data);
  }

  static async findById(id: number | string): Promise<Result<ProviderConfigVO>> {
    return http.get<any, Result<ProviderConfigVO>>(`/provider/find/${id}`);
  }

  static async deleteById(id: number | string): Promise<Result<void>> {
    return http.get<any, Result<void>>(`/provider/del/${id}`);
  }
}
