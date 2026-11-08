package com.summit.dp.workflow.application.decision;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.concurrent.ManagedAsyncExecutor;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.lifecycle.ResumeTriggerType;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.concurrent.RejectedExecutionException;

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
    private final UnresolvedToolSuspensionGate unresolvedToolGate;
    private final ApprovedCommandRestorer commandRestorer;
    private final ModelContextService modelContextService;
    private final ExecutionResumeCoordinator resumeCoordinator;
    private final ManagedAsyncExecutor asyncExecutor;

    /**
     * 准备 T1：锁外完成校验、控制信号登记与命令环境重建。
     *
     * <p><b>不重复引擎的闸门</b>：执行态、卡片是否待处理、会话归属、版本、形态都由
     * {@code InteractionDecisionEngine} 在锁内判定（它已经做完才调到这里）。这里再判一遍
     * 只会造出第二套文案，用户看到的错误取决于谁先抛 —— 语义等价就删，不等价才留。</p>
     *
     * <p><b>登记与重建必须先于事务</b>：命令环境不可重建时要让审批当场失败，绝不能
     * 带着过期上下文落库；信号登记失败同理。失败时释放信号，不留待审批卡被判为执行中。</p>
     *
     * @param commandId  决策命令身份（v2 幂等重试用；v1 无此概念，传 {@code null}）
     * @param digest     请求摘要（v2 判定「同 ID 不同内容」用；v1 传 {@code null}）
     * @param completion 链路收尾回调（v1 用它关流）；可空
     */
    public ApprovalPlan prepare(ToolCall toolCall, boolean approved, String commandId, String digest,
                                Runnable completion) {
        String executionId = String.valueOf(toolCall.getExecutionId());
        ExecutionRepository repository = executionRepository.getObject();
        Execution execution = repository.findById(executionId).orElseThrow(ClientException::new);
        if (!approved) {
            // 拒绝没有命令要跑，也不依赖环境可重建：用户拒绝的意愿不依赖执行环境。
            return new ApprovalPlan(false, execution, toolCall, null, null,
                    outcomeResolver.run(null, execution, false), completion);
        }
        // 环境校验先于登记：审批期间环境被替换则拒绝重放，命令绝不带着过期上下文落地。
        ToolExecution call = commandRestorer.restore(execution, toolCall);
        ExecutionControlSignal signal = repository.register(executionId);
        ApprovalPlan plan = new ApprovalPlan(true, execution, toolCall, call, signal, null, completion);
        // 决策身份随 T1 落库：这里只把身份写到卡片上，落库由引擎的事务负责。
        plan.card().attachDecision(commandId, digest);
        return plan;
    }

    /**
     * T1 的写入集：<b>调用方负责事务边界</b>（引擎的 commit 就是这段事务）。
     *
     * <p>批准只写占位：槽位占位输出 + APPROVED 占位结论 + 版本推进 + 决策身份 + 检查点 + 模型上下文。
     * <b>不在这里 accept 恢复</b> —— 恢复属于 T2（真实输出落库之后），提前登记会让执行
     * 在命令还没跑完时被唤醒。</p>
     *
     * <p>拒绝是单事务落定：真实结论 + 检查点 + 上下文 + 恢复意图同生共死，且<b>不调
     * {@code commandRestorer}</b>（见 {@link #prepare}）。</p>
     *
     * @return 本次 T1 的恢复处置；批准恒为 {@code RUNNING}（已进入执行态）
     */
    public ResumeDisposition writeT1(ApprovalPlan plan) {
        ToolCall card = plan.card();
        Execution execution = plan.execution();
        long conversationId = card.getConversationId();
        if (!plan.approved()) {
            if (!ExecutionToolSlot.write(execution, card.getId(), card.getToolName(),
                    plan.rejected().result().getToolOutput())) {
                throw new ClientException("找不到原工具结果，不能恢复执行");
            }
            card.complete(plan.rejected().rawOutput());
            toolCallRepository.updateById(card);
            executionRepository.getObject().save(execution);
            modelContextService.replace(conversationId, execution.getMessages());
            // 拒绝同样登记持久化恢复请求，因此关流必须等它落定：否则前端在恢复真正开始前
            // 就收到流结束，与批准路径（落定后才关）行为不一致。回调交给协调器保管。
            return resumeCoordinator.accept(card.getExecutionId(), ResumeTriggerType.APPROVAL_DECISION,
                    plan.completion());
        }
        if (!ExecutionToolSlot.write(execution, card.getId(), card.getToolName(),
                CommandOutcomeResolver.APPROVED_PENDING_OUTPUT)) {
            throw new ClientException("找不到原命令的工具结果，不能执行审批");
        }
        card.attachOutput(converter.commandOutcome(ToolCallOutcome.APPROVED, null, null));
        card.markInProgress();
        toolCallRepository.updateById(card);
        // beginApproval 负责状态推进与检查点落库：槽位占位与版本随它一起提交。
        executionControl.getObject().beginApproval(execution);
        modelContextService.replace(conversationId, execution.getMessages());
        return ResumeDisposition.RUNNING;
    }

    /** T1 回滚：释放控制信号，取消未执行的任务。副作用一次都不会跑，因为派发还没发生。 */
    public void abandonT1(ApprovalPlan plan) {
        if (plan.signal() == null) {
            return;
        }
        try {
            executionRepository.getObject().unregister(plan.signal());
        } catch (RuntimeException | Error cleanupFailure) {
            log.warn("T1 回滚时释放控制信号失败: executionId={}, error={}",
                    plan.execution().getId(), cleanupFailure.toString());
        }
    }

    /**
     * T1 提交之后的动作：批准派发锁外副作用；拒绝不再自行关流。
     *
     * <p><b>只在事务提交之后调用</b>：派发得比提交早，收尾段就可能读到未提交的受理状态。</p>
     *
     * <p><b>拒绝为什么什么都不做</b>：拒绝也登记了持久化恢复请求，关流已交给协调器的落定回调
     * （见 {@link #writeT1}）。在这里关流会让前端在恢复启动之前就看到流结束。</p>
     */
    public void afterCommit(ApprovalPlan plan) {
        if (!plan.approved()) {
            return;
        }
        try {
            dispatchAsync(() -> finish(plan.card(), plan.execution(), plan.call(), plan.signal(),
                    plan.completion()));
        } catch (RuntimeException | Error dispatchFailure) {
            // T1 已提交：派发失败必须当场收口，否则执行永久停在 RUNNING、控制槽位泄漏、
            // 而调用方（v1 的 SSE）会一直等一个永远不会到来的收尾。
            settleDispatchFailure(plan, dispatchFailure);
            throw dispatchFailure;
        }
    }

    /** 收尾回调只跑一次，且它的异常不得污染审批主流程。 */
    private static void runCompletion(Runnable completion) {
        if (completion == null) {
            return;
        }
        try {
            completion.run();
        } catch (RuntimeException error) {
            log.warn("命令审批收尾回调失败: error={}", error.toString());
        }
    }

    /**
     * 命令审批异步收尾，三段顺序不可调换：
     * <b>执行副作用</b>（{@link CommandOutcomeResolver}）→ <b>事务 T2</b>
     * （{@link ApprovalFinalizer}）→ <b>释放信号并恢复</b>。
     *
     * <p>副作用夹在 T1（{@link #writeT1}）与 T2 之间：T1 先提交受理状态，崩溃才不会静默重放命令；
     * T2 再落结果。三段分处三个协作类，本方法只保留「顺序」本身。</p>
     */
    private void finish(ToolCall toolCall, Execution execution, ToolExecution call,
                        ExecutionControlSignal signal, Runnable completion) {
        ToolMessageEntity message = ExecutionToolSlot.locate(execution, toolCall.getId(), toolCall.getToolName());
        ExecutionRepository repository = executionRepository.getObject();
        long conversationId = toolCall.getConversationId();
        String executionId = execution.getId();
        boolean released = false;
        try {
            CommandOutcomeResolver.CommandExecution command =
                    outcomeResolver.run(call, execution, signal.isCancelRequired());
            message.setToolOutput(command.result().getToolOutput());

            synchronized (ExecutionCoordination.monitor(executionId)) {
                finalizer.commitOutcome(toolCall, execution, message, call, command,
                        conversationId, signal.isCancelRequired());
            }

            // 未决判定必须在 unregister 之前：unregister 会经生命周期端口把该执行所有未决
            // 槽位一次性结掉，事后重查恒为「无未决」，恢复闸门会形同虚设。
            boolean pending = unresolvedToolGate.hasUnresolvedSlot(Long.valueOf(executionId));

            // 先置位再 unregister：unregister 抛错时 finally 不再重复释放（重复释放会抛
            // 「控制信号已释放」并盖掉真正的失败原因）。
            released = true;
            repository.unregister(signal);
            Execution latest = repository.findById(executionId).orElseThrow(ClientException::new);
            finalizer.resumeIfReady(latest, pending);
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
     *
     * <p>执行器拒绝（已关闭）时抛 {@link java.util.concurrent.RejectedExecutionException}：
     * 调用方必须把它当成「收尾永远起不来」来处理 —— T1 已提交，若不收口，执行会永久停在 RUNNING。</p>
     */
    protected void dispatchAsync(Runnable task) {
        if (!asyncExecutor.tryExecute("命令审批收尾", task)) {
            throw new RejectedExecutionException("受管执行器已关闭，审批收尾任务未被受理");
        }
    }

    /** 异步派发失败：T1 已提交，必须把执行收成失败并释放控制槽位，不能留下 RUNNING 泄漏。 */
    private void settleDispatchFailure(ApprovalPlan plan, Throwable failure) {
        try {
            finalizer.failApproval(plan.card(), plan.execution(), failure.getMessage());
        } catch (RuntimeException | Error saveFailure) {
            failure.addSuppressed(saveFailure);
        }
        try {
            executionRepository.getObject().unregister(plan.signal());
        } catch (RuntimeException | Error cleanupFailure) {
            failure.addSuppressed(cleanupFailure);
        }
        // 收尾段永不运行，关流只能在这里做：否则 v1 的 SSE 会一直挂着等一个不会到来的结束。
        runCompletion(plan.completion());
    }
}
