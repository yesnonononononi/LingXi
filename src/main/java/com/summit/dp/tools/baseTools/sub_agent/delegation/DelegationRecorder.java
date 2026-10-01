package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.agent.AgentRequest;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.infrastructure.event.SubAgentSessionEventPublisher;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Instant;

/**
 * 委派落账：把一次委派记成<b>可见事实</b>——子会话映射事件、子轮次、transcript 追加。
 *
 * <p>从 {@code CallSubAgentTool} 拆出的记录职责：编排器只决定「何时记」，本类独占「记什么、
 * 按什么归属记」。三条记录的归属规则都在这里，改动归属口径不必再读懂委派编排。</p>
 *
 * <p><b>两条时序约束：</b>映射事件在复用与首派两条路径上都要发（前端据它建立
 * 「子会话 id → 根会话」路由，事件幂等，复用不产生第二张卡片）；<b>必须先建轮次、
 * 再写消息</b>——消息要带 turn_id，反过来就写不出正确归属。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DelegationRecorder {

    private final SubAgentSessionEventPublisher subAgentSessionEventPublisher;
    private final ChatTurnService chatTurnService;
    private final ConversationTranscriptService transcriptService;

    /**
     * 记录一次委派：发映射事件 → 建子轮次（并把子执行的事件元数据指向它）→ 追加 transcript。
     *
     * @return 子轮次 id（本次委派自己的轮次，用量与消息归属都以它为准）
     * @throws RuntimeException transcript 写失败时原样上抛——消息没写成就<b>不留孤立轮次</b>，
     *                          轮次已在本方法内收口为失败终态
     */
    public long record(Long rootSessionId, ToolExecution toolExecution, AgentRequest request,
                       Long numericSubSessionId, String subSessionId, AgentVO agent, String task) {
        subAgentSessionEventPublisher.publish(toolExecution.getTurnId(), rootSessionId, subSessionId,
                agent.getId(), agent.getName(), task, toolExecution.getId());

        // 子轮次：与子会话的 USER 行同源归属。parentTurnId 指向**发起本次委派的主轮次**，
        // 从父工具执行的事件元数据读取，不反查执行对应的轮次。
        // 子会话会被复用，所以每次委派都必须新建一个子轮次，否则多次委派会共用一条统计。
        Long parentTurnId = ExecutionEventMetadata.turnId(toolExecution.getEventMetaData());
        long childTurnId = chatTurnService.acceptTurn(numericSubSessionId, parentTurnId,
                ExecutionIdentity.numericOrNull(request.getExecutionId()),
                request.getModelConfig() == null ? null : request.getModelConfig().getModelName(),
                request.getModelConfig() == null ? null : request.getModelConfig().getProvider());
        request.runtimeParametersOrDefault().setEventMetaData(
                ExecutionEventMetadata.of(numericSubSessionId, childTurnId, parentTurnId));

        try {
            // 复用与首派都要把本次任务追加进 transcript：子会话的消息流是 append-only 的可见记录。
            // 归属用**本次委派自己的轮次**（而不是「子会话最新轮次」）：子会话会被复用，
            // 同一个子会话先后承载多次委派，按会话累计用量推算本轮消耗必然错位。
            transcriptService.appendUser(numericSubSessionId, childTurnId, UserMessageEntity.from(task));
        } catch (RuntimeException e) {
            // 消息没写成 → **不留孤立轮次**：把它收口为失败终态。
            // 委派确实没跑起来，这个状态是如实的；比起留一条永远 ACCEPTED 的轮次更可解释。
            markTurnFailedQuietly(request, e);
            throw e;
        }
        return childTurnId;
    }

    /**
     * 消息没写成时收口子轮次，避免留下一条永远 ACCEPTED 的**孤立轮次**。
     *
     * <p>收口本身失败只告警：原始异常更重要，不能因为清理动作再抛一个把原因盖掉。</p>
     */
    private void markTurnFailedQuietly(AgentRequest request, RuntimeException cause) {
        Long executionId = ExecutionIdentity.numericOrNull(request.getExecutionId());
        if (executionId == null) {
            return;
        }
        try {
            chatTurnService.markTerminal(String.valueOf(executionId), ChatTurnStatus.FAILED,
                    null, null, null, Instant.now());
        } catch (RuntimeException markFailure) {
            log.warn("收口子轮次失败（不影响原始异常）: executionId={}, cause={}, 收口失败原因={}",
                    executionId, cause.toString(), markFailure.toString());
        }
    }
}
