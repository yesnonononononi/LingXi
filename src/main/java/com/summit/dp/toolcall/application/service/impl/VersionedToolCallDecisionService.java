package com.summit.dp.toolcall.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.execution.domain.lifecycle.ExecutionCoordination;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.utils.CommandDigest;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionCommand;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionReceipt;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.vo.DecisionConflictException;
import com.summit.dp.toolcall.application.vo.DecisionErrorCode;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.Objects;

/**
 * v2 决策入口：版本化 + 动作判别 + 机器可判别错误码。
 *
 * <p><b>幂等三态（各有唯一正确解，所以逐条判）</b>：</p>
 * <ol>
 *   <li><b>同 commandId + 同摘要</b> → 返回<b>首次实际结论</b>，不重新执行。
 *       重新执行意味着同一次点击跑两遍外部命令。</li>
 *   <li><b>同 commandId + 不同摘要</b> → 拒绝（{@code COMMAND_CONFLICT}）。
 *       放行等于静默丢弃用户第二次的修改意图。</li>
 *   <li><b>另一 commandId 争抢已决互动</b> → {@code DECISION_ALREADY_APPLIED} + 实际最新视图。
 *       <b>不把用户后一次意图当作成功覆盖</b>：命令已经跑过，再「批准」一次不会让它没跑过，
 *       谎报成功只会让用户以为状态可控。</li>
 * </ol>
 *
 * <p><b>为什么「尚未暂停」与「已经结束」必须分开</b>：两者的用户动作相反 ——
 * 前者要继续等并重试，后者重试多少次都不会生效（执行已终结）。
 * 合成一句「稍后重试」会让用户在已结束场景下无限重试。</p>
 *
 * <p><b>并发决策不丢槽位的保证</b>：同 execution 粒度门闩内重查 toolCall / execution /
 * version / actions，再在事务内写槽位 + 结论 + 上下文 + 执行检查点。
 * 进程内 synchronized 只是为了减少无谓的竞争，<b>真正的正确性靠 tool_call 的
 * {@code eq(version)} 乐观锁</b> —— 门闩在多进程下不成立。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class VersionedToolCallDecisionService {

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final ModelContextService modelContextService;
    private final SseEventPublisher sseEventPublisher;
    private final TransactionTemplate transactions;
    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final SuspendedExecutionResumer resumer;
    private final ExecutionResumeCoordinator resumeCoordinator;
    private final CommandApprovalExecutor commandApprovalExecutor;

    /**
     * 受理一次 v2 决策。
     *
     * @param command 决策命令（动作判别 + 期望版本 + 命令身份）
     * @return 决策回执
     */
    public ToolCallDecisionReceipt decide(ToolCallDecisionCommand command) {
        throwIf(command == null, "决策请求不能为空");
        throwIf(command.toolCallId() == null || command.toolCallId().isBlank(), "工具调用标识不能为空");
        throwIf(command.commandId() == null || command.commandId().isBlank(), "命令标识不能为空");
        throwIf(command.action() == null, "决策动作不能为空");
        throwIf(command.action() == ToolCallAction.ANSWER
                        && (command.text() == null || command.text().isBlank()),
                "回答动作必须带答复内容");

        String digest = buildDigest(command);
        ToolCall located = toolCallRepository.findById(command.toolCallId())
                .orElseThrow(ClientException::new);

        // 归属校验先于一切：拿 A 会话的卡片 id 去 B 会话提交决策必须被挡住。
        throwIf(command.conversationId() != null
                        && !Objects.equals(command.conversationId(), located.getConversationId()),
                new DecisionConflictException(DecisionErrorCode.STATE_CONFLICT, "会话与工具调用不匹配"));

        // 同 execution 粒度串行：多张卡片基于同一旧检查点并发决策会互相覆盖。
        synchronized (ExecutionCoordination.monitor(String.valueOf(located.getExecutionId()))) {
            return decideLocked(command, digest);
        }
    }

    private ToolCallDecisionReceipt decideLocked(ToolCallDecisionCommand command, String digest) {
        // 门闩内必须重查：等待期间另一方可能已经落定了结论。
        ToolCall toolCall = toolCallRepository.findById(command.toolCallId())
                .orElseThrow(ClientException::new);

        // 态一：同命令重试 —— 返回首次实际结论，不重新执行。
        if (toolCall.isDecidedBy(command.commandId())) {
            if (!Objects.equals(toolCall.getDecisionDigest(), digest)) {
                throw new DecisionConflictException(DecisionErrorCode.COMMAND_CONFLICT,
                        DecisionErrorCode.COMMAND_CONFLICT.message(), converter.toVO(toolCall));
            }
            log.info("决策重试返回首次结论: toolCallId={}, commandId={}", toolCall.getId(), command.commandId());
            // 重试路径不重新登记恢复意图：首次受理已经登记过，再登记只会重复派发。
            // 处置按当前事实回答（可能已经 RUNNING 或已经结束），这正是回执要表达的意思。
            ToolCallOutcome firstOutcome = converter.readOutcome(toolCall);
            return new ToolCallDecisionReceipt(command.commandId(), true,
                    firstOutcome == null ? null : firstOutcome.name(),
                    converter.toVO(toolCall), readDisposition(toolCall));
        }

        // 态三：另一命令争抢已决互动 —— 回实际最新视图，不覆盖。
        if (toolCall.getStatus() == ToolCallStatus.COMPLETED) {
            throw new DecisionConflictException(DecisionErrorCode.DECISION_ALREADY_APPLIED,
                    DecisionErrorCode.DECISION_ALREADY_APPLIED.message(), converter.toVO(toolCall));
        }

        // 准备中：决策会落空，且此时不该有版本冲突（版本还没稳定）。
        if (toolCall.getStatus() == ToolCallStatus.PREPARING) {
            throw new DecisionConflictException(DecisionErrorCode.INTERACTION_NOT_READY);
        }

        // 版本冲突：客户端拿着过期界面提交，必须让前端刷新而不是硬覆盖。
        if (command.expectedVersion() != null
                && !Objects.equals(command.expectedVersion(), toolCall.getVersion())) {
            throw new DecisionConflictException(DecisionErrorCode.STATE_CONFLICT,
                    DecisionErrorCode.STATE_CONFLICT.message(), converter.toVO(toolCall));
        }

        ExecutionRepository repository = executionRepository.getObject();
        long conversationId = toolCall.getConversationId();
        String executionId = String.valueOf(toolCall.getExecutionId());
        Execution execution = repository.findById(executionId).orElseThrow(ClientException::new);

        // 「尚未暂停」与「已经结束」分开报错：两者的用户动作相反。
        if (ExecutionStatusCodes.isTerminalState(execution.getExecutionState())) {
            throw new DecisionConflictException(DecisionErrorCode.EXECUTION_ENDED);
        }
        if (execution.getExecutionState() != ExecutionState.SUSPENDED) {
            throw new DecisionConflictException(DecisionErrorCode.INTERACTION_NOT_READY,
                    "执行尚未暂停，请等待后再提交");
        }

        ToolCallKind kind = converter.resolveKind(toolCall.getContent());
        throwIf(kind == null, new DecisionConflictException(DecisionErrorCode.INTERACTION_NOT_READY,
                "互动内容不可识别，请刷新后重试"));

        // 命令审批有外部副作用，走独立命令链（T1 提交先于副作用）；PLAN/CHOICE 走无副作用单事务。
        if (kind == ToolCallKind.COMMAND) {
            return decideCommand(toolCall, command, digest);
        }

        ToolCallOutcome outcome = resolveOutcome(kind, command.action());
        boolean affirmative = outcome == ToolCallOutcome.APPROVED || outcome == ToolCallOutcome.ANSWERED;
        String rawOutput = converter.decisionOutcome(outcome, command.text(), affirmative);
        String outputText = affirmative
                ? (command.text() == null || command.text().isBlank() ? "用户已批准该互动" : command.text())
                : "用户已拒绝该互动";

        // 决策元信息与结论同事务落库：命令身份晚一步写就会留下「已决但查不回命令」的行。
        toolCall.attachDecision(command.commandId(), digest);

        // 恢复处置必须在事务内求一次：事务外再求会看到「所有槽位都已完成」而误判为可以恢复，
        // 而真实情况是别的卡片还没落定。enqueue 本身幂等，但重复求值会把结论算错。
        final ResumeDisposition[] disposition = new ResumeDisposition[1];

        // 槽位、结论、模型上下文、执行检查点必须同事务：
        // 开放恢复与补写结论之间若有窗口，loop 会拿到还没写回结论的槽位。
        transactions.executeWithoutResult(status -> {
            ToolCall current = toolCallRepository.findById(toolCall.getId()).orElseThrow(ClientException::new);
            throwIf(!ExecutionToolSlot.write(execution, current.getId(), current.getToolName(), outputText),
                    "找不到原工具结果，不能恢复执行");
            current.attachDecision(command.commandId(), digest);
            current.complete(rawOutput);
            toolCallRepository.updateById(current);
            repository.save(execution);
            modelContextService.replace(conversationId, execution.getMessages());
            // 恢复意图与决策同事务登记：不存在「决策已落库但恢复意图没落库」的窗口。
            disposition[0] = resumeCoordinator.accept(current.getExecutionId());
        });

        ToolCall latest = toolCallRepository.findById(toolCall.getId()).orElse(toolCall);
        return receipt(command.commandId(), latest, outcome, disposition[0]);
    }

    /**
     * 命令审批：只接受批准 / 拒绝，转交命令链编排。
     *
     * <p><b>为什么不复用通用分支</b>：通用分支只把结论写回槽位、<b>不执行命令</b>，
     * 会把「已批准」落成一个永远不会执行的假象——用户以为命令跑了，其实没有。
     * 命令批准必须进 T1 提交 + 异步执行 + T2 落结果这条链。</p>
     *
     * <p>{@code ANSWER} 对命令卡无意义：放行会把「作答」静默当成「拒绝」，
     * 因此在这里显式拒绝，而不是靠布尔推导。</p>
     */
    private ToolCallDecisionReceipt decideCommand(ToolCall toolCall, ToolCallDecisionCommand command, String digest) {
        throwIf(command.action() == ToolCallAction.ANSWER, "命令审批只接受批准或拒绝");
        boolean approved = command.action() == ToolCallAction.APPROVE;
        CommandApprovalExecutor.CommandApprovalResult result =
                commandApprovalExecutor.decide(toolCall, approved, command.commandId(), digest, null);
        ToolCall latest = toolCallRepository.findById(toolCall.getId()).orElse(toolCall);
        return new ToolCallDecisionReceipt(command.commandId(), true, result.outcome().name(),
                converter.toVO(latest), result.disposition());
    }

    /**
     * 动作 → 结论。
     *
     * <p><b>CHOICE 的 {@code ANSWER} 映射成 {@code ANSWERED} 而不是 {@code APPROVED}</b>：
     * v1 把它隐含成 approved=true，导致「用户选了选项」与「用户批准执行命令」在库里无法区分，
     * 回放与审计都失去依据。</p>
     */
    private static ToolCallOutcome resolveOutcome(ToolCallKind kind, ToolCallAction action) {
        return switch (action) {
            case REJECT -> ToolCallOutcome.REJECTED;
            case ANSWER -> ToolCallOutcome.ANSWERED;
            case APPROVE -> kind == ToolCallKind.CHOICE ? ToolCallOutcome.ANSWERED : ToolCallOutcome.APPROVED;
        };
    }

    /** 决策请求摘要：同 commandId 不同内容即拒绝。 */
    private static String buildDigest(ToolCallDecisionCommand command) {
        return CommandDigest.build(command.toolCallId(), command.conversationId(),
                command.expectedVersion(), command.action() == null ? null : command.action().wireValue(),
                command.text());
    }

    /**
     * 只读恢复处置，不登记新的恢复意图。
     *
     * <p>用于「同命令重试」与回执组装：此刻决策早已落库，再走一次 {@code accept} 会重复
     * enqueue 并可能重复唤醒 worker。这里只回答「现在是什么状态」。</p>
     */
    private ResumeDisposition readDisposition(ToolCall toolCall) {
        if (toolCall.getExecutionId() == null) {
            return ResumeDisposition.ENDED;
        }
        Execution execution = executionRepository.getObject()
                .findById(String.valueOf(toolCall.getExecutionId())).orElse(null);
        if (execution == null || ExecutionStatusCodes.isTerminalState(execution.getExecutionState())) {
            return ResumeDisposition.ENDED;
        }
        if (execution.getExecutionState() == ExecutionState.SUSPENDED) {
            return resumer.hasUnresolvedSlot(toolCall.getExecutionId())
                    ? ResumeDisposition.WAITING_OTHER_TOOLS : ResumeDisposition.QUEUED;
        }
        return ResumeDisposition.RUNNING;
    }

    /**
     * 组装回执。
     *
     * @param outcome 本次实际落定的结论
     */
    private ToolCallDecisionReceipt receipt(String commandId, ToolCall toolCall,
                                            ToolCallOutcome outcome, ResumeDisposition disposition) {
        return new ToolCallDecisionReceipt(commandId, true, outcome.name(), converter.toVO(toolCall), disposition);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }

    private void throwIf(boolean condition, DecisionConflictException failure) {
        if (condition) {
            throw failure;
        }
    }
}
