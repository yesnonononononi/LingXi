package com.summit.dp.toolcall.application.service;

import com.summit.dp.shared.vo.ToolCallVO;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Optional;

/**
 * 工具调用应用服务：读侧查询 + 决策事务编排。
 *
 * <p><b>与登记器的分工：</b>{@link ToolCallRegistrar} 负责「写」（唯一登记器，被工具 executor 依赖）；
 * 本服务负责「读 + 决策编排」，持有 {@code ExecutionControl} / {@code ExecutionRepository} 等
 * 重量级依赖（经 {@code ObjectProvider} 延迟取用以断开构造期闭环）。</p>
 */
public interface ToolCallService {

    /** 按 {@code toolCallId} 查询聚合视图。 */
    Optional<ToolCallVO> findById(String toolCallId);

    /** 按会话查询工具调用列表（按创建顺序升序）。 */
    List<ToolCallVO> listByConversationId(Long conversationId);

    /**
     * 落定用户决策并恢复被暂停的执行，返回承载恢复期间事件流的 emitter。
     *
     * <p>PLAN/CHOICE 为单事务；COMMAND 因外部副作用拆为两段式（T1 提交先于副作用）。
     * 事务提交先于 {@code connect} + {@code resume}。</p>
     *
     * @param conversationId 会话 id（= tool_call.conversation_id），可为空（不做归属校验）
     * @param toolCallId     工具调用 id（定位键）
     * @param approved       是否批准
     * @param text           用户答复原文，可为空
     */
    SseEmitter decide(Long conversationId, String toolCallId, boolean approved, String text);

    /** 发布该执行下所有 pending PROMISE 卡片事件（按根会话定向推送）。 */
    void publishPendingToolCalls(String executionId);

    /** 执行终结（失败 / 完成 / 取消）时把该执行下所有 pending 工具调用收尾为 completed（outcome=CANCELLED）。 */
    void cancelPendingToolCalls(String executionId);
}
