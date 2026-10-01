package com.summit.dp.toolcall.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ApprovalOutcome;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.tool.ToolCallStatus;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.concurrent.CompletableFuture;

/**
 * 命令（{@code COMMAND}）审批执行器：从 {@link ToolCallServiceImpl} 中拆出的「有外部副作用」分支
 * （评审 P1-① 第一刀）。
 *
 * <p><b>崩溃安全不可省（两段式）：</b>命令执行有外部副作用，故拆为两段事务——
 * T1 先把 {@code tool_call} 落 {@code in_progress}、执行落 {@code RUNNING} 并提交，**提交先于副作用**；
 * T2 再把命令输出写回执行末条 toolcall 与 {@code tool_call} 行。若合并为单事务，
 * 崩溃后「未提交但副作用已发生」会静默重放命令，故不合并。</p>
 *
 * <p><b>职责边界（二次拆分）：</b>本类只保留审批状态机——校验 / 登记 / 两段式事务 / loop 恢复。
 * 「按快照重建待执行命令 + 环境一致性校验」下沉到 {@link ApprovedCommandRestorer}，
 * 「工具结果槽位的定位与写入」复用 {@link ExecutionToolSlot}，两侧可独立演进。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class CommandApprovalExecutor {

    private static final String LOG_PREFIX = "【command-approval】";

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final SseEventPublisher sseEventPublisher;
    private final ExecutionIdentity executionIdentity;
    private final ModelContextService modelContextService;
    private final RuntimeEventPublisher runtimeEvents;
    private final TransactionTemplate transactions;
    private final ObjectProvider<ExecutionControl> executionControl;
    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final SessionAttributeRestorer sessionAttributeRestorer;
    private final ApprovedCommandRestorer commandRestorer;

    /**
     * 落定一条 {@code COMMAND} 审批：两段式执行（T1 提交先于副作用）+ 异步收尾，返回承载恢复事件流的 emitter。
     *
     * @param toolCall 已确认为「可审批」状态的命令卡片
     * @param approved 是否批准（拒绝则只收尾、不执行命令）
     * @param text     用户答复原文（命令分支当前不使用，保留签名一致性）
     */
    public SseEmitter decide(ToolCall toolCall, boolean approved, String text) {
        ExecutionRepository repository = executionRepository.getObject();
        long conversationId = toolCall.getConversationId();
        String executionId = String.valueOf(toolCall.getExecutionId());
        // 先校验后登记：stop 与「点批准」竞争时，执行可能已被取消——状态校验前置于 register，
        // 业务失败走 ClientException（Result.error），而不是 register 的 IllegalStateException 兜成 500。
        ExecutionControlSignal signal = null;
        SseEmitter emitter = null;
        try {
            Execution execution = repository.findById(executionId)
                    .orElseThrow(() -> new ClientException("执行不存在: " + executionId));
            if (execution.getExecutionState() != ExecutionState.SUSPENDED) {
                throw new ClientException("执行尚未暂停或已结束");
            }
            ToolCall current = toolCallRepository.findById(toolCall.getId())
                    .orElseThrow(() -> new ClientException("工具调用不存在: " + toolCall.getId()));
            if (!current.isApprovalPending()) {
                throw new ClientException("该审批已处理");
            }
            ToolMessageEntity message = findResult(execution, current);
            ToolExecution call = approved ? commandRestorer.restore(execution, current) : null;

            signal = repository.register(executionId);
            emitter = sseEventPublisher.connect(executionIdentity.rootSessionIdOfSession(conversationId));
            // 事务 T1（提交先于副作用）：先落 RUNNING，崩溃不会静默重放命令。
            transactions.executeWithoutResult(status -> {
                current.markInProgress();
                executionControl.getObject().beginApproval(execution);
                toolCallRepository.updateById(current);
            });
            SseEmitter connected = emitter;
            ExecutionControlSignal registered = signal;
            CompletableFuture.runAsync(() -> finish(current, execution, message, call, registered, connected));
            return emitter;
        } catch (RuntimeException e) {
            if (signal != null) {
                try {
                    repository.unregister(signal);
                } catch (RuntimeException cleanupFailure) {
                    e.addSuppressed(cleanupFailure);
                }
            }
            if (emitter != null) {
                emitter.completeWithError(e);
            }
            throw e;
        }
    }

    /** 命令审批异步收尾：执行副作用（若有）→ 事务 T2 落结果 → 触发循环恢复。 */
    private void finish(ToolCall toolCall, Execution execution, ToolMessageEntity message,
                        ToolExecution call, ExecutionControlSignal signal, SseEmitter emitter) {
        ExecutionRepository repository = executionRepository.getObject();
        long conversationId = toolCall.getConversationId();
        String executionId = execution.getId();
        boolean released = false;
        try {
            ToolExecuteResult result;
            ToolCallOutcome outcome;
            String rawOutput;
            if (signal.isCancelRequired()) {
                result = ToolExecuteResult.err("命令未执行：执行已取消");
                outcome = ToolCallOutcome.CANCELLED;
                rawOutput = converter.cancelled("执行已取消");
            } else if (call == null) {
                result = ToolExecuteResult.err("用户拒绝，命令未执行");
                outcome = ToolCallOutcome.REJECTED;
                rawOutput = converter.commandOutcome(ToolCallOutcome.REJECTED, null, "用户拒绝，命令未执行");
            } else {
                runtimeEvents.onToolCall(new ToolCallStartEvent(call.getId(), execution.getId(),
                        call.getToolDefinition().name(), call.getArgs()));
                result = call.getToolDefinition().executor().execute(call);
                outcome = ToolCallOutcome.APPROVED;
                rawOutput = converter.commandOutcome(ToolCallOutcome.APPROVED, result.getToolOutput(), null);
            }
            message.setText(result.getToolOutput());
            ApprovalOutcome approvalOutcome = signal.isCancelRequired()
                    ? ApprovalOutcome.CANCELLED : ApprovalOutcome.CONTINUE;
            ToolCallOutcome finalOutcome = outcome;
            String finalRawOutput = rawOutput;
            // 事务 T2：把命令输出写回执行末条 toolcall 与 tool_call 行，再回写上下文。
            transactions.executeWithoutResult(status -> {
                toolCall.complete(finalRawOutput);
                executionControl.getObject().finishApproval(execution, approvalOutcome);
                modelContextService.replace(conversationId, execution.getMessages());
                toolCallRepository.updateById(toolCall);
            });
            runtimeEvents.onToolCallOutput(new ToolCallEndEvent(String.valueOf(message.getId()), execution.getId(),
                    message.getName(), call == null ? "" : call.getArgs(), result.getToolOutput(),
                    execution.eventMetaData(),
                    resultStatusOf(finalOutcome, signal.isCancelRequired())));

            boolean pending = !toolCallRepository.listPendingByExecutionId(Long.valueOf(executionId)).isEmpty();
            released = true;
            repository.unregister(signal);
            Execution latest = repository.findById(executionId).orElseThrow();
            if (!pending && latest.getExecutionState() == ExecutionState.SUSPENDED) {
                // 恢复不经过 RequestPreparer：先把会话级业务属性（团队绑定）补回请求再交给 loop，
                // 否则恢复后的委派工具解析不到团队，子 Agent 起不来。
                sessionAttributeRestorer.restore(latest, conversationId);
                Execution resumed = executionControl.getObject().resume(latest);
                modelContextService.replace(conversationId, resumed.getMessages());
            }
        } catch (Exception e) {
            log.error("{} command approval failed: executionId={}", LOG_PREFIX, executionId, e);
            if (!released) {
                try {
                    executionControl.getObject().failApproval(execution,
                            "命令审批执行中断；请检查命令实际结果，禁止自动重放：" + e.getMessage());
                    toolCall.complete(converter.commandOutcome(ToolCallOutcome.FAILED, null, e.getMessage()));
                    toolCallRepository.updateById(toolCall);
                } catch (Exception saveFailure) {
                    e.addSuppressed(saveFailure);
                }
            }
        } finally {
            try {
                if (!released) {
                    repository.unregister(signal);
                }
            } finally {
                emitter.complete();
            }
        }
    }

    /** 定位承载该调用的 {@code ToolMessageEntity}：主键命中优先，退化为按工具名取最后一条。 */
    private static ToolMessageEntity findResult(Execution execution, ToolCall current) {
        ToolMessageEntity message = ExecutionToolSlot.locate(execution, current.getId(), current.getToolName());
        if (message == null) {
            throw new ClientException("找不到原命令的工具结果，不能执行审批");
        }
        return message;
    }

    /** 业务结论 → 框架结果状态（用于向外界广播工具结束事件）。 */
    private static ToolCallStatus resultStatusOf(ToolCallOutcome outcome, boolean cancelled) {
        if (cancelled) {
            return ToolCallStatus.CANCELLED;
        }
        return switch (outcome) {
            case REJECTED -> ToolCallStatus.REJECTED;
            case FAILED -> ToolCallStatus.FAILED;
            case TIMED_OUT -> ToolCallStatus.TIMED_OUT;
            default -> ToolCallStatus.COMPLETED;
        };
    }
}
