package com.summit.dp.workflow.application.approval;

import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.utils.CommandDigest;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.application.decision.CommandDecision;
import com.summit.dp.workflow.application.decision.DecisionReceipt;
import com.summit.dp.workflow.application.decision.InteractionDecisionEngine;
import com.summit.dp.workflow.application.decision.ReactiveDecisionContract;
import com.summit.dp.workflow.application.decision.ResumeIntent;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;


/**
 * v1 决策入口：只做输入/输出转换与流管理，业务一律交给统一引擎。
 *
 * <p><b>命令为什么必须单独一条</b>：v1 命令要求「先建流、再提交、恢复落定才关流」。
 * 受理闸门、幂等三态、执行态与形态判定全部由 {@link InteractionDecisionEngine} 承担 ——
 * 这里只保留建流、提交与异常收尾三件事，绝不再自建第二套校验。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ToolCallWorkflowService {

    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter converter;
    private final InteractionDecisionEngine engine;
    private final ToolCallDecisionService decisionService;
    private final ReactiveDecisionContract contract;

    /** v1 请求级 SSE：命令审批在提交前先建流，恢复期事件与命令输出经它下发。 */
    private final SseEventPublisher sseEventPublisher;
    private final ExecutionLocator executionLocator;

    /**
     * 受理一次 v1 决策。
     *
     * @param conversationId 会话 id，可空（不校验归属）
     * @param toolCallId     目标卡片
     * @param approved       是否批准；缺省按拒绝
     * @param text           用户答复原文，可空
     */
    public SseEmitter decide(Long conversationId, String toolCallId, boolean approved, String text) {
        throwIf(toolCallId == null || toolCallId.isBlank(), "工具调用标识不能为空");
        ToolCall located = toolCallRepository.findById(toolCallId).orElseThrow(ClientException::new);
        ToolCallKind kind = converter.resolveKind(located.getContent());
        // 形态必须先判：它决定走哪条链路，也决定「不可识别 / 无需审批」这两条旧文案。
        throwIf(kind == null, "互动内容不可识别，请刷新后重试");
        throwIf(kind != ToolCallKind.PLAN && kind != ToolCallKind.CHOICE && kind != ToolCallKind.COMMAND,
                "该工具调用无需人工审批，子代理结果会自动回填");
        if (kind != ToolCallKind.COMMAND) {
            // 普通互动：归属、准备中、已处理、活跃执行与执行态全部由引擎按 v1 契约判定。
            return decisionService.decide(located, approved, text);
        }
        return decideCommand(conversationId, toolCallId, approved);
    }

    /** 命令审批：建流 → 交给统一引擎（T1/T2 与恢复全在引擎与策略里）→ 落定回调关流。 */
    private SseEmitter decideCommand(Long conversationId, String toolCallId, boolean approved) {
        ToolCall located = toolCallRepository.findById(toolCallId).orElseThrow(ClientException::new);
        // 先建流再提交：恢复请求在 T1 提交后立刻派发，此时必须已经有连接可接事件。
        SseEmitter emitter = sseEventPublisher.connect(
                executionLocator.resolveRootSessionId(located.getConversationId()));
        DecisionReceipt receipt;
        try {
            ToolCallAction action = approved ? ToolCallAction.APPROVE : ToolCallAction.REJECT;
            receipt = engine.decide(new CommandDecision(located.getConversationId(), located.getId(), null, null,
                    action,
                    CommandDigest.build(located.getId(), located.getConversationId(), located.getVersion(),
                            action.wireValue(), null),
                    ResumeIntent.COORDINATOR, () -> sseEventPublisher.finish(emitter)), contract);
        } catch (RuntimeException failure) {
            // 决策没落库：这条流不会有任何后续事件，必须当场以错误收尾再原样抛出。
            emitter.completeWithError(failure);
            throw failure;
        }
        if (!receipt.decisionApplied()) {
            // 幂等 no-op：没有登记恢复，也不会有落定回调，这里直接关流。
            sseEventPublisher.finish(emitter);
        }
        return emitter;
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }
}

