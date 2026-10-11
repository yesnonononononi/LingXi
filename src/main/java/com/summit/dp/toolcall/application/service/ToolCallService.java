package com.summit.dp.toolcall.application.service;

import com.summit.dp.shared.vo.ToolCallVO;

import java.util.List;
import java.util.Optional;

/** 工具调用的查询与未决槽位收口；执行恢复由工作流协调。 */
public interface ToolCallService {

    /** 按 {@code toolCallId} 查询聚合视图。 */
    Optional<ToolCallVO> findById(String toolCallId);

    /** 按会话查询工具调用列表（按创建顺序升序）。 */
    List<ToolCallVO> listByConversationId(Long conversationId);

    /** 执行终结时收口全部未决槽位，准备态也不能遗留。 */
    void cancelPendingToolCalls(String executionId);
}
