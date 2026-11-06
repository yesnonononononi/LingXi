package com.summit.dp.workflow.infrastructure.listener.session;

import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.runtime.RuntimeListener;
import com.summit.core.tool.ToolCallStatus;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.projection.TurnViewBroadcaster;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * 工具状态先落库再推块增量，避免前端读到旧状态。
 * 审批命令开始时也需推送，原始无版本事件无法推进已有持久化块。
 */
@Slf4j
@Component
@Order(Ordered.LOWEST_PRECEDENCE)
@RequiredArgsConstructor
public class BlockUpsertRuntimeListener implements RuntimeListener {

    private final TurnViewBroadcaster turnViewBroadcaster;
    private final ChatTurnRepository chatTurnRepository;

    @Override
    public void onToolCall(ToolCallStartEvent event) {
        if (event != null) {
            broadcastToolBlock(event.getRequestId(), event.getExecutionId());
        }
    }

    @Override
    public void onToolCallOutput(ToolCallEndEvent event) {
        if (event == null || event.resultStatus() == ToolCallStatus.PROMISED) {
            return;
        }
        broadcastToolBlock(event.getRequestId(), event.getExecutionId());
    }

    private void broadcastToolBlock(String toolCallId, String executionId) {
        if (toolCallId == null || toolCallId.isBlank()) {
            return;
        }
        try {
            // 轮次靠执行 ID 反查（工具事件只带 executionId，不带 turnId）。
            // 这里<b>不读工具行</b>：归属判断不需要它，读一次就是白白多读一次 raw_output CLOB；
            // 工具行由单块装配路径按需取一次只读投影。
            Long numericExecutionId = ExecutionIdentity.numericOrNull(executionId);
            if (numericExecutionId == null) {
                return;
            }
            chatTurnRepository.findByExecutionId(numericExecutionId)
                    .map(ChatTurn::getId)
                    .ifPresent(turnId -> turnViewBroadcaster.broadcastBlockUpsert(turnId, toolCallId));
        } catch (RuntimeException e) {
            log.warn("推送工具块增量失败（不影响执行本身）: requestId={}, error={}", toolCallId, e.toString());
        }
    }
}
