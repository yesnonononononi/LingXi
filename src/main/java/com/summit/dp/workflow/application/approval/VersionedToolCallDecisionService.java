package com.summit.dp.workflow.application.approval;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.utils.CommandDigest;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionCommand;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionReceipt;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.application.decision.CommandDecision;
import com.summit.dp.workflow.application.decision.DecisionReceipt;
import com.summit.dp.workflow.application.decision.ImmediateDecision;
import com.summit.dp.workflow.application.decision.InteractionDecisionEngine;
import com.summit.dp.workflow.application.decision.ResumeIntent;
import com.summit.dp.workflow.application.decision.SlotDecisionCommand;
import com.summit.dp.workflow.application.decision.VersionedDecisionContract;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * v2 决策入口：<b>薄适配器</b>，只做入参校验、动作/形态转换与回执装配。
 *
 * <p>判定顺序、幂等三态、冲突语义、单事务写入全部在
 * {@link InteractionDecisionEngine}；本类刻意不留任何落库编排，
 * 避免再出现「v1 一套、v2 一套」的双轨实现。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class VersionedToolCallDecisionService {

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final InteractionDecisionEngine engine;
    private final VersionedDecisionContract contract;

    /**
     * 受理一次 v2 决策。
     *
     * @param command 决策命令（动作判别 + 期望版本 + 命令身份）
     * @return 决策回执
     */
    public ToolCallDecisionReceipt decide(ToolCallDecisionCommand command) {
        requireArguments(command);
        String digest = buildDigest(command);
        DecisionReceipt receipt = engine.decide(toDecision(command, digest), contract);
        return new ToolCallDecisionReceipt(receipt.commandId(), receipt.decisionApplied(), receipt.decision(),
                receipt.singleView(), receipt.resumeDisposition());
    }

    /**
     * 把 v2 请求转成统一决议输入。
     *
     * <p>形态要从卡片读出：命令有外部副作用，必须走两阶段形态，不能与立即形态混用一条事务边界。</p>
     */
    private SlotDecisionCommand toDecision(
            ToolCallDecisionCommand command, String digest) {
        ToolCall located = toolCallRepository.findById(command.toolCallId()).orElseThrow(ClientException::new);
        boolean isCommand = converter.resolveKind(located.getContent()) == ToolCallKind.COMMAND;
        return isCommand
                ? new CommandDecision(command.conversationId(), command.toolCallId(), command.commandId(),
                        command.expectedVersion(), command.action(), digest, ResumeIntent.COORDINATOR)
                : new ImmediateDecision(command.conversationId(), command.toolCallId(), command.commandId(),
                        command.expectedVersion(), command.action(), command.text(), digest,
                        ResumeIntent.COORDINATOR);
    }

    /** 入口参数校验：缺字段属于客户端错误，不查库也不落库。 */
    private void requireArguments(ToolCallDecisionCommand command) {
        throwIf(command == null, "决策请求不能为空");
        throwIf(command.toolCallId() == null || command.toolCallId().isBlank(), "工具调用标识不能为空");
        throwIf(command.commandId() == null || command.commandId().isBlank(), "命令标识不能为空");
        throwIf(command.action() == null, "决策动作不能为空");
        throwIf(command.action() == ToolCallAction.ANSWER
                && (command.text() == null || command.text().isBlank()), "回答动作必须带答复内容");
    }

    /** 决策请求摘要：同 commandId 不同内容即拒绝。 */
    private static String buildDigest(ToolCallDecisionCommand command) {
        return CommandDigest.build(command.toolCallId(), command.conversationId(),
                command.expectedVersion(), command.action() == null ? null : command.action().wireValue(),
                command.text());
    }

    private void throwIf(boolean condition, String message) {
        if (condition) {
            throw new ClientException(message);
        }
    }
}


