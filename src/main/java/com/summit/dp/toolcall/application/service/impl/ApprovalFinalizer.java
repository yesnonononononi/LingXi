package com.summit.dp.toolcall.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ApprovalOutcome;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.Objects;

/**
 * 命令审批的事务 T2：把命令输出写回执行末条 tool 消息与 {@code tool_call} 行，
 * 再回写模型上下文，随后广播工具结束事件，并在无未决槽位时恢复执行。
 *
 * <p><b>为什么 T2 独立成类</b>：T1（提交先于副作用）在 {@code CommandApprovalExecutor}，
 * 副作用在 {@code CommandOutcomeResolver}，T2 在这里。三段分处三个类，
 * 「提交先于副作用」这条不变量才能在调用链上一眼可见 —— 任何人接手都不会把外部命令
 * 挪到 T1 之前。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ApprovalFinalizer {

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final ModelContextService modelContextService;
    private final RuntimeEventPublisher runtimeEvents;
    private final TransactionTemplate transactions;
    private final ObjectProvider<ExecutionControl> executionControl;
    private final SuspendedExecutionResumer resumer;
    private final ExecutionResumeCoordinator resumeCoordinator;

    /**
     * 落定 T2 并广播工具结束事件。
     *
     * <p><b>顺序不可调换</b>：先提交 T2（结论落库），再广播结束事件 ——
     * 提前广播会让前端先看到「已完成」而后端尚未提交，刷新即回退。</p>
     *
     * @param cancelRequired 调用方求得的取消标志；命令执行期间可能被异步置位，
     *                       故与 {@code command.outcome()} 分开传入而非从结论推导
     */
    public void commitOutcome(ToolCall toolCall, Execution execution, ToolMessageEntity message,
                              ToolExecution call, CommandOutcomeResolver.CommandExecution command,
                              long conversationId, boolean cancelRequired) {
        ApprovalOutcome approvalOutcome = cancelRequired
                ? ApprovalOutcome.CANCELLED : ApprovalOutcome.CONTINUE;
        // 门闩内只做落库与上下文替换：不发起网络写，也不调模型。
        transactions.executeWithoutResult(status -> {
            ToolCall current = toolCallRepository.findById(toolCall.getId()).orElseThrow(ClientException::new);
            current.complete(command.rawOutput());
            executionControl.getObject().finishApproval(execution, approvalOutcome);
            modelContextService.replace(conversationId, execution.getMessages());
            toolCallRepository.updateById(current);
        });
        runtimeEvents.onToolCallOutput(new ToolCallEndEvent(String.valueOf(message.getId()), execution.getId(),
                call == null ? null : call.getResponseId(),
                message.getName(), call == null ? "" : call.getArgs(), command.result().getToolOutput(),
                execution.eventMetaData(),
                CommandOutcomeResolver.resolveResultStatus(command.outcome(), cancelRequired)));
    }

    /**
     * T2 落定后派发普通 loop 恢复任务。
     *
     * <p><b>为什么改为派发而不是就地 resume</b>：架构 §8.4 要求「释放旧控制信号<b>才</b>派发
     * 普通 loop 恢复任务」。就地 resume 会在旧信号仍被持有时直接启动第二个 loop ——
     * 框架的控制槽位互斥只保证「同一 execution 只有一个合法运行」，而这里要保证的是
     * 「旧信号释放之后才开始下一次运行」，两者不是一回事。交给协调器后，
     * 恢复走「先落库意图、再唤醒 worker」，崩溃窗口由巡检兜住。</p>
     *
     * <p><b>为什么外部命令不进可重试的恢复任务</b>：命令可能已经产生了副作用。
     * 把它做成可自动重试的任务，等于让进程崩溃变成「命令被执行两次」。
     * 因此这里只登记「继续跑 loop」这个意图，命令本身的执行已经在 T1→T2 之间完成。</p>
     *
     * @return 是否真的登记了恢复任务
     */
    public boolean resumeIfReady(Execution latest, long conversationId, boolean hasUnresolvedSlot) {
        if (hasUnresolvedSlot) {
            return false;
        }
        if (!resumer.isSuspended(latest)) {
            return false;
        }
        return resumeCoordinator.accept(Objects.requireNonNullElse(
                ExecutionIdentity.numericOrNull(latest.getId()), 0L)) == ResumeDisposition.QUEUED;
    }

    /** 命令执行中断：把执行与卡片一并收成失败，禁止自动重放已可能产生副作用的命令。 */
    public void failApproval(ToolCall toolCall, Execution execution, String reason) {
        executionControl.getObject().failApproval(execution,
                "命令审批执行中断；请检查命令实际结果，禁止自动重放：" + reason);
        toolCall.complete(converter.commandOutcome(ToolCallOutcome.FAILED, null, reason));
        toolCallRepository.updateById(toolCall);
    }
}
