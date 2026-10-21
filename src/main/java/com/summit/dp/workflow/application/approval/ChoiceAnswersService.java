package com.summit.dp.workflow.application.approval;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.api.dto.ChoiceAnswersCommand;
import com.summit.dp.toolcall.api.dto.ChoiceAnswersReceipt;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.vo.DecisionConflictException;
import com.summit.dp.toolcall.application.vo.DecisionErrorCode;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.resume.SuspendedExecutionResumer;
import com.summit.dp.workflow.infrastructure.harness.ExecutionStateCodec;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/** 整组答案与工具结果同事务提交，全部保存后才登记恢复。 */
@Service
@RequiredArgsConstructor
public class ChoiceAnswersService {
    private final ToolCallRepository tools;
    private final ToolCallConverter converter;
    private final ChoiceAnswersValidator validator;
    private final ObjectProvider<ExecutionRepository> executions;
    private final ModelContextService contexts;
    private final ExecutionResumeCoordinator resumeCoordinator;
    private final SuspendedExecutionResumer resumer;
    private final TransactionTemplate transactions;

    public ChoiceAnswersReceipt submit(ChoiceAnswersCommand command) {
        validator.validateInput(command);
        ToolCall located = tools.findById(command.answers().getFirst().toolCallId()).orElseThrow(ClientException::new);
        String digest = validator.digest(command);
        synchronized (ExecutionCoordination.monitor(String.valueOf(located.getExecutionId()))) {
            return transactions.execute(status -> submitLocked(command, digest));
        }
    }

    /** 锁内且事务内的完整提交编排：只保留步骤顺序，细节落在各步骤方法里。 */
    private ChoiceAnswersReceipt submitLocked(ChoiceAnswersCommand command, String digest) {
        List<ChoiceAnswersCommand.Answer> answers = sortedAnswers(command);
        List<ToolCall> cards = reloadCards(answers);
        validator.validateOwnership(command, cards);
        Long executionId = cards.getFirst().getExecutionId();

        // 整批摘要包含成员和版本，重试删题或改答案都不能被当作首次结论。
        if (cards.stream().anyMatch(card -> card.isDecidedBy(command.commandId()))) {
            return replayDecided(command, digest, cards, executionId);
        }

        throwIf(cards.stream().anyMatch(ToolCall::isCompleted), DecisionErrorCode.DECISION_ALREADY_APPLIED);
        ExecutionRepository repository = executions.getObject();
        Execution execution = repository.findById(String.valueOf(executionId)).orElseThrow(ClientException::new);
        requireSuspendedExecution(execution);
        requireCompleteGroup(command, execution, cards);

        List<ToolMessageEntity> slots = lockSlots(execution, cards, answers);
        applyAnswers(command, digest, cards, answers, slots);

        repository.save(execution);
        contexts.replace(command.conversationId(), execution.getMessages());
        return toReceipt(command, cards, resumeCoordinator.accept(executionId));
    }

    /** 按卡片标识排序回答：摘要计算与落库顺序都以该顺序为准。 */
    private List<ChoiceAnswersCommand.Answer> sortedAnswers(ChoiceAnswersCommand command) {
        return command.answers().stream()
                .sorted(Comparator.comparing(ChoiceAnswersCommand.Answer::toolCallId)).toList();
    }

    /** 事务内重新读取卡片，避免锁外读到的状态被当作最新版本。 */
    private List<ToolCall> reloadCards(List<ChoiceAnswersCommand.Answer> answers) {
        return answers.stream()
                .map(answer -> tools.findById(answer.toolCallId()).orElseThrow(ClientException::new)).toList();
    }

    /**
     * 幂等重放：命令已落库时不再写库，只回报权威卡片与当前恢复处置。
     *
     * <p>成员被删减、版本或答案被改写一律视为命令冲突；通过冲突校验后，
     * 按执行当前状态推导恢复处置。</p>
     */
    private ChoiceAnswersReceipt replayDecided(ChoiceAnswersCommand command, String digest, List<ToolCall> cards,
            Long executionId) {
        throwIf(cards.stream().anyMatch(card -> !card.isDecidedBy(command.commandId())
                || !Objects.equals(digest, card.getDecisionDigest())), DecisionErrorCode.COMMAND_CONFLICT);
        Execution current = executions.getObject().findById(String.valueOf(executionId)).orElse(null);
        return toReceipt(command, cards, dispositionOf(current, executionId));
    }

