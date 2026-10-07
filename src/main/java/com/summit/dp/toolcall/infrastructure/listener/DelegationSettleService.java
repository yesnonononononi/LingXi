package com.summit.dp.toolcall.infrastructure.listener;

import com.fasterxml.jackson.databind.JsonNode;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.execution.domain.lifecycle.ExecutionCoordination;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.impl.ExecutionToolSlot;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.baseTools.sub_agent.result.SubAgentResultRenderer;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;

/**
 * 委派结果只回填已提交的父槽位；子执行先结束时，在父执行挂起后再次校准。
 * 恢复派发必须在父执行门闩外，避免模型运行阻塞其他决策。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DelegationSettleService {

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final SubAgentResultRenderer resultRenderer;
    private final ModelContextService modelContextService;
    private final TransactionTemplate transactions;
    private final ExecutionResumeCoordinator resumeCoordinator;
    private final ObjectProvider<ExecutionRepository> executionRepository;

    /** 父槽位提交可能晚于子执行终结，必须按子执行身份重新核对。 */
    public void reconcileSuspendedExecution(String executionId) {
        for (ToolCall slot : toolCallRepository.listUnresolvedByExecutionId(Long.valueOf(executionId))) {
            if (converter.resolveKind(slot.getContent()) != ToolCallKind.DELEGATION) continue;
            JsonNode content = converter.parse(slot.getContent());
            if (content == null || !content.hasNonNull(ToolCallKeys.SUB_EXECUTION_ID)) continue;
            String childId = content.get(ToolCallKeys.SUB_EXECUTION_ID).asText();
            executionRepository.getObject().findById(childId).ifPresent(child -> {
                if (ExecutionStatusCodes.isTerminalState(child.getExecutionState())) {
                    CompletableFuture.runAsync(() -> settle(new BackfillTarget(slot, Long.parseLong(executionId), child),
                            executionRepository.getObject()));
                }
            });
        }
    }

    /** 回填异步执行，不能占住子执行终结通知线程。 */
    public void backfillFinishedExecution(Execution execution) {
        BackfillTarget target = matchParentSlot(execution);
        if (target != null) {
            CompletableFuture.runAsync(() -> settle(target, executionRepository.getObject()));
        }
    }

    BackfillTarget matchParentSlot(Execution execution) {
        if (execution == null) return null;

        Map<String, Object> attributes = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();

        Long parentExecutionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.ROOT_EXECUTION_ID);

        if (parentExecutionId == null) return null;

        String subSessionId = String.valueOf(ExecutionIdentity.sessionId(attributes));

        for (ToolCall slot : toolCallRepository.listUnresolvedByExecutionId(parentExecutionId)) {

            if (converter.resolveKind(slot.getContent()) != ToolCallKind.DELEGATION) continue;

            JsonNode content = converter.parse(slot.getContent());

            String slotSessionId = content == null || !content.hasNonNull(ToolCallKeys.SUB_SESSION_ID)
                    ? null : content.get(ToolCallKeys.SUB_SESSION_ID).asText();

            if (!Objects.equals(subSessionId, slotSessionId)) continue;

            if (content.hasNonNull(ToolCallKeys.SUB_EXECUTION_ID)
                    && !Objects.equals(execution.getId(), content.get(ToolCallKeys.SUB_EXECUTION_ID).asText())) continue;

            return new BackfillTarget(slot, parentExecutionId, execution);
        }
        return null;
    }

    /** 回填落定：槽位写入 + 槽位卡片收口 + 父检查点/上下文落库（单事务），父执行无 pending 后恢复。 */
    public void settle(BackfillTarget target, ExecutionRepository repository) {
        synchronized (ExecutionCoordination.monitor(String.valueOf(target.parentExecutionId()))) {
            try {
                if (!settleInsideLatch(target, repository)) {
                    return;
                }
            } catch (Exception e) {
                log.error("委派回填失败: toolCallId={}, parentExecutionId={}",
                        target.slot().getId(), target.parentExecutionId(), e);
                return;
            }
        }
        // 模型运行不能持有决策门闩；登记槽位仍由框架保证单飞。
        // 恢复意图交给统一协调器派发：它先落库再派发，崩溃窗口由巡检兜住。
        // 这里刻意不再本地直接 resume —— 本地直接跑就没有「决策已落库但恢复没派发」的恢复点。
        ResumeDisposition disposition = resumeCoordinator.accept(target.parentExecutionId());
        log.info("委派回填已受理父执行恢复: parentExecutionId={}, disposition={}",
                target.parentExecutionId(), disposition);
    }

    /**
     * 门闩内的落库段。
     *
     * @return 是否应继续走门闩外的恢复判定（父执行缺失、未就绪、已终态都返回 {@code false}）
     */
    private boolean settleInsideLatch(BackfillTarget target,
                                      ExecutionRepository repository) {
        Execution parent = repository.findById(String.valueOf(target.parentExecutionId())).orElse(null);
        if (parent == null) {
            return false;
        }
        ToolCall current = toolCallRepository.findById(target.slot().getId()).orElseThrow(ClientException::new);
        if (!current.isUnresolved()) {
            return false;
        }
        if (ExecutionStatusCodes.isTerminalState(parent.getExecutionState())) {
            transactions.executeWithoutResult(status -> {
                current.complete(converter.cancelled("父执行已结束"));
                toolCallRepository.updateById(current);
            });
            return false;
        }
        // 父检查点尚未提交槽位时不能写回；退出通知会按明确的子执行身份再次校准。
        if (parent.getExecutionState() != ExecutionState.SUSPENDED) {
            return false;
        }
        String resultText = resultRenderer.render(target.subExecution());
        ToolCallOutcome outcome = resolveOutcome(target.subExecution());
        String rawOutput = outcome == ToolCallOutcome.CANCELLED
                ? converter.cancelled("子代理执行已取消")
                : converter.executeOutcome(outcome, resultText);

        boolean slotWritten = ExecutionToolSlot.write(parent, target.slot().getId(),
                target.slot().getToolName(), resultText);
        if (!slotWritten) {
            // 槽位缺失（检查点不一致）也要把卡片收口，让父执行还能被恢复或停止，不悬挂。
            log.warn("委派槽位缺失: toolCallId={}, parentExecutionId={}",
                    target.slot().getId(), target.parentExecutionId());
        }
        final boolean written = slotWritten;
        transactions.executeWithoutResult(status -> {
            if (current.complete(rawOutput)) toolCallRepository.updateById(current);
            if (written) {
                repository.save(parent);
                modelContextService.replace(resolveParentSessionId(parent), parent.getMessages());
            }
        });
        return true;
    }

    private static ToolCallOutcome resolveOutcome(Execution execution) {
        return switch (execution.getExecutionState()) {
            case COMPLETED -> ToolCallOutcome.SUCCEEDED;
            case CANCELLED -> ToolCallOutcome.CANCELLED;
            default -> ToolCallOutcome.FAILED;
        };
    }

    /** 父执行的所属会话：回填的模型上下文按它落库。缺失即数据不完整，抛错走统一失败日志。 */
    private static Long resolveParentSessionId(Execution parent) {
        try {
            return ExecutionIdentity.sessionId(parent.getAgentRequest());
        } catch (RuntimeException e) {
            throw new ClientException("父执行缺少会话标识，不能回填: " + parent.getId());
        }
    }

    record BackfillTarget(ToolCall slot, long parentExecutionId, Execution subExecution) {
    }
}
