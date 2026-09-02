package com.summit.dp.session.domain.repo;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.core.conversation.ConversationEntity;
import com.summit.core.conversation.ConversationStore;

/**
 * 会话仓储。
 * <p>会话的领域实体为 core 中的 {@link ConversationEntity}（聚合：sessionId、会话名、消息列表、
 * Token 用量、系统提示词与工作区），持久化实现同时承担 agent 运行期会话历史的读写。</p>
 */
public interface SessionRepository extends ConversationStore {

    /**
     * 新增会话并返回数据库自增 id。
     */
    Long saveAndReturnId(ConversationEntity entity);

    /**
     * 分页查询会话列表（按 id 倒序）。
     */
    Page<ConversationEntity> page(int page, int pageSize);
}
