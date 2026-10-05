package com.summit.dp.toolcall.application.service;

import cn.hutool.core.util.IdUtil;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.domain.lifecycle.ExecutionActivity;
import com.summit.dp.execution.domain.lifecycle.ExecutionCoordination;
import com.summit.dp.shared.event.ToolCallEventPublisher;
import com.summit.dp.shared.event.ToolCallPendingEvent;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.stream.application.protocol.StreamV3Event;
import com.summit.dp.stream.application.protocol.StreamV3EventType;
import com.summit.dp.stream.application.service.EventStreamPublisher;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** 卡片开放必须晚于检查点提交和旧信号释放。 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ToolCallReadinessService {
    private final ToolCallRepository tools;
    private final ToolCallConverter converter;
    private final ExecutionIdentity identity;
    private final ToolCallEventPublisher events;
    private final TransactionTemplate transactions;
    private final ObjectProvider<ExecutionRepository> executions;
    private final ObjectProvider<ExecutionActivity> activity;
    private final ObjectProvider<EventStreamPublisher> v3Publisher;

    public void markReady(String executionId) {
        synchronized (ExecutionCoordination.monitor(executionId)) {
            ExecutionRepository repository = executions.getObject();
            Execution execution = repository.findById(executionId).orElse(null);
            if (execution == null || execution.getExecutionState() != ExecutionState.SUSPENDED
                    || activity.getObject().isActive(executionId)) return;
            List<ToolCall> ready = new ArrayList<>();
            TransactionTemplate readinessTransaction = new TransactionTemplate(transactions.getTransactionManager());
            readinessTransaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            readinessTransaction.executeWithoutResult(status -> {
                for (ToolCall tool : tools.listUnresolvedByExecutionId(Long.valueOf(executionId))) {
                    if (tool.markReady()) {
                        tools.updateById(tool);
                        ready.add(tool);
                    }
                }
                repository.afterCommit(() -> publishReady(execution, executionId, ready));
            });
        }
    }

    /**
     * 提交后直接下发**完整卡片 DTO**，不再走「只发身份、前端逐卡回查」的主路径（§7）。
     *
     * <p><b>执行事实已知</b>：此处执行刚被判定为 SUSPENDED 且控制信号已释放，因此用纯计算入口
     * {@link ToolCallConverter#toVO(ToolCall, CardAvailabilityPolicy.ExecutionGate)} 直接算动作，
     * 禁止再逐卡回查执行（那正是要删除的 N+1）。</p>
     *
     * <p><b>双链并存</b>：v3 走直投 {@code TOOL_CALL_UPDATED}（载荷为完整 {@link ToolCallVO}）；
     * v2 仍发 {@code CARD_PENDING} 身份事件保持旧界面可用。新旧以卡片 version 判断，不依赖 eventId。</p>
     */
    private void publishReady(Execution execution, String executionId, List<ToolCall> ready) {
        if (ready == null || ready.isEmpty()) {
            return;
        }
        Map<String, Object> metadata = execution.eventMetaData();
        String streamKey = ExecutionEventMetadata.streamKey(metadata);
        // 卡片归属的会话/轮次/代际全部取自执行元数据：它就在手上，回查执行表或让前端
        // 「按最新 assistant 猜归属」都是多余的。子执行的元数据指向子会话，因此子卡片
        // 天然落到子会话身份上，不需要前端额外解析。
        String metadataSessionId = text(metadata, ExecutionEventMetadata.SESSION_ID);
        String turnId = text(metadata, ExecutionEventMetadata.TURN_ID);
        String historyRevision = text(metadata, ExecutionEventMetadata.HISTORY_REVISION);
        long rootId;
        try {
            Long resolved = ExecutionEventMetadata.parseRootSessionId(metadata);
            rootId = resolved != null ? resolved
                    : identity.resolveRootSessionId(ready.getFirst().getConversationId());
        } catch (RuntimeException error) {
            log.error("卡片就绪通知失败：无法解析根会话: executionId={}, error={}", executionId, error.toString());
            return;
        }
        EventStreamPublisher publisher = v3Publisher == null ? null : v3Publisher.getIfAvailable();
        for (ToolCall tool : ready) {
            try {
                // 纯计算：执行刚被判定为可决策的挂起点，动作不再逐卡回查。
                ToolCallVO card = converter.toVO(tool, CardAvailabilityPolicy.ExecutionGate.SUSPENDED);
                // 元数据缺会话时回落卡片自身的 conversationId：旧检查点可能没有 SESSION_ID 键，
                // 而卡片一定知道自己在哪个会话里。
                String cardSessionId = metadataSessionId != null ? metadataSessionId
                        : (tool.getConversationId() == null ? null : String.valueOf(tool.getConversationId()));
                if (publisher != null) {
                    publisher.publish(rootId, toolCallUpdated(
                            rootId, cardSessionId, turnId, historyRevision, executionId, streamKey, card));
                }
                ToolCallKind kind = converter.resolveKind(tool.getContent());
                events.publish(rootId, ToolCallPendingEvent.of(rootId, tool.getId(),
                        kind == null ? null : kind.name(), String.valueOf(tool.getConversationId()), executionId));
            } catch (RuntimeException error) {
                log.error("就绪通知失败: executionId={}, toolCallId={}", executionId, tool.getId(), error);
            }
        }
    }

    /**
     * 构造 v3 {@code TOOL_CALL_UPDATED} 帧：身份取自执行元数据，载荷即完整卡片。
     *
     * <p><b>身份必须完整</b>：{@code sessionId} 决定这张卡片属于主会话还是子会话，
     * {@code turnId} 是它与回答组对位的键。缺一个，前端就只能靠位置猜测，而猜测在多执行并发时必错。</p>
     */
    private StreamV3Event toolCallUpdated(long rootId, String sessionId, String turnId,
                                          String historyRevision, String executionId,
                                          String streamKey, ToolCallVO card) {
        StreamV3Event.Identity identity = new StreamV3Event.Identity(
                String.valueOf(rootId), sessionId, turnId, executionId, historyRevision, streamKey);
        return StreamV3Event.of(String.valueOf(IdUtil.getSnowflakeNextId()), identity,
                StreamV3EventType.TOOL_CALL_UPDATED, Instant.now(), card);
    }

    /** 读元数据里的字符串值；缺失或空白返回 {@code null}（不把空串当成身份）。 */
    private static String text(Map<String, Object> metadata, String key) {
        Object value = metadata == null ? null : metadata.get(key);
        if (value == null) {
            return null;
        }
        String text = value.toString();
        return text.isBlank() ? null : text;
    }
}
