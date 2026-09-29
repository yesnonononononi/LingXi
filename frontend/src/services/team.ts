import http from './interceptor';
import type { Result } from './types';
import type { PageResult, TeamVO, CreateTeamRequest, UpdateTeamRequest } from '../types/chat';

/** Team 团队 API (对应后端 TeamController) */
export class TeamAPI {
  /** 分页获取 Team 列表 (GET /team/list?page=1&pageSize=20) */
  static async list(page = 1, pageSize = 20): Promise<Result<PageResult<TeamVO>>> {
    return http.get<any, Result<PageResult<TeamVO>>>(`/team/list?page=${page}&pageSize=${pageSize}`);
  }

  /** 根据 ID 查询 Team 详情 (GET /team/find/{id}) */
  static async findById(id: number | string): Promise<Result<TeamVO>> {
    return http.get<any, Result<TeamVO>>(`/team/find/${id}`);
  }

  /** 创建 Team 团队 (POST /team/add) */
  static async add(data: CreateTeamRequest): Promise<Result<void>> {
    return http.post<any, Result<void>>('/team/add', data);
  }

  /** 更新 Team 团队 (POST /team/update) */
  static async update(data: UpdateTeamRequest): Promise<Result<void>> {
    return http.post<any, Result<void>>('/team/update', data);
  }

  /** 删除 Team 团队 (GET /team/del/{id}) */
  static async delById(id: number | string): Promise<Result<void>> {
    return http.get<any, Result<void>>(`/team/del/${id}`);
  }
}

