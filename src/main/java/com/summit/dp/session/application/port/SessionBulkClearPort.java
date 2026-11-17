package com.summit.dp.session.application.port;

/**
 * 整库清空会话与衍生数据的端口（保留团队、智能体、用户、模型、MCP、工作空间等配置表）。
 *
 * <p>实现必须避免 N+1 查询与长事务（按表独立短事务批量截断，并在库清理完成后回收磁盘目录）。</p>
 */
public interface SessionBulkClearPort {

    void clearAllSessionData();
}
