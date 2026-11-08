package com.summit.dp.workflow.application.decision;

import com.summit.dp.toolcall.api.dto.ChoiceAnswersCommand;
import com.summit.dp.toolcall.api.dto.ChoiceAnswersReceipt;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.Comparator;
import java.util.List;

/**
 * 多选批量入口：<b>薄适配器</b>，只做参数校验与批量输入转换。
 *
 * <p>整组答案「全成全败」由引擎的单事务保证：所有槽位与卡片结论在同一个事务里写，
 * 任何一条失败都整体回滚，因此库里不会出现半成品。</p>
 */
@Service
@RequiredArgsConstructor
public class ChoiceAnswersService {

    private final ChoiceAnswersValidator validator;
    private final InteractionDecisionEngine engine;
    private final VersionedDecisionContract contract;

    /**
     * 提交同一问题组的全部答案。
     *
     * @param command 回答请求
     * @return 整批回执（含恢复处置）
     */
    public ChoiceAnswersReceipt submit(ChoiceAnswersCommand command) {
        validator.validateInput(command);
        List<ChoiceAnswersCommand.Answer> sorted = command.answers().stream()
                .sorted(Comparator.comparing(ChoiceAnswersCommand.Answer::toolCallId)).toList();
        DecisionReceipt receipt = engine.decide(new ChoiceBatchDecision(command.conversationId(),
                command.responseId(), command.commandId(), sorted, validator.digest(command, sorted)), contract);
        return new ChoiceAnswersReceipt(command.commandId(), receipt.decisionApplied(),
                receipt.toolCalls(), receipt.resumeDisposition());
    }
}