    /** 由执行当前状态推导恢复处置：ENDED / RUNNING / WAITING_OTHER_TOOLS / QUEUED。 */
    private ResumeDisposition dispositionOf(Execution current, Long executionId) {
        if (current == null || ExecutionStateCodec.isTerminalState(current.getExecutionState())) {
            return ResumeDisposition.ENDED;
        }
        if (current.getExecutionState() != ExecutionState.SUSPENDED) {
            return ResumeDisposition.RUNNING;
        }
        return resumer.hasUnresolvedSlot(executionId)
                ? ResumeDisposition.WAITING_OTHER_TOOLS : ResumeDisposition.QUEUED;
    }

    /** 执行必须仍处于挂起态，否则不允许回填答案。 */
    private void requireSuspendedExecution(Execution execution) {
        throwIf(ExecutionStateCodec.isTerminalState(execution.getExecutionState()), DecisionErrorCode.EXECUTION_ENDED);
        throwIf(execution.getExecutionState() != ExecutionState.SUSPENDED, DecisionErrorCode.INTERACTION_NOT_READY);
    }

    /** 本次提交必须恰好覆盖原问题组的全部待答卡片。 */
    private void requireCompleteGroup(ChoiceAnswersCommand command, Execution execution, List<ToolCall> cards) {
        Set<String> groupIds = validator.groupCallIds(command, execution);
        List<ToolCall> group = tools.listByIds(groupIds);
        throwIf(group.size() != groupIds.size(), "问题组尚未准备完整，请刷新后重试");
        Set<String> pendingIds = group.stream().filter(ToolCall::isUnresolved)
                .map(ToolCall::getId).collect(Collectors.toSet());
        Set<String> submittedIds = cards.stream().map(ToolCall::getId).collect(Collectors.toSet());
        throwIf(!pendingIds.equals(submittedIds), "请一起提交该组全部待答问题");
    }

    /**
     * 逐卡校验并定位工具槽位，返回与卡片一一对应的槽位列表。
     *
     * <p>本方法只读：全部校验通过之前不产生任何写入，保证部分失败时不存在半成品。</p>
     */
    private List<ToolMessageEntity> lockSlots(Execution execution, List<ToolCall> cards,
            List<ChoiceAnswersCommand.Answer> answers) {
        List<ToolMessageEntity> slots = new ArrayList<>();
        for (int index = 0; index < cards.size(); index++) {
            ToolCall card = cards.get(index);
            throwIf(card.getStatus() == ToolCallStatus.COMPLETED, DecisionErrorCode.DECISION_ALREADY_APPLIED);
            throwIf(card.getStatus() != ToolCallStatus.PENDING, DecisionErrorCode.INTERACTION_NOT_READY);
            throwIf(!Objects.equals(card.getVersion(), answers.get(index).expectedVersion()), DecisionErrorCode.STATE_CONFLICT);
            throwIf(converter.resolveKind(card.getContent()) != ToolCallKind.CHOICE, "该卡片不是选择问题");
            // 同名工具可能有多条结果，缺少精确调用身份时必须拒绝回填。
            ToolMessageEntity slot = ExecutionToolSlot.locate(execution, card.getId(), null);
            throwIf(slot == null || !Objects.equals(slot.getName(), card.getToolName()), "找不到原问题的工具结果，不能恢复执行");
            slots.add(slot);
        }
        return slots;
    }

    /** 全部校验通过后统一落库：写卡片结论与工具槽位输出。 */
    private void applyAnswers(ChoiceAnswersCommand command, String digest, List<ToolCall> cards,
            List<ChoiceAnswersCommand.Answer> answers, List<ToolMessageEntity> slots) {
        for (int index = 0; index < cards.size(); index++) {
            ToolCall card = cards.get(index);
            String text = answers.get(index).text();
            card.attachDecision(command.commandId(), digest);
            card.complete(converter.decisionOutcome(ToolCallOutcome.ANSWERED, text, true));
            tools.updateById(card);
            slots.get(index).setToolOutput(text);
        }
    }

    /** 统一组装回执：命令标识、是否已决策、权威卡片与恢复处置。 */
    private ChoiceAnswersReceipt toReceipt(ChoiceAnswersCommand command, List<ToolCall> cards,
            ResumeDisposition disposition) {
        return new ChoiceAnswersReceipt(command.commandId(), true,
                cards.stream().map(converter::toVO).toList(), disposition);
    }

    private void throwIf(boolean condition, String message) {
        if (condition) throw new ClientException(message);
    }

    private void throwIf(boolean condition, DecisionErrorCode code) {
        if (condition) throw new DecisionConflictException(code);
    }
}
