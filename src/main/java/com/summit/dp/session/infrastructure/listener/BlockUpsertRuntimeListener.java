package com.summit.dp.session.infrastructure.listener;

import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.runtime.RuntimeListener;
import com.summit.core.tool.ToolCallStatus;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.application.service.TurnViewBroadcaster;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * 工具收尾时的**块增量**推送：某个工具块的结论落定即推一帧 {@code BLOCK_UPSERT}。
 *
 * <p><b>为什么是增量而不是整轮快照</b>：一次工具收尾只改变一个工具块的状态，
 * 重发整轮块列表是纯流量浪费（一轮里可能有几十个工具调用）。前端按 {@code blockId} upsert，
 * 契约上增量与快照共用同一 {@code TurnViewVO} 形状，只是 {@code blocks} 只含变化的块。</p>
 *
 * <p><b>与 {@code ToolCallExecutionListener} 的关系</b>：那个类负责把结果**落库**
 * （{@code tool_call} 行），本类负责把落库结果**播出去**。顺序不可反 ——
 * 推送读的是 {@code tool_call} 的已落库行，先推后写会让前端看到旧状态。
 * 因此本类 order 取 {@link Ordered#LOWEST_PRECEDENCE}，保证在落库监听器之后跑。</p>
 *
 * <p><b>PROMISE 工具不在此推送</b>：它们的结论由决策端点收尾，那个路径自己触发快照；
 * 在这里推会与实际状态竞争的中间态。</p>
 */
@Slf4j
@Component
@Order(Ordered.LOWEST_PRECEDENCE)
@RequiredArgsConstructor
public class BlockUpsertRuntimeListener implements RuntimeListener {

    private final TurnViewBroadcaster turnViewBroadcaster;
    private final ToolCallRepository toolCallRepository;
    private final ChatTurnRepository chatTurnRepository;

    @Override
    public void onToolCallOutput(ToolCallEndEvent event) {
        if (event == null || event.resultStatus() == ToolCallStatus.PROMISED) {
            return;
        }
        String toolCallId = event.getRequestId();
        if (toolCallId == null || toolCallId.isBlank()) {
            return;
        }
        try {
            // 工具行上有会话归属；轮次靠执行 ID 反查（工具事件只带 executionId，不带 turnId）。
            ToolCall toolCall = toolCallRepository.findById(toolCallId).orElse(null);
            if (toolCall == null || toolCall.getConversationId() == null) {
                return;
            }
            Long executionId = ExecutionIdentity.numericOrNull(event.getExecutionId());
            if (executionId == null) {
                return;
            }
            chatTurnRepository.findByExecutionId(executionId)
                    .map(ChatTurn::getId)
                    .ifPresent(turnId -> turnViewBroadcaster.broadcastBlockUpsert(turnId, toolCallId));
        } catch (RuntimeException e) {
            log.warn("推送工具块增量失败（不影响执行本身）: requestId={}, error={}", toolCallId, e.toString());
        }
    }
}
