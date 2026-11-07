package com.summit.dp.workflow.infrastructure.listener.session;

import com.summit.core.conversation.event.AgentEvent;
import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.runtime.RuntimeListener;
import com.summit.core.tool.ToolCallStatus;
import com.summit.dp.session.application.convert.ToolBlockEventFacts;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.projection.TurnBroadcastIdentity;
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
 *
 * <p><b>归属优先取自事件元数据</b>：框架的工具事件带着执行构造时生成的归属快照
 * （{@code turnId} / {@code sessionId} / {@code rootSessionId}）。工具调用一轮几十次，
 * 每次都按执行 ID 反查轮次、再让广播器解析一次根会话，等于把「推送一帧」变成三次查库。
 * 元数据齐备时本类只把事实与归属原样交给广播器，<b>一次反查都不做</b>。</p>
 *
 * <p><b>回退保留</b>：重启前落盘的执行元数据没有这两个键（旧检查点），这类执行仍在上报事件。
 * 此时沿用改造前的「执行 ID → 轮次」反查；归属依然拿不到就丢弃，绝不改投别的会话。</p>
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
            broadcastToolBlock(new ToolBlockEventFacts(event.getRequestId(), event.getResponseId(),
                    event.getRequestIndex(), event.getToolName(), event.getArgs()), event);
        }
    }

    @Override
    public void onToolCallOutput(ToolCallEndEvent event) {
        if (event == null || event.resultStatus() == ToolCallStatus.PROMISED) {
            return;
        }
        broadcastToolBlock(new ToolBlockEventFacts(event.getRequestId(), event.getResponseId(),
                event.getRequestIndex(), event.getToolName(), event.getArgs()), event);
    }

    /**
     * 推一帧工具块增量：元数据齐备走权威身份，缺失才回退反查。
     *
     * <p>本方法<b>不读工具行</b>：归属判断不需要它，读一次就是白白多读一次 {@code raw_output} CLOB；
     * 工具行由单块装配路径按需取一次只读投影。</p>
     *
     * @param facts 事件带来的块事实
     * @param event 框架事件（提供元数据与执行 ID）
     */
    private void broadcastToolBlock(ToolBlockEventFacts facts, AgentEvent event) {
        if (facts == null || facts.toolCallId() == null || facts.toolCallId().isBlank()) {
            return;
        }
        try {
            TurnBroadcastIdentity identity = TurnBroadcastIdentity.fromEventMetadata(event.eventMetaData());
            if (identity != null) {
                turnViewBroadcaster.broadcastBlockUpsert(identity, facts);
                return;
            }
            broadcastWithExecutionLookup(facts, event);
        } catch (RuntimeException e) {
            log.warn("推送工具块增量失败（不影响执行本身）: requestId={}, error={}",
                    facts.toolCallId(), e.toString());
        }
    }

    /**
     * 旧检查点的回退路径：工具事件只带 {@code executionId} 时靠它反查轮次。
     *
     * <p>反查不到就丢弃 —— 这正对应「拿不到归属就不推送」，与主路径的丢弃语义一致。</p>
     */
    private void broadcastWithExecutionLookup(ToolBlockEventFacts facts, AgentEvent event) {
        Long numericExecutionId = ExecutionIdentity.numericOrNull(event.executionId());
        if (numericExecutionId == null) {
            log.debug("工具事件缺少可解析的执行 ID，跳过推送: requestId={}", facts.toolCallId());
            return;
        }
        chatTurnRepository.findByExecutionId(numericExecutionId)
                .map(ChatTurn::getId)
                .ifPresentOrElse(turnId -> turnViewBroadcaster.broadcastBlockUpsert(turnId, facts),
                        () -> log.debug("工具事件无法归到轮次，跳过推送: executionId={}", event.executionId()));
    }
}
