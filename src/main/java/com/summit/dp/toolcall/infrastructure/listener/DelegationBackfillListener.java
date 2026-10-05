package com.summit.dp.toolcall.infrastructure.listener;

import com.fasterxml.jackson.databind.JsonNode;
import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.lifecycle.ExecutionLifecycleListener;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;

/**
 * 委派结果只能写入已提交的父槽位；本类只做「匹配 → 异步委派」，
 * 落定事务与门闩内细节见 {@link DelegationSettleService}。
 */
@Component
@RequiredArgsConstructor
public class DelegationBackfillListener implements ExecutionLifecycleListener {

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final DelegationSettleService settleService;


    /** 子执行可能先结束，父槽位提交后必须按明确的子执行身份再核对。 */
    @Override
    public void onExecutionSuspended(String executionId, Execution execution) {
        for (ToolCall slot : toolCallRepository.listUnresolvedByExecutionId(Long.valueOf(executionId))) {
            if (converter.resolveKind(slot.getContent()) != ToolCallKind.DELEGATION) continue;
            JsonNode content = converter.parse(slot.getContent());
            if (content == null || !content.hasNonNull(ToolCallKeys.SUB_EXECUTION_ID)) continue;
            String childId = content.get(ToolCallKeys.SUB_EXECUTION_ID).asText();
            executionRepository.getObject().findById(childId).ifPresent(child -> {
                if (ExecutionStatusCodes.isTerminalState(child.getExecutionState())) {
                    CompletableFuture.runAsync(() -> settle(new BackfillTarget(slot, Long.valueOf(executionId), child)));
                }
            });
        }
    }

    @Override
    public void onExecutionFinished(String executionId, Execution execution) {
        BackfillTarget target = matchParentSlot(execution);
        if (target != null) {
            // 异步落定；失败处理在 settle 的事务内，不在同步广播的保护范围内。
            CompletableFuture.runAsync(() -> settle(target));
        }
    }

    /**
     * 判断刚终结的执行是否有父执行的待回填委派槽位；有则构造回填目标，无则返回 {@code null}。
     * 主执行（无 {@code ROOT_EXECUTION_ID}）、旧格式数据（升级前挂起的子执行，父侧没有
     * DELEGATION 槽位）都在这里自然短路，保持旧行为。包私有仅供测试直调。
     */
    BackfillTarget matchParentSlot(Execution execution) {
        if (execution == null) {
            return null;
        }
        Map<String, Object> attributes = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
        Long parentExecutionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.ROOT_EXECUTION_ID);
        if (parentExecutionId == null) {
            return null;
        }
        String subSessionId = String.valueOf(ExecutionIdentity.sessionId(attributes));
        ToolCall slot = toolCallRepository.listUnresolvedByExecutionId(parentExecutionId).stream()
                .filter(call -> converter.resolveKind(call.getContent()) == ToolCallKind.DELEGATION)
                .filter(call -> Objects.equals(subSessionId, resolveSubSessionId(call)))
                .filter(call -> {
                    JsonNode content = converter.parse(call.getContent());
                    return content == null || !content.hasNonNull(ToolCallKeys.SUB_EXECUTION_ID)
                            || Objects.equals(execution.getId(), content.get(ToolCallKeys.SUB_EXECUTION_ID).asText());
                })
                .findFirst()
                .orElse(null);
        return slot == null ? null : new BackfillTarget(slot, parentExecutionId, execution);
    }

    private String resolveSubSessionId(ToolCall call) {
        JsonNode node = converter.parse(call.getContent());
        return node == null || !node.hasNonNull(ToolCallKeys.SUB_SESSION_ID)
                ? null : node.get(ToolCallKeys.SUB_SESSION_ID).asText();
    }

    /**
     * 回填落定。包私有保留：{@code DelegationBackfillListenerTest} 直调本方法验证事务与门闩边界，
     * 实际实现已转交 {@link DelegationSettleService}。
     */
    void settle(BackfillTarget target) {
        settleService.settle(target, executionRepository.getObject());
    }

    /** 一次待落定的回填：父执行上的槽位卡片 + 刚终结的子执行。 */
    record BackfillTarget(ToolCall slot, long parentExecutionId, Execution subExecution) {
    }
}
