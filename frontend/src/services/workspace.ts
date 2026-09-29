import http from './interceptor';
import type { Result } from './types';
import type { PageResult, WorkspaceVO, WorkspaceRequest } from '../types/chat';

/** 4. 工作空间 API (对应后端 WorkspaceController) */
export class WorkspaceAPI {
  static async list(page = 1, pageSize = 50): Promise<Result<PageResult<WorkspaceVO>>> {
    return http.get<any, Result<PageResult<WorkspaceVO>>>(`/workspace/list?page=${page}&pageSize=${pageSize}`);
  }

  static async findById(id: number | string): Promise<Result<WorkspaceVO>> {
    return http.get<any, Result<WorkspaceVO>>(`/workspace/find/${id}`);
  }

  static async add(data: WorkspaceRequest): Promise<Result<number>> {
    return http.post<any, Result<number>>('/workspace/add', data);
  }

  static async del(id: number | string): Promise<Result<void>> {
    return http.get<any, Result<void>>(`/workspace/del?id=${id}`);
  }
}
