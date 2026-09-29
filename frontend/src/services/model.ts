import http from './interceptor';
import type { Result } from './types';
import type { PageResult, ModelConfigVO, ModelConfigPayload } from '../types/chat';

/** 2. 模型配置 API (对应后端 ModelController) */
export class ModelAPI {
  static async update(data: ModelConfigPayload): Promise<Result<void>> {
    return http.post<any, Result<void>>('/model/update', data);
  }

  static async list(page = 1, pageSize = 10): Promise<Result<PageResult<ModelConfigVO>>> {
    return http.get<any, Result<PageResult<ModelConfigVO>>>(`/model/list?page=${page}&pageSize=${pageSize}`);
  }

  static async add(data: { modelName: string; baseUrl: string; apiKey?: string }): Promise<Result<void>> {
    return http.post<any, Result<void>>('/model/add', data);
  }

  static async findById(id: number | string): Promise<Result<ModelConfigVO>> {
    return http.get<any, Result<ModelConfigVO>>(`/model/find/${id}`);
  }

  static async deleteById(id: number | string): Promise<Result<void>> {
    return http.get<any, Result<void>>(`/model/del?id=${id}`);
  }

  /**
   * 清除该模型的已存密钥（DELETE /settings/model/credential?id=，§6-6 三态之「清除」）。
   * 与「替换」（update 带新 key）、「保留」（编辑不带 key 字段）并列，禁用空值表达清除。
   */
  static async clearCredential(id: number | string): Promise<Result<void>> {
    return http.delete<any, Result<void>>(`/settings/model/credential?id=${id}`);
  }
}
