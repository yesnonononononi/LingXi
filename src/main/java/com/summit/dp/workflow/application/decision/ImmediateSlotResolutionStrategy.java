package com.summit.dp.workflow.application.decision;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.api.dto.ChoiceAnswersCommand;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.vo.DecisionErrorCode;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 立即形态：普通同意 / 拒绝 / 作答、计划确认、多选问答批量。
 *
 * <p>本类只算「写什么」，不落库：全部校验通过之前不产生任何写入，
 * 部分失败因此不可能留下半成品（多选批量的全成全败由此保证）。</p>
 */
@Component
@RequiredArgsConstructor
public final class ImmediateSlotResolutionStrategy implements SlotResolutionStrategy {

    private final ToolCallConverter converter;
    private final ChoiceAnswersValidator validator;
    private final ToolCallRepository toolCalls;

    @Override
    public List<SlotResolutionItem> prepareSlotResolutions(Execution execution, List<ToolCall> cards,
                                                           SlotDecisionCommand command,
                                                           DecisionEntryContract contract) {
        return switch (command) {
            case ChoiceBatchDecision batch -> prepareBatch(execution, cards, batch, contract);
            case ImmediateDecision single -> List.of(prepareSingle(execution, cards.getFirst(), single, contract));
            case CommandDecision ignored -> List.of();
        };
    }

    /** 单卡：动作 → 结论 → 槽位文本，并核对版本与形态。 */
    private SlotResolutionItem prepareSingle(Execution execution, ToolCall card, ImmediateDecision command,
                                             DecisionEntryContract contract) {
        ToolCallKind kind = converter.resolveKind(card.getContent());
        if (kind == null) {
            throw contract.conflict(DecisionErrorCode.INTERACTION_NOT_READY, "互动内容不可识别，请刷新后重试",
                    converter.toVO(card));
        }
        ToolCallOutcome outcome = resolveOutcome(kind, command.action());
        boolean affirmative = outcome == ToolCallOutcome.APPROVED || outcome == ToolCallOutcome.ANSWERED;
        requireSlot(execution, card, card.getToolName(), "找不到原工具结果，不能恢复执行");
        return new SlotResolutionItem(card,
                affirmative ? affirmativeText(command.text()) : "用户已拒绝该互动",
                converter.decisionOutcome(outcome, command.text(), affirmative), outcome);
    }

    /** 整组：成员、版本、形态、槽位与完整性全部通过才产出决议项。 */
    private List<SlotResolutionItem> prepareBatch(Execution execution, List<ToolCall> cards,
                                                  ChoiceBatchDecision command, DecisionEntryContract contract) {
        validator.validateOwnership(new ChoiceAnswersCommand(command.conversationId(), command.responseId(),
                command.commandId(), command.answers()), cards);
        Map<String, String> texts = command.answers().stream()
                .collect(Collectors.toMap(ChoiceAnswersCommand.Answer::toolCallId,
                        ChoiceAnswersCommand.Answer::text, (first, second) -> first));
        requireCompleteGroup(command, execution, cards);
        List<SlotResolutionItem> items = new ArrayList<>(cards.size());
        for (ToolCall card : cards) {
            if (converter.resolveKind(card.getContent()) != ToolCallKind.CHOICE) {
                throw new ClientException("该卡片不是选择问题");
            }
            // 同名工具可能有多条结果：批量必须按调用身份精确命中，不得退化到按名字匹配。
            requireSlot(execution, card, null, "找不到原问题的工具结果，不能恢复执行");
            String text = texts.get(card.getId());
            items.add(new SlotResolutionItem(card, text,
                    converter.decisionOutcome(ToolCallOutcome.ANSWERED, text, true), ToolCallOutcome.ANSWERED));
        }
        return items;
    }

    /** 本次提交必须恰好覆盖原问题组的全部待答卡片，删题或漏题一律拒绝。 */
    private void requireCompleteGroup(ChoiceBatchDecision command, Execution execution, List<ToolCall> cards) {
        Set<String> groupIds = validator.groupCallIds(new ChoiceAnswersCommand(command.conversationId(),
                command.responseId(), command.commandId(), command.answers()), execution);
        List<ToolCall> group = toolCalls.listByIds(groupIds);
        if (group.size() != groupIds.size()) {
            throw new ClientException("问题组尚未准备完整，请刷新后重试");
        }
        Set<String> pendingIds = group.stream().filter(ToolCall::isUnresolved).map(ToolCall::getId)
                .collect(Collectors.toSet());
        Set<String> submittedIds = cards.stream().map(ToolCall::getId).collect(Collectors.toSet());
        if (!pendingIds.equals(submittedIds)) {
            throw new ClientException("请一起提交该组全部待答问题");
        }
    }

    /** 槽位必须在执行消息里存在，否则恢复后模型拿不到这条结论。 */
    private void requireSlot(Execution execution, ToolCall card, String toolNameFallback, String message) {
        ToolMessageEntity slot = ExecutionToolSlot.locate(execution, card.getId(), toolNameFallback);
        if (slot == null || !Objects.equals(slot.getName(), card.getToolName())) {
            throw new ClientException(message);
        }
    }

    private static String affirmativeText(String text) {
        return text == null || text.isBlank() ? "用户已批准该互动" : text;
    }

    /**
     * 动作 → 结论。
     *
     * <p>{@code CHOICE} 的 {@code APPROVE} 映射成 {@code ANSWERED}：v1 只有一个布尔，
     * 选择与批准在库里必须区分开，否则回放与审计失去依据。</p>
     */
    private static ToolCallOutcome resolveOutcome(ToolCallKind kind, ToolCallAction action) {
        return switch (action) {
            case REJECT -> ToolCallOutcome.REJECTED;
            case ANSWER -> ToolCallOutcome.ANSWERED;
            case APPROVE -> kind == ToolCallKind.CHOICE ? ToolCallOutcome.ANSWERED : ToolCallOutcome.APPROVED;
        };
    }
}
