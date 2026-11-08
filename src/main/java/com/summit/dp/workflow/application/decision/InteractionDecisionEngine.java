package com.summit.dp.workflow.application.decision;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.vo.DecisionErrorCode;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.application.lifecycle.ResumeTriggerType;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.harness.ExecutionStateCodec;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * 互动决策唯一模板：三个入口（v1 SSE / v2 JSON / 多选批量）共用同一份判定顺序。
 *
 * <h2>顺序即不变量</h2>
 *
 * <ol>
 *   <li><b>入口参数校验</b>：缺字段直接拒绝，不查库。</li>
 *   <li><b>会话归属</b>：拿 A 会话的卡片 id 到 B 会话提交必须被挡住。</li>
 *   <li><b>执行级门闩</b>（{@link ExecutionCoordination}）：同一执行的多张卡片串行。</li>
 *   <li><b>锁内重读</b>：等待期间另一方可能已经落定结论，不能沿用锁外读到的事实。</li>
 *   <li><b>幂等三态</b>：同命令同摘要回放首次结论、同命令不同摘要冲突、他人命令抢已决互动回实际视图。</li>
 *   <li><b>状态 / 版本 / 形态校验</b>：按入口契约表达冲突。</li>
 *   <li><b>策略算槽位决议</b>（纯函数，不写库）。</li>
 *   <li><b>单事务写</b>：槽位 + 结论 + 检查点 + 模型上下文 + 恢复意图。</li>
 *   <li><b>统一回执</b>：含恢复处置。</li>
 * </ol>
 *
 * <h2>并发正确性来自乐观锁，不是进程内门闩</h2>
 *
 * <p>门闩只减少无谓竞争；真正的正确性靠 {@code tool_call} 的 {@code eq(version)} 条件更新 ——
 * 门闩在多进程下不成立，条件更新在任何部署形态下都成立。</p>
 *
 * <h2>引擎不负责什么</h2>
 *
 * <p>命令副作用执行、SSE 连接管理、命令环境重建都不在这里：它们分别在
 * {@link TwoPhaseCommandResolutionStrategy}、各入口适配器与 {@code ApprovedCommandRestorer}。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class InteractionDecisionEngine {

    private final ToolCallRepository toolCalls;
    private final ToolCallConverter converter;
    private final ObjectProvider<ExecutionRepository> executions;
    private final ModelContextService contexts;
    private final TransactionTemplate transactions;
    private final ExecutionResumeCoordinator resumeCoordinator;
    private final UnresolvedToolSuspensionGate unresolvedToolGate;
    private final ImmediateSlotResolutionStrategy immediate;
    private final TwoPhaseCommandResolutionStrategy twoPhase;

    /**
     * 受理一次决策。
     *
     * @param command  统一决议输入
     * @param contract 入口契约（决定冲突怎么表达、已处理怎么收场）
     * @return 统一回执
     */
    public DecisionReceipt decide(SlotDecisionCommand command, DecisionEntryContract contract) {
        requireArguments(command, contract);
        ToolCall located = requireCard(command.cardIds().getFirst());
        requireOwnership(command, located, contract);

        // 门闩在事务外层：锁内读到的必须是已提交的事实，否则乐观锁校验形同虚设。
        synchronized (ExecutionCoordination.monitor(String.valueOf(located.getExecutionId()))) {
            return decideLocked(command, contract);
        }
    }

    /** 锁内全流程：重读 → 入口闸门 → 幂等三态 → 执行态 → 策略 → 单事务写。 */
    private DecisionReceipt decideLocked(SlotDecisionCommand command, DecisionEntryContract contract) {
        List<ToolCall> cards = reloadCards(command);
        for (ToolCall card : cards) {
            contract.admitCard(card);
        }
        DecisionReceipt replayed = replayDecided(cards, command, contract);
        if (replayed != null) {
            return replayed;
        }
        for (ToolCall card : cards) {
            if (!card.isApprovalPending()) {
                return contract.unavailable(card, DecisionErrorCode.DECISION_ALREADY_APPLIED.message());
            }
        }
        for (ToolCall card : cards) {
            contract.admitExecution(card);
        }

        requireExpectedVersions(cards, command, contract);
        ToolCall target = cards.getFirst();
        Execution execution = requireSuspendedExecution(target, contract);
        SlotResolutionStrategy strategy = strategyFor(target);
        return switch (strategy) {
            case TwoPhaseCommandResolutionStrategy commandStrategy ->
                    decideTwoPhase(commandStrategy, target, (CommandDecision) command, contract);
            case ImmediateSlotResolutionStrategy ignored -> {
                List<SlotResolutionItem> items =
                        this.immediate.prepareSlotResolutions(execution, cards, command, contract);
                yield commit(execution, cards, command, items);
            }
        };
    }

    /**
     * 命令形态：T1（引擎事务）→ 提交后派发锁外副作用 → T2 由收尾段落结果。
     *
     * <p><b>顺序不可调换</b>：T1 必须早于副作用，否则进程崩溃后重启会静默重放已产生
     * 副作用的命令；T2 必须与真实输出同批提交，否则「执行过但没落库」会被误当成失败重跑。
     * 这两条都由本方法的三段顺序保证，而不是由某个协作方的自觉保证。</p>
     *
     * <p><b>派发在事务之后</b>：{@code writeT1} 返回时事务已提交；此时才派发，
     * 收尾段读到的受理状态一定已落库。</p>
     */
    private DecisionReceipt decideTwoPhase(TwoPhaseCommandResolutionStrategy strategy, ToolCall card,
                                           CommandDecision command, DecisionEntryContract contract) {
        ApprovalPlan plan = strategy.prepare(card, command, contract, command.settledCallback());
        ResumeDisposition[] disposition = new ResumeDisposition[1];
        try {
            // T1（引擎事务）：占位输出 + 占位结论 + 版本推进 + 决策身份 + 检查点 + 模型上下文。
            // 恢复意图不在这里登记 —— 那属于 T2，提前登记会让执行在命令还没跑完时被唤醒。
            transactions.executeWithoutResult(status -> disposition[0] = strategy.writeT1(plan));
        } catch (RuntimeException | Error failure) {
            // T1 失败：释放控制槽位；副作用还没派发过，因此一次都不会执行。
            strategy.abandonT1(plan);
            throw failure;
        }
        strategy.afterCommit(plan);
        return strategy.buildReceipt(plan, command, disposition[0]);
    }

    /**
     * 单事务写：槽位、结论、检查点、模型上下文、恢复意图同生共死。
     *
     * <p>恢复意图必须<b>在事务内</b>求一次：事务外再求会看到「所有槽位都已完成」而误判为可以恢复。</p>
     */
    private DecisionReceipt commit(Execution execution, List<ToolCall> cards, SlotDecisionCommand command,
                                   List<SlotResolutionItem> items) {
        ResumeDisposition[] disposition = new ResumeDisposition[1];
        transactions.executeWithoutResult(status -> {
            for (SlotResolutionItem item : items) {
                ToolCall card = item.card();
                if (!ExecutionToolSlot.write(execution, card.getId(), card.getToolName(), item.outputText())) {
                    throw new ClientException("找不到原工具结果，不能恢复执行");
                }
                card.attachDecision(command.commandId(), command.digest());
                card.complete(item.rawOutput());
                toolCalls.updateById(card);
            }
            executions.getObject().save(execution);
            contexts.replace(cards.getFirst().getConversationId(), execution.getMessages());
            if (command.resumeIntent() == ResumeIntent.COORDINATOR) {
                // 触发来源必须显式声明为人工决策：自动轮次上限不该拦住用户刚做的批准。
                disposition[0] = resumeCoordinator.accept(resolveExecutionId(cards.getFirst()),
                        ResumeTriggerType.APPROVAL_DECISION, command.settledCallback());
            }
        });
        String decision = items.isEmpty() ? null : items.getFirst().outcome().name();
        return new DecisionReceipt(command.commandId(), true, decision, reloadViews(command), disposition[0]);
    }

    /**
     * 幂等三态。
     *
     * <p>三态各有唯一正确解：同命令同摘要必须回放首次结论（重新执行意味着同一次点击跑两遍），
     * 同命令不同摘要必须拒绝（放行等于静默丢弃用户第二次的修改意图），
     * 他人命令抢已决互动必须回实际视图（谎报成功只会让用户以为状态可控）。</p>
     *
     * @return 非空表示本次是重放，不再写库
     */
    private DecisionReceipt replayDecided(List<ToolCall> cards, SlotDecisionCommand command,
                                          DecisionEntryContract contract) {
        boolean anyDecided = cards.stream().anyMatch(card -> card.isDecidedBy(command.commandId()));
        if (!anyDecided) {
            return null;
        }
        for (ToolCall card : cards) {
            if (!card.isDecidedBy(command.commandId())
                    || !Objects.equals(command.digest(), card.getDecisionDigest())) {
                throw contract.conflict(DecisionErrorCode.COMMAND_CONFLICT,
                        DecisionErrorCode.COMMAND_CONFLICT.message(), converter.toVO(card));
            }
        }
        log.info("决策重试返回首次结论: cards={}, commandId={}", command.cardIds(), command.commandId());
        // 重放不重新登记恢复意图：首次受理已经登记过，再登记只会重复派发。
        return new DecisionReceipt(command.commandId(), true, outcomeName(cards.getFirst()),
                cards.stream().map(converter::toVO).toList(), readDisposition(cards.getFirst()));
    }

    /** 形态决定策略：密封类型加穷尽 switch，不按 Class 查注册表。 */
    private SlotResolutionStrategy strategyFor(ToolCall card) {
        return converter.resolveKind(card.getContent()) == ToolCallKind.COMMAND ? this.twoPhase : this.immediate;
    }

    /**
     * 会话归属：拿别的会话的卡片 id 提交决策必须被挡住。
     *
     * <p>多选批量的归属是「整组卡片同会话同执行」，由策略逐卡校验并沿用原文案，
     * 这里不重复判单卡，否则会改掉批量入口的错误类型。</p>
     */
    private void requireOwnership(SlotDecisionCommand command, ToolCall located, DecisionEntryContract contract) {
        if (command instanceof ChoiceBatchDecision) {
            return;
        }
        if (command.conversationId() != null
                && !Objects.equals(command.conversationId(), located.getConversationId())) {
            throw contract.conflict(DecisionErrorCode.STATE_CONFLICT, "会话与工具调用不匹配", null);
        }
    }

    /** 版本校验前置：过期界面提交必须让前端刷新，而不是在稍后的分支里被执行态错误盖掉。 */
    private void requireExpectedVersions(List<ToolCall> cards, SlotDecisionCommand command,
                                         DecisionEntryContract contract) {
        Map<String, Long> expected = command.expectedVersions();
        for (ToolCall card : cards) {
            Long version = expected.get(card.getId());
            if (version != null && !Objects.equals(version, card.getVersion())) {
                throw contract.conflict(DecisionErrorCode.STATE_CONFLICT,
                        DecisionErrorCode.STATE_CONFLICT.message(), converter.toVO(card));
            }
        }
    }

    /** 锁内逐张重读；任何一张查不到都是客户端错误。 */
    private List<ToolCall> reloadCards(SlotDecisionCommand command) {
        return command.cardIds().stream().map(this::requireCard).toList();
    }

    private ToolCall requireCard(String toolCallId) {
        return toolCalls.findById(toolCallId).orElseThrow(ClientException::new);
    }

    /**
     * 执行必须仍停在挂起态。
     *
     * <p>「已经结束」与「尚未暂停」分开表达：前者重试无用，后者应当继续等。</p>
     */
    private Execution requireSuspendedExecution(ToolCall card, DecisionEntryContract contract) {
        Execution execution = executions.getObject().findById(String.valueOf(card.getExecutionId()))
                .orElseThrow(ClientException::new);
        if (ExecutionStateCodec.isTerminalState(execution.getExecutionState())) {
            throw contract.executionUnavailable(card, true);
        }
        if (execution.getExecutionState() != ExecutionState.SUSPENDED) {
            throw contract.executionUnavailable(card, false);
        }
        return execution;
    }

    /**
     * 只读恢复处置，不登记新的恢复意图。
     *
     * <p>用于「同命令重试」与回执装配：此刻决策早已落库，再走一次 {@code accept}
     * 会重复派发，而回执要回答的是「现在是什么状态」。</p>
     */
    private ResumeDisposition readDisposition(ToolCall card) {
        if (card.getExecutionId() == null) {
            return ResumeDisposition.ENDED;
        }
        Execution execution = executions.getObject().findById(String.valueOf(card.getExecutionId())).orElse(null);
        if (execution == null || ExecutionStateCodec.isTerminalState(execution.getExecutionState())) {
            return ResumeDisposition.ENDED;
        }
        if (execution.getExecutionState() == ExecutionState.SUSPENDED) {
            return unresolvedToolGate.hasUnresolvedSlot(card.getExecutionId())
                    ? ResumeDisposition.WAITING_OTHER_TOOLS : ResumeDisposition.QUEUED;
        }
        return ResumeDisposition.RUNNING;
    }

    /**
     * 回执里的权威视图：一次批量查询，再按入参顺序重排后转 VO。
     *
     * <p>多选批量是整组回执，逐卡查询是 N 次 select；回执顺序必须稳定（前端按提交顺序渲染），
     * 因此重排不能省。查不到的卡片直接跳过 —— 它已经被并发删除，回执里不该出现空壳。</p>
     */
    private List<ToolCallVO> reloadViews(SlotDecisionCommand command) {
        List<String> ids = command.cardIds();
        Map<String, ToolCall> byId = toolCalls.listByIds(ids).stream()
                .collect(Collectors.toMap(ToolCall::getId, card -> card, (first, second) -> first));
        return ids.stream()
                .map(byId::get)
                .filter(Objects::nonNull)
                .map(converter::toVO)
                .toList();
    }

    private static long resolveExecutionId(ToolCall card) {
        return card.getExecutionId() == null ? 0L : card.getExecutionId();
    }

    private String outcomeName(ToolCall card) {
        return converter.readOutcome(card) == null ? null : converter.readOutcome(card).name();
    }

    private void requireArguments(SlotDecisionCommand command, DecisionEntryContract contract) {
        if (command == null || contract == null) {
            throw new ClientException("决策请求不能为空");
        }
        if (command.cardIds().isEmpty()
                || command.cardIds().stream().anyMatch(id -> id == null || id.isBlank())) {
            throw new ClientException("工具调用标识不能为空");
        }
        if (command.resumeIntent() == null) {
            throw new ClientException("恢复意图不能为空");
        }
    }
}
