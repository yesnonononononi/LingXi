package com.summit.dp.toolcall.domain.repo;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.toolcall.domain.model.ToolCall;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/**
 * {@code tool_call} 表仓储：工具调用状态与卡片载荷的唯一读写入口。
 *
 * <p><b>写操作约定：</b>调用方必须先把 {@link ToolCall} 通过其充血方法流转到目标状态，
 * 再整行落库；本仓储不提供「直接改 status 列」的便捷方法，状态机不会在持久化层被绕过。</p>
 */
public interface ToolCallRepository extends RepositoryTemplate<ToolCall, String> {

    @Override
    Optional<ToolCall> findById(String id);

    /** 分页装配主路径：一次 {@code IN} 批量查（去重集合由调用方保证）。 */
    List<ToolCall> listByIds(Collection<String> ids);

    List<ToolCall> listByConversationId(Long conversationId);

    List<ToolCall> listByExecutionId(Long executionId);

    List<ToolCall> listPendingByExecutionId(Long executionId);

    List<ToolCall> listPendingByConversationId(Long conversationId);

    default List<ToolCall> listUnresolvedByExecutionId(Long executionId) {
        return listByExecutionId(executionId).stream().filter(ToolCall::isUnresolved).toList();
    }

    List<ToolCall> listActionableByExecutionId(Long executionId);

    List<Long> listUnresolvedExecutionIds();

    /** 登记器幂等判定：同一 call id 是否已存在记录。 */
    boolean existsById(String id);

    long countByConversationId(Long conversationId);

    /** 会话删除级联：按 {@code conversation_id} 批量清理，返回删除行数。 */
    int deleteByConversationIds(Collection<Long> conversationIds);

    /**
     * 重发回滚级联：按一批执行 ID 批量清理工具调用卡片，返回删除行数。
     *
     * <p>按执行 ID 而不是消息 ID 定位：卡片与消息并非一一对应（审批卡片可以没有 TOOL 消息行，
     * 而 {@code session_message_id} 锚点只做尽力回填），只有执行 ID 是每张卡片必然带的归属。</p>
     */
    int deleteByExecutionIds(Collection<Long> executionIds);

    /** 尽力回填 TOOL 行锚点：设置 {@code session_message_id}。 */
    void bindSessionMessage(String toolCallId, Long sessionMessageId);
}
