import http from './interceptor';
import type { Result } from './types';
import type { PageResult, McpVO, McpRequest } from '../types/chat';

/** MCP 服务 API (对应后端 McpController) */
export class McpAPI {
  /** 分页获取 MCP 服务列表 (GET /mcp/list?page=1&pageSize=20) */
  static async list(page = 1, pageSize = 20): Promise<Result<PageResult<McpVO>>> {
    return http.get<any, Result<PageResult<McpVO>>>(`/mcp/list?page=${page}&pageSize=${pageSize}`);
  }

  /** 根据 ID 查询 MCP 服务详情 (GET /mcp/find/{id}) */
  static async findById(id: number | string): Promise<Result<McpVO>> {
    return http.get<any, Result<McpVO>>(`/mcp/find/${id}`);
  }

  /** 新增 MCP 服务 (POST /mcp/add) */
  static async add(data: McpRequest): Promise<Result<void>> {
    return http.post<any, Result<void>>('/mcp/add', data);
  }

  /** 更新 MCP 服务 (POST /mcp/update) */
  static async update(data: McpRequest): Promise<Result<void>> {
    return http.post<any, Result<void>>('/mcp/update', data);
  }

  /** 删除 MCP 服务 (GET /mcp/del/{id}) */
  static async delById(id: number | string): Promise<Result<void>> {
    return http.get<any, Result<void>>(`/mcp/del/${id}`);
  }
}
