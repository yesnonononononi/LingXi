package com.summit.dp.toolcall.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.domain.lifecycle.ExecutionCoordination;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.concurrent.CompletableFuture;

/**
 * 命令审批入口与异步收尾的<b>顺序编排</b>：T1 提交 → 执行副作用 → T2 落结果 → 释放并恢复。
 *
 * <p>三段各自落在独立协作类里：副作用见 {@link CommandOutcomeResolver}，
 * T2 见 {@link ApprovalFinalizer}，恢复闸门见 {@link SuspendedExecutionResumer}。
 * 本类只保留顺序本身 —— 顺序即不变量：<b>T1 必须早于外部命令执行</b>，
 * 否则进程崩溃后重启会静默重放已产生副作用的命令。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class CommandApprovalExecutor {

    private final ToolCallRepository toolCallRepository;
    private final SseEventPublisher sseEventPublisher;
    private final ExecutionIdentity executionIdentity;
    private final TransactionTemplate transactions;
    private final ObjectProvider<ExecutionControl> executionControl;
    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final CommandOutcomeResolver outcomeResolver;
    private final ApprovalFinalizer finalizer;
    private final SuspendedExecutionResumer resumer;
    private final ApprovedCommandRestorer commandRestorer;

    /** 提交先于副作用；异步收尾仍沿用旧版恢复流。 */
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
                    .orElseThrow(ClientException::new);
            throwIf(execution.getExecutionState() != ExecutionState.SUSPENDED, "执行尚未暂停或已结束");
            ToolCall current = toolCallRepository.findById(toolCall.getId())
                    .orElseThrow(ClientException::new);
            throwIf(!current.isApprovalPending(), "该审批已处理");
            ToolMessageEntity message = ExecutionToolSlot.locate(execution, current.getId(), current.getToolName());
            throwIf(message == null, "找不到原命令的工具结果，不能执行审批");
            ToolExecution call = approved ? commandRestorer.restore(execution, current) : null;

            signal = repository.register(executionId);
            emitter = sseEventPublisher.connect(executionIdentity.resolveRootSessionId(conversationId));
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

    /**
     * 命令审批异步收尾，三段顺序不可调换：
     * <b>执行副作用</b>（{@link CommandOutcomeResolver}）→ <b>事务 T2</b>
     * （{@link ApprovalFinalizer}）→ <b>释放信号并恢复</b>。
     *
     * <p>副作用夹在 T1（{@link #decide} 内）与 T2 之间：T1 先提交受理状态，崩溃才不会静默重放命令；
     * T2 再落结果。三段分处三个协作类，本方法只保留「顺序」本身。</p>
     */
    private void finish(ToolCall toolCall, Execution execution, ToolMessageEntity message,
                        ToolExecution call, ExecutionControlSignal signal, SseEmitter emitter) {
        ExecutionRepository repository = executionRepository.getObject();
        long conversationId = toolCall.getConversationId();
        String executionId = execution.getId();
        boolean released = false;
        try {
            CommandOutcomeResolver.CommandExecution command =
                    outcomeResolver.run(call, execution, signal.isCancelRequired());
            message.setText(command.result().getToolOutput());

            synchronized (ExecutionCoordination.monitor(executionId)) {
                finalizer.commitOutcome(toolCall, execution, message, call, command,
                        conversationId, signal.isCancelRequired());
            }

            // 未决判定必须在 unregister 之前：unregister 会经生命周期端口把该执行所有未决
            // 槽位一次性结掉，事后重查恒为「无未决」，恢复闸门会形同虚设。
            boolean pending = resumer.hasUnresolvedSlot(Long.valueOf(executionId));

            // 先置位再 unregister：unregister 抛错时 finally 不再重复释放（重复释放会抛
            // 「控制信号已释放」并盖掉真正的失败原因）。
            released = true;
            repository.unregister(signal);
            Execution latest = repository.findById(executionId).orElseThrow(ClientException::new);
            finalizer.resumeIfReady(latest, conversationId, pending);
        } catch (Exception e) {
            log.error("命令审批失败: executionId={}", executionId, e);
            if (!released) {
                try {
                    finalizer.failApproval(toolCall, execution, e.getMessage());
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
                sseEventPublisher.finish(emitter);
            }
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
