package com.summit.dp.toolcall.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.execution.domain.lifecycle.ExecutionCoordination;
import com.summit.dp.session.application.service.ModelContextService;
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

import java.util.concurrent.CompletableFuture;

/**
 * 命令审批入口与异步收尾的<b>顺序编排</b>：T1 提交 → 执行副作用 → T2 落结果 → 释放并恢复。
 *
 * <p>三段各自落在独立协作类里：副作用见 {@link CommandOutcomeResolver}，
 * T2 见 {@link ApprovalFinalizer}，恢复闸门见 {@link SuspendedExecutionResumer}。
 * 本类只保留顺序本身 —— 顺序即不变量：<b>T1 必须早于外部命令执行</b>，
 * 否则进程崩溃后重启会静默重放已产生副作用的命令。</p>
 *
 * <p><b>为什么不持有 emitter</b>：本类只负责编排顺序，传输协议（v1 SSE / v2 JSON）是调用方的事。
 * 把 emitter 挡在外面后，v1 与 v2 共用同一条编排链，v1 只是多传一个「收尾后关流」的回调。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class CommandApprovalExecutor {

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final TransactionTemplate transactions;
    private final ObjectProvider<ExecutionControl> executionControl;
    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final CommandOutcomeResolver outcomeResolver;
    private final ApprovalFinalizer finalizer;
    private final SuspendedExecutionResumer resumer;
    private final ApprovedCommandRestorer commandRestorer;
    private final ModelContextService modelContextService;
    private final ExecutionResumeCoordinator resumeCoordinator;

    /** 一次命令审批的受理结论：落定的动作与恢复处置。 */
    public record CommandApprovalResult(ToolCallOutcome outcome, ResumeDisposition disposition) {
    }

    /**
     * 受理一次命令审批。
     *
     * @param commandId  决策命令身份（v2 幂等重试用；v1 无此概念，传 {@code null}）
     * @param digest     请求摘要（v2 判定「同 ID 不同内容」用；v1 传 {@code null}）
     * @param completion 异步收尾结束后的回调（v1 用它关流）；可空
     */
    public CommandApprovalResult decide(ToolCall toolCall, boolean approved,
                                        String commandId, String digest, Runnable completion) {
        return approved
                ? approve(toolCall, commandId, digest, completion)
                : reject(toolCall, commandId, digest, completion);
    }

    /** 批准：T1 提交先于副作用，命令在提交之后异步执行。 */
    private CommandApprovalResult approve(ToolCall toolCall, String commandId, String digest, Runnable completion) {
        ExecutionRepository repository = executionRepository.getObject();
        String executionId = String.valueOf(toolCall.getExecutionId());
        // 先校验后登记：stop 与「点批准」竞争时，执行可能已被取消——状态校验前置于 register，
        // 业务失败走 ClientException（Result.error），而不是 register 的 IllegalStateException 兜成 500。
        ExecutionControlSignal signal = null;
        boolean settled = false;
        try {
            Execution execution = repository.findById(executionId)
                    .orElseThrow(ClientException::new);
            throwIf(execution.getExecutionState() != ExecutionState.SUSPENDED, "执行尚未暂停或已结束");
            ToolCall current = toolCallRepository.findById(toolCall.getId())
                    .orElseThrow(ClientException::new);
            throwIf(!current.isApprovalPending(), "该审批已处理");
            ToolMessageEntity message = ExecutionToolSlot.locate(execution, current.getId(), current.getToolName());
            throwIf(message == null, "找不到原命令的工具结果，不能执行审批");
            // 环境校验先于登记：审批期间环境被替换则拒绝重放，命令绝不带着过期上下文落地。
            ToolExecution call = commandRestorer.restore(execution, current);

            signal = repository.register(executionId);
            ExecutionControlSignal registered = signal;
            // 事务 T1（提交先于副作用）：决策身份、摘要、结论与 in_progress 同事务落库。
            // 结论先写 APPROVED 的占位，T2 再覆盖成带输出的实际结果——这正是「执行中重试」能
            // 查回批准结论、而不是拿到 null 的原因。崩溃也不会静默重放命令。
            transactions.executeWithoutResult(status -> {
                current.attachDecision(commandId, digest);
                current.attachOutput(converter.commandOutcome(ToolCallOutcome.APPROVED, null, null));
                current.markInProgress();
                executionControl.getObject().beginApproval(execution);
                toolCallRepository.updateById(current);
            });
            try {
                dispatchAsync(() -> finish(current, execution, message, call, registered, completion));
            } catch (RuntimeException dispatchFailure) {
                // T1 已提交：派发失败必须当场收口，否则执行永久停在 RUNNING、控制槽位泄漏。
                settleDispatchFailure(current, execution, registered, dispatchFailure);
                settled = true;
                throw dispatchFailure;
            }
            // 回执只承诺「决策已落库 + 命令已受理」；T1 的 beginApproval 已把执行置 RUNNING。
            return new CommandApprovalResult(ToolCallOutcome.APPROVED, ResumeDisposition.RUNNING);
        } catch (RuntimeException e) {
            if (signal != null && !settled) {
                try {
                    repository.unregister(signal);
                } catch (RuntimeException cleanupFailure) {
                    e.addSuppressed(cleanupFailure);
                }
            }
            throw e;
        }
    }

    /**
     * 拒绝：单事务落定，命令一次都不执行，也不依赖命令环境可重建。
     *
     * <p>与 {@link ToolCallDecisionService} 的 PLAN/CHOICE 路径同形：槽位、结论、检查点、
     * 模型上下文与恢复意图同事务提交，因此不存在「决策已落库但恢复意图没落库」的窗口。
     * <b>刻意不调 {@code commandRestorer.restore}</b>：拒绝没有命令要跑，
     * 让「环境已变化」把一次拒绝挡在门外是错的——用户拒绝的意愿不依赖环境。</p>
     */
    private CommandApprovalResult reject(ToolCall toolCall, String commandId, String digest, Runnable completion) {
        ExecutionRepository repository = executionRepository.getObject();
        long conversationId = toolCall.getConversationId();
        String executionId = String.valueOf(toolCall.getExecutionId());
        Execution execution = repository.findById(executionId)
                .orElseThrow(ClientException::new);
        throwIf(execution.getExecutionState() != ExecutionState.SUSPENDED, "执行尚未暂停或已结束");
        // 拒绝文案与结论复用命令结论派生：写读同源，措辞只在 CommandOutcomeResolver 定义一次。
        CommandOutcomeResolver.CommandExecution rejected = outcomeResolver.run(null, execution, false);

        ResumeDisposition[] disposition = new ResumeDisposition[1];
        transactions.executeWithoutResult(status -> {
            ToolCall current = toolCallRepository.findById(toolCall.getId()).orElseThrow(ClientException::new);
            throwIf(!current.isApprovalPending(), "该审批已处理");
            throwIf(!ExecutionToolSlot.write(execution, current.getId(), current.getToolName(),
                    rejected.result().getToolOutput()), "找不到原工具结果，不能恢复执行");
            current.attachDecision(commandId, digest);
            current.complete(rejected.rawOutput());
            toolCallRepository.updateById(current);
            repository.save(execution);
            modelContextService.replace(conversationId, execution.getMessages());
            disposition[0] = resumeCoordinator.accept(current.getExecutionId());
        });
        if (completion != null) {
            completion.run();
        }
        return new CommandApprovalResult(ToolCallOutcome.REJECTED, disposition[0]);
    }

    /**
     * 命令审批异步收尾，三段顺序不可调换：
     * <b>执行副作用</b>（{@link CommandOutcomeResolver}）→ <b>事务 T2</b>
     * （{@link ApprovalFinalizer}）→ <b>释放信号并恢复</b>。
     *
     * <p>副作用夹在 T1（{@link #approve} 内）与 T2 之间：T1 先提交受理状态，崩溃才不会静默重放命令；
     * T2 再落结果。三段分处三个协作类，本方法只保留「顺序」本身。</p>
     */
    private void finish(ToolCall toolCall, Execution execution, ToolMessageEntity message,
                        ToolExecution call, ExecutionControlSignal signal, Runnable completion) {
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
                if (completion != null) {
                    completion.run();
                }
            }
        }
    }

    /**
     * 异步派发收尾任务；独立成可覆写方法，使「派发失败仍收口」这条护栏能被单测构造出来。
     */
    protected void dispatchAsync(Runnable task) {
        CompletableFuture.runAsync(task);
    }

    /** 异步派发失败：T1 已提交，必须把执行收成失败并释放控制槽位，不能留下 RUNNING 泄漏。 */
    private void settleDispatchFailure(ToolCall toolCall, Execution execution,
                                       ExecutionControlSignal signal, RuntimeException failure) {
        try {
            finalizer.failApproval(toolCall, execution, failure.getMessage());
        } catch (RuntimeException saveFailure) {
            failure.addSuppressed(saveFailure);
        }
        try {
            executionRepository.getObject().unregister(signal);
        } catch (RuntimeException cleanupFailure) {
            failure.addSuppressed(cleanupFailure);
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
