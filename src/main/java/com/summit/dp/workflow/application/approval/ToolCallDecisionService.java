package com.summit.dp.workflow.application.approval;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.concurrent.ManagedAsyncExecutor;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.resume.SuspendedExecutionResumer;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/** 无外部副作用的互动决策，槽位与模型上下文必须同事务提交。 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ToolCallDecisionService {
    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final ExecutionLocator executionLocator;
    private final ModelContextService modelContextService;
    private final SseEventPublisher sseEventPublisher;
    private final TransactionTemplate transactions;
    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final UnresolvedToolSuspensionGate unresolvedToolGate;
    private final SuspendedExecutionResumer resumer;
    private final ManagedAsyncExecutor asyncExecutor;

    /** 分支 A：{@code PLAN} / {@code CHOICE}（无外部副作用）——单事务。 */
    public SseEmitter decide(ToolCall toolCall, ToolCallKind kind, boolean approved, String text) {
        ExecutionRepository repository = executionRepository.getObject();
        long conversationId = toolCall.getConversationId();
        String executionId = String.valueOf(toolCall.getExecutionId());
        Execution execution = repository.findById(executionId)
                .orElseThrow(ClientException::new);
        throwIf(execution.getExecutionState() != ExecutionState.SUSPENDED, "执行尚未暂停或已结束，请稍后重试");

        ToolCallOutcome outcome = kind == ToolCallKind.CHOICE ? ToolCallOutcome.ANSWERED
                : (approved ? ToolCallOutcome.APPROVED : ToolCallOutcome.REJECTED);
        boolean affirmative = outcome == ToolCallOutcome.APPROVED || outcome == ToolCallOutcome.ANSWERED;
        String rawOutput = converter.decisionOutcome(outcome, text, affirmative);
        String outputText = affirmative
                ? (text == null || text.isBlank() ? "用户已批准该互动" : text)
                : "用户已拒绝该互动";

        // 槽位和上下文必须与结论一起提交，不能先开放恢复再补结论。
        transactions.executeWithoutResult(status -> {
            throwIf(!ExecutionToolSlot.write(execution, toolCall.getId(), toolCall.getToolName(), outputText),
                    "找不到原工具结果，不能恢复执行");
            toolCall.complete(rawOutput);
            toolCallRepository.updateById(toolCall);
            repository.save(execution);
            modelContextService.replace(conversationId, execution.getMessages());
        });

        boolean pending = unresolvedToolGate.hasUnresolvedSlot(toolCall.getExecutionId());
        long rootId = executionLocator.resolveRootSessionId(conversationId);
        SseEmitter emitter = sseEventPublisher.connect(rootId);
        // v1 契约：先连上，再在后台把恢复跑完，最后才关这条连接 —— 前端靠「连接仍开着」判断还在恢复。
        // 因此这里只换执行器，三步的先后一个字都不能动。
        boolean accepted = asyncExecutor.tryExecute("工具决策后恢复执行", () -> {
            try {
                // 未决判定在事务提交后即已完成（见上方 pending），异步段只负责恢复。
                if (!pending) {
                    Execution latest = repository.findById(executionId).orElse(execution);
                    resumer.resume(latest, conversationId);
                }
            } catch (Exception e) {
                log.warn("恢复执行失败: executionId={}, error={}", executionId, e.toString());
            } finally {
                sseEventPublisher.finish(emitter);
            }
        });
        if (!accepted) {
            // 执行器已关闭：后台段不会跑，收尾就没人做。这里当场关流，绝不留一条永不结束的连接。
            log.warn("恢复任务未被受理，直接关闭本次 SSE 连接: executionId={}", executionId);
            sseEventPublisher.finish(emitter);
        }
        return emitter;
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
