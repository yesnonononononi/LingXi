import http from './interceptor';
import type { Result } from './types';
import type { SessionBootstrapVO, SessionMessagePageVO, SessionTreeVO, SessionVO } from '../types/chat';

export interface SessionCreateRequest {
  name: string;
  workspaceId?: number | string | null;
  /** 建会话时一并绑定的团队；不传即非团队会话，后续可经 bindTeam 换绑。 */
  teamId?: number | string | null;
}

/** 3. 会话 API (对应后端 SessionController) */
export class SessionAPI {
  static async list(page = 1, pageSize = 50): Promise<Result<any>> {
    return http.get<any, Result<any>>(`/session/list?page=${page}&pageSize=${pageSize}`);
  }

  /**
   * 创建新会话
   * 对应后端 @PostMapping("/session/create")
   */
  static async create(data: SessionCreateRequest): Promise<Result<string | number>> {
    // ID 一律按原始形态透传，禁止 Number() 强转：
    // 雪花 ID 超出 Number.MAX_SAFE_INTEGER，强转即失精度。
    return http.post<any, Result<string | number>>('/session/create', {
      name: data.name,
      workspaceId: data.workspaceId ?? null,
      teamId: data.teamId ?? null,
    });
  }

  /**
   * 换绑会话的协作团队（前端团队下拉框选中的同步落点）。
   * 对应后端 @PostMapping("/{id}/team")；teamId 传 null/空即解绑。
   *
   * <p>teamId 作为 query 参数下发：雪花 ID 走 JSON body 会被 JS Number 抹掉精度，
   * 原样以字符串传递最安全。</p>
   */
  static async bindTeam(id: number | string, teamId: number | string | null): Promise<Result<void>> {
    const query = teamId === null || teamId === undefined || teamId === ''
      ? ''
      : `?teamId=${encodeURIComponent(String(teamId))}`;
    return http.post<any, Result<void>>(`/session/${id}/team${query}`);
  }

  /**
   * 按雪花主键游标分页拉取会话消息；cursor 为空表示拉取最新的一页，
   * 传入游标则拉取比它更早的一页
   * 对应后端 @GetMapping("/{id}/messages")
   */
  static async messages(
    id: number | string,
    cursor?: string | null,
    size = 50
  ): Promise<Result<SessionMessagePageVO>> {
    const params = new URLSearchParams();
    if (size) params.append('size', String(size));
    if (cursor && cursor.trim()) params.append('cursor', cursor.trim());
    const query = params.toString() ? `?${params.toString()}` : '';
    return http.get<any, Result<SessionMessagePageVO>>(`/session/${id}/messages${query}`);
  }

  static async update(id: number | string, name: string): Promise<Result<void>> {
    return http.post<any, Result<void>>('/session/update', { id, name });
  }

  static async del(id: number | string): Promise<Result<void>> {
    return http.get<any, Result<void>>(`/session/del?id=${id}`);
  }

  /**
   * 按 ID 查询单个会话元数据
   * 对应后端 @GetMapping("/{id}")
   */
  static async findById(id: number | string): Promise<Result<SessionVO>> {
    return http.get<any, Result<SessionVO>>(`/session/${id}`);
  }

  /**
   * 会话树：一次返回根会话 + 其下全部子会话（平铺列表）
   * 传根会话 id 或子会话 id 都可以，后端自动解析出真正的根会话
   * 对应后端 @GetMapping("/{id}/tree")
   */
  static async tree(id: number | string): Promise<Result<SessionTreeVO>> {
    return http.get<any, Result<SessionTreeVO>>(`/session/${id}/tree`);
  }

  /**
   * v3 显式同步入口：一次读回根会话树摘要、历史首屏、未决卡片、进行中轮次与活跃/挂起执行。
   *
   * <p>对应后端 {@code GET /session/{rootSessionId}/bootstrap}（design §8.2）。这是 v3 前端
   * 在收到 {@code STREAM_READY} 后发起的**唯一一次**持久化状态读取：实时帧只负责增量，
   * 断线期间的状态由它兜底，不靠超时轮询库（§1 禁止的读路径）。</p>
   *
   * @param rootSessionId 根会话 ID（传子会话 ID 后端也会解析到根）
   */
  static async bootstrap(rootSessionId: number | string): Promise<Result<SessionBootstrapVO>> {
    return http.get<any, Result<SessionBootstrapVO>>(
      `/session/${encodeURIComponent(String(rootSessionId))}/bootstrap`
    );
  }
}
