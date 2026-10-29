import http from './interceptor';
import type { Result } from './types';
import type { PageResult, McpVO, McpRequest, McpConnectionVO } from '../types/chat';

// 初始化可能先检测协议再回退握手，HTTP 等待时间须覆盖两次初始化和工具发现。
function resolveConnectionTimeout(data: McpRequest): number {
  return 2 * (data.initializationTimeout ?? 30_000) + (data.executionTimeout ?? 60_000) + 10_000;
}

/**
 * 收敛 `protocolVersion`：空白字符串视为「未设置」。
 *
 * 契约 2.2 铁律要求 null 原样透传（= 保持库默认的协议探测），因此这里**只**把
 * 空串/纯空白归一成 null——空串发到后端会被 2.3 的护栏判成非法协议版本。
 * 非字符串输入（脏数据）同样归一成 null，绝不编造业务默认值。
 *
 * @param value 表单/视图层给出的原始取值
 * @returns 裁剪后的协议版本；未设置时返回 null
 */
function normalizeProtocolVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 透传 4 个容错调参字段（契约 2.1 / 2.2）。
 *
 * 规则：
 * 1. 调用方**没有**携带该键时不补键——避免只提交部分字段的调用（如列表内启停）
 *    顺手把别的字段写空；
 * 2. 携带了就原样下发，`undefined` 一律收敛成 `null`，因为「空」= 不设置 = 库默认，
 *    而不是某个前端默认值；
 * 3. 只对 `protocolVersion` 做空白裁剪，其余字段不做任何取值改写。
 *
 * @param data 原始请求体，不被就地修改
 * @returns 浅拷贝后的请求体
 */
function passTuningThrough(data: McpRequest): McpRequest {
  const payload: McpRequest = { ...data };
  if ('protocolVersion' in data) {
    payload.protocolVersion = normalizeProtocolVersion(data.protocolVersion);
  }
  if ('autoHealthCheck' in data) {
    payload.autoHealthCheck = data.autoHealthCheck ?? null;
  }
  if ('healthCheckInterval' in data) {
    payload.healthCheckInterval = data.healthCheckInterval ?? null;
  }
  if ('reconnectInterval' in data) {
    payload.reconnectInterval = data.reconnectInterval ?? null;
  }
  return payload;
}

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
    return http.post<any, Result<void>>('/mcp/add', passTuningThrough(data), { timeout: resolveConnectionTimeout(data) });
  }

  /** 连接测试 (POST /mcp/connect)；容错调参字段同样透传，测试结果才与保存后一致 */
  static async connect(data: McpRequest): Promise<Result<McpConnectionVO>> {
    return http.post<any, Result<McpConnectionVO>>('/mcp/connect', passTuningThrough(data), { timeout: resolveConnectionTimeout(data) });
  }

  /** 更新 MCP 服务 (POST /mcp/update) */
  static async update(data: McpRequest): Promise<Result<void>> {
    return http.post<any, Result<void>>('/mcp/update', passTuningThrough(data), { timeout: resolveConnectionTimeout(data) });
  }

  /** 删除 MCP 服务 (GET /mcp/del/{id}) */
  static async delById(id: number | string): Promise<Result<void>> {
    return http.get<any, Result<void>>(`/mcp/del/${id}`);
  }
}
