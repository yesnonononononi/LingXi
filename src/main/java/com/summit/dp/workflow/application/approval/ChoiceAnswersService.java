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
            return transactions.execute(status -> {
                List<ChoiceAnswersCommand.Answer> answers = command.answers().stream()
                        .sorted(Comparator.comparing(ChoiceAnswersCommand.Answer::toolCallId)).toList();
                List<ToolCall> cards = answers.stream()
                        .map(answer -> tools.findById(answer.toolCallId()).orElseThrow(ClientException::new)).toList();
                validator.validateOwnership(command, cards);
                Long executionId = cards.getFirst().getExecutionId();

                // 整批摘要包含成员和版本，重试删题或改答案都不能被当作首次结论。
                if (cards.stream().anyMatch(card -> card.isDecidedBy(command.commandId()))) {
                    throwIf(cards.stream().anyMatch(card -> !card.isDecidedBy(command.commandId())
                            || !Objects.equals(digest, card.getDecisionDigest())), DecisionErrorCode.COMMAND_CONFLICT);
                    Execution current = executions.getObject().findById(String.valueOf(executionId)).orElse(null);
                    ResumeDisposition disposition = current == null || ExecutionStateCodec.isTerminalState(current.getExecutionState())
                            ? ResumeDisposition.ENDED : current.getExecutionState() != ExecutionState.SUSPENDED
                            ? ResumeDisposition.RUNNING : resumer.hasUnresolvedSlot(executionId)
                            ? ResumeDisposition.WAITING_OTHER_TOOLS : ResumeDisposition.QUEUED;
                    return new ChoiceAnswersReceipt(command.commandId(), true,
                            cards.stream().map(converter::toVO).toList(), disposition);
                }

                throwIf(cards.stream().anyMatch(ToolCall::isCompleted), DecisionErrorCode.DECISION_ALREADY_APPLIED);
                ExecutionRepository repository = executions.getObject();
                Execution execution = repository.findById(String.valueOf(executionId)).orElseThrow(ClientException::new);
                throwIf(ExecutionStateCodec.isTerminalState(execution.getExecutionState()), DecisionErrorCode.EXECUTION_ENDED);
                throwIf(execution.getExecutionState() != ExecutionState.SUSPENDED, DecisionErrorCode.INTERACTION_NOT_READY);
                Set<String> groupIds = validator.groupCallIds(command, execution);
                List<ToolCall> group = tools.listByIds(groupIds);
                throwIf(group.size() != groupIds.size(), "问题组尚未准备完整，请刷新后重试");
                Set<String> pendingIds = group.stream().filter(ToolCall::isUnresolved)
                        .map(ToolCall::getId).collect(Collectors.toSet());
                Set<String> submittedIds = cards.stream().map(ToolCall::getId).collect(Collectors.toSet());
                throwIf(!pendingIds.equals(submittedIds), "请一起提交该组全部待答问题");

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

                for (int index = 0; index < cards.size(); index++) {
                    ToolCall card = cards.get(index);
                    String text = answers.get(index).text();
                    card.attachDecision(command.commandId(), digest);
                    card.complete(converter.decisionOutcome(ToolCallOutcome.ANSWERED, text, true));
                    tools.updateById(card);
                    slots.get(index).setToolOutput(text);
                }
                repository.save(execution);
                contexts.replace(command.conversationId(), execution.getMessages());
                ResumeDisposition disposition = resumeCoordinator.accept(executionId);
                return new ChoiceAnswersReceipt(command.commandId(), true,
                        cards.stream().map(converter::toVO).toList(), disposition);
            });
        }
    }

    private void throwIf(boolean condition, String message) {
        if (condition) throw new ClientException(message);
    }

    private void throwIf(boolean condition, DecisionErrorCode code) {
        if (condition) throw new DecisionConflictException(code);
    }
}
